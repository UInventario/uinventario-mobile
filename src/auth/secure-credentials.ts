import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'uinventario.session-token';
const DEVICE_KEY = 'uinventario.device-id';

export interface CredentialsStore {
  readToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  deviceId(): Promise<string>;
}

export class SecureCredentialsStore implements CredentialsStore {
  async readToken(): Promise<string | null> {
    await this.assertAvailable();
    return SecureStore.getItemAsync(TOKEN_KEY);
  }

  async saveToken(token: string): Promise<void> {
    await this.assertAvailable();
    await SecureStore.setItemAsync(TOKEN_KEY, token, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
  }

  async clearToken(): Promise<void> {
    if (await SecureStore.isAvailableAsync()) {
      await SecureStore.deleteItemAsync(TOKEN_KEY);
    }
  }

  async deviceId(): Promise<string> {
    await this.assertAvailable();
    const stored = await SecureStore.getItemAsync(DEVICE_KEY);
    if (stored) return stored;
    const deviceId = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, deviceId, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return deviceId;
  }

  private async assertAvailable(): Promise<void> {
    if (!(await SecureStore.isAvailableAsync())) {
      throw new Error('El almacenamiento seguro no está disponible en este dispositivo.');
    }
  }
}
