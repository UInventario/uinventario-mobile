import {
  BootstrapSnapshot,
  MobileSessionResponse,
  OfflineBootstrapResponse,
  OfflineChangesResponse,
  ProductDetailResponse,
  SessionContextInput,
  SessionResponse,
} from './contracts';
import {
  CashSaleInput,
  OfflineCommand,
  OfflineCommandBatchResponse,
  PaymentMethod,
  PosCartLineInput,
  PosQuoteResponse,
  SaleInput,
  SaleResponse,
} from '@/pos/contracts';
import {
  CreateInventoryTransferInput,
  InventoryTransferListResponse,
  InventoryTransferResponse,
  PurchaseOrderListResponse,
  PurchaseOrderResponse,
  ReceiveInventoryTransferInput,
  ReceivePurchaseOrderInput,
} from '@/inventory/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface MobileApi {
  login(email: string, password: string): Promise<MobileSessionResponse>;
  refresh(token: string): Promise<MobileSessionResponse>;
  current(token: string): Promise<SessionResponse>;
  changeContext(token: string, input: SessionContextInput): Promise<SessionResponse>;
  logout(token: string): Promise<void>;
  bootstrap(token: string, deviceId: string): Promise<BootstrapSnapshot>;
  changes(token: string, deviceId: string, cursor: string): Promise<OfflineChangesResponse>;
  product(token: string, id: string): Promise<ProductDetailResponse>;
  quote(token: string, lines: PosCartLineInput[]): Promise<PosQuoteResponse>;
  paymentOptions(token: string): Promise<{ data: { methods: PaymentMethod[] } }>;
  cashSale(
    token: string,
    input: CashSaleInput,
    idempotencyKey: string,
  ): Promise<SaleResponse>;
  sale(token: string, input: SaleInput, idempotencyKey: string): Promise<SaleResponse>;
  commands(token: string, commands: OfflineCommand[]): Promise<OfflineCommandBatchResponse>;
  inventoryTransfers(token: string): Promise<InventoryTransferListResponse>;
  createInventoryTransfer(
    token: string,
    input: CreateInventoryTransferInput,
    idempotencyKey: string,
  ): Promise<InventoryTransferResponse>;
  dispatchInventoryTransfer(
    token: string,
    transferId: string,
    idempotencyKey: string,
  ): Promise<InventoryTransferResponse>;
  receiveInventoryTransfer(
    token: string,
    transferId: string,
    input: ReceiveInventoryTransferInput,
    idempotencyKey: string,
  ): Promise<InventoryTransferResponse>;
  purchaseOrders(token: string, query?: string): Promise<PurchaseOrderListResponse>;
  receivePurchaseOrder(
    token: string,
    orderId: string,
    input: ReceivePurchaseOrderInput,
    idempotencyKey: string,
  ): Promise<PurchaseOrderResponse>;
}

export class HttpMobileApi implements MobileApi {
  constructor(private readonly baseUrl: string) {}

  login(email: string, password: string) {
    return this.request<MobileSessionResponse>('/auth/mobile/sessions', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  refresh(token: string) {
    return this.request<MobileSessionResponse>('/auth/mobile/sessions/refresh', {
      method: 'POST',
      token,
    });
  }

  current(token: string) {
    return this.request<SessionResponse>('/auth/sessions/current', { token });
  }

  changeContext(token: string, input: SessionContextInput) {
    return this.request<SessionResponse>('/auth/sessions/current/context', {
      method: 'PATCH',
      token,
      body: JSON.stringify(input),
    });
  }

  async logout(token: string): Promise<void> {
    await this.request<void>('/auth/sessions/current', {
      method: 'DELETE',
      token,
    });
  }

  async bootstrap(token: string, deviceId: string): Promise<BootstrapSnapshot> {
    let cursor: string | null = null;
    const entities: BootstrapSnapshot['entities'] = [];

    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams({
        protocolVersion: '1.0',
        deviceId,
        pageSize: '500',
      });
      if (cursor) query.set('cursor', cursor);

      const response = await this.request<OfflineBootstrapResponse>(
        `/offline/bootstrap?${query.toString()}`,
        { token },
      );
      entities.push(...response.data.page.entities);

      if (response.data.page.complete) {
        return {
          protocolVersion: response.data.protocolVersion,
          generatedAt: response.data.generatedAt,
          sessionExpiresAt: response.data.sessionExpiresAt,
          initialSyncCursor: response.data.page.initialSyncCursor,
          freshnessPolicy: response.data.freshnessPolicy,
          valuationPolicy: response.data.valuationPolicy,
          posPolicy: response.data.posPolicy,
          scope: response.data.scope,
          identity: response.data.identity,
          entities,
        };
      }
      if (!response.data.page.nextCursor || response.data.page.nextCursor === cursor) break;
      cursor = response.data.page.nextCursor;
    }

    throw new ApiError(502, 'INCOMPLETE_BOOTSTRAP', 'No fue posible completar el bootstrap.');
  }

  changes(token: string, deviceId: string, cursor: string) {
    const query = new URLSearchParams({
      protocolVersion: '1.0',
      deviceId,
      cursor,
      pageSize: '500',
    });
    return this.request<OfflineChangesResponse>(`/offline/changes?${query.toString()}`, { token });
  }

  product(token: string, id: string) {
    return this.request<ProductDetailResponse>(`/products/${encodeURIComponent(id)}`, { token });
  }

  quote(token: string, lines: PosCartLineInput[]) {
    return this.request<PosQuoteResponse>('/pos/cart/quote', {
      method: 'POST',
      token,
      body: JSON.stringify({ lines, channel: 'MOBILE' }),
    });
  }

  paymentOptions(token: string) {
    return this.request<{ data: { methods: PaymentMethod[] } }>('/pos/payment-options', { token });
  }

  cashSale(token: string, input: CashSaleInput, idempotencyKey: string) {
    return this.request<SaleResponse>('/pos/sales/cash', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ ...input, channel: 'MOBILE' }),
    });
  }

  sale(token: string, input: SaleInput, idempotencyKey: string) {
    return this.request<SaleResponse>('/pos/sales', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify({ ...input, channel: 'MOBILE' }),
    });
  }

  commands(token: string, commands: OfflineCommand[]) {
    return this.request<OfflineCommandBatchResponse>('/offline/commands/batch', {
      method: 'POST',
      token,
      body: JSON.stringify({ commands: commands.map(commandEnvelope) }),
    });
  }

  inventoryTransfers(token: string) {
    return this.request<InventoryTransferListResponse>('/inventory/transfers', { token });
  }

  createInventoryTransfer(
    token: string,
    input: CreateInventoryTransferInput,
    idempotencyKey: string,
  ) {
    return this.request<InventoryTransferResponse>('/inventory/transfers', {
      method: 'POST',
      token,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    });
  }

  dispatchInventoryTransfer(token: string, transferId: string, idempotencyKey: string) {
    return this.request<InventoryTransferResponse>(
      `/inventory/transfers/${encodeURIComponent(transferId)}/dispatch`,
      {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    );
  }

  receiveInventoryTransfer(
    token: string,
    transferId: string,
    input: ReceiveInventoryTransferInput,
    idempotencyKey: string,
  ) {
    return this.request<InventoryTransferResponse>(
      `/inventory/transfers/${encodeURIComponent(transferId)}/receipts`,
      {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
  }

  purchaseOrders(token: string, query = '') {
    const parameters = new URLSearchParams({ page: '1', pageSize: '100' });
    if (query.trim()) parameters.set('q', query.trim());
    return this.request<PurchaseOrderListResponse>(`/purchase-orders?${parameters.toString()}`, {
      token,
    });
  }

  receivePurchaseOrder(
    token: string,
    orderId: string,
    input: ReceivePurchaseOrderInput,
    idempotencyKey: string,
  ) {
    return this.request<PurchaseOrderResponse>(
      `/purchase-orders/${encodeURIComponent(orderId)}/receipts`,
      {
        method: 'POST',
        token,
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input),
      },
    );
  }

  private async request<T>(
    path: string,
    options: RequestInit & { token?: string } = {},
  ): Promise<T> {
    const { token, ...requestOptions } = options;
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (options.body) headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, { ...requestOptions, headers });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'No fue posible conectar con UInventario.');
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const body = error as { code?: string; message?: string };
      throw new ApiError(
        response.status,
        body.code ?? 'API_ERROR',
        body.message ?? 'La operación no pudo completarse.',
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

function commandEnvelope(command: OfflineCommand) {
  const { status: _status, attempts: _attempts, retryable: _retryable, result: _result, error: _error, ...envelope } = command;
  return envelope;
}
