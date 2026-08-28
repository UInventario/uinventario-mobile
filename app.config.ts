import type { ConfigContext, ExpoConfig } from 'expo/config';

const DEVELOPMENT_API_URL = 'https://uinventario-api-6w7v33traa-uc.a.run.app/api/v1';

function readEnvironment() {
  const environment = process.env.EXPO_PUBLIC_APP_ENV ?? 'development';
  if (environment !== 'development' && environment !== 'production') {
    throw new Error('EXPO_PUBLIC_APP_ENV must be development or production.');
  }

  const apiBaseUrl =
    process.env.EXPO_PUBLIC_API_URL ??
    (environment === 'development' ? DEVELOPMENT_API_URL : undefined);
  if (!apiBaseUrl) {
    throw new Error('EXPO_PUBLIC_API_URL is required for production builds.');
  }

  const url = new URL(apiBaseUrl);
  if (environment === 'production' && url.protocol !== 'https:') {
    throw new Error('Production API URL must use HTTPS.');
  }

  return { environment, apiBaseUrl: apiBaseUrl.replace(/\/$/, '') };
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const runtime = readEnvironment();

  return {
    ...config,
    name: runtime.environment === 'production' ? 'UInventario' : 'UInventario Dev',
    slug: 'uinventario-mobile',
    version: '0.1.0',
    orientation: 'portrait',
    icon: './assets/images/icon.png',
    scheme: 'uinventario',
    userInterfaceStyle: 'light',
    ios: {
      bundleIdentifier: 'com.uinventario.mobile',
      icon: './assets/expo.icon',
      supportsTablet: true,
    },
    android: {
      package: 'com.uinventario.mobile',
      adaptiveIcon: {
        backgroundColor: '#EAF2FF',
        foregroundImage: './assets/images/android-icon-foreground.png',
        backgroundImage: './assets/images/android-icon-background.png',
        monochromeImage: './assets/images/android-icon-monochrome.png',
      },
      predictiveBackGestureEnabled: true,
    },
    web: {
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: ['expo-router', 'expo-secure-store'],
    experiments: {
      typedRoutes: true,
      reactCompiler: true,
    },
    extra: {
      appEnvironment: runtime.environment,
      apiBaseUrl: runtime.apiBaseUrl,
    },
  };
};
