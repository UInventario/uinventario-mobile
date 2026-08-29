export interface InventoryCountInput {
  productId: string;
  locationId: string;
  countedQuantity: string;
  reason: string;
  reference: string;
}

export interface InventoryTransferLine {
  id: string;
  lineNumber: number;
  product: { id: string; name: string; sku: string };
  sourceLocation: { id: string; name: string; code: string };
  destinationLocation: { id: string; name: string; code: string };
  quantity: string;
  receivedQuantity: string;
  discrepancyQuantity: string;
  pendingQuantity: string;
  serialNumbers: string[];
}

export interface InventoryTransfer {
  id: string;
  status: 'DRAFT' | 'DISPATCHED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
  reference: string;
  reason: string;
  originWarehouse: { id: string; name: string; branch: { id: string; name: string } };
  destinationWarehouse: { id: string; name: string; branch: { id: string; name: string } };
  lines: InventoryTransferLine[];
  receipts: { id: string; createdAt: string }[];
  createdBy: { id: string; email: string };
  dispatchedBy: { id: string; email: string } | null;
  createdAt: string;
  dispatchedAt: string | null;
}

export interface CreateInventoryTransferInput {
  destinationWarehouseId: string;
  reference: string;
  reason: string;
  lines: {
    productId: string;
    sourceLocationId: string;
    destinationLocationId: string;
    quantity: string;
  }[];
}

export interface ReceiveInventoryTransferInput {
  discrepancyReason?: string;
  lines: {
    transferLineId: string;
    receivedQuantity: string;
    discrepancyQuantity: string;
  }[];
}

export interface InventoryTransferResponse {
  data: InventoryTransfer;
  meta: { apiVersion: '1'; idempotentReplay?: boolean };
}

export interface InventoryTransferListResponse {
  data: InventoryTransfer[];
  meta: { apiVersion: '1' };
}

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  quantity: string;
  receivedQuantity: string;
  remainingQuantity: string;
}

export interface PurchaseOrder {
  id: string;
  folio: string;
  supplier: { id: string; name: string };
  status: 'DRAFT' | 'APPROVED' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CANCELLED';
  version: number;
  lines: PurchaseOrderLine[];
}

export interface PurchaseOrderListResponse {
  data: PurchaseOrder[];
  meta: {
    apiVersion: '1';
    pagination: { page: number; pageSize: number; total: number; totalPages: number };
  };
}

export interface ReceivePurchaseOrderInput {
  version: number;
  locationId: string;
  documentReference: string;
  overageReason?: string;
  lines: { purchaseOrderLineId: string; receivedQuantity: string }[];
}

export interface PurchaseOrderResponse {
  data: PurchaseOrder;
  meta: { apiVersion: '1'; idempotentReplay?: boolean; receiptId?: string };
}
