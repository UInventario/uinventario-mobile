import Constants from 'expo-constants';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { appEnvironment } from '@/config/environment';
import { Colors, Spacing } from '@/constants/theme';

const details = [
  ['Ambiente', appEnvironment.environment === 'production' ? 'Prod' : 'Dev'],
  ['Plataforma', Platform.OS],
  ['Versión', Constants.expoConfig?.version ?? 'local'],
  ['Contrato API', 'v1'],
] as const;

export default function EnvironmentScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>CONFIGURACIÓN</Text>
        <Text style={styles.title}>Entorno de ejecución</Text>
        <Text style={styles.subtitle}>
          Información pública para diagnosticar la conexión. Las credenciales nunca forman parte de
          esta configuración.
        </Text>

        <View style={styles.card}>
          {details.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text style={styles.label}>{label}</Text>
              <Text style={styles.value}>{value}</Text>
            </View>
          ))}
        </View>

        <View style={styles.endpointCard}>
          <Text style={styles.label}>Endpoint API</Text>
          <Text selectable style={styles.endpoint}>
            {appEnvironment.apiBaseUrl}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  content: { flexGrow: 1, padding: Spacing.four, gap: Spacing.three },
  eyebrow: { color: Colors.light.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: Colors.light.text, fontSize: 30, fontWeight: '800' },
  subtitle: { color: Colors.light.textSecondary, fontSize: 16, lineHeight: 24 },
  card: {
    marginTop: Spacing.three,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: Colors.light.border,
    overflow: 'hidden',
  },
  row: {
    minHeight: 56,
    paddingHorizontal: Spacing.three,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.light.border,
  },
  label: { color: Colors.light.textSecondary, fontSize: 14 },
  value: { color: Colors.light.text, fontSize: 15, fontWeight: '700', textTransform: 'capitalize' },
  endpointCard: {
    padding: Spacing.three,
    gap: Spacing.two,
    borderRadius: 18,
    backgroundColor: Colors.light.backgroundElement,
  },
  endpoint: { color: Colors.light.text, fontFamily: 'monospace', fontSize: 13, lineHeight: 20 },
});
