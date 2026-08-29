export interface SessionData {
  user: {
    id: string;
    email: string;
    roles: string[];
    permissions: string[];
  };
  tenant: { id: string; name: string };
  context: {
    branch: { id: string; name: string } | null;
    warehouse: { id: string; name: string } | null;
    cashRegister: { id: string; name: string; code: string } | null;
  };
  nextStep: 'ONBOARDING' | 'APPLICATION';
}

export interface SessionResponse {
  data: SessionData;
  meta: { apiVersion: '1'; sessionExpiresAt: string };
}

export interface MobileSessionResponse extends SessionResponse {
  auth: { tokenType: 'Bearer'; accessToken: string };
}

export interface BootstrapEntity {
  id: string;
  tenantId: string;
  kind: string;
  version: number;
  updatedAt: string;
  active?: boolean;
  name?: string;
  branchId?: string;
  warehouseId?: string;
  code?: string;
  sku?: string;
  barcode?: string | null;
  price?: string;
  categoryId?: string | null;
  brandId?: string | null;
  productId?: string;
  locationId?: string;
  availableQuantity?: string;
  currency?: string;
  customerId?: string | null;
  channel?: 'POS' | 'WEB' | 'MOBILE' | 'DESKTOP' | null;
  priority?: number;
  validFrom?: string;
  validTo?: string | null;
  items?: { productId: string; price: string }[];
}

export interface OfflineFreshnessPolicy {
  version: 1;
  maxClockSkewSeconds: number;
  catalogTtlSeconds: number;
  permissionsTtlSeconds: number;
  actionTtlSeconds: {
    CASH_SALE: number;
    INVENTORY_COUNT: number;
    INVENTORY_MOVEMENT: number;
  };
}

export interface OfflineValuationPolicy {
  method: 'MOVING_AVERAGE' | 'FIFO' | 'SPECIFIC_LOT';
  version: number;
  effectiveAt: string;
  migrationRule: 'INITIAL_DEFAULT' | 'FORWARD_ONLY_CUTOVER';
}

export interface OfflinePosPolicy {
  kind: 'POS_POLICY';
  id: string;
  tenantId: string;
  version: number;
  updatedAt: string;
  branchId: string;
  warehouseId: string;
  cashRegisterId: string;
  shiftId: string;
  shiftOpenedAt: string;
  currency: string;
  taxRate: string;
  paymentMethods: ['CASH'];
  negativeStock: 'DENY';
}

export interface ProductDetailData {
  id: string;
  name: string;
  sku: string;
  barcode: string | null;
  trackLots: boolean;
  trackSerials: boolean;
  category: { id: string; name: string } | null;
  brand: { id: string; name: string } | null;
  cost: string;
  price: string;
  active: boolean;
  version: number;
}

export interface ProductDetailResponse {
  data: ProductDetailData;
  meta: { apiVersion: '1' };
}

export interface OfflineBootstrapResponse {
  data: {
    protocolVersion: '1.0';
    generatedAt: string;
    sessionExpiresAt: string;
    freshnessPolicy: OfflineFreshnessPolicy;
    valuationPolicy: OfflineValuationPolicy;
    posPolicy: OfflinePosPolicy | null;
    scope: {
      tenantId: string;
      userId: string;
      deviceId: string;
      branchId: string | null;
      cashRegisterId: string | null;
    };
    identity: {
      tenant: { id: string; name: string };
      user: { id: string; roles: string[]; permissions: string[] };
    };
    page: {
      initialSyncCursor: string;
      cursor: string;
      nextCursor: string | null;
      complete: boolean;
      entities: BootstrapEntity[];
    };
  };
}

export interface OfflineChange {
  changeId: string;
  operation: 'UPSERT' | 'DELETE';
  occurredAt: string;
  entity: BootstrapEntity;
}

export interface OfflineChangesData {
  protocolVersion: '1.0';
  generatedAt: string;
  sessionExpiresAt: string;
  freshnessPolicy: OfflineFreshnessPolicy;
  scope: OfflineBootstrapResponse['data']['scope'];
  identity: {
    user: { id: string; roles: string[]; permissions: string[] };
  };
  cursor: string;
  nextCursor: string;
  hasMore: boolean;
  changes: OfflineChange[];
}

export interface OfflineChangesResponse {
  data: OfflineChangesData;
}

export interface BootstrapSnapshot {
  protocolVersion: '1.0';
  generatedAt: string;
  sessionExpiresAt: string;
  initialSyncCursor: string;
  freshnessPolicy: OfflineFreshnessPolicy;
  valuationPolicy: OfflineValuationPolicy;
  posPolicy: OfflinePosPolicy | null;
  scope: OfflineBootstrapResponse['data']['scope'];
  identity: OfflineBootstrapResponse['data']['identity'];
  entities: BootstrapEntity[];
}

export interface AuthenticatedSession {
  data: SessionData;
  expiresAt: string;
  bootstrap: BootstrapSnapshot;
}

export interface SessionContextInput {
  branchId: string;
  warehouseId: string;
  cashRegisterId?: string;
}
