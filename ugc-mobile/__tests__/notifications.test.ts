import { beforeEach, describe, expect, it, vi } from 'vitest';

const notificationsMocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  setNotificationHandler: vi.fn(),
}));

const secureStoreMocks = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
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
  setNotificationChannelAsync: notificationsMocks.setNotificationChannelAsync,
  addNotificationResponseReceivedListener: notificationsMocks.addNotificationResponseReceivedListener,
  setNotificationHandler: notificationsMocks.setNotificationHandler,
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMocks.getItemAsync,
  setItemAsync: secureStoreMocks.setItemAsync,
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
    notificationsMocks.setNotificationChannelAsync.mockReset();
    notificationsMocks.addNotificationResponseReceivedListener.mockReset();
    notificationsMocks.setNotificationHandler.mockReset();
    secureStoreMocks.getItemAsync.mockReset();
    secureStoreMocks.setItemAsync.mockReset();
    routerMocks.push.mockReset();
    secureStoreMocks.getItemAsync.mockResolvedValue(null);
    secureStoreMocks.setItemAsync.mockResolvedValue(undefined);
    notificationsMocks.setNotificationChannelAsync.mockResolvedValue(undefined);
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue(null);
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
});
