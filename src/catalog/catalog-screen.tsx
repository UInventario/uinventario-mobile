import { BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useCallback, useMemo, useState } from 'react';
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
import { Colors, Spacing } from '@/constants/theme';

import {
  CatalogProduct,
  buildCatalogView,
  canReadProductCost,
  filterProducts,
  findProductByCode,
  isCatalogStale,
  stockForProduct,
} from './catalog-model';

type DetailState = { productId: string; cost: string | null; status: 'ready' | 'offline' | 'error' };

export function CatalogScreen() {
  const { status, session } = useSession();
  const scopeKey = session
    ? `${session.data.tenant.id}:${session.data.user.id}:${session.bootstrap.scope.branchId ?? ''}`
    : status;
  return <ScopedCatalogScreen key={scopeKey} />;
}

function ScopedCatalogScreen() {
  const { status, session, busy, error, product: loadProduct, refresh } = useSession();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CatalogProduct | null>(null);
  const [detail, setDetail] = useState<DetailState | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMessage, setScanMessage] = useState<string | null>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const catalog = useMemo(
    () => (session ? buildCatalogView(session.bootstrap) : null),
    [session],
  );
  const filtered = useMemo(
    () => filterProducts(catalog?.products ?? [], query),
    [catalog?.products, query],
  );
  const mayReadCost = canReadProductCost(session?.data.user.permissions ?? []);
  const selectProduct = useCallback(
    async (next: CatalogProduct) => {
      setSelected(next);
      setDetail(null);
      if (!mayReadCost) return;
      try {
        const online = await loadProduct(next.id);
        if (online.id !== next.id) throw new Error('El detalle recibido no corresponde al producto.');
        setDetail({ productId: next.id, cost: online.cost, status: 'ready' });
      } catch (cause) {
        setDetail({
          productId: next.id,
          cost: null,
          status: cause instanceof ApiError && cause.status === 0 ? 'offline' : 'error',
        });
      }
    },
    [loadProduct, mayReadCost],
  );

  const scan = useCallback(
    ({ data }: BarcodeScanningResult) => {
      if (!scannerOpen || !catalog) return;
      setScannerOpen(false);
      setQuery(data);
      const match = findProductByCode(catalog.products, data);
      if (!match) {
        setSelected(null);
        setScanMessage(`No se encontró un producto para ${data}. Puedes corregirlo manualmente.`);
        return;
      }
      setScanMessage(`Código reconocido: ${match.name}.`);
      void selectProduct(match);
    },
    [catalog, scannerOpen, selectProduct],
  );

  async function openScanner() {
    setScanMessage(null);
    const permission = cameraPermission?.granted
      ? cameraPermission
      : await requestCameraPermission();
    if (!permission.granted) {
      setScannerOpen(false);
      setScanMessage('Cámara no autorizada. La búsqueda manual sigue disponible.');
      return;
    }
    setScannerOpen(true);
  }

  if (status === 'booting') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <ActivityIndicator color={Colors.light.primary} size="large" />
          <Text style={styles.muted}>Cargando catálogo protegido…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (status !== 'authenticated' || !session || !catalog) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Text style={styles.title}>Catálogo móvil</Text>
          <Text style={styles.muted}>Inicia sesión en Inicio para consultar productos y stock.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const stock = selected ? stockForProduct(catalog, selected.id) : [];
  const stale = isCatalogStale(session.bootstrap.generatedAt);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}>
        <FlatList
          contentContainerStyle={styles.content}
          data={filtered}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={styles.headerContent}>
              <View>
                <Text style={styles.eyebrow}>CATÁLOGO AUTORIZADO</Text>
                <Text style={styles.title}>Productos y existencias</Text>
                <Text style={styles.muted}>
                  {session.data.context.branch?.name ?? 'Sin sucursal'} · sincronizado{' '}
                  {new Date(session.bootstrap.generatedAt).toLocaleString()}
                </Text>
              </View>

              <View style={[styles.syncBanner, stale && styles.warningBanner]}>
                <Text style={styles.syncText}>
                  {stale
                    ? 'Datos desactualizados: renueva antes de operar.'
                    : 'Catálogo local listo para consulta sin conexión.'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() => void refresh().catch(() => undefined)}
                  style={({ pressed }) => [styles.inlineButton, pressed && styles.pressed]}>
                  <Text style={styles.inlineButtonText}>Sincronizar</Text>
                </Pressable>
              </View>

              <View style={styles.searchRow}>
                <TextInput
                  accessibilityLabel="Buscar producto"
                  autoCapitalize="none"
                  onChangeText={(value) => {
                    setQuery(value);
                    setScanMessage(null);
                  }}
                  placeholder="Nombre, SKU o código"
                  placeholderTextColor={Colors.light.textSecondary}
                  returnKeyType="search"
                  style={styles.input}
                  value={query}
                />
                <Pressable
                  accessibilityLabel="Escanear código con la cámara"
                  accessibilityRole="button"
                  onPress={() => void openScanner()}
                  style={({ pressed }) => [styles.scanButton, pressed && styles.pressed]}>
                  <Text style={styles.scanButtonText}>Escanear</Text>
                </Pressable>
              </View>

              {scannerOpen ? (
                <View style={styles.cameraCard}>
                  <CameraView
                    barcodeScannerSettings={{
                      barcodeTypes: ['qr', 'ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
                    }}
                    onBarcodeScanned={scan}
                    style={styles.camera}
                  />
                  <View style={styles.cameraFooter}>
                    <Text style={styles.cameraText}>Alinea el código dentro del visor.</Text>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setScannerOpen(false)}
                      style={({ pressed }) => [styles.cameraClose, pressed && styles.pressed]}>
                      <Text style={styles.cameraCloseText}>Cerrar</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {scanMessage ? (
                <Text accessibilityLiveRegion="polite" style={styles.message}>
                  {scanMessage}
                </Text>
              ) : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {busy ? <ActivityIndicator color={Colors.light.primary} /> : null}

              {selected ? (
                <View style={styles.detailCard}>
                  <Text style={styles.detailTitle}>{selected.name}</Text>
                  <Text style={styles.detailMeta}>SKU {selected.sku}</Text>
                  <Text style={styles.detailMeta}>
                    {selected.categoryName ?? 'Sin categoría'} · {selected.brandName ?? 'Sin marca'}
                  </Text>
                  <View style={styles.priceRow}>
                    <Value label="Precio" value={`$${selected.price}`} />
                    <Value
                      label="Costo"
                      value={costLabel(mayReadCost, detail, selected.id)}
                    />
                  </View>
                  <Text style={styles.stockTitle}>Stock por ubicación</Text>
                  {stock.length ? (
                    stock.map((row) => (
                      <View key={row.locationId} style={styles.stockRow}>
                        <View style={styles.stockCopy}>
                          <Text style={styles.stockName}>{row.locationName}</Text>
                          <Text style={styles.detailMeta}>
                            {row.warehouseName} · {row.locationCode}
                          </Text>
                        </View>
                        <Text style={styles.quantity}>{row.availableQuantity}</Text>
                      </View>
                    ))
                  ) : (
                    <Text style={styles.muted}>Sin existencias registradas en ubicaciones autorizadas.</Text>
                  )}
                </View>
              ) : null}

              <Text style={styles.listTitle}>{filtered.length} productos</Text>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.emptyCard}>
              <Text style={styles.detailTitle}>Sin coincidencias</Text>
              <Text style={styles.muted}>Prueba con otro nombre, SKU o código de barras.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityHint="Abre el detalle y existencias por ubicación"
              accessibilityRole="button"
              onPress={() => void selectProduct(item)}
              style={({ pressed }) => [styles.productRow, pressed && styles.pressed]}>
              <View style={styles.productCopy}>
                <Text style={styles.productName}>{item.name}</Text>
                <Text style={styles.detailMeta}>
                  {item.sku}{item.barcode ? ` · ${item.barcode}` : ''}
                </Text>
              </View>
              <Text style={styles.productPrice}>${item.price}</Text>
            </Pressable>
          )}
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function costLabel(mayRead: boolean, detail: DetailState | null, productId: string): string {
  if (!mayRead) return 'Protegido';
  if (!detail || detail.productId !== productId) return 'Consultando…';
  if (detail.status === 'offline') return 'No disponible offline';
  if (detail.status === 'error') return 'No disponible';
  return detail.cost ? `$${detail.cost}` : 'No disponible';
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.valueCard}>
      <Text style={styles.valueLabel}>{label}</Text>
      <Text style={styles.valueText}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  content: { padding: Spacing.four, paddingBottom: 120, gap: Spacing.two },
  headerContent: { gap: Spacing.three, marginBottom: Spacing.three },
  centered: { flex: 1, padding: Spacing.four, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  eyebrow: { color: Colors.light.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  title: { color: Colors.light.text, fontSize: 28, fontWeight: '800' },
  muted: { color: Colors.light.textSecondary, lineHeight: 20 },
  syncBanner: { padding: Spacing.three, borderRadius: 14, backgroundColor: '#E9F5EE', gap: Spacing.two },
  warningBanner: { backgroundColor: '#FFF5D9' },
  syncText: { color: Colors.light.text, lineHeight: 20, fontWeight: '600' },
  inlineButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.three, borderRadius: 10, backgroundColor: '#FFFFFF' },
  inlineButtonText: { color: Colors.light.primary, fontWeight: '800' },
  searchRow: { flexDirection: 'row', gap: Spacing.two },
  input: { flex: 1, minHeight: 48, paddingHorizontal: Spacing.three, borderWidth: 1, borderColor: Colors.light.border, borderRadius: 12, color: Colors.light.text, backgroundColor: '#FFFFFF' },
  scanButton: { minHeight: 48, paddingHorizontal: Spacing.three, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: Colors.light.primary },
  scanButtonText: { color: '#FFFFFF', fontWeight: '800' },
  cameraCard: { overflow: 'hidden', borderRadius: 18, backgroundColor: Colors.light.navy },
  camera: { height: 280 },
  cameraFooter: { minHeight: 56, paddingHorizontal: Spacing.three, flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  cameraText: { flex: 1, color: '#FFFFFF' },
  cameraClose: { minHeight: 44, justifyContent: 'center', paddingHorizontal: Spacing.three },
  cameraCloseText: { color: '#FFFFFF', fontWeight: '800' },
  message: { color: Colors.light.text, padding: Spacing.three, borderRadius: 12, backgroundColor: Colors.light.backgroundElement },
  error: { color: '#A82836', padding: Spacing.three, borderRadius: 12, backgroundColor: '#FFF0F1' },
  detailCard: { padding: Spacing.four, borderRadius: 18, borderWidth: 1, borderColor: Colors.light.border, gap: Spacing.two, backgroundColor: '#FFFFFF' },
  detailTitle: { color: Colors.light.text, fontSize: 20, fontWeight: '800' },
  detailMeta: { color: Colors.light.textSecondary, fontSize: 13 },
  priceRow: { flexDirection: 'row', gap: Spacing.two, marginVertical: Spacing.two },
  valueCard: { flex: 1, padding: Spacing.three, borderRadius: 12, backgroundColor: Colors.light.backgroundElement },
  valueLabel: { color: Colors.light.textSecondary, fontSize: 12 },
  valueText: { color: Colors.light.text, fontSize: 17, fontWeight: '800', marginTop: Spacing.one },
  stockTitle: { color: Colors.light.text, fontWeight: '800', marginTop: Spacing.two },
  stockRow: { minHeight: 58, flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.light.border },
  stockCopy: { flex: 1, gap: Spacing.one },
  stockName: { color: Colors.light.text, fontWeight: '700' },
  quantity: { color: Colors.light.primary, fontSize: 18, fontWeight: '800' },
  listTitle: { color: Colors.light.text, fontSize: 18, fontWeight: '800' },
  productRow: { minHeight: 68, padding: Spacing.three, flexDirection: 'row', alignItems: 'center', borderRadius: 14, borderWidth: 1, borderColor: Colors.light.border, backgroundColor: '#FFFFFF' },
  productCopy: { flex: 1, gap: Spacing.one },
  productName: { color: Colors.light.text, fontSize: 16, fontWeight: '700' },
  productPrice: { color: Colors.light.primary, fontSize: 16, fontWeight: '800' },
  emptyCard: { padding: Spacing.four, alignItems: 'center', gap: Spacing.two, borderRadius: 16, backgroundColor: Colors.light.backgroundElement },
  pressed: { opacity: 0.65 },
});
