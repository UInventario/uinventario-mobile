import { posSnapshot } from '@/pos/pos-test-fixture';

import {
  inventoryOptions,
  locationsFor,
  mayDispatch,
  mayReceiveTransfer,
  normalizeQuantity,
  receivableOrders,
  snapshotQuantity,
} from './inventory-model';
import { InventoryTransfer, PurchaseOrder } from './contracts';

describe('mobile inventory operations model', () => {
  it('derives only scoped locations and the captured stock snapshot', () => {
    const snapshot = posSnapshot();
    const options = inventoryOptions(snapshot);

    expect(locationsFor(options, 'warehouse-1')).toEqual([
      expect.objectContaining({ id: 'location-1', warehouseId: 'warehouse-1' }),
    ]);
    expect(snapshotQuantity(snapshot, 'product-1', 'location-1')).toBe('2.000');
    expect(snapshotQuantity(snapshot, 'product-1', 'missing')).toBe('0.000');
  });

  it('uses server states and the active warehouse for transfer actions', () => {
    const transfer = transferFixture();
    expect(mayDispatch(transfer, 'warehouse-1', ['INVENTORY_APPROVE'])).toBe(true);
    expect(mayDispatch({ ...transfer, status: 'DISPATCHED' }, 'warehouse-1', [
      'INVENTORY_APPROVE',
    ])).toBe(false);
    expect(
      mayReceiveTransfer(
        { ...transfer, status: 'DISPATCHED' },
        'warehouse-2',
        ['INVENTORY_TRANSFER'],
      ),
    ).toBe(true);
  });

  it('offers only orders that the backend state allows receiving', () => {
    const order = orderFixture();
    expect(receivableOrders([order, { ...order, id: 'draft', status: 'DRAFT' }])).toEqual([
      order,
    ]);
    expect(normalizeQuantity(' 1.250 ')).toBe('1.250');
    expect(normalizeQuantity('-1')).toBeNull();
  });
});

function transferFixture(): InventoryTransfer {
  return {
    id: 'transfer-1',
    status: 'DRAFT',
    reference: 'TR-1',
    reason: 'Reposición',
    originWarehouse: { id: 'warehouse-1', name: 'Principal', branch: { id: 'b1', name: 'Centro' } },
    destinationWarehouse: { id: 'warehouse-2', name: 'Norte', branch: { id: 'b2', name: 'Norte' } },
    lines: [
      {
        id: 'line-1',
        lineNumber: 1,
        product: { id: 'product-1', name: 'Producto', sku: 'SKU-1' },
        sourceLocation: { id: 'location-1', name: 'A', code: 'A' },
        destinationLocation: { id: 'location-2', name: 'B', code: 'B' },
        quantity: '2.000',
        receivedQuantity: '0.000',
        discrepancyQuantity: '0.000',
        pendingQuantity: '2.000',
        serialNumbers: [],
      },
    ],
    receipts: [],
    createdBy: { id: 'user-1', email: 'admin@example.com' },
    dispatchedBy: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    dispatchedAt: null,
  };
}

function orderFixture(): PurchaseOrder {
  return {
    id: 'order-1',
    folio: 'OC-1',
    supplier: { id: 'supplier-1', name: 'Proveedor' },
    status: 'SENT',
    version: 2,
    lines: [
      {
        id: 'order-line-1',
        productId: 'product-1',
        productName: 'Producto',
        productSku: 'SKU-1',
        quantity: '5.000',
        receivedQuantity: '2.000',
        remainingQuantity: '3.000',
      },
    ],
  };
}
