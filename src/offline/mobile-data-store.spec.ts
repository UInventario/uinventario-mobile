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
      'uinventario-mobile:schema',
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

  it('queues a count with the server bootstrap stock and the next causal sequence', async () => {
    const store = testStore();
    const snapshot = countSnapshot();
    await store.queueCashSale(
      snapshot,
      posQuote(),
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-before-count',
    );

    const count = await store.queueInventoryCount(
      snapshot,
      {
        productId: 'product-1',
        locationId: 'location-1',
        countedQuantity: '3.000',
        reason: 'Conteo móvil',
        reference: 'CNT-1',
      },
      'mobile-count-stable',
    );

    expect(count).toMatchObject({
      kind: 'INVENTORY_COUNT',
      sequence: 2,
      payload: {
        productId: 'product-1',
        locationId: 'location-1',
        snapshotQuantity: '2.000',
        countedQuantity: '3.000',
        reason: 'Conteo móvil',
        reference: 'CNT-1',
      },
    });
    await expect(
      store.queueInventoryCount(
        snapshot,
        {
          productId: 'product-1',
          locationId: 'location-1',
          countedQuantity: '3.000',
          reason: 'Conteo móvil',
          reference: 'CNT-1',
        },
        'mobile-count-stable',
      ),
    ).resolves.toMatchObject({ commandId: count.commandId, sequence: 2 });
  });

  it('rejects counts when the server-defined offline permission expired', async () => {
    const snapshot = countSnapshot(Date.now() - 2_000);
    snapshot.freshnessPolicy.actionTtlSeconds.INVENTORY_COUNT = 1;

    await expect(
      testStore().queueInventoryCount(
        snapshot,
        {
          productId: 'product-1',
          locationId: 'location-1',
          countedQuantity: '3.000',
          reason: 'Conteo móvil',
          reference: 'CNT-2',
        },
        'mobile-count-expired',
      ),
    ).rejects.toThrow('autorización offline venció');
  });

  it('migrates the legacy bootstrap and restores it after a forced restart', async () => {
    const storage = new MemoryKeyValueStore();
    const snapshot = posSnapshot();
    await storage.setItem('uinventario-mobile:bootstrap', JSON.stringify(snapshot));

    const firstProcess = new SqliteMobileDataStore(storage);
    expect(await firstProcess.snapshot(snapshot.scope)).toEqual(snapshot);
    expect(await storage.getItem('uinventario-mobile:bootstrap')).toBeNull();

    const restartedProcess = new SqliteMobileDataStore(storage);
    expect(await restartedProcess.snapshot(snapshot.scope)).toEqual(snapshot);
    expect(await storage.getAllKeys()).toEqual(
      expect.arrayContaining([
        'uinventario-mobile:schema',
        expect.stringContaining('snapshot:tenant-1:user-1'),
      ]),
    );
  });

  it('persists non-sensitive session metadata for an authorized offline restart', async () => {
    const storage = new MemoryKeyValueStore();
    const snapshot = posSnapshot();
    const session = {
      data: {
        user: {
          id: 'user-1',
          email: 'admin@example.com',
          roles: ['ADMIN'],
          permissions: ['SALES_MANAGE'],
        },
        tenant: { id: 'tenant-1', name: 'Empresa' },
        context: {
          branch: { id: 'branch-1', name: 'Centro' },
          warehouse: { id: 'warehouse-1', name: 'Principal' },
          cashRegister: { id: 'cash-1', name: 'Caja móvil', code: 'MOB' },
        },
        nextStep: 'APPLICATION' as const,
      },
      expiresAt: snapshot.sessionExpiresAt,
    };
    await new SqliteMobileDataStore(storage).replace(snapshot, session);

    const restored = await new SqliteMobileDataStore(storage).latest(snapshot.scope.deviceId);

    expect(restored).toEqual({ ...session, bootstrap: snapshot });
    expect(JSON.stringify(restored)).not.toContain('token');
    expect(JSON.stringify(restored)).not.toContain('password');
  });

  it('applies upserts and tombstones atomically with the next cursor', async () => {
    const store = testStore();
    const snapshot = posSnapshot();
    await store.replace(snapshot);

    const updated = await store.applyChanges(snapshot.scope, {
      protocolVersion: '1.0',
      generatedAt: new Date().toISOString(),
      sessionExpiresAt: snapshot.sessionExpiresAt,
      freshnessPolicy: snapshot.freshnessPolicy,
      scope: snapshot.scope,
      identity: { user: snapshot.identity.user },
      cursor: 'cursor',
      nextCursor: 'cursor-2',
      hasMore: false,
      changes: [
        {
          changeId: 'change-1',
          operation: 'UPSERT',
          occurredAt: new Date().toISOString(),
          entity: {
            ...snapshot.entities.find(({ id }) => id === 'product-1')!,
            version: 2,
            name: 'Producto actualizado',
          },
        },
        {
          changeId: 'change-2',
          operation: 'DELETE',
          occurredAt: new Date().toISOString(),
          entity: snapshot.entities.find(({ id }) => id === 'balance-1')!,
        },
      ],
    });

    expect(updated.initialSyncCursor).toBe('cursor-2');
    expect(updated.entities.find(({ id }) => id === 'product-1')).toMatchObject({
      version: 2,
      name: 'Producto actualizado',
    });
    expect(updated.entities.find(({ id }) => id === 'balance-1')).toBeUndefined();
    expect(await store.snapshot(snapshot.scope)).toEqual(updated);
  });

  it('isolates corrupt data and rebuilds an empty versioned store', async () => {
    const storage = new MemoryKeyValueStore();
    const store = new SqliteMobileDataStore(
      storage,
      () => '10000000-0000-4000-8000-000000000099',
    );
    const snapshot = posSnapshot();
    await store.replace(snapshot);
    const command = await store.queueCashSale(
      snapshot,
      posQuote(),
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-survives-recovery',
    );
    const snapshotKey = (await storage.getAllKeys()).find((key) => key.includes(':snapshot:'))!;
    await storage.setItem(snapshotKey, '{broken');

    await expect(store.snapshot(snapshot.scope)).rejects.toMatchObject({ code: 'CORRUPT' });
    await store.recover();

    expect(await store.snapshot(snapshot.scope)).toBeNull();
    const outboxKey = (await storage.getAllKeys()).find((key) => key.includes(':outbox:'))!;
    expect(JSON.parse((await storage.getItem(outboxKey))!)).toMatchObject({
      schemaVersion: 2,
      scopeKey:
        'tenant-1:user-1:10000000-0000-4000-8000-000000000001:branch-1:cash-1',
      commands: [expect.objectContaining({ scope: snapshot.scope })],
    });
    expect(await store.commands(snapshot.scope)).toEqual([command]);
    expect(await storage.getAllKeys()).toEqual(
      expect.arrayContaining([
        'uinventario-mobile:schema',
        expect.stringContaining('sequence:tenant-1:user-1'),
        expect.stringContaining('outbox:tenant-1:user-1'),
      ]),
    );
  });

  it('keeps server conflicts terminal and available for review', async () => {
    const store = testStore();
    const snapshot = posSnapshot();
    const command = await store.queueCashSale(
      snapshot,
      posQuote(),
      { lines: [{ productId: 'product-1', quantity: '1' }], cashReceived: '120.00' },
      'mobile-sale-conflict',
    );

    await store.flush(snapshot.scope, async () => ({
      data: {
        results: [
          {
            commandId: command.commandId,
            sequence: command.sequence,
            status: 'ERROR',
            replay: false,
            error: { conflict: { domain: 'STOCK', strategy: 'REVIEW' } },
          },
        ],
      },
      meta: { apiVersion: '1' },
    }));

    expect(await store.commands(snapshot.scope)).toEqual([
      expect.objectContaining({
        status: 'ERROR',
        retryable: false,
        error: { conflict: { domain: 'STOCK', strategy: 'REVIEW' } },
      }),
    ]);
  });
});

function testStore() {
  return new SqliteMobileDataStore(
    new MemoryKeyValueStore(),
    () => '10000000-0000-4000-8000-000000000099',
  );
}

function countSnapshot(now = Date.now()) {
  const snapshot = posSnapshot(now);
  return {
    ...snapshot,
    identity: {
      ...snapshot.identity,
      user: {
        ...snapshot.identity.user,
        permissions: [...snapshot.identity.user.permissions, 'INVENTORY_COUNT'],
      },
    },
  };
}
