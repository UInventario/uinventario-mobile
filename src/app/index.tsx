import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { appEnvironment } from '@/config/environment';
import { Colors, Spacing } from '@/constants/theme';

type HealthStatus = 'checking' | 'online' | 'offline';

export default function HomeScreen() {
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('checking');

  const queryHealth = useCallback(async (signal?: AbortSignal) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const response = await fetch(`${appEnvironment.apiOrigin}/health/live`, {
        signal: controller.signal,
      });
      setHealthStatus(response.ok ? 'online' : 'offline');
    } catch {
      setHealthStatus('offline');
    } finally {
      clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const startup = setTimeout(() => void queryHealth(controller.signal), 0);
    return () => {
      clearTimeout(startup);
      controller.abort();
    };
  }, [queryHealth]);

  const checkHealth = useCallback(() => {
    setHealthStatus('checking');
    void queryHealth();
  }, [queryHealth]);

  const statusLabel = {
    checking: 'Comprobando conexión…',
    online: 'API disponible',
    offline: 'Sin conexión con la API',
  }[healthStatus];

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.brandRow}>
          <View style={styles.logoMark}>
            <Text style={styles.logoText}>UI</Text>
          </View>
          <View>
            <Text style={styles.eyebrow}>UINVENTARIO</Text>
            <Text style={styles.title}>Operación móvil</Text>
          </View>
        </View>

        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Tu inventario, donde ocurre el trabajo.</Text>
          <Text style={styles.heroBody}>
            El cliente móvil está listo para incorporar autenticación, consulta, escaneo y
            operaciones conectadas a la API versionada.
          </Text>
        </View>

        <View style={styles.statusCard}>
          <View
            accessibilityLabel={statusLabel}
            style={[
              styles.statusDot,
              healthStatus === 'online' && styles.statusOnline,
              healthStatus === 'offline' && styles.statusOffline,
            ]}
          />
          <View style={styles.statusCopy}>
            <Text style={styles.statusTitle}>{statusLabel}</Text>
            <Text style={styles.statusDetail}>
              Ambiente {appEnvironment.environment === 'production' ? 'Prod' : 'Dev'}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Volver a comprobar la conexión"
            hitSlop={10}
            onPress={checkHealth}
            style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
            <Text style={styles.retryText}>Reintentar</Text>
          </Pressable>
        </View>

        <View style={styles.nextCard}>
          <Text style={styles.nextLabel}>SIGUIENTE CAPACIDAD</Text>
          <Text style={styles.nextTitle}>Acceso seguro y bootstrap</Text>
          <Text style={styles.nextBody}>
            El shell y la configuración por ambiente ya están preparados para conectar el flujo de
            sesión sin duplicar reglas del dominio.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  content: { flexGrow: 1, padding: Spacing.four, gap: Spacing.four },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three },
  logoMark: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: Colors.light.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { color: '#FFFFFF', fontSize: 18, fontWeight: '800' },
  eyebrow: { color: Colors.light.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: Colors.light.text, fontSize: 22, fontWeight: '700' },
  hero: {
    marginTop: Spacing.three,
    backgroundColor: Colors.light.navy,
    padding: Spacing.four,
    borderRadius: 24,
    gap: Spacing.three,
  },
  heroTitle: { color: '#FFFFFF', fontSize: 30, lineHeight: 36, fontWeight: '800' },
  heroBody: { color: '#DCE7F8', fontSize: 16, lineHeight: 24 },
  statusCard: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    padding: Spacing.three,
    gap: Spacing.three,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.light.border,
    backgroundColor: '#FFFFFF',
  },
  statusDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#D89B25' },
  statusOnline: { backgroundColor: '#21875B' },
  statusOffline: { backgroundColor: '#C43D4B' },
  statusCopy: { flex: 1 },
  statusTitle: { color: Colors.light.text, fontSize: 16, fontWeight: '700' },
  statusDetail: { color: Colors.light.textSecondary, marginTop: 3 },
  retryButton: {
    minHeight: 44,
    minWidth: 88,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    backgroundColor: Colors.light.backgroundElement,
  },
  retryText: { color: Colors.light.primary, fontWeight: '700' },
  pressed: { opacity: 0.65 },
  nextCard: {
    padding: Spacing.four,
    gap: Spacing.two,
    borderRadius: 18,
    backgroundColor: Colors.light.backgroundElement,
  },
  nextLabel: { color: Colors.light.primary, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  nextTitle: { color: Colors.light.text, fontSize: 20, fontWeight: '700' },
  nextBody: { color: Colors.light.textSecondary, fontSize: 15, lineHeight: 22 },
});
