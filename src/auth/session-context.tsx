import { PropsWithChildren, createContext, useContext, useEffect, useMemo, useState } from 'react';

import { appEnvironment } from '@/config/environment';

import { AuthenticatedSession, ProductDetailData, SessionContextInput } from './contracts';
import { ApiError, HttpMobileApi } from './mobile-api';
import { SecureCredentialsStore } from './secure-credentials';
import { SessionManager } from './session-manager';
import { SqliteMobileDataStore, type OfflineFlushSummary } from '@/offline/mobile-data-store';
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
  quote(lines: PosCartLineInput[]): Promise<PosQuote>;
  paymentOptions(): Promise<PaymentMethod[]>;
  cashSale(input: CashSaleInput, idempotencyKey: string): Promise<SaleData>;
  sale(input: SaleInput, idempotencyKey: string): Promise<SaleData>;
  queueCashSale(quote: PosQuote, input: CashSaleInput, idempotencyKey: string): Promise<OfflineCommand>;
  offlineCommands(): Promise<OfflineCommand[]>;
  flushOffline(): Promise<OfflineFlushSummary>;
  queueInventoryCount(input: InventoryCountInput, idempotencyKey: string): Promise<OfflineCommand>;
  inventoryTransfers(): Promise<InventoryTransfer[]>;
  createInventoryTransfer(
    input: CreateInventoryTransferInput,
    idempotencyKey: string,
  ): Promise<InventoryTransfer>;
  dispatchInventoryTransfer(transferId: string, idempotencyKey: string): Promise<InventoryTransfer>;
  receiveInventoryTransfer(
    transferId: string,
    input: ReceiveInventoryTransferInput,
    idempotencyKey: string,
  ): Promise<InventoryTransfer>;
  purchaseOrders(query?: string): Promise<PurchaseOrder[]>;
  receivePurchaseOrder(
    orderId: string,
    input: ReceivePurchaseOrderInput,
    idempotencyKey: string,
  ): Promise<PurchaseOrder>;
  clearError(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const manager = useMemo(
    () =>
      new SessionManager(
        new HttpMobileApi(appEnvironment.apiBaseUrl),
        new SecureCredentialsStore(),
        new SqliteMobileDataStore(),
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
    return runValue(() => manager.product(id));
  }

  async function quote(lines: PosCartLineInput[]) {
    return runValue(() => manager.quote(lines));
  }

  async function paymentOptions() {
    return runValue(() => manager.paymentOptions());
  }

  async function cashSale(input: CashSaleInput, idempotencyKey: string) {
    return runValue(() => manager.cashSale(input, idempotencyKey));
  }

  async function sale(input: SaleInput, idempotencyKey: string) {
    return runValue(() => manager.sale(input, idempotencyKey));
  }

  async function queueCashSale(quoteValue: PosQuote, input: CashSaleInput, idempotencyKey: string) {
    if (!session) throw new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida.');
    return runValue(() => manager.queueCashSale(session, quoteValue, input, idempotencyKey));
  }

  async function offlineCommands() {
    if (!session) return [];
    return manager.offlineCommands(session);
  }

  async function flushOffline() {
    if (!session) throw new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida.');
    return runValue(() => manager.flushOffline(session));
  }

  async function queueInventoryCount(input: InventoryCountInput, idempotencyKey: string) {
    if (!session) throw new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida.');
    return runValue(() => manager.queueInventoryCount(session, input, idempotencyKey));
  }

  function inventoryTransfers() {
    return runValue(() => manager.inventoryTransfers());
  }

  function createInventoryTransfer(
    input: CreateInventoryTransferInput,
    idempotencyKey: string,
  ) {
    return runValue(() => manager.createInventoryTransfer(input, idempotencyKey));
  }

  function dispatchInventoryTransfer(transferId: string, idempotencyKey: string) {
    return runValue(() => manager.dispatchInventoryTransfer(transferId, idempotencyKey));
  }

  function receiveInventoryTransfer(
    transferId: string,
    input: ReceiveInventoryTransferInput,
    idempotencyKey: string,
  ) {
    return runValue(() => manager.receiveInventoryTransfer(transferId, input, idempotencyKey));
  }

  function purchaseOrders(query = '') {
    return runValue(() => manager.purchaseOrders(query));
  }

  function receivePurchaseOrder(
    orderId: string,
    input: ReceivePurchaseOrderInput,
    idempotencyKey: string,
  ) {
    return runValue(() => manager.receivePurchaseOrder(orderId, input, idempotencyKey));
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

  async function runValue<T>(action: () => Promise<T>): Promise<T> {
    let value!: T;
    await run(async () => {
      value = await action();
    });
    return value;
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
        quote,
        paymentOptions,
        cashSale,
        sale,
        queueCashSale,
        offlineCommands,
        flushOffline,
        queueInventoryCount,
        inventoryTransfers,
        createInventoryTransfer,
        dispatchInventoryTransfer,
        receiveInventoryTransfer,
        purchaseOrders,
        receivePurchaseOrder,
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
