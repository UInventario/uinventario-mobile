import NetInfo from '@react-native-community/netinfo';
import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import * as Crypto from 'expo-crypto';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
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
import { useSession } from '@/auth/session-context';
import { buildCatalogView, filterProducts, findProductByCode } from '@/catalog/catalog-model';
import { Colors, Spacing } from '@/constants/theme';

import { PaymentMethod, PosCartLineInput, PosQuote } from './contracts';
import { offlineQuote } from './pos-model';

interface CartItem {
  productId: string;
  name: string;
  sku: string;
  quantity: number;
}

export function PosScreen() {
  const { status, session } = useSession();
  const scopeKey = session
    ? `${session.data.tenant.id}:${session.data.user.id}:${session.bootstrap.scope.branchId ?? ''}:${session.bootstrap.scope.cashRegisterId ?? ''}`
    : status;
  return <ScopedPosScreen key={scopeKey} />;
}

function ScopedPosScreen() {
  const {
    status,
    session,
    busy,
    quote: quoteOnline,
    paymentOptions,
    cashSale,
    sale,
    queueCashSale,
    offlineCommands,
    flushOffline,
    refresh,
  } = useSession();
  const [query, setQuery] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [quote, setQuote] = useState<PosQuote | null>(null);
  const [quoteSource, setQuoteSource] = useState<'ONLINE' | 'OFFLINE' | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>(['CASH']);
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  const [cashReceived, setCashReceived] = useState('');
  const [reference, setReference] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const syncActive = useRef(false);
  const cartRevision = useRef(0);
  const pendingSale = useRef<{ fingerprint: string; key: string } | null>(null);
  const catalog = useMemo(
    () => (session ? buildCatalogView(session.bootstrap) : null),
    [session],
  );
  const products = useMemo(
    () => filterProducts(catalog?.products ?? [], query).slice(0, 30),
    [catalog?.products, query],
  );

  const synchronize = useEffectEvent(async () => {
    if (!session || syncActive.current) return;
    syncActive.current = true;
    try {
      const result = await flushOffline();
      setPendingCount((await offlineCommands()).filter(isPending).length);
      if (result.confirmed || result.rejected) {
        setNotice(
          `${result.confirmed} venta(s) sincronizada(s)` +
            (result.rejected ? `; ${result.rejected} rechazada(s).` : '.'),
        );
        await refresh();
      }
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 0)) setActionError(messageFor(cause));
    } finally {
      syncActive.current = false;
    }
  });

  const loadStartup = useEffectEvent(async () => {
    try {
      const [available, commands] = await Promise.all([paymentOptions(), offlineCommands()]);
      setMethods(available.length ? available : ['CASH']);
      setMethod((current) =>
        available.includes(current) ? current : (available[0] ?? 'CASH'),
      );
      setPendingCount(commands.filter(isPending).length);
    } catch {
      // Cash remains the safe fallback when online payment options are unavailable.
    }
  });

  useEffect(() => {
    let active = true;
    const startup = setTimeout(() => {
      if (active) void loadStartup();
    }, 0);
    const unsubscribe = NetInfo.addEventListener((network) => {
      if (network.isConnected) void synchronize();
    });
    return () => {
      active = false;
      clearTimeout(startup);
      unsubscribe();
    };
  }, []);

  if (status === 'booting') {
    return <Centered text="Preparando el POS móvil…" loading />;
  }
  if (status !== 'authenticated' || !session || !catalog) {
    return <Centered text="Inicia sesión en Inicio para registrar ventas." />;
  }
  if (!session.data.user.permissions.includes('SALES_MANAGE')) {
    return <Centered text="Tu sesión no tiene permiso para registrar ventas." />;
  }

  const lines = cartLines(cart);

  function resetQuote() {
    setQuote(null);
    setQuoteSource(null);
    setCashReceived('');
    pendingSale.current = null;
  }

  function addProduct(productId: string) {
    const product = catalog!.products.find(({ id }) => id === productId);
    if (!product) return;
    cartRevision.current += 1;
    setCart((current) => {
      const existing = current.find((item) => item.productId === product.id);
      return existing
        ? current.map((item) =>
            item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item,
          )
        : [...current, { productId: product.id, name: product.name, sku: product.sku, quantity: 1 }];
    });
    resetQuote();
    setNotice(null);
    setActionError(null);
  }

  function changeQuantity(productId: string, delta: number) {
    cartRevision.current += 1;
    setCart((current) =>
      current
        .map((item) =>
          item.productId === productId ? { ...item, quantity: item.quantity + delta } : item,
        )
        .filter(({ quantity }) => quantity > 0),
    );
    resetQuote();
  }

  async function calculateQuote() {
    if (!lines.length) return;
    const requestedRevision = cartRevision.current;
    setNotice(null);
    setActionError(null);
    try {
      const online = await quoteOnline(lines);
      if (requestedRevision !== cartRevision.current) return;
      assertQuoteScope(online, session!);
      setQuote(online);
      setQuoteSource('ONLINE');
      setCashReceived((current) => current || online.totals.total);
    } catch (cause) {
      if (!(cause instanceof ApiError && cause.status === 0)) {
        setActionError(messageFor(cause));
        return;
      }
      try {
        const local = offlineQuote(session!.bootstrap, lines, await offlineCommands());
        if (requestedRevision !== cartRevision.current) return;
        setQuote(local);
        setQuoteSource('OFFLINE');
        setMethod('CASH');
        setCashReceived((current) => current || local.totals.total);
        setNotice('Cotización offline: sólo efectivo y dentro de la vigencia indicada.');
      } catch (offlineError) {
        setActionError(messageFor(offlineError));
      }
    }
  }

  async function completeSale() {
    if (!quote || !lines.length) return;
    if (method !== 'CASH' && reference.trim().length < 4) {
      setActionError('Captura una referencia de autorización de al menos 4 caracteres.');
      return;
    }
    setActionError(null);
    setNotice(null);
    const fingerprint = JSON.stringify({ lines, method, cashReceived, reference });
    const key =
      pendingSale.current?.fingerprint === fingerprint
        ? pendingSale.current.key
        : `mobile-sale-${Crypto.randomUUID()}`;
    pendingSale.current = { fingerprint, key };
    try {
      const completed =
        method === 'CASH'
          ? await cashSale({ lines, cashReceived }, key)
          : await sale(
              {
                lines,
                payment: { method, amount: quote.totals.total, reference: reference.trim() },
              },
              key,
            );
      pendingSale.current = null;
      setNotice(`Venta ${completed.receiptNumber} completada por ${completed.totals.total}.`);
      clearCart();
      await refresh().catch(() => {
        setNotice(
          `Venta ${completed.receiptNumber} completada; el stock se actualizará al reconectar.`,
        );
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 0 && method === 'CASH') {
        try {
          const command = await queueCashSale(quote, { lines, cashReceived }, key);
          pendingSale.current = null;
          setPendingCount((await offlineCommands()).filter(isPending).length);
          setNotice(`Venta ${command.commandId.slice(0, 8)} guardada; se enviará al reconectar.`);
          clearCart();
          return;
        } catch (queueError) {
          setActionError(messageFor(queueError));
          return;
        }
      }
      setActionError(
        cause instanceof ApiError && cause.status === 0
          ? 'Los pagos distintos de efectivo requieren conexión.'
          : messageFor(cause),
      );
      if (cause instanceof ApiError && cause.status > 0 && cause.status < 500) {
        pendingSale.current = null;
      }
    }
  }

  function clearCart() {
    cartRevision.current += 1;
    setCart([]);
    setQuote(null);
    setQuoteSource(null);
    setCashReceived('');
    setReference('');
  }

  async function openScanner() {
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    if (!permission.granted) {
      setActionError('Cámara no autorizada. Usa la búsqueda manual para agregar productos.');
      return;
    }
    setScannerOpen(true);
  }

  function scanned({ data }: BarcodeScanningResult) {
    if (!scannerOpen) return;
    setScannerOpen(false);
    const product = findProductByCode(catalog!.products, data);
    if (!product) {
      setQuery(data);
      setActionError(`No se encontró un producto para ${data}.`);
      return;
    }
    addProduct(product.id);
    setNotice(`${product.name} agregado por escaneo.`);
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <FlatList
          contentContainerStyle={styles.content}
          data={products}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={styles.headerContent}>
              <View>
                <Text style={styles.eyebrow}>VENTA MÓVIL</Text>
                <Text style={styles.title}>{session.data.context.cashRegister?.name ?? 'Sin caja'}</Text>
                <Text style={styles.muted}>
                  {session.data.context.branch?.name ?? 'Sin sucursal'} · {pendingCount} pendiente(s)
                </Text>
              </View>

              {notice ? <Text style={styles.notice}>{notice}</Text> : null}
              {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
              {busy ? <ActivityIndicator color={Colors.light.primary} /> : null}

              {cart.length ? (
                <View style={styles.cartCard}>
                  <Text style={styles.sectionTitle}>Carrito</Text>
                  {cart.map((item) => (
                    <View key={item.productId} style={styles.cartRow}>
                      <View style={styles.productCopy}>
                        <Text style={styles.productName}>{item.name}</Text>
                        <Text style={styles.muted}>{item.sku}</Text>
                      </View>
                      <Pressable accessibilityLabel={`Quitar ${item.name}`} onPress={() => changeQuantity(item.productId, -1)} style={styles.quantityButton}>
                        <Text style={styles.quantityButtonText}>−</Text>
                      </Pressable>
                      <Text style={styles.quantity}>{item.quantity}</Text>
                      <Pressable accessibilityLabel={`Agregar otro ${item.name}`} onPress={() => changeQuantity(item.productId, 1)} style={styles.quantityButton}>
                        <Text style={styles.quantityButtonText}>+</Text>
                      </Pressable>
                    </View>
                  ))}
                  <Pressable disabled={busy} onPress={() => void calculateQuote()} style={styles.primaryButton}>
                    <Text style={styles.primaryText}>Calcular total en servidor</Text>
                  </Pressable>
                </View>
              ) : null}

              {quote ? (
                <View style={styles.quoteCard}>
                  <View style={styles.quoteHeading}>
                    <Text style={styles.sectionTitle}>Total {quote.currency} {quote.totals.total}</Text>
                    <Text style={styles.source}>{quoteSource === 'ONLINE' ? 'Servidor' : 'Offline'}</Text>
                  </View>
                  <Text style={styles.muted}>Subtotal {quote.totals.subtotal} · Impuesto {quote.totals.tax}</Text>
                  <View style={styles.methodRow}>
                    {(quoteSource === 'OFFLINE' ? ['CASH'] as PaymentMethod[] : methods).map((item) => (
                      <Pressable key={item} onPress={() => setMethod(item)} style={[styles.methodChip, method === item && styles.methodSelected]}>
                        <Text style={[styles.methodText, method === item && styles.methodTextSelected]}>{paymentLabel(item)}</Text>
                      </Pressable>
                    ))}
                  </View>
                  {method === 'CASH' ? (
                    <TextInput accessibilityLabel="Efectivo recibido" inputMode="decimal" onChangeText={setCashReceived} placeholder="Efectivo recibido" style={styles.input} value={cashReceived} />
                  ) : (
                    <TextInput accessibilityLabel="Referencia del pago" autoCapitalize="characters" onChangeText={setReference} placeholder="Referencia de autorización" style={styles.input} value={reference} />
                  )}
                  <Pressable disabled={busy} onPress={() => void completeSale()} style={styles.completeButton}>
                    <Text style={styles.completeText}>Cobrar {quote.currency} {quote.totals.total}</Text>
                  </Pressable>
                </View>
              ) : null}

              <View style={styles.searchRow}>
                <TextInput accessibilityLabel="Buscar producto para vender" autoCapitalize="none" onChangeText={setQuery} placeholder="Nombre, SKU o código" style={styles.input} value={query} />
                <Pressable accessibilityLabel="Escanear producto" onPress={() => void openScanner()} style={styles.scanButton}>
                  <Text style={styles.scanText}>Escanear</Text>
                </Pressable>
              </View>
              {scannerOpen ? (
                <View style={styles.cameraCard}>
                  <CameraView barcodeScannerSettings={{ barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128'] }} onBarcodeScanned={scanned} style={styles.camera} />
                  <Pressable onPress={() => setScannerOpen(false)} style={styles.cameraClose}>
                    <Text style={styles.cameraCloseText}>Cerrar cámara</Text>
                  </Pressable>
                </View>
              ) : null}
              <Text style={styles.sectionTitle}>Agregar producto</Text>
            </View>
          }
          ListEmptyComponent={<Text style={styles.muted}>Sin productos coincidentes.</Text>}
          renderItem={({ item }) => (
            <Pressable accessibilityHint="Agrega una unidad al carrito" accessibilityRole="button" onPress={() => addProduct(item.id)} style={({ pressed }) => [styles.productRow, pressed && styles.pressed]}>
              <View style={styles.productCopy}>
                <Text style={styles.productName}>{item.name}</Text>
                <Text style={styles.muted}>{item.sku}</Text>
              </View>
              <Text style={styles.productPrice}>${item.price}</Text>
            </Pressable>
          )}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function cartLines(cart: CartItem[]): PosCartLineInput[] {
  return cart.map(({ productId, quantity }) => ({ productId, quantity: String(quantity) }));
}

function assertQuoteScope(quote: PosQuote, session: NonNullable<ReturnType<typeof useSession>['session']>) {
  if (
    quote.context.branch.id !== session.data.context.branch?.id ||
    quote.context.warehouse.id !== session.data.context.warehouse?.id ||
    quote.context.cashRegister.id !== session.data.context.cashRegister?.id
  ) {
    throw new Error('La cotización no pertenece a la caja activa.');
  }
}

function isPending(command: { status: string; retryable: boolean }) {
  return command.status === 'PENDING' || command.status === 'SENT' || (command.status === 'ERROR' && command.retryable);
}

function paymentLabel(method: PaymentMethod) {
  return ({ CASH: 'Efectivo', CARD: 'Tarjeta', TRANSFER: 'Transferencia', VOUCHER: 'Vale' } as const)[method];
}

function messageFor(error: unknown) {
  return error instanceof Error ? error.message : 'La operación no pudo completarse.';
}

function Centered({ text, loading = false }: { text: string; loading?: boolean }) {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.centered}>
        {loading ? <ActivityIndicator color={Colors.light.primary} size="large" /> : null}
        <Text style={styles.muted}>{text}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  centered: { flex: 1, padding: Spacing.four, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  content: { padding: Spacing.four, paddingBottom: 120, gap: Spacing.two },
  headerContent: { gap: Spacing.three, marginBottom: Spacing.three },
  eyebrow: { color: Colors.light.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  title: { color: Colors.light.text, fontSize: 28, fontWeight: '800' },
  sectionTitle: { color: Colors.light.text, fontSize: 18, fontWeight: '800' },
  muted: { color: Colors.light.textSecondary, fontSize: 13, lineHeight: 19 },
  notice: { padding: Spacing.three, borderRadius: 12, color: '#185B37', backgroundColor: '#E9F5EE' },
  error: { padding: Spacing.three, borderRadius: 12, color: '#A82836', backgroundColor: '#FFF0F1' },
  cartCard: { padding: Spacing.three, gap: Spacing.two, borderRadius: 16, backgroundColor: Colors.light.backgroundElement },
  cartRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  productCopy: { flex: 1, gap: Spacing.one },
  productName: { color: Colors.light.text, fontSize: 15, fontWeight: '700' },
  quantityButton: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  quantityButtonText: { color: Colors.light.primary, fontSize: 22, fontWeight: '800' },
  quantity: { minWidth: 24, textAlign: 'center', color: Colors.light.text, fontWeight: '800' },
  primaryButton: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.light.primary },
  primaryText: { color: '#FFFFFF', fontWeight: '800' },
  quoteCard: { padding: Spacing.four, gap: Spacing.three, borderRadius: 18, backgroundColor: Colors.light.navy },
  quoteHeading: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  source: { marginLeft: 'auto', color: '#DCE7F8', fontSize: 12, fontWeight: '700' },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.two },
  methodChip: { minHeight: 44, paddingHorizontal: Spacing.three, borderRadius: 99, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF22' },
  methodSelected: { backgroundColor: '#FFFFFF' },
  methodText: { color: '#FFFFFF', fontWeight: '700' },
  methodTextSelected: { color: Colors.light.navy },
  input: { minHeight: 48, flex: 1, paddingHorizontal: Spacing.three, borderRadius: 12, borderWidth: 1, borderColor: Colors.light.border, color: Colors.light.text, backgroundColor: '#FFFFFF' },
  completeButton: { minHeight: 50, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#3BB273' },
  completeText: { color: '#FFFFFF', fontWeight: '800' },
  searchRow: { flexDirection: 'row', gap: Spacing.two },
  scanButton: { minHeight: 48, paddingHorizontal: Spacing.three, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.light.primary },
  scanText: { color: '#FFFFFF', fontWeight: '800' },
  cameraCard: { overflow: 'hidden', borderRadius: 18, backgroundColor: Colors.light.navy },
  camera: { height: 260 },
  cameraClose: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  cameraCloseText: { color: '#FFFFFF', fontWeight: '800' },
  productRow: { minHeight: 64, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: '#FFFFFF' },
  productPrice: { color: Colors.light.primary, fontWeight: '800' },
  pressed: { opacity: 0.65 },
});
