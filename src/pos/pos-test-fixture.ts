import { BootstrapSnapshot } from '@/auth/contracts';

import { PosQuote } from './contracts';

export function posSnapshot(now = Date.now()): BootstrapSnapshot {
  const generatedAt = new Date(now).toISOString();
  return {
    protocolVersion: '1.0',
    generatedAt,
    sessionExpiresAt: new Date(now + 8 * 60 * 60_000).toISOString(),
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
      effectiveAt: generatedAt,
      migrationRule: 'INITIAL_DEFAULT',
    },
    posPolicy: {
      kind: 'POS_POLICY',
      id: '00000000-0000-4000-8000-000000000010',
      tenantId: 'tenant-1',
      version: 1,
      updatedAt: generatedAt,
      branchId: 'branch-1',
      warehouseId: 'warehouse-1',
      cashRegisterId: 'cash-1',
      shiftId: 'shift-1',
      shiftOpenedAt: generatedAt,
      currency: 'MXN',
      taxRate: '0.1600',
      paymentMethods: ['CASH'],
      negativeStock: 'DENY',
    },
    scope: {
      tenantId: 'tenant-1',
      userId: 'user-1',
      deviceId: '10000000-0000-4000-8000-000000000001',
      branchId: 'branch-1',
      cashRegisterId: 'cash-1',
    },
    identity: {
      tenant: { id: 'tenant-1', name: 'Empresa' },
      user: { id: 'user-1', roles: ['ADMIN'], permissions: ['SALES_MANAGE'] },
    },
    entities: [
      entity('branch-1', 'BRANCH', { name: 'Centro' }, generatedAt),
      entity(
        'warehouse-1',
        'WAREHOUSE',
        { name: 'Principal', branchId: 'branch-1' },
        generatedAt,
      ),
      entity(
        'location-1',
        'LOCATION',
        { name: 'Mostrador', warehouseId: 'warehouse-1' },
        generatedAt,
      ),
      entity(
        'cash-1',
        'CASH_REGISTER',
        { name: 'Caja móvil', code: 'MOB', branchId: 'branch-1' },
        generatedAt,
      ),
      entity(
        'product-1',
        'PRODUCT',
        { name: 'Producto', sku: 'SKU-1', barcode: '7501', price: '116.00' },
        generatedAt,
      ),
      entity(
        'balance-1',
        'INVENTORY_AVAILABILITY',
        { productId: 'product-1', locationId: 'location-1', availableQuantity: '2.000' },
        generatedAt,
      ),
    ],
  };
}

export function posQuote(): PosQuote {
  return {
    context: {
      branch: { id: 'branch-1', name: 'Centro' },
      warehouse: { id: 'warehouse-1', name: 'Principal' },
      cashRegister: { id: 'cash-1', name: 'Caja móvil', code: 'MOB' },
    },
    currency: 'MXN',
    taxRate: '0.1600',
    lines: [
      {
        product: { id: 'product-1', name: 'Producto', sku: 'SKU-1' },
        quantity: '1.000',
        lotId: null,
        availableQuantity: '2.000',
        unitPrice: '116.00',
        priceSource: 'BASE',
        priceList: null,
        subtotal: '100.00',
        tax: '16.00',
        total: '116.00',
      },
    ],
    totals: { subtotal: '100.00', tax: '16.00', total: '116.00' },
  };
}

function entity(id: string, kind: string, fields: Record<string, unknown>, updatedAt: string) {
  return { id, kind, tenantId: 'tenant-1', version: 1, updatedAt, active: true, ...fields };
}
