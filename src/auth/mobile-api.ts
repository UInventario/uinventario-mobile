import {
  BootstrapSnapshot,
  MobileSessionResponse,
  OfflineBootstrapResponse,
  ProductDetailResponse,
  SessionContextInput,
  SessionResponse,
} from './contracts';

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
  product(token: string, id: string): Promise<ProductDetailResponse>;
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
          initialSyncCursor: response.data.page.initialSyncCursor,
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

  product(token: string, id: string) {
    return this.request<ProductDetailResponse>(`/products/${encodeURIComponent(id)}`, { token });
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
