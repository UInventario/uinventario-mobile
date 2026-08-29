import * as Crypto from 'expo-crypto';
import { SQLiteStorage } from 'expo-sqlite/kv-store';

import {
  AuthenticatedSession,
  BootstrapSnapshot,
  OfflineChangesData,
  SessionData,
} from '@/auth/contracts';
import {
  CashSaleInput,
  OfflineCashSalePayload,
  OfflineCommand,
  OfflineCommandBatchResponse,
  PosQuote,
} from '@/pos/contracts';

const STORAGE_PREFIX = 'uinventario-mobile:';
const SCHEMA_VERSION = 2;
const MANIFEST_KEY = `${STORAGE_PREFIX}schema`;
const LEGACY_BOOTSTRAP_KEY = `${STORAGE_PREFIX}bootstrap`;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<string[]>;
  multiSet(values: [string, string][]): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
}

interface VersionedRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  scopeKey: string;
}

interface SnapshotRecord extends VersionedRecord {
  storedAt: string;
  snapshot: BootstrapSnapshot;
  session: StoredSession | null;
}

interface StoredSession {
  data: SessionData;
  expiresAt: string;
}

interface OutboxRecord extends VersionedRecord {
  commands: OfflineCommand[];
}

export interface OfflineFlushSummary {
  confirmed: number;
  rejected: number;
}

export class MobileStorageError extends Error {
  constructor(
    readonly code: 'CORRUPT' | 'INCOMPATIBLE_SCHEMA',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface MobileDataStore {
  replace(snapshot: BootstrapSnapshot, session?: StoredSession): Promise<void>;
  snapshot(scope: BootstrapSnapshot['scope']): Promise<BootstrapSnapshot | null>;
  latest(deviceId: string): Promise<AuthenticatedSession | null>;
  applyChanges(
    scope: BootstrapSnapshot['scope'],
    changes: OfflineChangesData,
  ): Promise<BootstrapSnapshot>;
  recover(): Promise<void>;
  clear(): Promise<void>;
  queueCashSale(
    snapshot: BootstrapSnapshot,
    quote: PosQuote,
    input: CashSaleInput,
    idempotencyKey: string,
  ): Promise<OfflineCommand>;
  commands(scope: BootstrapSnapshot['scope']): Promise<OfflineCommand[]>;
  pendingCount(scope: BootstrapSnapshot['scope']): Promise<number>;
  pendingCountAll(): Promise<number>;
  flush(
    scope: BootstrapSnapshot['scope'],
    sender: (commands: OfflineCommand[]) => Promise<OfflineCommandBatchResponse>,
  ): Promise<OfflineFlushSummary>;
}

export class SqliteMobileDataStore implements MobileDataStore {
  private readonly storage: KeyValueStore;
  private operation: Promise<void> = Promise.resolve();
  private ready: Promise<void> | null = null;

  constructor(
    storage: KeyValueStore = new SQLiteStorage('uinventario-mobile.db'),
    private readonly createId: () => string = Crypto.randomUUID,
  ) {
    this.storage = storage;
  }

  replace(snapshot: BootstrapSnapshot, session?: StoredSession): Promise<void> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      this.assertSnapshot(snapshot);
      await this.writeSnapshot(snapshot, session ?? null);
    });
  }

  snapshot(scope: BootstrapSnapshot['scope']): Promise<BootstrapSnapshot | null> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      return (await this.readSnapshotRecord(scope))?.snapshot ?? null;
    });
  }

  latest(deviceId: string): Promise<AuthenticatedSession | null> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      const activeScope = await this.storage.getItem(this.activeScopeKey(deviceId));
      if (!activeScope) return null;
      const value = await this.storage.getItem(`${STORAGE_PREFIX}snapshot:${activeScope}`);
      if (!value) {
        throw new MobileStorageError('CORRUPT', 'La sesión local no tiene bootstrap.');
      }
      const record = this.parseSnapshotRecord(value);
      if (record.snapshot.scope.deviceId !== deviceId) {
        throw new MobileStorageError('CORRUPT', 'La sesión local pertenece a otro dispositivo.');
      }
      return record?.session
        ? {
            data: record.session.data,
            expiresAt: record.session.expiresAt,
            bootstrap: record.snapshot,
          }
        : null;
    });
  }

  applyChanges(
    scope: BootstrapSnapshot['scope'],
    data: OfflineChangesData,
  ): Promise<BootstrapSnapshot> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      const record = await this.readSnapshotRecord(scope);
      if (!record) {
        throw new MobileStorageError('CORRUPT', 'No existe un bootstrap para aplicar cambios.');
      }
      const current = record.snapshot;
      if (
        data.protocolVersion !== current.protocolVersion ||
        this.scopeKey(data.scope) !== this.scopeKey(scope) ||
        data.identity.user.id !== scope.userId ||
        data.cursor !== current.initialSyncCursor
      ) {
        throw new MobileStorageError('CORRUPT', 'La página incremental no pertenece al alcance local.');
      }

      const entities = new Map(current.entities.map((entity) => [entityKey(entity), entity]));
      for (const change of data.changes) {
        if (change.entity.tenantId !== scope.tenantId) {
          throw new MobileStorageError('CORRUPT', 'La sincronización contiene datos de otra empresa.');
        }
        const key = entityKey(change.entity);
        if (change.operation === 'DELETE') entities.delete(key);
        else entities.set(key, change.entity);
      }
      const snapshot: BootstrapSnapshot = {
        ...current,
        generatedAt: data.generatedAt,
        sessionExpiresAt: data.sessionExpiresAt,
        initialSyncCursor: data.nextCursor,
        freshnessPolicy: data.freshnessPolicy,
        identity: {
          ...current.identity,
          user: {
            id: data.identity.user.id,
            roles: data.identity.user.roles,
            permissions: data.identity.user.permissions,
          },
        },
        entities: [...entities.values()].sort(byEntity),
      };
      const session = record.session
        ? {
            ...record.session,
            expiresAt: data.sessionExpiresAt,
            data: {
              ...record.session.data,
              user: {
                ...record.session.data.user,
                roles: data.identity.user.roles,
                permissions: data.identity.user.permissions,
              },
            },
          }
        : null;
      await this.writeSnapshot(snapshot, session);
      return snapshot;
    });
  }

  recover(): Promise<void> {
    return this.exclusive(async () => {
      const keys = (await this.storage.getAllKeys()).filter(
        (key) =>
          key === LEGACY_BOOTSTRAP_KEY ||
          key.startsWith(`${STORAGE_PREFIX}snapshot:`) ||
          key.startsWith(`${STORAGE_PREFIX}active-scope:`),
      );
      if (keys.length) await this.storage.multiRemove(keys);
      await this.storage.setItem(
        MANIFEST_KEY,
        JSON.stringify({ schemaVersion: SCHEMA_VERSION, recoveredAt: new Date().toISOString() }),
      );
      this.ready = Promise.resolve();
    });
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      const keys = (await this.storage.getAllKeys()).filter(
        (key) =>
          key === LEGACY_BOOTSTRAP_KEY ||
          key.startsWith(`${STORAGE_PREFIX}snapshot:`) ||
          key.startsWith(`${STORAGE_PREFIX}active-scope:`) ||
          key.startsWith(`${STORAGE_PREFIX}outbox:`),
      );
      if (keys.length) await this.storage.multiRemove(keys);
      await this.storage.setItem(MANIFEST_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION }));
      this.ready = Promise.resolve();
    });
  }

  queueCashSale(
    snapshot: BootstrapSnapshot,
    quote: PosQuote,
    input: CashSaleInput,
    idempotencyKey: string,
  ): Promise<OfflineCommand> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      this.assertOfflineSale(snapshot, quote, input, idempotencyKey);
      const key = this.outboxKey(snapshot.scope);
      const commands = await this.readCommands(key, snapshot.scope);
      const existing = commands.find((command) => command.idempotencyKey === idempotencyKey);
      const payload = this.payload(quote, input, existing?.payload.snapshot.capturedAt);
      if (existing) {
        if (JSON.stringify(existing.payload) !== JSON.stringify(payload)) {
          throw new Error('La clave idempotente ya pertenece a otra venta local.');
        }
        return existing;
      }
      const sequenceKey = this.sequenceKey(snapshot.scope);
      const sequence = Number((await this.storage.getItem(sequenceKey)) ?? '0') + 1;
      const command: OfflineCommand = {
        protocolVersion: '1.0',
        commandId: this.createId(),
        idempotencyKey,
        scope: snapshot.scope,
        sequence,
        createdAt: new Date().toISOString(),
        valuationMethod: snapshot.valuationPolicy.method,
        valuationPolicyVersion: snapshot.valuationPolicy.version,
        kind: 'CASH_SALE',
        payload,
        status: 'PENDING',
        attempts: 0,
        retryable: true,
        result: null,
        error: null,
      };
      await this.storage.multiSet([
        [sequenceKey, String(sequence)],
        [key, this.outboxValue(snapshot.scope, [...commands, command])],
      ]);
      return command;
    });
  }

  commands(scope: BootstrapSnapshot['scope']): Promise<OfflineCommand[]> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      return this.readCommands(this.outboxKey(scope), scope);
    });
  }

  async pendingCount(scope: BootstrapSnapshot['scope']): Promise<number> {
    const commands = await this.commands(scope);
    return commands.filter(this.pending).length;
  }

  pendingCountAll(): Promise<number> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      const keys = (await this.storage.getAllKeys()).filter((key) =>
        key.startsWith(`${STORAGE_PREFIX}outbox:`),
      );
      let count = 0;
      for (const key of keys) {
        const scope = this.scopeFromOutboxKey(key);
        count += (await this.readCommands(key, scope)).filter(this.pending).length;
      }
      return count;
    });
  }

  flush(
    scope: BootstrapSnapshot['scope'],
    sender: (commands: OfflineCommand[]) => Promise<OfflineCommandBatchResponse>,
  ): Promise<OfflineFlushSummary> {
    return this.exclusive(async () => {
      await this.ensureSchema();
      const summary: OfflineFlushSummary = { confirmed: 0, rejected: 0 };
      const key = this.outboxKey(scope);
      while (true) {
        const commands = await this.readCommands(key, scope);
        const batch = commands.filter(this.pending).sort(bySequence).slice(0, 20);
        if (!batch.length) return summary;
        const ids = new Set(batch.map(({ commandId }) => commandId));
        const sent = commands.map((command) =>
          ids.has(command.commandId)
            ? {
                ...command,
                status: 'SENT' as const,
                attempts: command.attempts + 1,
                error: null,
              }
            : command,
        );
        await this.writeCommands(key, scope, sent);
        try {
          const response = await sender(batch);
          const results = new Map(
            response.data.results
              .filter(({ commandId }) => ids.has(commandId))
              .map((result) => [result.commandId, result]),
          );
          const settled = sent.map((command) => {
            if (!ids.has(command.commandId)) return command;
            const result = results.get(command.commandId);
            if (!result) {
              return {
                ...command,
                status: 'ERROR' as const,
                retryable: true,
                error: 'El servidor no confirmó el comando.',
              };
            }
            if (result.status === 'CONFIRMED') summary.confirmed += 1;
            else summary.rejected += 1;
            return {
              ...command,
              status: result.status,
              retryable: false,
              result: result.result ?? null,
              error: result.error ?? null,
            };
          });
          await this.writeCommands(key, scope, settled);
          if (settled.some((command) => ids.has(command.commandId) && command.retryable)) {
            return summary;
          }
        } catch (error) {
          await this.writeCommands(
            key,
            scope,
            sent.map((command) =>
              ids.has(command.commandId)
                ? {
                    ...command,
                    status: 'ERROR' as const,
                    retryable: true,
                    error: serializableError(error),
                  }
                : command,
            ),
          );
          throw error;
        }
      }
    });
  }

  private async ensureSchema(): Promise<void> {
    this.ready ??= this.migrate();
    try {
      await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  private async migrate(): Promise<void> {
    const manifestValue = await this.storage.getItem(MANIFEST_KEY);
    if (manifestValue) {
      const manifest = this.parse<{ schemaVersion?: number }>(manifestValue, 'esquema');
      if (manifest.schemaVersion === SCHEMA_VERSION) return;
      if ((manifest.schemaVersion ?? 0) > SCHEMA_VERSION) {
        throw new MobileStorageError(
          'INCOMPATIBLE_SCHEMA',
          'La base local fue creada por una versión más reciente de UInventario.',
        );
      }
    }

    const legacyValue = await this.storage.getItem(LEGACY_BOOTSTRAP_KEY);
    const writes: [string, string][] = [
      [MANIFEST_KEY, JSON.stringify({ schemaVersion: SCHEMA_VERSION })],
    ];
    if (legacyValue) {
      const snapshot = this.parse<BootstrapSnapshot>(legacyValue, 'bootstrap anterior');
      this.assertSnapshot(snapshot);
      writes.push([this.snapshotKey(snapshot.scope), this.snapshotValue(snapshot)]);
    }
    await this.storage.multiSet(writes);
    if (legacyValue) await this.storage.multiRemove([LEGACY_BOOTSTRAP_KEY]);
  }

  private async readSnapshotRecord(
    scope: BootstrapSnapshot['scope'],
  ): Promise<SnapshotRecord | null> {
    const value = await this.storage.getItem(this.snapshotKey(scope));
    if (!value) return null;
    const record = this.parseSnapshotRecord(value);
    if (record.scopeKey !== this.scopeKey(scope)) {
      throw new MobileStorageError('CORRUPT', 'El bootstrap local está dañado.');
    }
    return record;
  }

  private writeSnapshot(snapshot: BootstrapSnapshot, session: StoredSession | null): Promise<void> {
    const values: [string, string][] = [
      [this.snapshotKey(snapshot.scope), this.snapshotValue(snapshot, session)],
    ];
    if (session) {
      values.push([this.activeScopeKey(snapshot.scope.deviceId), this.scopeKey(snapshot.scope)]);
    }
    return this.storage.multiSet(values);
  }

  private snapshotValue(snapshot: BootstrapSnapshot, session: StoredSession | null = null): string {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      scopeKey: this.scopeKey(snapshot.scope),
      storedAt: new Date().toISOString(),
      snapshot,
      session,
    } satisfies SnapshotRecord);
  }

  private parseSnapshotRecord(value: string): SnapshotRecord {
    const record = this.parse<SnapshotRecord>(value, 'bootstrap');
    if (
      record.schemaVersion !== SCHEMA_VERSION ||
      typeof record.scopeKey !== 'string' ||
      typeof record.storedAt !== 'string' ||
      !this.isSnapshot(record.snapshot) ||
      this.scopeKey(record.snapshot.scope) !== record.scopeKey ||
      (record.session !== null && record.session !== undefined && !this.isStoredSession(record.session))
    ) {
      throw new MobileStorageError('CORRUPT', 'El bootstrap local está dañado.');
    }
    return { ...record, session: record.session ?? null };
  }

  private isStoredSession(value: unknown): value is StoredSession {
    if (!value || typeof value !== 'object') return false;
    const session = value as Partial<StoredSession>;
    return (
      typeof session.expiresAt === 'string' &&
      !!session.data &&
      typeof session.data.user?.id === 'string' &&
      typeof session.data.tenant?.id === 'string'
    );
  }

  private payload(
    quote: PosQuote,
    input: CashSaleInput,
    capturedAt = new Date().toISOString(),
  ): OfflineCashSalePayload {
    return {
      ...input,
      channel: 'MOBILE',
      snapshot: {
        capturedAt,
        branchId: quote.context.branch.id,
        warehouseId: quote.context.warehouse.id,
        cashRegisterId: quote.context.cashRegister.id,
        currency: quote.currency,
        taxRate: quote.taxRate,
        paymentMethod: 'CASH',
        negativeStock: 'DENY',
        lines: quote.lines.map((line) => ({
          productId: line.product.id,
          name: line.product.name,
          sku: line.product.sku,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          subtotal: line.subtotal,
          tax: line.tax,
          total: line.total,
        })),
        totals: quote.totals,
      },
    };
  }

  private assertOfflineSale(
    snapshot: BootstrapSnapshot,
    quote: PosQuote,
    input: CashSaleInput,
    idempotencyKey: string,
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
      throw new Error('La clave idempotente de la venta no es válida.');
    }
    if (!snapshot.identity.user.permissions.includes('SALES_MANAGE')) {
      throw new Error('La sesión no permite registrar ventas.');
    }
    const policy = snapshot.posPolicy;
    if (
      !policy ||
      policy.branchId !== snapshot.scope.branchId ||
      policy.cashRegisterId !== snapshot.scope.cashRegisterId ||
      quote.context.branch.id !== policy.branchId ||
      quote.context.warehouse.id !== policy.warehouseId ||
      quote.context.cashRegister.id !== policy.cashRegisterId
    ) {
      throw new Error('La caja offline no coincide con el contexto autorizado.');
    }
    const ageSeconds = (Date.now() - Date.parse(snapshot.generatedAt)) / 1000;
    const expiresAt = Date.parse(snapshot.sessionExpiresAt);
    if (
      !Number.isFinite(ageSeconds) ||
      ageSeconds < -snapshot.freshnessPolicy.maxClockSkewSeconds ||
      ageSeconds > snapshot.freshnessPolicy.permissionsTtlSeconds ||
      ageSeconds > snapshot.freshnessPolicy.actionTtlSeconds.CASH_SALE ||
      !Number.isFinite(expiresAt) ||
      Date.now() >= expiresAt
    ) {
      throw new Error('La autorización offline venció; conéctate antes de vender.');
    }
    if (money(input.cashReceived) < money(quote.totals.total)) {
      throw new Error('El efectivo recibido no cubre el total de la venta.');
    }
  }

  private assertSnapshot(snapshot: BootstrapSnapshot): void {
    if (!this.isSnapshot(snapshot)) {
      throw new MobileStorageError('CORRUPT', 'El bootstrap no tiene un formato compatible.');
    }
    if (snapshot.entities.some(({ tenantId }) => tenantId !== snapshot.scope.tenantId)) {
      throw new MobileStorageError('CORRUPT', 'El bootstrap contiene datos de otra empresa.');
    }
  }

  private isSnapshot(value: unknown): value is BootstrapSnapshot {
    if (!value || typeof value !== 'object') return false;
    const snapshot = value as Partial<BootstrapSnapshot>;
    return (
      snapshot.protocolVersion === '1.0' &&
      typeof snapshot.initialSyncCursor === 'string' &&
      !!snapshot.scope &&
      typeof snapshot.scope.tenantId === 'string' &&
      typeof snapshot.scope.userId === 'string' &&
      typeof snapshot.scope.deviceId === 'string' &&
      !!snapshot.identity &&
      Array.isArray(snapshot.entities)
    );
  }

  private pending(command: OfflineCommand): boolean {
    return (
      command.status === 'PENDING' ||
      command.status === 'SENT' ||
      (command.status === 'ERROR' && command.retryable)
    );
  }

  private async readCommands(
    key: string,
    scope: BootstrapSnapshot['scope'],
  ): Promise<OfflineCommand[]> {
    const value = await this.storage.getItem(key);
    if (!value) return [];
    const parsed = this.parse<OutboxRecord | OfflineCommand[]>(value, 'outbox');
    if (Array.isArray(parsed)) {
      if (!parsed.every((command) => this.isCommand(command, scope))) {
        throw new MobileStorageError('CORRUPT', 'La cola offline está dañada.');
      }
      await this.writeCommands(key, scope, parsed);
      return parsed.sort(bySequence);
    }
    if (
      parsed.schemaVersion !== SCHEMA_VERSION ||
      parsed.scopeKey !== this.scopeKey(scope) ||
      !Array.isArray(parsed.commands) ||
      !parsed.commands.every((command) => this.isCommand(command, scope))
    ) {
      throw new MobileStorageError('CORRUPT', 'La cola offline está dañada.');
    }
    return parsed.commands.sort(bySequence);
  }

  private isCommand(value: unknown, scope: BootstrapSnapshot['scope']): value is OfflineCommand {
    if (!value || typeof value !== 'object') return false;
    const command = value as Partial<OfflineCommand>;
    return (
      command.protocolVersion === '1.0' &&
      typeof command.commandId === 'string' &&
      typeof command.sequence === 'number' &&
      !!command.scope &&
      this.scopeKey(command.scope) === this.scopeKey(scope)
    );
  }

  private writeCommands(
    key: string,
    scope: BootstrapSnapshot['scope'],
    commands: OfflineCommand[],
  ): Promise<void> {
    return this.storage.setItem(key, this.outboxValue(scope, commands));
  }

  private outboxValue(scope: BootstrapSnapshot['scope'], commands: OfflineCommand[]): string {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      scopeKey: this.scopeKey(scope),
      commands,
    } satisfies OutboxRecord);
  }

  private parse<T>(value: string, label: string): T {
    try {
      return JSON.parse(value) as T;
    } catch (cause) {
      throw new MobileStorageError('CORRUPT', `El ${label} local está dañado.`, { cause });
    }
  }

  private snapshotKey(scope: BootstrapSnapshot['scope']): string {
    return `${STORAGE_PREFIX}snapshot:${this.scopeKey(scope)}`;
  }

  private outboxKey(scope: BootstrapSnapshot['scope']): string {
    return `${STORAGE_PREFIX}outbox:${this.scopeKey(scope)}`;
  }

  private activeScopeKey(deviceId: string): string {
    return `${STORAGE_PREFIX}active-scope:${deviceId}`;
  }

  private scopeKey(scope: BootstrapSnapshot['scope']): string {
    return [
      scope.tenantId,
      scope.userId,
      scope.deviceId,
      scope.branchId ?? '-',
      scope.cashRegisterId ?? '-',
    ].join(':');
  }

  private scopeFromOutboxKey(key: string): BootstrapSnapshot['scope'] {
    const [tenantId, userId, deviceId, branchId, cashRegisterId] = key
      .slice(`${STORAGE_PREFIX}outbox:`.length)
      .split(':');
    if (!tenantId || !userId || !deviceId || !branchId || !cashRegisterId) {
      throw new MobileStorageError('CORRUPT', 'La cola offline tiene un alcance inválido.');
    }
    return {
      tenantId,
      userId,
      deviceId,
      branchId: branchId === '-' ? null : branchId,
      cashRegisterId: cashRegisterId === '-' ? null : cashRegisterId,
    };
  }

  private sequenceKey(scope: BootstrapSnapshot['scope']): string {
    return `${STORAGE_PREFIX}sequence:${scope.tenantId}:${scope.userId}:${scope.deviceId}`;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, string>();
  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  async getAllKeys() {
    return [...this.values.keys()];
  }
  async multiSet(values: [string, string][]) {
    for (const [key, value] of values) this.values.set(key, value);
  }
  async multiRemove(keys: string[]) {
    for (const key of keys) this.values.delete(key);
  }
}

function money(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function bySequence(left: OfflineCommand, right: OfflineCommand) {
  return left.sequence - right.sequence;
}

function byEntity(
  left: BootstrapSnapshot['entities'][number],
  right: BootstrapSnapshot['entities'][number],
) {
  return entityKey(left).localeCompare(entityKey(right));
}

function entityKey(entity: BootstrapSnapshot['entities'][number]): string {
  return `${entity.kind}:${entity.id}`;
}

function serializableError(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message };
  try {
    return JSON.parse(JSON.stringify(error)) as unknown;
  } catch {
    return 'Error de sincronización no serializable';
  }
}
