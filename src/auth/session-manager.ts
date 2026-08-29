import {
  AuthenticatedSession,
  BootstrapSnapshot,
  ProductDetailData,
  SessionContextInput,
} from './contracts';
import { ApiError, MobileApi } from './mobile-api';
import { CredentialsStore } from './secure-credentials';
import {
  MobileDataStore,
  MobileStorageError,
  OfflineFlushSummary,
} from '@/offline/mobile-data-store';
import {
  CashSaleInput,
  OfflineCommand,
  PaymentMethod,
  PosCartLineInput,
  PosQuote,
  SaleData,
  SaleInput,
} from '@/pos/contracts';
import {
  CreateInventoryTransferInput,
  InventoryCountInput,
  InventoryTransfer,
  PurchaseOrder,
  ReceiveInventoryTransferInput,
  ReceivePurchaseOrderInput,
} from '@/inventory/contracts';

export class SessionManager {
  private token: string | null = null;

  constructor(
    private readonly api: MobileApi,
    private readonly credentials: CredentialsStore,
    private readonly localData: MobileDataStore,
  ) {}

  async restore(): Promise<AuthenticatedSession | null> {
    const token = await this.credentials.readToken();
    if (!token) return null;

    try {
      const refreshed = await this.api.refresh(token);
      await this.credentials.saveToken(refreshed.auth.accessToken);
      this.token = refreshed.auth.accessToken;
      return await this.loadSession(refreshed);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
        const local = await this.localData.latest(await this.credentials.deviceId());
        if (local && this.offlineSessionIsValid(local)) {
          this.token = token;
          return local;
        }
      }
      if (this.requiresLocalReset(error)) {
        await this.clear();
        if (error instanceof ApiError && error.status === 401) return null;
      }
      throw error;
    }
  }

  async login(email: string, password: string): Promise<AuthenticatedSession> {
    await this.clear();
    const response = await this.api.login(email, password);
    this.token = response.auth.accessToken;
    await this.credentials.saveToken(this.token);

    try {
      return await this.loadSession(response);
    } catch (error) {
      await this.clear();
      throw error;
    }
  }

  async refresh(): Promise<AuthenticatedSession> {
    const token = this.requireToken();
    try {
      const response = await this.api.refresh(token);
      this.token = response.auth.accessToken;
      await this.credentials.saveToken(this.token);
      return await this.loadSession(response);
    } catch (error) {
      await this.clearIfSecurityFailure(error);
      throw error;
    }
  }

  async changeContext(input: SessionContextInput): Promise<AuthenticatedSession> {
    if ((await this.localData.pendingCountAll()) > 0) {
      throw new ApiError(
        409,
        'OFFLINE_COMMANDS_PENDING',
        'Sincroniza las operaciones pendientes antes de cambiar de sucursal o caja.',
      );
    }
    const token = this.requireToken();
    try {
      const response = await this.api.changeContext(token, input);
      return await this.loadSession(response);
    } catch (error) {
      await this.clearIfSecurityFailure(error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    const token = this.token ?? (await this.credentials.readToken());
    try {
      if (token) await this.api.logout(token);
    } finally {
      await this.clear();
    }
  }

  async product(id: string): Promise<ProductDetailData> {
    return this.apiRequest(async (token) => (await this.api.product(token, id)).data);
  }

  quote(lines: PosCartLineInput[]): Promise<PosQuote> {
    return this.apiRequest(async (token) => (await this.api.quote(token, lines)).data);
  }

  paymentOptions(): Promise<PaymentMethod[]> {
    return this.apiRequest(async (token) => (await this.api.paymentOptions(token)).data.methods);
  }

  cashSale(input: CashSaleInput, idempotencyKey: string): Promise<SaleData> {
    return this.apiRequest(async (token) =>
      (await this.api.cashSale(token, input, idempotencyKey)).data,
    );
  }

  sale(input: SaleInput, idempotencyKey: string): Promise<SaleData> {
    return this.apiRequest(async (token) =>
      (await this.api.sale(token, input, idempotencyKey)).data,
    );
  }

  queueCashSale(
    session: AuthenticatedSession,
    quote: PosQuote,
    input: CashSaleInput,
    idempotencyKey: string,
  ): Promise<OfflineCommand> {
    return this.localData.queueCashSale(session.bootstrap, quote, input, idempotencyKey);
  }

  offlineCommands(session: AuthenticatedSession): Promise<OfflineCommand[]> {
    return this.localData.commands(session.bootstrap.scope);
  }

  flushOffline(session: AuthenticatedSession): Promise<OfflineFlushSummary> {
    return this.apiRequest((token) =>
      this.localData.flush(session.bootstrap.scope, (commands) =>
        this.api.commands(token, commands),
      ),
    );
  }

  queueInventoryCount(
    session: AuthenticatedSession,
    input: InventoryCountInput,
    idempotencyKey: string,
  ): Promise<OfflineCommand> {
    return this.localData.queueInventoryCount(session.bootstrap, input, idempotencyKey);
  }

  inventoryTransfers(): Promise<InventoryTransfer[]> {
    return this.apiRequest(async (token) => (await this.api.inventoryTransfers(token)).data);
  }

  createInventoryTransfer(
    input: CreateInventoryTransferInput,
    idempotencyKey: string,
  ): Promise<InventoryTransfer> {
    return this.apiRequest(async (token) =>
      (await this.api.createInventoryTransfer(token, input, idempotencyKey)).data,
    );
  }

  dispatchInventoryTransfer(
    transferId: string,
    idempotencyKey: string,
  ): Promise<InventoryTransfer> {
    return this.apiRequest(async (token) =>
      (await this.api.dispatchInventoryTransfer(token, transferId, idempotencyKey)).data,
    );
  }

  receiveInventoryTransfer(
    transferId: string,
    input: ReceiveInventoryTransferInput,
    idempotencyKey: string,
  ): Promise<InventoryTransfer> {
    return this.apiRequest(async (token) =>
      (await this.api.receiveInventoryTransfer(token, transferId, input, idempotencyKey)).data,
    );
  }

  purchaseOrders(query = ''): Promise<PurchaseOrder[]> {
    return this.apiRequest(async (token) => (await this.api.purchaseOrders(token, query)).data);
  }

  receivePurchaseOrder(
    orderId: string,
    input: ReceivePurchaseOrderInput,
    idempotencyKey: string,
  ): Promise<PurchaseOrder> {
    return this.apiRequest(async (token) =>
      (await this.api.receivePurchaseOrder(token, orderId, input, idempotencyKey)).data,
    );
  }

  async clear(): Promise<void> {
    this.token = null;
    await Promise.all([this.credentials.clearToken(), this.localData.clear()]);
  }

  private async loadSession(response: {
    data: AuthenticatedSession['data'];
    meta: { sessionExpiresAt: string };
  }): Promise<AuthenticatedSession> {
    const deviceId = await this.credentials.deviceId();
    const scope: BootstrapSnapshot['scope'] = {
      tenantId: response.data.tenant.id,
      userId: response.data.user.id,
      deviceId,
      branchId: response.data.context.branch?.id ?? null,
      cashRegisterId: response.data.context.cashRegister?.id ?? null,
    };
    let bootstrap: BootstrapSnapshot;
    try {
      const stored = await this.localData.snapshot(scope);
      bootstrap = stored
        ? await this.syncStored(stored)
        : await this.freshBootstrap(deviceId, scope);
    } catch (error) {
      if (error instanceof MobileStorageError && error.code === 'CORRUPT') {
        await this.localData.recover();
        bootstrap = await this.freshBootstrap(deviceId, scope);
      } else if (error instanceof ApiError && [400, 410].includes(error.status)) {
        bootstrap = await this.freshBootstrap(deviceId, scope);
      } else {
        throw error;
      }
    }
    if (
      bootstrap.scope.tenantId !== response.data.tenant.id ||
      bootstrap.scope.userId !== response.data.user.id ||
      bootstrap.scope.deviceId !== deviceId
    ) {
      throw new ApiError(409, 'BOOTSTRAP_SCOPE_MISMATCH', 'El bootstrap no pertenece a la sesión.');
    }
    await this.localData.replace(bootstrap, {
      data: response.data,
      expiresAt: response.meta.sessionExpiresAt,
    });
    return { data: response.data, expiresAt: response.meta.sessionExpiresAt, bootstrap };
  }

  private async syncStored(stored: BootstrapSnapshot): Promise<BootstrapSnapshot> {
    let snapshot = stored;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.api.changes(
        this.requireToken(),
        snapshot.scope.deviceId,
        snapshot.initialSyncCursor,
      );
      snapshot = await this.localData.applyChanges(snapshot.scope, response.data);
      if (!response.data.hasMore) return snapshot;
    }
    throw new ApiError(502, 'INCOMPLETE_SYNC', 'No fue posible completar la sincronización.');
  }

  private async freshBootstrap(
    deviceId: string,
    expectedScope: BootstrapSnapshot['scope'],
  ): Promise<BootstrapSnapshot> {
    const bootstrap = await this.api.bootstrap(this.requireToken(), deviceId);
    if (
      bootstrap.scope.tenantId !== expectedScope.tenantId ||
      bootstrap.scope.userId !== expectedScope.userId ||
      bootstrap.scope.deviceId !== expectedScope.deviceId ||
      bootstrap.scope.branchId !== expectedScope.branchId ||
      bootstrap.scope.cashRegisterId !== expectedScope.cashRegisterId
    ) {
      throw new ApiError(409, 'BOOTSTRAP_SCOPE_MISMATCH', 'El bootstrap no pertenece a la sesión.');
    }
    return bootstrap;
  }

  private offlineSessionIsValid(session: AuthenticatedSession): boolean {
    const now = Date.now();
    const generatedAt = Date.parse(session.bootstrap.generatedAt);
    const expiresAt = Math.min(
      Date.parse(session.expiresAt),
      Date.parse(session.bootstrap.sessionExpiresAt),
    );
    const ageSeconds = (now - generatedAt) / 1000;
    return (
      Number.isFinite(ageSeconds) &&
      ageSeconds >= -session.bootstrap.freshnessPolicy.maxClockSkewSeconds &&
      ageSeconds <= session.bootstrap.freshnessPolicy.permissionsTtlSeconds &&
      Number.isFinite(expiresAt) &&
      now < expiresAt &&
      session.data.tenant.id === session.bootstrap.scope.tenantId &&
      session.data.user.id === session.bootstrap.scope.userId
    );
  }

  private requireToken(): string {
    if (!this.token) throw new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida.');
    return this.token;
  }

  private async clearIfSecurityFailure(error: unknown): Promise<void> {
    if (this.requiresLocalReset(error)) await this.clear();
  }

  private requiresLocalReset(error: unknown): boolean {
    return (
      error instanceof ApiError &&
      (error.status === 401 || error.code === 'BOOTSTRAP_SCOPE_MISMATCH')
    );
  }

  private async apiRequest<T>(request: (token: string) => Promise<T>): Promise<T> {
    try {
      return await request(this.requireToken());
    } catch (error) {
      await this.clearIfSecurityFailure(error);
      throw error;
    }
  }
}
