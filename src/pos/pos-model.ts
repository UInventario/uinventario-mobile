import { BootstrapEntity, BootstrapSnapshot } from '@/auth/contracts';

import { OfflineCommand, PosCartLineInput, PosQuote } from './contracts';

export function offlineQuote(
  snapshot: BootstrapSnapshot,
  lines: PosCartLineInput[],
  commands: OfflineCommand[],
  now = Date.now(),
): PosQuote {
  assertOfflineReady(snapshot, now);
  if (!lines.length) throw new Error('Agrega al menos un producto al carrito.');
  const policy = snapshot.posPolicy!;
  const scoped = snapshot.entities.filter(({ tenantId }) => tenantId === snapshot.scope.tenantId);
  const products = new Map(scoped.filter(kind('PRODUCT')).map((entity) => [entity.id, entity]));
  const locations = new Set(
    scoped
      .filter(kind('LOCATION'))
      .filter(({ warehouseId, active }) => warehouseId === policy.warehouseId && active !== false)
      .map(({ id }) => id),
  );
  const pending = pendingQuantities(commands);
  const prices = resolvedPrices(scoped.filter(kind('PRICE_LIST')), policy, now);
  const taxRate = decimalUnits(policy.taxRate, 4);
  let subtotal = 0n;
  let tax = 0n;
  let total = 0n;

  const quotedLines = lines.map((line) => {
    const product = products.get(line.productId);
    if (!product?.name || !product.sku || !product.price || product.active === false) {
      throw new Error('El producto ya no está disponible para venta offline.');
    }
    const requested = decimalUnits(line.quantity, 3);
    if (requested <= 0n) throw new Error('La cantidad debe ser mayor que cero.');
    const available = scoped
      .filter(kind('INVENTORY_AVAILABILITY'))
      .filter(
        ({ productId, locationId }) =>
          productId === product.id && Boolean(locationId && locations.has(locationId)),
      )
      .reduce(
        (sum, balance) => sum + decimalUnits(balance.availableQuantity ?? '0', 3),
        0n,
      );
    const effectiveAvailable = available - (pending.get(product.id) ?? 0n);
    if (requested > effectiveAvailable) {
      throw new Error(`Stock offline insuficiente para ${product.name}.`);
    }
    const resolved = prices.get(product.id);
    const unitPrice = money(resolved?.price ?? product.price);
    const lineTotal = roundDivide(unitPrice * requested, 1000n);
    const lineTax = taxRate === 0n ? 0n : roundDivide(lineTotal * taxRate, 10_000n + taxRate);
    const lineSubtotal = lineTotal - lineTax;
    subtotal += lineSubtotal;
    tax += lineTax;
    total += lineTotal;
    return {
      product: { id: product.id, name: product.name, sku: product.sku },
      quantity: quantity(requested),
      lotId: null,
      availableQuantity: quantity(effectiveAvailable),
      unitPrice: formatMoney(unitPrice),
      priceSource: resolved ? ('PRICE_LIST' as const) : ('BASE' as const),
      priceList: resolved ? { id: resolved.id, name: resolved.name } : null,
      subtotal: formatMoney(lineSubtotal),
      tax: formatMoney(lineTax),
      total: formatMoney(lineTotal),
    };
  });
  return {
    context: {
      branch: entityName(scoped, 'BRANCH', policy.branchId),
      warehouse: entityName(scoped, 'WAREHOUSE', policy.warehouseId),
      cashRegister: {
        ...entityName(scoped, 'CASH_REGISTER', policy.cashRegisterId),
        code: scoped.find(
          (entity) => entity.kind === 'CASH_REGISTER' && entity.id === policy.cashRegisterId,
        )?.code ?? 'CAJA',
      },
    },
    currency: policy.currency,
    taxRate: policy.taxRate,
    lines: quotedLines,
    totals: {
      subtotal: formatMoney(subtotal),
      tax: formatMoney(tax),
      total: formatMoney(total),
    },
  };
}

function assertOfflineReady(snapshot: BootstrapSnapshot, now: number) {
  const policy = snapshot.posPolicy;
  if (
    !policy ||
    policy.branchId !== snapshot.scope.branchId ||
    policy.cashRegisterId !== snapshot.scope.cashRegisterId
  ) {
    throw new Error('Abre la caja y sincroniza antes de vender sin conexión.');
  }
  if (!snapshot.identity.user.permissions.includes('SALES_MANAGE')) {
    throw new Error('La sesión no permite registrar ventas.');
  }
  const generatedAt = Date.parse(snapshot.generatedAt);
  const ageSeconds = (now - generatedAt) / 1000;
  if (
    !Number.isFinite(ageSeconds) ||
    ageSeconds < -snapshot.freshnessPolicy.maxClockSkewSeconds ||
    ageSeconds > snapshot.freshnessPolicy.permissionsTtlSeconds ||
    ageSeconds > snapshot.freshnessPolicy.actionTtlSeconds.CASH_SALE ||
    now >= Date.parse(snapshot.sessionExpiresAt)
  ) {
    throw new Error('La autorización offline venció; conéctate antes de vender.');
  }
}

function pendingQuantities(commands: OfflineCommand[]) {
  const result = new Map<string, bigint>();
  for (const command of commands) {
    if (
      command.status === 'CONFIRMED' ||
      (command.status === 'ERROR' && !command.retryable)
    ) {
      continue;
    }
    for (const line of command.payload.lines) {
      result.set(
        line.productId,
        (result.get(line.productId) ?? 0n) + decimalUnits(line.quantity, 3),
      );
    }
  }
  return result;
}

function resolvedPrices(entities: BootstrapEntity[], policy: NonNullable<BootstrapSnapshot['posPolicy']>, now: number) {
  const candidates = entities
    .filter(
      ({ active, currency, channel, branchId, validFrom, validTo }) =>
        active !== false &&
        currency === policy.currency &&
        (!channel || channel === 'MOBILE') &&
        (!branchId || branchId === policy.branchId) &&
        Boolean(validFrom && Date.parse(validFrom) <= now) &&
        (!validTo || Date.parse(validTo) > now),
    )
    .sort(
      (left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) ||
        Number(Boolean(right.branchId)) - Number(Boolean(left.branchId)) ||
        Date.parse(right.validFrom ?? '') - Date.parse(left.validFrom ?? '') ||
        left.id.localeCompare(right.id),
    );
  const result = new Map<string, { id: string; name: string; price: string }>();
  for (const list of candidates) {
    for (const item of list.items ?? []) {
      if (!result.has(item.productId)) {
        result.set(item.productId, {
          id: list.id,
          name: list.name ?? 'Lista de precio',
          price: item.price,
        });
      }
    }
  }
  return result;
}

function entityName(entities: BootstrapEntity[], kindValue: string, id: string) {
  const entity = entities.find((candidate) => candidate.kind === kindValue && candidate.id === id);
  if (!entity) throw new Error('El contexto offline ya no está disponible.');
  return { id, name: entity.name ?? 'Sin nombre' };
}

function kind(kindValue: string) {
  return (entity: BootstrapEntity) => entity.kind === kindValue;
}

function decimalUnits(value: string, scale: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('El valor decimal no es válido.');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) throw new Error('El valor tiene demasiados decimales.');
  return BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}

function money(value: string) {
  return decimalUnits(value, 2);
}

function formatMoney(value: bigint) {
  return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
}

function quantity(value: bigint) {
  return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
}

function roundDivide(numerator: bigint, denominator: bigint) {
  return (numerator + denominator / 2n) / denominator;
}
