import { BootstrapSnapshot, MobileSessionResponse, SessionResponse } from './contracts';
import { ApiError, MobileApi } from './mobile-api';
import { CredentialsStore } from './secure-credentials';
import { LocalDataStore, SessionManager } from './session-manager';

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
  initialSyncCursor: 'cursor',
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
});

function setup(storedToken: string | null = null) {
  const api: MobileApi = {
    login: jest.fn().mockResolvedValue(mobileSession),
    refresh: jest.fn().mockResolvedValue(mobileSession),
    current: jest.fn().mockResolvedValue(mobileSession),
    changeContext: jest.fn().mockResolvedValue(mobileSession),
    logout: jest.fn().mockResolvedValue(undefined),
    bootstrap: jest.fn().mockResolvedValue(bootstrap),
  };
  const credentials: CredentialsStore = {
    readToken: jest.fn().mockResolvedValue(storedToken),
    saveToken: jest.fn().mockResolvedValue(undefined),
    clearToken: jest.fn().mockResolvedValue(undefined),
    deviceId: jest.fn().mockResolvedValue('device-1'),
  };
  const localData: LocalDataStore = {
    replace: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  };
  return {
    manager: new SessionManager(api, credentials, localData),
    api,
    credentials,
    localData,
  };
}
