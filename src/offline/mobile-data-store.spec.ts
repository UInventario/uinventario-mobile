import { MemoryKeyValueStore, SqliteMobileDataStore } from './mobile-data-store';
import { posQuote, posSnapshot } from '@/pos/pos-test-fixture';

describe('persistent mobile outbox', () => {
  it('deduplicates the same local sale before sending it', async () => {
    const store = testStore();
    const snapshot = posSnapshot();
    const input = { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' };

    const first = await store.queueCashSale(snapshot, posQuote(), input, 'mobile-sale-same');
    const second = await store.queueCashSale(snapshot, posQuote(), input, 'mobile-sale-same');

    expect(second.commandId).toBe(first.commandId);
    expect(await store.commands(snapshot.scope)).toHaveLength(1);
  });

  it('retries the identical command after a lost response and settles the server replay', async () => {
    const store = testStore();
    const snapshot = posSnapshot();
    const command = await store.queueCashSale(
      snapshot,
      posQuote(),
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-replay',
    );
    const offline = jest.fn().mockRejectedValueOnce(new Error('offline'));

    await expect(store.flush(snapshot.scope, offline)).rejects.toThrow('offline');
    expect(await store.commands(snapshot.scope)).toEqual([
      expect.objectContaining({
        commandId: command.commandId,
        idempotencyKey: 'mobile-sale-replay',
        sequence: 1,
        status: 'ERROR',
        attempts: 1,
        retryable: true,
      }),
    ]);

    const replay = jest.fn().mockImplementation(async ([sent]) => ({
      data: {
        results: [
          {
            commandId: sent.commandId,
            sequence: sent.sequence,
            status: 'CONFIRMED',
            replay: true,
            result: { data: { id: 'sale-1' } },
          },
        ],
      },
      meta: { apiVersion: '1' },
    }));

    await expect(store.flush(snapshot.scope, replay)).resolves.toEqual({
      confirmed: 1,
      rejected: 0,
    });
    expect(replay).toHaveBeenCalledWith([
      expect.objectContaining({
        commandId: command.commandId,
        idempotencyKey: 'mobile-sale-replay',
        sequence: 1,
      }),
    ]);
    expect(await store.commands(snapshot.scope)).toEqual([
      expect.objectContaining({ status: 'CONFIRMED', attempts: 2, retryable: false }),
    ]);
  });

  it('removes all tenant data when the secure session is cleared', async () => {
    const storage = new MemoryKeyValueStore();
    const store = new SqliteMobileDataStore(storage, () => '10000000-0000-4000-8000-000000000099');
    const snapshot = posSnapshot();
    await store.replace(snapshot);
    await store.queueCashSale(
      snapshot,
      posQuote(),
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-clear',
    );

    await store.clear();

    expect(await storage.getAllKeys()).toEqual([
      expect.stringContaining('sequence:tenant-1:user-1:10000000-0000-4000-8000-000000000001'),
    ]);
  });

  it('keeps one causal sequence across cash registers on the same device', async () => {
    const store = testStore();
    const firstScope = posSnapshot();
    const secondScope = {
      ...posSnapshot(),
      scope: { ...posSnapshot().scope, branchId: 'branch-2', cashRegisterId: 'cash-2' },
      posPolicy: {
        ...posSnapshot().posPolicy!,
        branchId: 'branch-2',
        warehouseId: 'warehouse-2',
        cashRegisterId: 'cash-2',
      },
    };
    const secondQuote = {
      ...posQuote(),
      context: {
        branch: { id: 'branch-2', name: 'Norte' },
        warehouse: { id: 'warehouse-2', name: 'Bodega norte' },
        cashRegister: { id: 'cash-2', name: 'Caja norte', code: 'N01' },
      },
    };

    const first = await store.queueCashSale(
      firstScope,
      posQuote(),
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-first-scope',
    );
    const second = await store.queueCashSale(
      secondScope,
      secondQuote,
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-second-scope',
    );

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(await store.pendingCountAll()).toBe(2);
  });
});

function testStore() {
  return new SqliteMobileDataStore(
    new MemoryKeyValueStore(),
    () => '10000000-0000-4000-8000-000000000099',
  );
}
