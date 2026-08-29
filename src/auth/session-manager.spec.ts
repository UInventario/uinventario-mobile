import { BootstrapSnapshot, MobileSessionResponse, SessionResponse } from './contracts';
import { ApiError, MobileApi } from './mobile-api';
import { CredentialsStore } from './secure-credentials';
import { SessionManager } from './session-manager';
import { MobileDataStore, MobileStorageError } from '@/offline/mobile-data-store';

const sessionData: SessionResponse['data'] = {
  user: {
    id: 'user-1',
    email: 'admin@example.com',
    roles: ['ADMIN'],
    permissions: ['PRODUCTS_VIEW'],
  },
  tenant: { id: 'tenant-1', name: 'Empresa Uno' },
  context: {
    branch: { id: 'branch-1', name: 'Centro' },
    warehouse: { id: 'warehouse-1', name: 'Principal' },
    cashRegister: { id: 'cash-1', name: 'Caja 1', code: 'C01' },
  },
  nextStep: 'APPLICATION',
};

const mobileSession: MobileSessionResponse = {
  data: sessionData,
  meta: { apiVersion: '1', sessionExpiresAt: '2026-08-29T00:00:00.000Z' },
  auth: { tokenType: 'Bearer', accessToken: 'mobile-token' },
};

const bootstrap: BootstrapSnapshot = {
  protocolVersion: '1.0',
  generatedAt: '2026-08-28T00:00:00.000Z',
  sessionExpiresAt: '2026-08-29T00:00:00.000Z',
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
    effectiveAt: '2026-08-28T00:00:00.000Z',
    migrationRule: 'INITIAL_DEFAULT',
  },
  posPolicy: null,
  scope: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    deviceId: 'device-1',
    branchId: 'branch-1',
    cashRegisterId: 'cash-1',
  },
  identity: {
    tenant: { id: 'tenant-1', name: 'Empresa Uno' },
    user: { id: 'user-1', roles: ['ADMIN'], permissions: ['PRODUCTS_VIEW'] },
  },
  entities: [],
};

describe('SessionManager', () => {
  it('replaces prior account data and stores only the issued token', async () => {
    const { manager, api, credentials, localData } = setup();

    const result = await manager.login('admin@example.com', 'Password-2026!');

    expect(jest.mocked(localData.clear).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(localData.replace).mock.invocationCallOrder[0],
    );
    expect(jest.mocked(credentials.clearToken).mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(credentials.saveToken).mock.invocationCallOrder[0],
    );
    expect(credentials.saveToken).toHaveBeenCalledWith('mobile-token');
    expect(credentials.saveToken).not.toHaveBeenCalledWith('Password-2026!');
    expect(api.bootstrap).toHaveBeenCalledWith('mobile-token', 'device-1');
    expect(result.bootstrap.scope.tenantId).toBe('tenant-1');
  });

  it('clears credentials and local data when the stored session was revoked', async () => {
    const { manager, api, credentials, localData } = setup('revoked-token');
    jest.mocked(api.refresh).mockRejectedValueOnce(
      new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida.'),
    );

    await expect(manager.restore()).resolves.toBeNull();

    expect(credentials.clearToken).toHaveBeenCalledTimes(1);
    expect(localData.clear).toHaveBeenCalledTimes(1);
    expect(api.bootstrap).not.toHaveBeenCalled();
  });

  it('rejects and removes a bootstrap from another tenant or user', async () => {
    const { manager, api, credentials, localData } = setup('stored-token');
    jest.mocked(api.bootstrap).mockResolvedValueOnce({
      ...bootstrap,
      scope: { ...bootstrap.scope, tenantId: 'tenant-other' },
    });

    await expect(manager.restore()).rejects.toMatchObject({
      code: 'BOOTSTRAP_SCOPE_MISMATCH',
    });

    expect(credentials.clearToken).toHaveBeenCalledTimes(1);
    expect(localData.clear).toHaveBeenCalledTimes(1);
    expect(localData.replace).not.toHaveBeenCalled();
  });

  it('blocks a cash-register context change while an offline sale is pending', async () => {
    const { manager, api, localData } = setup('stored-token');
    jest.mocked(localData.pendingCountAll).mockResolvedValueOnce(1);

    await expect(
      manager.changeContext({ branchId: 'branch-2', warehouseId: 'warehouse-2' }),
    ).rejects.toMatchObject({ code: 'OFFLINE_COMMANDS_PENDING' });

    expect(api.changeContext).not.toHaveBeenCalled();
  });

  it('continues from the durable cursor after an application restart', async () => {
    const { manager, api, localData } = setup('stored-token');
    jest.mocked(localData.snapshot).mockResolvedValueOnce(bootstrap);
    const synchronized = { ...bootstrap, initialSyncCursor: 'cursor-next' };
    jest.mocked(api.changes).mockResolvedValueOnce({
      data: changesData({ nextCursor: 'cursor-next' }),
    });
    jest.mocked(localData.applyChanges).mockResolvedValueOnce(synchronized);

    await expect(manager.restore()).resolves.toMatchObject({
      bootstrap: { initialSyncCursor: 'cursor-next' },
    });

    expect(api.changes).toHaveBeenCalledWith('mobile-token', 'device-1', 'cursor');
    expect(api.bootstrap).not.toHaveBeenCalled();
  });

  it('downloads a new bootstrap when the durable cursor expired', async () => {
    const { manager, api, localData } = setup('stored-token');
    jest.mocked(localData.snapshot).mockResolvedValueOnce(bootstrap);
    jest.mocked(api.changes).mockRejectedValueOnce(
      new ApiError(410, 'OFFLINE_SYNC_CURSOR_EXPIRED', 'El cursor venció.'),
    );

    await expect(manager.restore()).resolves.toMatchObject({
      bootstrap: { initialSyncCursor: 'cursor' },
    });

    expect(api.bootstrap).toHaveBeenCalledWith('mobile-token', 'device-1');
    expect(localData.replace).toHaveBeenCalledWith(bootstrap, {
      data: sessionData,
      expiresAt: mobileSession.meta.sessionExpiresAt,
    });
  });

  it('recovers a damaged local database before rebuilding the bootstrap', async () => {
    const { manager, localData } = setup('stored-token');
    jest
      .mocked(localData.snapshot)
      .mockRejectedValueOnce(new MobileStorageError('CORRUPT', 'Base dañada'));

    await expect(manager.restore()).resolves.toBeTruthy();

    expect(localData.recover).toHaveBeenCalledTimes(1);
    expect(localData.replace).toHaveBeenCalledWith(bootstrap, {
      data: sessionData,
      expiresAt: mobileSession.meta.sessionExpiresAt,
    });
  });

  it('restores a still-authorized local session when the app restarts offline', async () => {
    const { manager, api, localData } = setup('stored-token');
    const now = Date.now();
    const localSession = {
      data: sessionData,
      expiresAt: new Date(now + 60 * 60_000).toISOString(),
      bootstrap: {
        ...bootstrap,
        generatedAt: new Date(now - 60_000).toISOString(),
        sessionExpiresAt: new Date(now + 60 * 60_000).toISOString(),
      },
    };
    jest.mocked(api.refresh).mockRejectedValueOnce(
      new ApiError(0, 'NETWORK_ERROR', 'Sin conexión'),
    );
    jest.mocked(localData.latest).mockResolvedValueOnce(localSession);

    await expect(manager.restore()).resolves.toEqual(localSession);

    expect(localData.latest).toHaveBeenCalledWith('device-1');
    expect(api.bootstrap).not.toHaveBeenCalled();
  });
});

function setup(storedToken: string | null = null) {
  const api: MobileApi = {
    login: jest.fn().mockResolvedValue(mobileSession),
    refresh: jest.fn().mockResolvedValue(mobileSession),
    current: jest.fn().mockResolvedValue(mobileSession),
    changeContext: jest.fn().mockResolvedValue(mobileSession),
    logout: jest.fn().mockResolvedValue(undefined),
    bootstrap: jest.fn().mockResolvedValue(bootstrap),
    changes: jest.fn(),
    product: jest.fn().mockResolvedValue({ data: {}, meta: { apiVersion: '1' } }),
    quote: jest.fn(),
    paymentOptions: jest.fn(),
    cashSale: jest.fn(),
    sale: jest.fn(),
    commands: jest.fn(),
  };
  const credentials: CredentialsStore = {
    readToken: jest.fn().mockResolvedValue(storedToken),
    saveToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
    deviceId: jest.fn().mockResolvedValue('device-1'),
  };
  const localData: MobileDataStore = {
    replace: jest.fn().mockResolvedValue(undefined),
    snapshot: jest.fn().mockResolvedValue(null),
    latest: jest.fn().mockResolvedValue(null),
    applyChanges: jest.fn(),
    recover: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
    queueCashSale: jest.fn(),
    commands: jest.fn().mockResolvedValue([]),
    pendingCount: jest.fn().mockResolvedValue(0),
    pendingCountAll: jest.fn().mockResolvedValue(0),
    flush: jest.fn(),
  };
  return {
    manager: new SessionManager(api, credentials, localData),
    api,
    credentials,
    localData,
  };
}

function changesData(overrides: Partial<Awaited<ReturnType<MobileApi['changes']>>['data']> = {}) {
  return {
    protocolVersion: '1.0' as const,
    generatedAt: '2026-08-28T00:01:00.000Z',
    sessionExpiresAt: '2026-08-29T00:00:00.000Z',
    freshnessPolicy: bootstrap.freshnessPolicy,
    scope: bootstrap.scope,
    identity: { user: bootstrap.identity.user },
    cursor: 'cursor',
    nextCursor: 'cursor-next',
    hasMore: false,
    changes: [],
    ...overrides,
  };
}
