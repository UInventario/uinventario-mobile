import {
  AuthenticatedSession,
  ProductDetailData,
  SessionContextInput,
} from './contracts';
import { ApiError, MobileApi } from './mobile-api';
import { CredentialsStore } from './secure-credentials';
import { MobileDataStore, OfflineFlushSummary } from '@/offline/mobile-data-store';
import {
  CashSaleInput,
  OfflineCommand,
  PaymentMethod,
  PosCartLineInput,
  PosQuote,
  SaleData,
  SaleInput,
} from '@/pos/contracts';

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
        'Sincroniza las ventas pendientes antes de cambiar de sucursal o caja.',
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

  async clear(): Promise<void> {
    this.token = null;
    await Promise.all([this.credentials.clearToken(), this.localData.clear()]);
  }

  private async loadSession(response: {
    data: AuthenticatedSession['data'];
    meta: { sessionExpiresAt: string };
  }): Promise<AuthenticatedSession> {
    const bootstrap = await this.api.bootstrap(
      this.requireToken(),
      await this.credentials.deviceId(),
    );
    if (
      bootstrap.scope.tenantId !== response.data.tenant.id ||
      bootstrap.scope.userId !== response.data.user.id
    ) {
      throw new ApiError(409, 'BOOTSTRAP_SCOPE_MISMATCH', 'El bootstrap no pertenece a la sesión.');
    }
    await this.localData.replace(bootstrap);
    return { data: response.data, expiresAt: response.meta.sessionExpiresAt, bootstrap };
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
