import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Spacing } from '@/constants/theme';

import { useSession } from './session-context';

export function LoginScreen() {
  const { login, busy, error, clearError } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function submit() {
    if (!email.trim() || !password) return;
    try {
      await login(email.trim(), password);
    } catch {
      // The provider exposes a sanitized user-facing error.
    }
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.keyboard}>
        <View style={styles.container}>
          <View style={styles.mark}>
            <Text style={styles.markText}>UI</Text>
          </View>
          <Text style={styles.eyebrow}>UINVENTARIO MOBILE</Text>
          <Text style={styles.title}>Bienvenido</Text>
          <Text style={styles.subtitle}>
            Entra con tu cuenta para descargar únicamente las sucursales, permisos y datos que
            tienes autorizados.
          </Text>

          <View style={styles.form}>
            <Text style={styles.label}>Correo</Text>
            <TextInput
              accessibilityLabel="Correo"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              editable={!busy}
              keyboardType="email-address"
              onChangeText={(value) => {
                clearError();
                setEmail(value);
              }}
              returnKeyType="next"
              style={styles.input}
              value={email}
            />

            <Text style={styles.label}>Contraseña</Text>
            <TextInput
              accessibilityLabel="Contraseña"
              autoCapitalize="none"
              autoComplete="current-password"
              editable={!busy}
              onChangeText={(value) => {
                clearError();
                setPassword(value);
              }}
              onSubmitEditing={() => void submit()}
              returnKeyType="go"
              secureTextEntry
              style={styles.input}
              value={password}
            />

            {error ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {error}
              </Text>
            ) : null}

            <Pressable
              accessibilityRole="button"
              disabled={busy || !email.trim() || !password}
              onPress={() => void submit()}
              style={({ pressed }) => [
                styles.button,
                (busy || !email.trim() || !password) && styles.buttonDisabled,
                pressed && styles.pressed,
              ]}>
              {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>Entrar</Text>}
            </Pressable>
          </View>

          <Text style={styles.securityNote}>
            La contraseña no se almacena. La sesión se protege con el almacén seguro del dispositivo.
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: Colors.light.background },
  keyboard: { flex: 1 },
  container: { flex: 1, justifyContent: 'center', padding: Spacing.four, gap: Spacing.two },
  mark: {
    width: 58,
    height: 58,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.light.primary,
    marginBottom: Spacing.two,
  },
  markText: { color: '#FFFFFF', fontSize: 20, fontWeight: '800' },
  eyebrow: { color: Colors.light.primary, fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: Colors.light.text, fontSize: 34, fontWeight: '800' },
  subtitle: { color: Colors.light.textSecondary, fontSize: 16, lineHeight: 23 },
  form: { marginTop: Spacing.four, gap: Spacing.two },
  label: { color: Colors.light.text, fontSize: 14, fontWeight: '700', marginTop: Spacing.one },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: Colors.light.border,
    borderRadius: 14,
    paddingHorizontal: Spacing.three,
    fontSize: 16,
    color: Colors.light.text,
    backgroundColor: '#FFFFFF',
  },
  error: { color: '#A82836', lineHeight: 20, marginVertical: Spacing.one },
  button: {
    minHeight: 52,
    marginTop: Spacing.two,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.light.primary,
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  securityNote: { color: Colors.light.textSecondary, fontSize: 13, lineHeight: 19, marginTop: Spacing.four },
});
