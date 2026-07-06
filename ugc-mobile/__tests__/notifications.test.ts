import { beforeEach, describe, expect, it, vi } from 'vitest';

const notificationsMocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(),
  clearLastNotificationResponseAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addPushTokenListener: vi.fn((_listener: (event: { data: string }) => void) => ({ remove: vi.fn() })),
  unregisterForNotificationsAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
}));

const secureStoreMocks = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const routerMocks = vi.hoisted(() => ({
  push: vi.fn(),
}));

vi.mock('expo-notifications', () => ({
  AndroidImportance: {
    DEFAULT: 'default',
  },
  getPermissionsAsync: notificationsMocks.getPermissionsAsync,
  requestPermissionsAsync: notificationsMocks.requestPermissionsAsync,
  getExpoPushTokenAsync: notificationsMocks.getExpoPushTokenAsync,
  getLastNotificationResponseAsync: notificationsMocks.getLastNotificationResponseAsync,
  clearLastNotificationResponseAsync: notificationsMocks.clearLastNotificationResponseAsync,
  setNotificationChannelAsync: notificationsMocks.setNotificationChannelAsync,
  addNotificationResponseReceivedListener: notificationsMocks.addNotificationResponseReceivedListener,
  addPushTokenListener: notificationsMocks.addPushTokenListener,
  unregisterForNotificationsAsync: notificationsMocks.unregisterForNotificationsAsync,
  setNotificationHandler: notificationsMocks.setNotificationHandler,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMocks.getItemAsync,
  setItemAsync: secureStoreMocks.setItemAsync,
  deleteItemAsync: secureStoreMocks.deleteItemAsync,
}));

vi.mock('expo-router', () => ({
  router: routerMocks,
}));

vi.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
  },
}));

vi.mock('expo-constants', () => ({
  default: {
    easConfig: {
      projectId: 'project-1',
    },
    expoConfig: {
      version: '1.0.0',
      extra: {
        eas: {
          projectId: 'project-1',
        },
      },
    },
  },
}));

describe('mobile notifications helper', () => {
  beforeEach(() => {
    vi.resetModules();
    notificationsMocks.getPermissionsAsync.mockReset();
    notificationsMocks.requestPermissionsAsync.mockReset();
    notificationsMocks.getExpoPushTokenAsync.mockReset();
    notificationsMocks.getLastNotificationResponseAsync.mockReset();
    notificationsMocks.clearLastNotificationResponseAsync.mockReset();
    notificationsMocks.setNotificationChannelAsync.mockReset();
    notificationsMocks.addNotificationResponseReceivedListener.mockReset();
    notificationsMocks.addPushTokenListener.mockReset();
    notificationsMocks.unregisterForNotificationsAsync.mockReset();
    notificationsMocks.setNotificationHandler.mockReset();
    secureStoreMocks.getItemAsync.mockReset();
    secureStoreMocks.setItemAsync.mockReset();
    secureStoreMocks.deleteItemAsync.mockReset();
    routerMocks.push.mockReset();
    secureStoreMocks.getItemAsync.mockResolvedValue(null);
    secureStoreMocks.setItemAsync.mockResolvedValue(undefined);
    secureStoreMocks.deleteItemAsync.mockResolvedValue(undefined);
    notificationsMocks.setNotificationChannelAsync.mockResolvedValue(undefined);
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue(null);
    notificationsMocks.clearLastNotificationResponseAsync.mockResolvedValue(undefined);
    notificationsMocks.unregisterForNotificationsAsync.mockResolvedValue(undefined);
  });

  it('skips the OS prompt during silent sync when permission is not granted yet', async () => {
    notificationsMocks.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
    });

    const { registerForMobilePushNotifications } = await import('../lib/notifications');
    const api = {
      registerMobilePushToken: vi.fn(),
    };

    await expect(registerForMobilePushNotifications(api as never, { requestPermission: false })).resolves.toEqual({
      status: 'permission-required',
    });
    expect(notificationsMocks.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(api.registerMobilePushToken).not.toHaveBeenCalled();
  });

  it('requests permission and registers the Expo token for the explicit enable flow', async () => {
    notificationsMocks.getPermissionsAsync.mockResolvedValue({
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
    });
    notificationsMocks.requestPermissionsAsync.mockResolvedValue({
      granted: true,
      canAskAgain: true,
      status: 'granted',
    });
    notificationsMocks.getExpoPushTokenAsync.mockResolvedValue({
      data: 'ExponentPushToken[abc123]',
    });

    const { registerForMobilePushNotifications } = await import('../lib/notifications');
    const api = {
      registerMobilePushToken: vi.fn(async () => ({ success: true })),
    };

    await expect(registerForMobilePushNotifications(api as never, { requestPermission: true })).resolves.toMatchObject({
      status: 'registered',
      expoPushToken: 'ExponentPushToken[abc123]',
    });
    expect(notificationsMocks.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(api.registerMobilePushToken).toHaveBeenCalledWith(expect.objectContaining({
      expoPushToken: 'ExponentPushToken[abc123]',
      platform: expect.any(String),
    }));
  });

  it('routes the last notification response on cold start', async () => {
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue({
      notification: {
        request: {
          identifier: 'notification-1',
          content: {
            data: {
              deepLink: '/studio',
            },
          },
        },
      },
    });

    const { syncLastNotificationResponse } = await import('../lib/notifications');

    await expect(syncLastNotificationResponse()).resolves.toBe(true);
    expect(routerMocks.push).toHaveBeenCalledWith('/studio');
    expect(notificationsMocks.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
  });

  it('lets the app layer mark notification taps read before navigation', async () => {
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue({
      notification: {
        request: {
          identifier: 'notification-1',
          content: {
            data: {
              notificationId: 'notification-db-1',
              deepLink: '/viewer?source=studio-creations&initialId=gen-1',
            },
          },
        },
      },
    });
    const handleResponse = vi.fn(async () => true);

    const { syncLastNotificationResponse } = await import('../lib/notifications');
    await expect(syncLastNotificationResponse({ handleResponse })).resolves.toBe(true);

    expect(handleResponse).toHaveBeenCalledWith({
      notificationId: 'notification-db-1',
      deepLink: '/viewer?source=studio-creations&initialId=gen-1',
    });
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(notificationsMocks.clearLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the cold-start response when the live listener receives the same notification', async () => {
    let listener: ((response: unknown) => void) | null = null;
    const remove = vi.fn();
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue({
      notification: {
        request: {
          identifier: 'notification-1',
          content: {
            data: {
              deepLink: '/viewer?source=studio-creations&initialId=gen-1',
            },
          },
        },
      },
    });
    notificationsMocks.addNotificationResponseReceivedListener.mockImplementation(((
      callback: (response: unknown) => void
    ) => {
      listener = callback;
      return { remove };
    }) as never);

    const { subscribeToNotificationResponses } = await import('../lib/notifications');
    const unsubscribe = subscribeToNotificationResponses();
    await Promise.resolve();
    await Promise.resolve();

    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith('/viewer?source=studio-creations&initialId=gen-1');

    expect(listener).not.toBeNull();
    (listener as unknown as (response: unknown) => void)({
      notification: {
        request: {
          identifier: 'notification-1',
          content: {
            data: {
              deepLink: '/viewer?source=studio-creations&initialId=gen-1',
            },
          },
        },
      },
    });

    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('unregisters the native token and clears the stored Expo token on logout cleanup', async () => {
    secureStoreMocks.getItemAsync
      .mockResolvedValueOnce('ExponentPushToken[old123]')
      .mockResolvedValueOnce('device-1');
    const api = {
      unregisterMobilePushToken: vi.fn(async () => ({ success: true })),
    };

    const { unregisterMobilePushNotifications } = await import('../lib/notifications');
    await unregisterMobilePushNotifications(api as never);

    expect(api.unregisterMobilePushToken).toHaveBeenCalledWith({
      expoPushToken: 'ExponentPushToken[old123]',
      deviceId: 'device-1',
      platform: expect.any(String),
    });
    expect(notificationsMocks.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(secureStoreMocks.deleteItemAsync).toHaveBeenCalledWith('magicbooklet.mobileNotifications.expoPushToken');
  });

  it('re-registers the device when Expo rotates the push token', async () => {
    let listener: ((event: { data: string }) => void) | null = null;
    const remove = vi.fn();
    notificationsMocks.addPushTokenListener.mockImplementation((callback: (event: { data: string }) => void) => {
      listener = callback;
      return { remove };
    });
    secureStoreMocks.getItemAsync.mockResolvedValue('device-1');
    const api = {
      registerMobilePushToken: vi.fn(async () => ({ success: true })),
    };

    const { subscribeToMobilePushTokenChanges } = await import('../lib/notifications');
    const unsubscribe = subscribeToMobilePushTokenChanges(api as never);
    expect(listener).toBeTypeOf('function');

    (listener as unknown as (event: { data: string }) => void)({
      data: 'ExponentPushToken[rotated123]',
    });

    await vi.waitFor(() => {
      expect(api.registerMobilePushToken).toHaveBeenCalledWith(expect.objectContaining({
        expoPushToken: 'ExponentPushToken[rotated123]',
        deviceId: 'device-1',
      }));
    });
    expect(secureStoreMocks.setItemAsync).toHaveBeenCalledWith(
      'magicbooklet.mobileNotifications.expoPushToken',
      'ExponentPushToken[rotated123]',
    );
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
