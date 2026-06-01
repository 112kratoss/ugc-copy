import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { MagicbookletApiClient } from './api-client';
import { env } from './env';

const DEVICE_ID_KEY = 'magicbooklet.mobileNotifications.deviceId';
const EXPO_PUSH_TOKEN_KEY = 'magicbooklet.mobileNotifications.expoPushToken';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function isNativeMobile() {
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

function getProjectId() {
  return env.easProjectId
    || Constants.easConfig?.projectId
    || (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId
    || null;
}

async function getStableDeviceId() {
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (existing) {
      return existing;
    }

    const generated = `device_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    await SecureStore.setItemAsync(DEVICE_ID_KEY, generated);
    return generated;
  } catch {
    return null;
  }
}

async function configureAndroidChannel() {
  if (Platform.OS !== 'android') {
    return;
  }

  await Notifications.setNotificationChannelAsync('default', {
    name: 'Default',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#a78bfa',
  });
}

export async function registerForMobilePushNotifications(api: MagicbookletApiClient) {
  if (!isNativeMobile()) {
    return { status: 'skipped' as const, reason: 'not-mobile' };
  }
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  await configureAndroidChannel();

  const currentPermissions = await Notifications.getPermissionsAsync();
  const finalPermissions = currentPermissions.granted
    ? currentPermissions
    : await Notifications.requestPermissionsAsync();

  if (!finalPermissions.granted) {
    return { status: 'denied' as const };
  }

  const projectId = getProjectId();
  if (!projectId) {
    return { status: 'skipped' as const, reason: 'missing-project-id' };
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const expoPushToken = token.data;
  const deviceId = await getStableDeviceId();
  await SecureStore.setItemAsync(EXPO_PUSH_TOKEN_KEY, expoPushToken);
  await api.registerMobilePushToken({
    expoPushToken,
    platform,
    deviceId,
    appVersion: Constants.expoConfig?.version ?? null,
  });

  return { status: 'registered' as const, expoPushToken };
}

export async function unregisterMobilePushNotifications(api: MagicbookletApiClient) {
  if (!isNativeMobile()) {
    return;
  }
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  const expoPushToken = await SecureStore.getItemAsync(EXPO_PUSH_TOKEN_KEY).catch(() => null);
  const deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY).catch(() => null);
  await api.unregisterMobilePushToken({
    ...(expoPushToken ? { expoPushToken } : {}),
    ...(deviceId ? { deviceId } : {}),
    platform,
  }).catch((error) => {
    console.error('Failed to unregister mobile push token', error);
  });
}

export function navigateToNotificationDeepLink(deepLink: unknown) {
  if (typeof deepLink !== 'string' || !deepLink.trim()) {
    return false;
  }

  const target = deepLink.trim();
  if (!target.startsWith('/')) {
    return false;
  }

  router.push(target as never);
  return true;
}

export function subscribeToNotificationResponses() {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const deepLink = response.notification.request.content.data?.deepLink;
    navigateToNotificationDeepLink(deepLink);
  });

  return () => subscription.remove();
}
