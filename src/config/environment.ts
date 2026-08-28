import Constants from 'expo-constants';

export type AppEnvironment = 'development' | 'production';

type RuntimeExtra = {
  appEnvironment?: string;
  apiBaseUrl?: string;
};

const extra = (Constants.expoConfig?.extra ?? {}) as RuntimeExtra;

if (extra.appEnvironment !== 'development' && extra.appEnvironment !== 'production') {
  throw new Error('The app environment is missing or invalid.');
}

if (!extra.apiBaseUrl) {
  throw new Error('The API base URL is missing.');
}

const parsedApiUrl = new URL(extra.apiBaseUrl);
if (extra.appEnvironment === 'production' && parsedApiUrl.protocol !== 'https:') {
  throw new Error('Production API URL must use HTTPS.');
}

export const appEnvironment = Object.freeze({
  environment: extra.appEnvironment,
  apiBaseUrl: extra.apiBaseUrl.replace(/\/$/, ''),
  apiOrigin: parsedApiUrl.origin,
});
