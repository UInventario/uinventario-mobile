import { BootstrapSnapshot } from '@/auth/contracts';
import { buildCatalogView, CatalogProduct } from '@/catalog/catalog-model';

import { InventoryTransfer, PurchaseOrder } from './contracts';

export interface WarehouseOption {
  id: string;
  name: string;
  branchId: string | null;
}

export interface LocationOption {
  id: string;
  name: string;
  code: string;
  warehouseId: string;
}

export interface InventoryOptions {
  products: CatalogProduct[];
  warehouses: WarehouseOption[];
  locations: LocationOption[];
}

export function inventoryOptions(snapshot: BootstrapSnapshot): InventoryOptions {
  return {
    products: buildCatalogView(snapshot).products,
    warehouses: snapshot.entities
      .filter((entity) => entity.kind === 'WAREHOUSE' && entity.active !== false)
      .map((entity) => ({
        id: entity.id,
        name: entity.name ?? entity.id,
        branchId: entity.branchId ?? null,
      }))
      .sort(byName),
    locations: snapshot.entities
      .filter(
        (entity) =>
          entity.kind === 'LOCATION' &&
          entity.active !== false &&
          typeof entity.warehouseId === 'string',
      )
      .map((entity) => ({
        id: entity.id,
        name: entity.name ?? entity.id,
        code: entity.code ?? '',
        warehouseId: entity.warehouseId!,
      }))
      .sort(byName),
  };
}

export function locationsFor(options: InventoryOptions, warehouseId: string | undefined) {
  return options.locations.filter((location) => location.warehouseId === warehouseId);
}

export function snapshotQuantity(
  snapshot: BootstrapSnapshot,
  productId: string,
  locationId: string,
): string {
  return (
    snapshot.entities.find(
      (entity) =>
        entity.kind === 'INVENTORY_AVAILABILITY' &&
        entity.productId === productId &&
        entity.locationId === locationId,
    )?.availableQuantity ?? '0.000'
  );
}

export function mayDispatch(
  transfer: InventoryTransfer,
  warehouseId: string | undefined,
  permissions: string[],
): boolean {
  return (
    transfer.status === 'DRAFT' &&
    transfer.originWarehouse.id === warehouseId &&
    permissions.includes('INVENTORY_APPROVE')
  );
}

export function mayReceiveTransfer(
  transfer: InventoryTransfer,
  warehouseId: string | undefined,
  permissions: string[],
): boolean {
  return (
    ['DISPATCHED', 'PARTIALLY_RECEIVED'].includes(transfer.status) &&
    transfer.destinationWarehouse.id === warehouseId &&
    permissions.includes('INVENTORY_TRANSFER') &&
    transfer.lines.some((line) => Number(line.pendingQuantity) > 0)
  );
}

export function receivableOrders(orders: PurchaseOrder[]): PurchaseOrder[] {
  return orders.filter(
    (order) =>
      ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'].includes(order.status) &&
      order.lines.some((line) => Number(line.remainingQuantity) > 0),
  );
}

export function normalizeQuantity(value: string): string | null {
  const normalized = value.trim();
  return /^(0|[1-9]\d{0,11})(\.\d{1,3})?$/.test(normalized) ? normalized : null;
}

function byName<T extends { name: string }>(left: T, right: T) {
  return left.name.localeCompare(right.name, 'es');
}
