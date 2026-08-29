import { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from 'react';

import { appEnvironment } from '@/config/environment';

import { AuthenticatedSession, ProductDetailData, SessionContextInput } from './contracts';
import { ApiError, HttpMobileApi } from './mobile-api';
import { SecureCredentialsStore } from './secure-credentials';
import { MemoryLocalDataStore, SessionManager } from './session-manager';

type SessionStatus = 'booting' | 'anonymous' | 'authenticated';

interface SessionContextValue {
  status: SessionStatus;
  busy: boolean;
  session: AuthenticatedSession | null;
  error: string | null;
  login(email: string, password: string): Promise<void>;
  refresh(): Promise<void>;
  changeContext(input: SessionContextInput): Promise<void>;
  logout(): Promise<void>;
  product(id: string): Promise<ProductDetailData>;
  clearError(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const manager = useMemo(
    () =>
      new SessionManager(
        new HttpMobileApi(appEnvironment.apiBaseUrl),
        new SecureCredentialsStore(),
        new MemoryLocalDataStore(),
      ),
    [],
  );
  const [status, setStatus] = useState<SessionStatus>('booting');
  const [session, setSession] = useState<AuthenticatedSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const startup = setTimeout(() => {
      void manager
        .restore()
        .then((restored) => {
          if (!active) return;
          setSession(restored);
          setStatus(restored ? 'authenticated' : 'anonymous');
        })
        .catch((cause: unknown) => {
          if (!active) return;
          setError(messageFor(cause));
          setStatus('anonymous');
        });
    }, 0);
    return () => {
      active = false;
      clearTimeout(startup);
    };
  }, [manager]);

  async function login(email: string, password: string) {
    await run(async () => {
      const authenticated = await manager.login(email, password);
      setSession(authenticated);
      setStatus('authenticated');
    });
  }

  async function refresh() {
    await run(async () => setSession(await manager.refresh()));
  }

  async function changeContext(input: SessionContextInput) {
    await run(async () => setSession(await manager.changeContext(input)));
  }

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await manager.logout();
    } finally {
      setSession(null);
      setStatus('anonymous');
      setBusy(false);
    }
  }

  async function product(id: string): Promise<ProductDetailData> {
    setBusy(true);
    setError(null);
    try {
      return await manager.product(id);
    } catch (cause) {
      setError(messageFor(cause));
      if (
        cause instanceof ApiError &&
        (cause.status === 401 || cause.code === 'BOOTSTRAP_SCOPE_MISMATCH')
      ) {
        setSession(null);
        setStatus('anonymous');
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(messageFor(cause));
      if (
        cause instanceof ApiError &&
        (cause.status === 401 || cause.code === 'BOOTSTRAP_SCOPE_MISMATCH')
      ) {
        setSession(null);
        setStatus('anonymous');
      }
      throw cause;
    } finally {
      setBusy(false);
    }
  }

  return (
    <SessionContext.Provider
      value={{
        status,
        busy,
        session,
        error,
        login,
        refresh,
        changeContext,
        logout,
        product,
        clearError: () => setError(null),
      }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider.');
  return context;
}

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'La operación no pudo completarse.';
}
