import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import type { MagicbookletApiClient } from './api-client';
import { env } from './env';

const DEVICE_ID_KEY = 'magicbooklet.mobileNotifications.deviceId';
const EXPO_PUSH_TOKEN_KEY = 'magicbooklet.mobileNotifications.expoPushToken';
let lastHandledNotificationResponseKey: string | null = null;

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

export type MobilePushPermissionStatus = 'unsupported' | 'undetermined' | 'denied' | 'granted';
export type MobilePushRegistrationResult =
  | { status: 'registered'; expoPushToken: string }
  | { status: 'not-mobile' }
  | { status: 'permission-required' }
  | { status: 'denied' }
  | { status: 'missing-project-id' }
  | { status: 'missing-firebase-setup' };

export async function getMobilePushPermissionState(): Promise<{ status: MobilePushPermissionStatus }> {
  if (!isNativeMobile()) {
    return { status: 'unsupported' };
  }

  const permissions = await Notifications.getPermissionsAsync();
  if (permissions.granted) {
    return { status: 'granted' };
  }

  if (permissions.canAskAgain === false) {
    return { status: 'denied' };
  }

  return { status: 'undetermined' };
}

function isMissingFirebaseSetupError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('default firebaseapp is not initialized')
    || message.includes('fcm-credentials')
  );
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

export async function registerForMobilePushNotifications(
  api: MagicbookletApiClient,
  options: { requestPermission?: boolean } = {}
): Promise<MobilePushRegistrationResult> {
  if (!isNativeMobile()) {
    return { status: 'not-mobile' };
  }
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';

  await configureAndroidChannel();

  const currentPermissions = await Notifications.getPermissionsAsync();
  let finalPermissions = currentPermissions;
  if (!currentPermissions.granted) {
    if (!options.requestPermission) {
      return { status: currentPermissions.canAskAgain === false ? 'denied' : 'permission-required' };
    }
    finalPermissions = await Notifications.requestPermissionsAsync();
  }

  if (!finalPermissions.granted) {
    return { status: 'denied' };
  }

  const projectId = getProjectId();
  if (!projectId) {
    return { status: 'missing-project-id' };
  }

  let token: Notifications.ExpoPushToken;
  try {
    token = await Notifications.getExpoPushTokenAsync({ projectId });
  } catch (error) {
    if (platform === 'android' && isMissingFirebaseSetupError(error)) {
      return { status: 'missing-firebase-setup' };
    }
    throw error;
  }
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

function getNotificationResponseKey(response: Notifications.NotificationResponse | null | undefined) {
  const identifier = response?.notification.request.identifier;
  if (typeof identifier === 'string' && identifier.trim()) {
    return identifier.trim();
  }

  const deepLink = response?.notification.request.content.data?.deepLink;
  if (typeof deepLink === 'string' && deepLink.trim()) {
    return `deep-link:${deepLink.trim()}`;
  }

  return null;
}

function handleNotificationResponse(response: Notifications.NotificationResponse | null | undefined) {
  const responseKey = getNotificationResponseKey(response);
  if (responseKey && responseKey === lastHandledNotificationResponseKey) {
    return false;
  }

  const deepLink = response?.notification.request.content.data?.deepLink;
  const handled = navigateToNotificationDeepLink(deepLink);
  if (handled && responseKey) {
    lastHandledNotificationResponseKey = responseKey;
  }

  return handled;
}

export async function syncLastNotificationResponse() {
  const response = await Notifications.getLastNotificationResponseAsync();
  return handleNotificationResponse(response);
}

export function subscribeToNotificationResponses() {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    handleNotificationResponse(response);
  });
  void syncLastNotificationResponse();

  return () => subscription.remove();
}
