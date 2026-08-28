import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { AuthenticatedHome } from '@/auth/authenticated-home';
import { LoginScreen } from '@/auth/login-screen';
import { useSession } from '@/auth/session-context';
import { Colors } from '@/constants/theme';

export default function HomeScreen() {
  const { status } = useSession();

  if (status === 'booting') {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={Colors.light.primary} size="large" />
        <Text style={styles.loadingText}>Protegiendo tu sesión…</Text>
      </View>
    );
  }

  return status === 'authenticated' ? <AuthenticatedHome /> : <LoginScreen />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: Colors.light.background,
  },
  loadingText: { color: Colors.light.textSecondary, fontSize: 15 },
});
