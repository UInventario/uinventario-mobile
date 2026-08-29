import NetInfo from '@react-native-community/netinfo';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/auth/mobile-api';
import { AuthenticatedSession } from '@/auth/contracts';
import { useSession } from '@/auth/session-context';
import { findProductByCode, filterProducts } from '@/catalog/catalog-model';
import { Colors, Spacing } from '@/constants/theme';
import { OfflineCommand } from '@/pos/contracts';

import {
  CreateInventoryTransferInput,
  InventoryTransfer,
  PurchaseOrder,
  ReceiveInventoryTransferInput,
} from './contracts';
import {
  InventoryOptions,
  inventoryOptions,
  locationsFor,
  mayDispatch,
  mayReceiveTransfer,
  normalizeQuantity,
  receivableOrders,
  snapshotQuantity,
} from './inventory-model';

type Mode = 'COUNT' | 'TRANSFER' | 'RECEIPT';
type OpenScanner = (onCode: (code: string) => void) => Promise<void>;

export function InventoryOperationsScreen() {
  const { status, session } = useSession();
  const scopeKey = session
    ? `${session.data.tenant.id}:${session.data.user.id}:${session.bootstrap.scope.branchId ?? ''}`
    : status;
  return <ScopedInventoryOperations key={scopeKey} />;
}

function ScopedInventoryOperations() {
  const { status, session, offlineCommands, flushOffline, refresh } = useSession();
  const [mode, setMode] = useState<Mode>('COUNT');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [commands, setCommands] = useState<OfflineCommand[]>([]);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const scanHandler = useRef<((code: string) => void) | null>(null);
  const syncing = useRef(false);
  const options = useMemo(
    () => (session ? inventoryOptions(session.bootstrap) : null),
    [session],
  );

  const reloadCommands = useCallback(async () => setCommands(await offlineCommands()), [
    offlineCommands,
  ]);
  const synchronize = useCallback(async () => {
    if (!session || syncing.current) return;
    syncing.current = true;
    try {
      const result = await flushOffline();
      await reloadCommands();
      if (result.confirmed || result.rejected) {
        setSyncMessage(
          `${result.confirmed} operación(es) confirmada(s)` +
            (result.rejected ? `; ${result.rejected} con conflicto.` : '.'),
        );
        await refresh();
      }
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 0)) setSyncMessage(messageFor(cause));
    } finally {
      syncing.current = false;
    }
  }, [flushOffline, refresh, reloadCommands, session]);

  useEffect(() => {
    const timer = setTimeout(() => void reloadCommands(), 0);
    const unsubscribe = NetInfo.addEventListener((state) => {
      if (state.isConnected) void synchronize();
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [reloadCommands, session?.bootstrap.scope.deviceId, synchronize]);

  async function openScanner(onCode: (code: string) => void) {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    if (!permission.granted) {
      setScanMessage('Cámara no autorizada; la búsqueda manual sigue disponible.');
      return;
    }
    scanHandler.current = onCode;
    setScanMessage(null);
    setScannerOpen(true);
  }

  function scanned({ data }: BarcodeScanningResult) {
    if (!scannerOpen) return;
    setScannerOpen(false);
    scanHandler.current?.(data);
    setScanMessage(`Código capturado: ${data}`);
  }

  if (status === 'booting') return <Loading />;
  if (status !== 'authenticated' || !session || !options) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Text style={styles.title}>Operaciones de bodega</Text>
          <Text style={styles.muted}>Inicia sesión para operar inventario real.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.title}>Operaciones de bodega</Text>
          <Text style={styles.muted}>
            {session.data.context.warehouse?.name ?? 'Sin bodega'} · Responsable{' '}
            {session.data.user.email}
          </Text>
          <View style={styles.modes}>
            <ModeButton active={mode === 'COUNT'} onPress={() => setMode('COUNT')}>
              Conteo
            </ModeButton>
            <ModeButton active={mode === 'TRANSFER'} onPress={() => setMode('TRANSFER')}>
              Transferir
            </ModeButton>
            <ModeButton active={mode === 'RECEIPT'} onPress={() => setMode('RECEIPT')}>
              Recibir OC
            </ModeButton>
          </View>
          {scannerOpen ? (
            <View style={styles.cameraBox}>
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'qr'] }}
                onBarcodeScanned={scanned}
              />
              <Button label="Cancelar escaneo" kind="secondary" onPress={() => setScannerOpen(false)} />
            </View>
          ) : null}
          {scanMessage ? <Notice>{scanMessage}</Notice> : null}
          {syncMessage ? <Notice>{syncMessage}</Notice> : null}
        </View>
        {mode === 'COUNT' ? (
          <CountPanel
            session={session}
            options={options}
            commands={commands}
            openScanner={openScanner}
            afterQueue={async (commandId) => {
              await synchronize();
              const latest = await offlineCommands();
              setCommands(latest);
              return latest.find((command) => command.commandId === commandId) ?? null;
            }}
          />
        ) : null}
        {mode === 'TRANSFER' ? (
          <TransferPanel session={session} options={options} openScanner={openScanner} />
        ) : null}
        {mode === 'RECEIPT' ? (
          <PurchaseReceiptPanel session={session} options={options} openScanner={openScanner} />
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function CountPanel({
  session,
  options,
  commands,
  openScanner,
  afterQueue,
}: {
  session: AuthenticatedSession;
  options: InventoryOptions;
  commands: OfflineCommand[];
  openScanner: OpenScanner;
  afterQueue(commandId: string): Promise<OfflineCommand | null>;
}) {
  const { queueInventoryCount } = useSession();
  const warehouseId = session.data.context.warehouse?.id;
  const locations = locationsFor(options, warehouseId);
  const [query, setQuery] = useState('');
  const [productId, setProductId] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('Conteo móvil');
  const [reference, setReference] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingKey = useRef<{ fingerprint: string; key: string } | null>(null);
  const products = filterProducts(options.products, query).slice(0, 12);
  const selected = options.products.find((product) => product.id === productId);
  const countCommands = commands.filter((command) => command.kind === 'INVENTORY_COUNT');

  async function submit() {
    const normalized = normalizeQuantity(quantity);
    if (!productId || !locationId || !normalized) {
      setError('Selecciona producto, ubicación y una cantidad válida.');
      return;
    }
    const input = {
      productId,
      locationId,
      countedQuantity: normalized,
      reason,
      reference,
    };
    const fingerprint = JSON.stringify(input);
    const key =
      pendingKey.current?.fingerprint === fingerprint
        ? pendingKey.current.key
        : `mobile-count-${Crypto.randomUUID()}`;
    pendingKey.current = { fingerprint, key };
    setSaving(true);
    setError(null);
    try {
      const command = await queueInventoryCount(input, key);
      const updated = await afterQueue(command.commandId);
      if (updated?.status === 'CONFIRMED') {
        setNotice(`Conteo ${command.commandId.slice(0, 8)} confirmado por el servidor.`);
      } else if (updated && isConflict(updated)) {
        setNotice(null);
        setError(`Conteo rechazado: ${conflictMessage(updated.error)}`);
      } else {
        setNotice(`Conteo ${command.commandId.slice(0, 8)} guardado como pendiente offline.`);
      }
      pendingKey.current = null;
      setQuantity('');
      setReference('');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setSaving(false);
    }
  }

  function selectCode(code: string) {
    setQuery(code);
    const product = findProductByCode(options.products, code);
    if (product) setProductId(product.id);
    else setError(`No existe un producto para ${code}.`);
  }

  return (
    <FlatList
      data={products}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <View style={styles.form}>
          {!session.data.user.permissions.includes('INVENTORY_COUNT') ? (
            <ErrorNotice>Tu rol no permite capturar conteos.</ErrorNotice>
          ) : null}
          <Field label="Buscar o escanear producto">
            <View style={styles.row}>
              <TextInput style={[styles.input, styles.flex]} value={query} onChangeText={setQuery} />
              <Button label="Escanear" kind="secondary" onPress={() => openScanner(selectCode)} />
            </View>
          </Field>
          {selected ? (
            <Notice>
              {selected.name} · saldo base{' '}
              {snapshotQuantity(session.bootstrap, selected.id, locationId)}
            </Notice>
          ) : null}
          <Text style={styles.label}>Ubicación</Text>
          <ChoiceRow
            items={locations.map((location) => ({ id: location.id, label: location.name }))}
            selected={locationId}
            onSelect={setLocationId}
          />
          <Field label="Cantidad contada">
            <TextInput style={styles.input} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" />
          </Field>
          <Field label="Motivo">
            <TextInput style={styles.input} value={reason} onChangeText={setReason} />
          </Field>
          <Field label="Referencia">
            <TextInput style={styles.input} value={reference} onChangeText={setReference} />
          </Field>
          {notice ? <Notice>{notice}</Notice> : null}
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <Button
            label={saving ? 'Guardando…' : 'Guardar conteo'}
            disabled={saving || !session.data.user.permissions.includes('INVENTORY_COUNT')}
            onPress={submit}
          />
          {countCommands.length ? (
            <Text style={styles.muted}>
              {countCommands.filter(isPending).length} pendiente(s) ·{' '}
              {countCommands.filter(isConflict).length} conflicto(s)
            </Text>
          ) : null}
          {countCommands.filter(isConflict).slice(-3).map((command) => (
            <ErrorNotice key={command.commandId}>
              Conflicto {command.commandId.slice(0, 8)}: {conflictMessage(command.error)}
            </ErrorNotice>
          ))}
          <Text style={styles.sectionTitle}>Productos</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={[styles.card, item.id === productId && styles.selectedCard]}
          onPress={() => setProductId(item.id)}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          <Text style={styles.muted}>{item.sku} · {item.barcode ?? 'sin código'}</Text>
        </Pressable>
      )}
      ListEmptyComponent={<Text style={styles.muted}>Sin productos coincidentes.</Text>}
    />
  );
}

function TransferPanel({
  session,
  options,
  openScanner,
}: {
  session: AuthenticatedSession;
  options: InventoryOptions;
  openScanner: OpenScanner;
}) {
  const {
    inventoryTransfers,
    createInventoryTransfer,
    dispatchInventoryTransfer,
    receiveInventoryTransfer,
  } = useSession();
  const currentWarehouseId = session.data.context.warehouse?.id;
  const sourceLocations = locationsFor(options, currentWarehouseId);
  const [transfers, setTransfers] = useState<InventoryTransfer[]>([]);
  const [destinationWarehouseId, setDestinationWarehouseId] = useState('');
  const destinationLocations = locationsFor(options, destinationWarehouseId);
  const [sourceLocationId, setSourceLocationId] = useState(sourceLocations[0]?.id ?? '');
  const [destinationLocationId, setDestinationLocationId] = useState('');
  const [productId, setProductId] = useState('');
  const [query, setQuery] = useState('');
  const [quantity, setQuantity] = useState('');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('Reposición móvil');
  const [receiptQuantities, setReceiptQuantities] = useState<Record<string, string>>({});
  const [discrepancyReasons, setDiscrepancyReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const idempotency = useRef(new Map<string, string>());
  const products = filterProducts(options.products, query).slice(0, 8);
  const permissions = session.data.user.permissions;
  const destinations = options.warehouses.filter((warehouse) => warehouse.id !== currentWarehouseId);

  const load = useEffectEvent(async () => {
    try {
      setTransfers(await inventoryTransfers());
    } catch (cause) {
      setError(onlineMessage(cause));
    }
  });
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [currentWarehouseId]);

  async function create() {
    const normalized = normalizeQuantity(quantity);
    if (
      !destinationWarehouseId ||
      !sourceLocationId ||
      !destinationLocationId ||
      !productId ||
      !normalized ||
      decimalUnits(normalized) <= 0n ||
      reference.trim().length < 2 ||
      reason.trim().length < 2
    ) {
      setError('Completa destino, ubicaciones, producto, cantidad, referencia y motivo.');
      return;
    }
    const input: CreateInventoryTransferInput = {
      destinationWarehouseId,
      reference: reference.trim(),
      reason: reason.trim(),
      lines: [{ productId, sourceLocationId, destinationLocationId, quantity: normalized }],
    };
    await onlineAction(async () => {
      const operation = `create:${JSON.stringify(input)}`;
      const created = await createInventoryTransfer(input, stableKey(idempotency.current, operation, 'mobile-transfer'));
      idempotency.current.delete(operation);
      setTransfers((current) => [created, ...current.filter(({ id }) => id !== created.id)]);
      setMessage(`Transferencia ${created.reference} creada en estado ${created.status}.`);
      setQuantity('');
      setReference('');
    });
  }

  async function dispatch(transfer: InventoryTransfer) {
    await onlineAction(async () => {
      const operation = `dispatch:${transfer.id}`;
      const updated = await dispatchInventoryTransfer(
        transfer.id,
        stableKey(idempotency.current, operation, 'mobile-dispatch'),
      );
      idempotency.current.delete(operation);
      replaceTransfer(updated);
      setMessage(`Transferencia ${updated.reference} despachada.`);
    });
  }

  async function receive(transfer: InventoryTransfer) {
    const lines: ReceiveInventoryTransferInput['lines'] = [];
    let discrepancy = false;
    for (const line of transfer.lines.filter((candidate) => Number(candidate.pendingQuantity) > 0)) {
      const received = normalizeQuantity(receiptQuantities[line.id] ?? line.pendingQuantity);
      if (!received || decimalUnits(received) > decimalUnits(line.pendingQuantity)) {
        setError(`Cantidad inválida para ${line.product.name}.`);
        return;
      }
      const difference = decimalDifference(line.pendingQuantity, received);
      discrepancy ||= decimalUnits(difference) > 0n;
      lines.push({
        transferLineId: line.id,
        receivedQuantity: received,
        discrepancyQuantity: difference,
      });
    }
    const discrepancyReason = discrepancyReasons[transfer.id]?.trim();
    if (discrepancy && (!discrepancyReason || discrepancyReason.length < 2)) {
      setError('Explica la discrepancia antes de recibir.');
      return;
    }
    await onlineAction(async () => {
      const input = { lines, ...(discrepancyReason ? { discrepancyReason } : {}) };
      const operation = `receive:${transfer.id}:${JSON.stringify(input)}`;
      const updated = await receiveInventoryTransfer(
        transfer.id,
        input,
        stableKey(idempotency.current, operation, 'mobile-transfer-receipt'),
      );
      idempotency.current.delete(operation);
      replaceTransfer(updated);
      setMessage(`Recepción de ${updated.reference} confirmada: ${updated.status}.`);
    });
  }

  function replaceTransfer(updated: InventoryTransfer) {
    setTransfers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  async function onlineAction(action: () => Promise<void>) {
    setLoading(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(onlineMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  function scan(code: string) {
    setQuery(code);
    const product = findProductByCode(options.products, code);
    if (product) setProductId(product.id);
    else setError(`No existe un producto para ${code}.`);
  }

  return (
    <FlatList
      data={transfers}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.form}>
          <Notice>Creación, despacho y recepción requieren conexión y confirmación del servidor.</Notice>
          <Text style={styles.sectionTitle}>Nueva transferencia</Text>
          <Text style={styles.label}>Bodega destino</Text>
          <ChoiceRow
            items={destinations.map((item) => ({ id: item.id, label: item.name }))}
            selected={destinationWarehouseId}
            onSelect={(id) => {
              setDestinationWarehouseId(id);
              setDestinationLocationId(locationsFor(options, id)[0]?.id ?? '');
            }}
          />
          <Text style={styles.label}>Ubicación origen</Text>
          <ChoiceRow items={sourceLocations.map(choice)} selected={sourceLocationId} onSelect={setSourceLocationId} />
          <Text style={styles.label}>Ubicación destino</Text>
          <ChoiceRow items={destinationLocations.map(choice)} selected={destinationLocationId} onSelect={setDestinationLocationId} />
          <Field label="Producto">
            <View style={styles.row}>
              <TextInput style={[styles.input, styles.flex]} value={query} onChangeText={setQuery} />
              <Button label="Escanear" kind="secondary" onPress={() => openScanner(scan)} />
            </View>
          </Field>
          <View style={styles.compactChoices}>
            {products.map((product) => (
              <Choice
                key={product.id}
                selected={productId === product.id}
                label={`${product.name} · ${product.sku}`}
                onPress={() => setProductId(product.id)}
              />
            ))}
          </View>
          <Field label="Cantidad"><TextInput style={styles.input} value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" /></Field>
          <Field label="Referencia"><TextInput style={styles.input} value={reference} onChangeText={setReference} /></Field>
          <Field label="Motivo"><TextInput style={styles.input} value={reason} onChangeText={setReason} /></Field>
          {message ? <Notice>{message}</Notice> : null}
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <Button
            label={loading ? 'Procesando…' : 'Crear transferencia'}
            disabled={loading || !permissions.includes('INVENTORY_TRANSFER')}
            onPress={create}
          />
          <Text style={styles.sectionTitle}>Transferencias del contexto</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{item.reference} · {item.status}</Text>
          <Text style={styles.muted}>{item.originWarehouse.name} → {item.destinationWarehouse.name}</Text>
          {item.lines.map((line) => (
            <View key={line.id} style={styles.lineBlock}>
              <Text>{line.product.name} · pendiente {line.pendingQuantity}</Text>
              {mayReceiveTransfer(item, currentWarehouseId, permissions) ? (
                <TextInput
                  style={styles.input}
                  value={receiptQuantities[line.id] ?? line.pendingQuantity}
                  onChangeText={(value) =>
                    setReceiptQuantities((current) => ({ ...current, [line.id]: value }))
                  }
                  keyboardType="decimal-pad"
                  accessibilityLabel={`Cantidad recibida ${line.product.name}`}
                />
              ) : null}
            </View>
          ))}
          {mayDispatch(item, currentWarehouseId, permissions) ? (
            <Button label="Despachar" disabled={loading} onPress={() => dispatch(item)} />
          ) : null}
          {mayReceiveTransfer(item, currentWarehouseId, permissions) ? (
            <>
              <TextInput
                style={styles.input}
                placeholder="Motivo si hay discrepancia"
                value={discrepancyReasons[item.id] ?? ''}
                onChangeText={(value) =>
                  setDiscrepancyReasons((current) => ({ ...current, [item.id]: value }))
                }
              />
              <Button label="Confirmar recepción" disabled={loading} onPress={() => receive(item)} />
            </>
          ) : null}
        </View>
      )}
      ListEmptyComponent={<Text style={styles.muted}>No hay transferencias visibles o no hay conexión.</Text>}
    />
  );
}

function PurchaseReceiptPanel({
  session,
  options,
  openScanner,
}: {
  session: AuthenticatedSession;
  options: InventoryOptions;
  openScanner: OpenScanner;
}) {
  const { purchaseOrders, receivePurchaseOrder } = useSession();
  const locations = locationsFor(options, session.data.context.warehouse?.id);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [documentReference, setDocumentReference] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const idempotency = useRef(new Map<string, string>());
  const selected = orders.find(({ id }) => id === selectedId);
  const mayManage = session.data.user.permissions.includes('PURCHASE_ORDERS_MANAGE');

  const load = useEffectEvent(async () => {
    if (!mayManage) return;
    try {
      setOrders(receivableOrders(await purchaseOrders()));
    } catch (cause) {
      setError(onlineMessage(cause));
    }
  });
  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [session.data.context.warehouse?.id]);

  function scan(code: string) {
    const product = findProductByCode(options.products, code);
    const order = product
      ? orders.find((candidate) =>
          candidate.lines.some(
            (line) => line.productId === product.id && Number(line.remainingQuantity) > 0,
          ),
        )
      : null;
    if (order) setSelectedId(order.id);
    else setError(`No hay una orden recibible para ${code}.`);
  }

  async function receive() {
    if (!selected || !locationId || !documentReference.trim()) {
      setError('Selecciona orden, ubicación y referencia documental.');
      return;
    }
    const lines = selected.lines
      .map((line) => ({
        line,
        quantity: normalizeQuantity(quantities[line.id] ?? line.remainingQuantity),
      }))
      .filter(({ quantity }) => quantity && decimalUnits(quantity) > 0n);
    if (
      !lines.length ||
      lines.some(({ line, quantity }) => decimalUnits(quantity!) > decimalUnits(line.remainingQuantity))
    ) {
      setError('Las cantidades deben ser positivas y no exceder lo pendiente.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const input = {
        version: selected.version,
        locationId,
        documentReference: documentReference.trim(),
        lines: lines.map(({ line, quantity }) => ({
          purchaseOrderLineId: line.id,
          receivedQuantity: quantity!,
        })),
      };
      const operation = `purchase-receipt:${selected.id}:${JSON.stringify(input)}`;
      const updated = await receivePurchaseOrder(
        selected.id,
        input,
        stableKey(idempotency.current, operation, 'mobile-purchase-receipt'),
      );
      idempotency.current.delete(operation);
      setOrders((current) => receivableOrders(current.map((item) => (item.id === updated.id ? updated : item))));
      setMessage(`Recepción de ${updated.folio} confirmada por el servidor.`);
      setSelectedId('');
      setDocumentReference('');
      setQuantities({});
    } catch (cause) {
      setError(onlineMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <FlatList
      data={orders}
      keyExtractor={(item) => item.id}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={styles.form}>
          <Notice>La recepción requiere conexión; nunca se muestra confirmada antes del servidor.</Notice>
          {!mayManage ? <ErrorNotice>Tu rol no permite recibir órdenes de compra.</ErrorNotice> : null}
          <Button label="Escanear producto" kind="secondary" onPress={() => openScanner(scan)} />
          <Text style={styles.label}>Ubicación de recepción</Text>
          <ChoiceRow items={locations.map(choice)} selected={locationId} onSelect={setLocationId} />
          {selected ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>{selected.folio} · {selected.supplier.name}</Text>
              {selected.lines.filter((line) => Number(line.remainingQuantity) > 0).map((line) => (
                <Field key={line.id} label={`${line.productName} · pendiente ${line.remainingQuantity}`}>
                  <TextInput
                    style={styles.input}
                    value={quantities[line.id] ?? line.remainingQuantity}
                    onChangeText={(value) => setQuantities((current) => ({ ...current, [line.id]: value }))}
                    keyboardType="decimal-pad"
                  />
                </Field>
              ))}
              <Field label="Documento / remisión">
                <TextInput style={styles.input} value={documentReference} onChangeText={setDocumentReference} />
              </Field>
              <Button label={loading ? 'Confirmando…' : 'Confirmar recepción'} disabled={loading || !mayManage} onPress={receive} />
            </View>
          ) : null}
          {message ? <Notice>{message}</Notice> : null}
          {error ? <ErrorNotice>{error}</ErrorNotice> : null}
          <Text style={styles.sectionTitle}>Órdenes recibibles</Text>
        </View>
      }
      renderItem={({ item }) => (
        <Pressable
          style={[styles.card, item.id === selectedId && styles.selectedCard]}
          onPress={() => setSelectedId(item.id)}>
          <Text style={styles.cardTitle}>{item.folio} · {item.status}</Text>
          <Text style={styles.muted}>{item.supplier.name} · versión {item.version}</Text>
        </Pressable>
      )}
      ListEmptyComponent={<Text style={styles.muted}>No hay órdenes recibibles o no hay conexión.</Text>}
    />
  );
}

function Loading() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.light.primary} />
        <Text style={styles.muted}>Cargando operaciones…</Text>
      </View>
    </SafeAreaView>
  );
}

function ModeButton({ active, onPress, children }: { active: boolean; onPress(): void; children: string }) {
  return (
    <Pressable style={[styles.mode, active && styles.modeActive]} onPress={onPress}>
      <Text style={[styles.modeText, active && styles.modeTextActive]}>{children}</Text>
    </Pressable>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text>{children}</View>;
}

function Button({
  label,
  onPress,
  disabled = false,
  kind = 'primary',
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
  kind?: 'primary' | 'secondary';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'secondary' && styles.secondaryButton,
        (pressed || disabled) && styles.dimmed,
      ]}>
      <Text style={[styles.buttonText, kind === 'secondary' && styles.secondaryButtonText]}>{label}</Text>
    </Pressable>
  );
}

function ChoiceRow({
  items,
  selected,
  onSelect,
}: {
  items: { id: string; label: string }[];
  selected: string;
  onSelect(id: string): void;
}) {
  return (
    <View style={styles.compactChoices}>
      {items.map((item) => (
        <Choice key={item.id} label={item.label} selected={selected === item.id} onPress={() => onSelect(item.id)} />
      ))}
      {!items.length ? <Text style={styles.muted}>Sin opciones en el alcance actual.</Text> : null}
    </View>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable style={[styles.choice, selected && styles.choiceSelected]} onPress={onPress}>
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <View style={styles.notice}><Text style={styles.noticeText}>{children}</Text></View>;
}

function ErrorNotice({ children }: { children: React.ReactNode }) {
  return <View style={styles.errorNotice}><Text style={styles.errorText}>{children}</Text></View>;
}

function choice(item: { id: string; name: string }) {
  return { id: item.id, label: item.name };
}

function isPending(command: OfflineCommand) {
  return command.status === 'PENDING' || command.status === 'SENT' || (command.status === 'ERROR' && command.retryable);
}

function isConflict(command: OfflineCommand) {
  return command.status === 'ERROR' && !command.retryable;
}

function decimalDifference(expected: string, actual: string): string {
  const value = decimalUnits(expected) - decimalUnits(actual);
  return `${value / 1000n}.${String(value % 1000n).padStart(3, '0')}`;
}

function decimalUnits(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'));
}

function onlineMessage(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 0) {
    return 'Esta operación requiere conexión; no se guardó ni se confirmó.';
  }
  return messageFor(cause);
}

function stableKey(keys: Map<string, string>, operation: string, prefix: string): string {
  const existing = keys.get(operation);
  if (existing) return existing;
  const created = `${prefix}-${Crypto.randomUUID()}`;
  keys.set(operation, created);
  return created;
}

function conflictMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as {
      conflict?: { userAction?: string };
      details?: { message?: string };
    };
    return candidate.conflict?.userAction ?? candidate.details?.message ?? 'Revisión manual requerida.';
  }
  return typeof error === 'string' ? error : 'Revisión manual requerida.';
}

function messageFor(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'No fue posible completar la operación.';
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  flex: { flex: 1 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, padding: Spacing.four },
  header: { paddingHorizontal: Spacing.three, paddingTop: Spacing.two, gap: Spacing.two },
  content: { padding: Spacing.three, gap: Spacing.two, paddingBottom: 120 },
  form: { gap: Spacing.two },
  title: { fontSize: 24, fontWeight: '800', color: Colors.light.text },
  sectionTitle: { fontSize: 18, fontWeight: '800', marginTop: Spacing.two, color: Colors.light.text },
  muted: { color: Colors.light.textSecondary },
  modes: { flexDirection: 'row', gap: Spacing.one },
  mode: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: Colors.light.border },
  modeActive: { backgroundColor: Colors.light.primary },
  modeText: { fontWeight: '700', color: Colors.light.textSecondary },
  modeTextActive: { color: '#FFFFFF' },
  cameraBox: { height: 250, overflow: 'hidden', borderRadius: 16, gap: Spacing.one },
  camera: { flex: 1 },
  field: { gap: Spacing.one },
  label: { fontWeight: '700', color: Colors.light.text },
  input: { minHeight: 46, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, backgroundColor: '#FFFFFF', paddingHorizontal: Spacing.three, color: Colors.light.text },
  row: { flexDirection: 'row', gap: Spacing.two, alignItems: 'center' },
  compactChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  choice: { minHeight: 42, justifyContent: 'center', paddingHorizontal: Spacing.two, borderRadius: 10, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: '#FFFFFF' },
  choiceSelected: { backgroundColor: Colors.light.backgroundElement, borderColor: Colors.light.primary },
  choiceText: { color: Colors.light.textSecondary },
  choiceTextSelected: { color: Colors.light.primary, fontWeight: '700' },
  card: { padding: Spacing.three, borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: '#FFFFFF', gap: Spacing.one, marginBottom: Spacing.two },
  selectedCard: { borderColor: Colors.light.primary, backgroundColor: Colors.light.backgroundElement },
  cardTitle: { fontWeight: '800', color: Colors.light.text },
  lineBlock: { gap: Spacing.one, paddingVertical: Spacing.one },
  button: { minHeight: 46, paddingHorizontal: Spacing.three, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.light.primary },
  secondaryButton: { backgroundColor: Colors.light.backgroundElement, borderWidth: 1, borderColor: Colors.light.border },
  buttonText: { color: '#FFFFFF', fontWeight: '800' },
  secondaryButtonText: { color: Colors.light.primary },
  dimmed: { opacity: 0.55 },
  notice: { padding: Spacing.two, borderRadius: 10, backgroundColor: '#E8F3FF' },
  noticeText: { color: '#164E7A' },
  errorNotice: { padding: Spacing.two, borderRadius: 10, backgroundColor: '#FDECEC' },
  errorText: { color: '#8B1E1E' },
});
