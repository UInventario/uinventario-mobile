import { BootstrapSnapshot, MobileSessionResponse, SessionResponse } from './contracts';
import { ApiError, MobileApi } from './mobile-api';
import { CredentialsStore } from './secure-credentials';
import { SessionManager } from './session-manager';
import { MobileDataStore } from '@/offline/mobile-data-store';

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
});

function setup(storedToken: string | null = null) {
  const api: MobileApi = {
    login: jest.fn().mockResolvedValue(mobileSession),
    refresh: jest.fn().mockResolvedValue(mobileSession),
    current: jest.fn().mockResolvedValue(mobileSession),
    changeContext: jest.fn().mockResolvedValue(mobileSession),
    logout: jest.fn().mockResolvedValue(undefined),
    bootstrap: jest.fn().mockResolvedValue(bootstrap),
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
