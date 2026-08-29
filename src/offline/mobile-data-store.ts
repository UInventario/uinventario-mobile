import * as Crypto from 'expo-crypto';
import { SQLiteStorage } from 'expo-sqlite/kv-store';

import { BootstrapSnapshot } from '@/auth/contracts';
import {
  CashSaleInput,
  OfflineCashSalePayload,
  OfflineCommand,
  OfflineCommandBatchResponse,
  PosQuote,
} from '@/pos/contracts';

const STORAGE_PREFIX = 'uinventario-mobile:';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  getAllKeys(): Promise<string[]>;
  multiSet(values: [string, string][]): Promise<void>;
  multiRemove(keys: string[]): Promise<void>;
}

export interface OfflineFlushSummary {
  confirmed: number;
  rejected: number;
}

export interface MobileDataStore {
  replace(snapshot: BootstrapSnapshot): Promise<void>;
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

  constructor(
    storage: KeyValueStore = new SQLiteStorage('uinventario-mobile.db'),
    private readonly createId: () => string = Crypto.randomUUID,
  ) {
    this.storage = storage;
  }

  replace(snapshot: BootstrapSnapshot): Promise<void> {
    return this.exclusive(() =>
      this.storage.setItem(`${STORAGE_PREFIX}bootstrap`, JSON.stringify(snapshot)),
    );
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      const keys = (await this.storage.getAllKeys()).filter(
        (key) =>
          key.startsWith(`${STORAGE_PREFIX}bootstrap`) ||
          key.startsWith(`${STORAGE_PREFIX}outbox:`),
      );
      if (keys.length) await this.storage.multiRemove(keys);
    });
  }

  queueCashSale(
    snapshot: BootstrapSnapshot,
    quote: PosQuote,
    input: CashSaleInput,
    idempotencyKey: string,
  ): Promise<OfflineCommand> {
    return this.exclusive(async () => {
      this.assertOfflineSale(snapshot, quote, input, idempotencyKey);
      const key = this.outboxKey(snapshot.scope);
      const commands = await this.readCommands(key);
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
        [key, JSON.stringify([...commands, command])],
      ]);
      return command;
    });
  }

  commands(scope: BootstrapSnapshot['scope']): Promise<OfflineCommand[]> {
    return this.exclusive(() => this.readCommands(this.outboxKey(scope)));
  }

  async pendingCount(scope: BootstrapSnapshot['scope']): Promise<number> {
    const commands = await this.commands(scope);
    return commands.filter(this.pending).length;
  }

  pendingCountAll(): Promise<number> {
    return this.exclusive(async () => {
      const keys = (await this.storage.getAllKeys()).filter((key) =>
        key.startsWith(`${STORAGE_PREFIX}outbox:`),
      );
      let count = 0;
      for (const key of keys) count += (await this.readCommands(key)).filter(this.pending).length;
      return count;
    });
  }

  flush(
    scope: BootstrapSnapshot['scope'],
    sender: (commands: OfflineCommand[]) => Promise<OfflineCommandBatchResponse>,
  ): Promise<OfflineFlushSummary> {
    return this.exclusive(async () => {
      const summary: OfflineFlushSummary = { confirmed: 0, rejected: 0 };
      const key = this.outboxKey(scope);
      while (true) {
        const commands = await this.readCommands(key);
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
        await this.writeCommands(key, sent);
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
          await this.writeCommands(key, settled);
          if (settled.some((command) => ids.has(command.commandId) && command.retryable)) {
            return summary;
          }
        } catch (error) {
          await this.writeCommands(
            key,
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

  private pending(command: OfflineCommand): boolean {
    return (
      command.status === 'PENDING' ||
      command.status === 'SENT' ||
      (command.status === 'ERROR' && command.retryable)
    );
  }

  private async readCommands(key: string): Promise<OfflineCommand[]> {
    const value = await this.storage.getItem(key);
    if (!value) return [];
    const parsed = JSON.parse(value) as OfflineCommand[];
    return parsed.sort(bySequence);
  }

  private writeCommands(key: string, commands: OfflineCommand[]): Promise<void> {
    return this.storage.setItem(key, JSON.stringify(commands));
  }

  private outboxKey(scope: BootstrapSnapshot['scope']): string {
    return `${STORAGE_PREFIX}outbox:${[
      scope.tenantId,
      scope.userId,
      scope.deviceId,
      scope.branchId ?? '-',
      scope.cashRegisterId ?? '-',
    ].join(':')}`;
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

function serializableError(error: unknown): unknown {
  if (error instanceof Error) return { name: error.name, message: error.message };
  try {
    return JSON.parse(JSON.stringify(error)) as unknown;
  } catch {
    return 'Error de sincronización no serializable';
  }
}
