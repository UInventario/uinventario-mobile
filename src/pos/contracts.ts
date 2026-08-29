import type { BootstrapSnapshot } from '@/auth/contracts';

export interface PosCartLineInput {
  productId: string;
  quantity: string;
}

export interface PosQuote {
  context: {
    branch: { id: string; name: string };
    warehouse: { id: string; name: string };
    cashRegister: { id: string; name: string; code: string };
  };
  currency: string;
  taxRate: string;
  lines: {
    product: { id: string; name: string; sku: string };
    quantity: string;
    lotId: string | null;
    serialNumbers?: string[];
    availableQuantity: string;
    unitPrice: string;
    priceSource: 'BASE' | 'PRICE_LIST';
    priceList: { id: string; name: string } | null;
    subtotal: string;
    tax: string;
    total: string;
  }[];
  totals: { subtotal: string; tax: string; total: string };
}

export interface PosQuoteResponse {
  data: PosQuote;
  meta: { apiVersion: '1'; recalculatedAt: string };
}

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'VOUCHER';

export interface SaleInput {
  lines: PosCartLineInput[];
  payment: {
    method: PaymentMethod;
    amount?: string;
    amountReceived?: string;
    reference?: string;
  };
}

export interface CashSaleInput {
  lines: PosCartLineInput[];
  cashReceived: string;
}

export interface SaleData {
  id: string;
  receiptNumber: string;
  status: 'COMPLETED' | 'VOIDED';
  context: PosQuote['context'];
  currency: string;
  totals: PosQuote['totals'];
  payments: {
    method: PaymentMethod;
    amountReceived: string;
    amountApplied: string;
    change: string;
    reference: string | null;
  }[];
  createdAt: string;
}

export interface SaleResponse {
  data: SaleData;
  meta: { apiVersion: '1'; idempotentReplay: boolean };
}

export interface OfflineCashSalePayload extends CashSaleInput {
  channel: 'MOBILE';
  snapshot: {
    capturedAt: string;
    branchId: string;
    warehouseId: string;
    cashRegisterId: string;
    currency: string;
    taxRate: string;
    paymentMethod: 'CASH';
    negativeStock: 'DENY';
    lines: {
      productId: string;
      name: string;
      sku: string;
      quantity: string;
      unitPrice: string;
      subtotal: string;
      tax: string;
      total: string;
    }[];
    totals: PosQuote['totals'];
  };
}

export interface OfflineCommand {
  protocolVersion: '1.0';
  commandId: string;
  idempotencyKey: string;
  scope: BootstrapSnapshot['scope'];
  sequence: number;
  createdAt: string;
  valuationMethod: BootstrapSnapshot['valuationPolicy']['method'];
  valuationPolicyVersion: number;
  kind: 'CASH_SALE';
  payload: OfflineCashSalePayload;
  status: 'PENDING' | 'SENT' | 'CONFIRMED' | 'ERROR';
  attempts: number;
  retryable: boolean;
  result: unknown | null;
  error: unknown | null;
}

export interface OfflineCommandResult {
  commandId: string;
  sequence: number;
  status: 'CONFIRMED' | 'ERROR';
  replay: boolean;
  result?: unknown;
  error?: unknown;
}

export interface OfflineCommandBatchResponse {
  data: { results: OfflineCommandResult[] };
  meta: { apiVersion: '1' };
}
