import { useCallback, useMemo } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';

import { BootstrapEntity } from './contracts';
import { useSession } from './session-context';

export function AuthenticatedHome() {
  const { session, busy, error, refresh, changeContext, logout } = useSession();
  const entities = session?.bootstrap.entities;
  const branches = useMemo(() => entities?.filter(isActiveKind('BRANCH')) ?? [], [entities]);
  const warehouses = useMemo(
    () => entities?.filter(isActiveKind('WAREHOUSE')) ?? [],
    [entities],
  );
  const cashRegisters = useMemo(
    () => entities?.filter(isActiveKind('CASH_REGISTER')) ?? [],
    [entities],
  );
  const products = useMemo(() => entities?.filter(isActiveKind('PRODUCT')) ?? [], [entities]);

  const selectBranch = useCallback(
    async (branch: BootstrapEntity) => {
      if (!session) return;
      const warehouse = warehouses.find(({ branchId }) => branchId === branch.id);
      const cashRegister = cashRegisters.find(({ branchId }) => branchId === branch.id);
      if (!warehouse) return;
      try {
        await changeContext({
          branchId: branch.id,
          warehouseId: warehouse.id,
          cashRegisterId: cashRegister?.id,
        });
      } catch {
        // The session provider exposes the sanitized failure in the screen.
      }
    },
    [cashRegisters, changeContext, session, warehouses],
  );

  const renderBranch = useCallback(
    ({ item }: { item: BootstrapEntity }) => {
      const selected = session?.data.context.branch?.id === item.id;
      const available = warehouses.some(({ branchId }) => branchId === item.id);
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected, disabled: !available || busy }}
          disabled={!available || busy}
          onPress={() => void selectBranch(item)}
          style={({ pressed }) => [
            styles.branchCard,
            selected && styles.branchSelected,
            !available && styles.disabled,
            pressed && styles.pressed,
          ]}>
          <Text style={[styles.branchName, selected && styles.branchNameSelected]}>
            {item.name}
          </Text>
          <Text style={[styles.branchDetail, selected && styles.branchDetailSelected]}>
            {available ? (selected ? 'Contexto activo' : 'Cambiar contexto') : 'Sin bodega autorizada'}
          </Text>
        </Pressable>
      );
    },
    [busy, selectBranch, session?.data.context.branch?.id, warehouses],
  );

  if (!session) return null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{session.data.tenant.name.toUpperCase()}</Text>
            <Text style={styles.title}>Hola, {session.data.user.email.split('@')[0]}</Text>
            <Text style={styles.subtitle}>
              {session.data.context.branch?.name ?? 'Selecciona una sucursal para operar'}
            </Text>
          </View>
          {busy ? <ActivityIndicator color={Colors.light.primary} /> : null}
        </View>

        {error ? (
          <Text accessibilityLiveRegion="polite" style={styles.error}>
            {error}
          </Text>
        ) : null}

        <View style={styles.metrics}>
          <Metric label="Productos" value={products.length} />
          <Metric label="Cajas" value={cashRegisters.length} />
          <Metric label="Permisos" value={session.data.user.permissions.length} />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Sucursal autorizada</Text>
          <Text style={styles.sectionBody}>
            Al cambiarla, el servidor valida bodega y caja y vuelve a descargar sólo su contexto.
          </Text>
          {branches.length ? (
            <FlatList
              contentContainerStyle={styles.branchList}
              data={branches}
              horizontal
              keyExtractor={(item) => item.id}
              renderItem={renderBranch}
              showsHorizontalScrollIndicator={false}
            />
          ) : (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Onboarding pendiente</Text>
              <Text style={styles.emptyBody}>
                Configura la primera sucursal y bodega en Web para habilitar la operación móvil.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Permisos de esta sesión</Text>
          <FlatList
            contentContainerStyle={styles.permissionList}
            data={session.data.user.permissions}
            horizontal
            keyExtractor={(permission) => permission}
            renderItem={({ item }) => (
              <View style={styles.permissionChip}>
                <Text style={styles.permissionText}>{item}</Text>
              </View>
            )}
            showsHorizontalScrollIndicator={false}
          />
        </View>

        <View style={styles.sessionCard}>
          <Text style={styles.sessionTitle}>Sesión protegida</Text>
          <Text style={styles.sessionBody}>
            Vigencia: {new Date(session.expiresAt).toLocaleString()}. El token rotatorio permanece en
            el almacén seguro del dispositivo.
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void refresh().catch(() => undefined)}
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>Renovar</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void logout().catch(() => undefined)}
              style={({ pressed }) => [styles.logoutButton, pressed && styles.pressed]}>
              <Text style={styles.logoutText}>Cambiar cuenta</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function isActiveKind(kind: string) {
  return (entity: BootstrapEntity) => entity.kind === kind && entity.active !== false;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  content: { padding: Spacing.four, paddingBottom: 120, gap: Spacing.four },
  header: { flexDirection: 'row', alignItems: 'center' },
  headerCopy: { flex: 1, gap: Spacing.one },
  eyebrow: { color: Colors.light.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  title: { color: Colors.light.text, fontSize: 28, fontWeight: '800' },
  subtitle: { color: Colors.light.textSecondary, fontSize: 15 },
  error: { color: '#A82836', padding: Spacing.three, borderRadius: 12, backgroundColor: '#FFF0F1' },
  metrics: { flexDirection: 'row', gap: Spacing.two },
  metric: { flex: 1, padding: Spacing.three, borderRadius: 16, backgroundColor: Colors.light.navy },
  metricValue: { color: '#FFFFFF', fontSize: 24, fontWeight: '800' },
  metricLabel: { color: '#DCE7F8', fontSize: 12, marginTop: Spacing.one },
  section: { gap: Spacing.two },
  sectionTitle: { color: Colors.light.text, fontSize: 19, fontWeight: '800' },
  sectionBody: { color: Colors.light.textSecondary, lineHeight: 21 },
  branchList: { gap: Spacing.two, paddingVertical: Spacing.one },
  branchCard: {
    width: 190,
    minHeight: 86,
    padding: Spacing.three,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.light.border,
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  branchSelected: { backgroundColor: Colors.light.primary, borderColor: Colors.light.primary },
  branchName: { color: Colors.light.text, fontWeight: '800' },
  branchNameSelected: { color: '#FFFFFF' },
  branchDetail: { color: Colors.light.textSecondary, marginTop: Spacing.one, fontSize: 12 },
  branchDetailSelected: { color: '#DCE7F8' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.65 },
  emptyCard: { padding: Spacing.three, borderRadius: 16, backgroundColor: Colors.light.backgroundElement },
  emptyTitle: { color: Colors.light.text, fontWeight: '800' },
  emptyBody: { color: Colors.light.textSecondary, lineHeight: 20, marginTop: Spacing.one },
  permissionList: { gap: Spacing.two, paddingVertical: Spacing.one },
  permissionChip: { paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderRadius: 99, backgroundColor: Colors.light.backgroundElement },
  permissionText: { color: Colors.light.text, fontSize: 12, fontWeight: '700' },
  sessionCard: { padding: Spacing.four, gap: Spacing.two, borderRadius: 18, backgroundColor: Colors.light.backgroundElement },
  sessionTitle: { color: Colors.light.text, fontSize: 18, fontWeight: '800' },
  sessionBody: { color: Colors.light.textSecondary, lineHeight: 21 },
  actions: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.two },
  secondaryButton: { minHeight: 44, flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: '#FFFFFF' },
  secondaryText: { color: Colors.light.primary, fontWeight: '800' },
  logoutButton: { minHeight: 44, flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: '#D7A4AA' },
  logoutText: { color: '#A82836', fontWeight: '800' },
});
