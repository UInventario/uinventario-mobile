import { BootstrapSnapshot } from '@/auth/contracts';

import {
  buildCatalogView,
  canReadProductCost,
  filterProducts,
  findProductByCode,
  isCatalogStale,
  stockForProduct,
} from './catalog-model';

const snapshot: BootstrapSnapshot = {
  protocolVersion: '1.0',
  generatedAt: '2026-08-28T12:00:00.000Z',
  sessionExpiresAt: '2026-08-29T20:00:00.000Z',
  initialSyncCursor: 'cursor',
  freshnessPolicy: {
    version: 1,
    maxClockSkewSeconds: 300,
    catalogTtlSeconds: 86400,
    permissionsTtlSeconds: 3600,
    actionTtlSeconds: { CASH_SALE: 900, INVENTORY_COUNT: 14400, INVENTORY_MOVEMENT: 3600 },
  },
  valuationPolicy: {
    method: 'MOVING_AVERAGE',
    version: 1,
    effectiveAt: '2026-08-28T12:00:00.000Z',
    migrationRule: 'INITIAL_DEFAULT',
  },
  posPolicy: null,
  scope: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    deviceId: 'device-1',
    branchId: 'branch-1',
    cashRegisterId: null,
  },
  identity: {
    tenant: { id: 'tenant-1', name: 'Empresa' },
    user: { id: 'user-1', roles: [], permissions: ['INVENTORY_VIEW'] },
  },
  entities: [
    entity('warehouse-1', 'WAREHOUSE', { name: 'Principal', branchId: 'branch-1' }),
    entity('location-1', 'LOCATION', {
      name: 'Mostrador',
      code: 'MOS',
      warehouseId: 'warehouse-1',
    }),
    entity('location-2', 'LOCATION', {
      name: 'Reserva',
      code: 'RES',
      warehouseId: 'warehouse-1',
    }),
    entity('category-1', 'CATEGORY', { name: 'Bebidas' }),
    entity('product-1', 'PRODUCT', {
      name: 'Café molido',
      sku: 'CAF-001',
      barcode: '750100000001',
      price: '125.00',
      categoryId: 'category-1',
      cost: 'SHOULD_NOT_LEAK',
    }),
    entity('balance-1', 'INVENTORY_AVAILABILITY', {
      productId: 'product-1',
      locationId: 'location-1',
      availableQuantity: '4.000',
    }),
    { ...entity('foreign-product', 'PRODUCT', { name: 'Ajeno', sku: 'OTHER', price: '1' }), tenantId: 'tenant-2' },
  ],
};

describe('mobile catalog model', () => {
  it('searches name/SKU/barcode and resolves an exact scanned code', () => {
    const view = buildCatalogView(snapshot);

    expect(filterProducts(view.products, 'cafe')).toHaveLength(1);
    expect(filterProducts(view.products, 'CAF-001')).toHaveLength(1);
    expect(findProductByCode(view.products, '750100000001')?.id).toBe('product-1');
    expect(stockForProduct(view, 'product-1')).toEqual([
      expect.objectContaining({ locationName: 'Mostrador', availableQuantity: '4.000' }),
      expect.objectContaining({ locationName: 'Reserva', availableQuantity: '0.000' }),
    ]);
  });

  it('drops injected entities from another tenant and never projects cost from bootstrap', () => {
    const view = buildCatalogView(snapshot);

    expect(view.products.map(({ id }) => id)).toEqual(['product-1']);
    expect(view.products[0]).not.toHaveProperty('cost');
    expect(canReadProductCost(['INVENTORY_VIEW'])).toBe(false);
    expect(canReadProductCost(['PRODUCTS_MANAGE'])).toBe(true);
  });

  it('marks snapshots older than the catalog TTL as stale', () => {
    expect(isCatalogStale(snapshot.generatedAt, Date.parse('2026-08-29T11:59:59.000Z'))).toBe(false);
    expect(isCatalogStale(snapshot.generatedAt, Date.parse('2026-08-29T12:00:01.000Z'))).toBe(true);
  });
});

function entity(id: string, kind: string, fields: Record<string, unknown>) {
  return {
    id,
    kind,
    tenantId: 'tenant-1',
    version: 1,
    updatedAt: '2026-08-28T12:00:00.000Z',
    active: true,
    ...fields,
  };
}
