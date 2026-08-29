import { OfflineCommand } from './contracts';
import { offlineQuote } from './pos-model';
import { posSnapshot } from './pos-test-fixture';

describe('offline mobile POS quote', () => {
  it('calculates the same tax-inclusive totals and authorized cash context', () => {
    const now = Date.parse('2026-08-29T08:00:00.000Z');
    const snapshot = posSnapshot(now);

    const quote = offlineQuote(snapshot, [{ productId: 'product-1', quantity: '1' }], [], now);

    expect(quote.context).toEqual({
      branch: { id: 'branch-1', name: 'Centro' },
      warehouse: { id: 'warehouse-1', name: 'Principal' },
      cashRegister: { id: 'cash-1', name: 'Caja móvil', code: 'MOB' },
    });
    expect(quote.totals).toEqual({ subtotal: '100.00', tax: '16.00', total: '116.00' });
  });

  it('subtracts queued sales so reconnect retries cannot oversell stock', () => {
    const now = Date.parse('2026-08-29T08:00:00.000Z');
    const snapshot = posSnapshot(now);
    const pending = {
      kind: 'CASH_SALE',
      status: 'ERROR',
      retryable: true,
      payload: { lines: [{ productId: 'product-1', quantity: '1.000' }] },
    } as OfflineCommand;

    expect(() =>
      offlineQuote(snapshot, [{ productId: 'product-1', quantity: '2' }], [pending], now),
    ).toThrow('Stock offline insuficiente');
  });

  it('does not subtract an inventory count from sale availability', () => {
    const now = Date.parse('2026-08-29T08:00:00.000Z');
    const snapshot = posSnapshot(now);
    const count = {
      kind: 'INVENTORY_COUNT',
      status: 'PENDING',
      retryable: true,
      payload: {
        productId: 'product-1',
        locationId: 'location-1',
        snapshotQuantity: '2.000',
        countedQuantity: '0.000',
      },
    } as OfflineCommand;

    expect(
      offlineQuote(snapshot, [{ productId: 'product-1', quantity: '2' }], [count], now).lines[0]
        .availableQuantity,
    ).toBe('2.000');
  });

  it('rejects an offline sale after the server-defined authorization TTL', () => {
    const now = Date.parse('2026-08-29T08:00:00.000Z');
    const snapshot = posSnapshot(now);

    expect(() =>
      offlineQuote(
        snapshot,
        [{ productId: 'product-1', quantity: '1' }],
        [],
        now + snapshot.freshnessPolicy.actionTtlSeconds.CASH_SALE * 1000 + 1,
      ),
    ).toThrow('autorización offline venció');
  });
});
