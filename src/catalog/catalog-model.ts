import { BootstrapEntity, BootstrapSnapshot } from '@/auth/contracts';

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export interface CatalogProduct {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  price: string;
  categoryName: string | null;
  brandName: string | null;
  updatedAt: string;
}

export interface LocationStock {
  locationId: string;
  locationName: string;
  locationCode: string;
  warehouseName: string;
  availableQuantity: string;
  updatedAt: string;
}

export interface CatalogSnapshotView {
  products: CatalogProduct[];
  locations: LocationStock[];
  stockByProduct: Map<string, LocationStock[]>;
}

export function buildCatalogView(snapshot: BootstrapSnapshot): CatalogSnapshotView {
  const scoped = snapshot.entities.filter(
    (entity) => entity.tenantId === snapshot.scope.tenantId,
  );
  const byId = new Map(scoped.map((entity) => [entity.id, entity]));
  const products = scoped
    .filter((entity) => entity.kind === 'PRODUCT' && entity.active !== false)
    .map((entity) => productFrom(entity, byId))
    .filter((product): product is CatalogProduct => product !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
  const productIds = new Set(products.map(({ id }) => id));
  const stockByProduct = new Map<string, LocationStock[]>();
  const locations = scoped
    .filter((entity) => entity.kind === 'LOCATION' && entity.active !== false)
    .map((location) => {
      const warehouse = location.warehouseId ? byId.get(location.warehouseId) : null;
      if (!warehouse || warehouse.kind !== 'WAREHOUSE') return null;
      return {
        locationId: location.id,
        locationName: location.name ?? 'Ubicación',
        locationCode: location.code ?? '—',
        warehouseName: warehouse.name ?? 'Bodega',
        availableQuantity: '0.000',
        updatedAt: location.updatedAt,
      };
    })
    .filter((location): location is LocationStock => location !== null)
    .sort((left, right) => left.locationName.localeCompare(right.locationName));

  for (const entity of scoped) {
    if (
      entity.kind !== 'INVENTORY_AVAILABILITY' ||
      !entity.productId ||
      !entity.locationId ||
      !productIds.has(entity.productId)
    ) {
      continue;
    }
    const location = byId.get(entity.locationId);
    if (!location || location.kind !== 'LOCATION' || !location.warehouseId) continue;
    const warehouse = byId.get(location.warehouseId);
    if (!warehouse || warehouse.kind !== 'WAREHOUSE') continue;
    const rows = stockByProduct.get(entity.productId) ?? [];
    rows.push({
      locationId: location.id,
      locationName: location.name ?? 'Ubicación',
      locationCode: location.code ?? '—',
      warehouseName: warehouse.name ?? 'Bodega',
      availableQuantity: entity.availableQuantity ?? '0.000',
      updatedAt: entity.updatedAt,
    });
    stockByProduct.set(entity.productId, rows);
  }
  for (const rows of stockByProduct.values()) {
    rows.sort((left, right) => left.locationName.localeCompare(right.locationName));
  }
  return { products, locations, stockByProduct };
}

export function stockForProduct(
  view: CatalogSnapshotView,
  productId: string,
): LocationStock[] {
  const balances = new Map(
    (view.stockByProduct.get(productId) ?? []).map((row) => [row.locationId, row]),
  );
  return view.locations.map((location) => balances.get(location.locationId) ?? location);
}

export function filterProducts(products: CatalogProduct[], query: string): CatalogProduct[] {
  const term = normalize(query);
  if (!term) return products;
  return products.filter((product) =>
    [product.name, product.sku, product.barcode ?? ''].some((value) =>
      normalize(value).includes(term),
    ),
  );
}

export function findProductByCode(
  products: CatalogProduct[],
  rawCode: string,
): CatalogProduct | null {
  const code = normalize(rawCode);
  if (!code) return null;
  return (
    products.find(
      (product) => normalize(product.sku) === code || normalize(product.barcode ?? '') === code,
    ) ?? null
  );
}

export function canReadProductCost(permissions: string[]): boolean {
  return permissions.some((permission) =>
    ['PRODUCTS_MANAGE', 'INVENTORY_VALUATION_MANAGE'].includes(permission),
  );
}

export function isCatalogStale(generatedAt: string, now = Date.now()): boolean {
  const generated = Date.parse(generatedAt);
  return !Number.isFinite(generated) || now - generated > CATALOG_TTL_MS;
}

function productFrom(
  entity: BootstrapEntity,
  byId: Map<string, BootstrapEntity>,
): CatalogProduct | null {
  if (!entity.name || !entity.sku || !entity.price) return null;
  return {
    id: entity.id,
    name: entity.name,
    sku: entity.sku,
    barcode: entity.barcode ?? null,
    price: entity.price,
    categoryName: entity.categoryId ? byId.get(entity.categoryId)?.name ?? null : null,
    brandName: entity.brandId ? byId.get(entity.brandId)?.name ?? null : null,
    updatedAt: entity.updatedAt,
  };
}

function normalize(value: string): string {
  return value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}
