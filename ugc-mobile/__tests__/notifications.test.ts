import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What `addPushTokenListener` really delivers: a native device token, never an Expo one. */
type MockDevicePushToken = { type: 'ios' | 'android'; data: string };

const notificationsMocks = vi.hoisted(() => ({
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setBadgeCountAsync: vi.fn(async () => true),
  getExpoPushTokenAsync: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(),
  clearLastNotificationResponseAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addPushTokenListener: vi.fn((_listener: (token: MockDevicePushToken) => void) => ({ remove: vi.fn() })),
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
  setBadgeCountAsync: notificationsMocks.setBadgeCountAsync,
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

  it('does not invoke the app notification fallback during an ordinary cold start', async () => {
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue(null);
    const handleResponse = vi.fn(async () => true);

    const { syncLastNotificationResponse } = await import('../lib/notifications');

    await expect(syncLastNotificationResponse({ handleResponse })).resolves.toBe(false);
    expect(handleResponse).not.toHaveBeenCalled();
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(notificationsMocks.clearLastNotificationResponseAsync).not.toHaveBeenCalled();
  });

  it('routes referral reward notifications to Invite & Earn', async () => {
    notificationsMocks.getLastNotificationResponseAsync.mockResolvedValue({
      notification: {
        request: {
          identifier: 'referral-reward-1',
          content: {
            data: {
              deepLink: '/invite',
            },
          },
        },
      },
    });

    const { syncLastNotificationResponse } = await import('../lib/notifications');

    await expect(syncLastNotificationResponse()).resolves.toBe(true);
    expect(routerMocks.push).toHaveBeenCalledWith('/invite');
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

  it('clears only local push state after the backend has deleted the account', async () => {
    const { clearLocalMobilePushRegistration } = await import('../lib/notifications');

    await clearLocalMobilePushRegistration();

    expect(secureStoreMocks.getItemAsync).not.toHaveBeenCalled();
    expect(notificationsMocks.unregisterForNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(secureStoreMocks.deleteItemAsync).toHaveBeenCalledWith(
      'magicbooklet.mobileNotifications.expoPushToken',
    );
  });

  describe('device push token rotation', () => {
    // The shapes the native emitters produce: the APNs hex on iOS, the FCM
    // registration string on Android. The API accepts neither.
    const apnsDeviceToken: MockDevicePushToken = {
      type: 'ios',
      data: '0f9a3c1e7b2d4c5a6e8f9012a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6',
    };
    const fcmDeviceToken: MockDevicePushToken = {
      type: 'android',
      data: 'e7Kq1ZxTQ0-abc:APA91bFakeFcmRegistrationToken_0123456789',
    };
    const EXPO_PUSH_TOKEN_KEY = 'magicbooklet.mobileNotifications.expoPushToken';

    function storeHolds(storedExpoPushToken: string | null) {
      secureStoreMocks.getItemAsync.mockImplementation(async (key: string) => (
        key === EXPO_PUSH_TOKEN_KEY ? storedExpoPushToken : 'device-1'
      ));
    }

    async function subscribeAndCaptureListener(api: { registerMobilePushToken: unknown }) {
      let listener: ((token: MockDevicePushToken) => void) | null = null;
      const remove = vi.fn();
      notificationsMocks.addPushTokenListener.mockImplementation((callback: (token: MockDevicePushToken) => void) => {
        listener = callback;
        return { remove };
      });

      const { subscribeToMobilePushTokenChanges } = await import('../lib/notifications');
      const unsubscribe = subscribeToMobilePushTokenChanges(api as never);
      expect(listener).toBeTypeOf('function');

      return { emit: listener as unknown as (token: MockDevicePushToken) => void, remove, unsubscribe };
    }

    /** The listener's work is fire-and-forget; let its promise chain settle before asserting absence. */
    const settleListener = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('exchanges a rotated device token for an Expo token before registering it', async () => {
      notificationsMocks.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true, status: 'granted' });
      notificationsMocks.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[rotated123]' });
      storeHolds('ExponentPushToken[previous456]');
      const api = {
        registerMobilePushToken: vi.fn(async () => ({ success: true })),
      };

      const { emit, remove, unsubscribe } = await subscribeAndCaptureListener(api);
      emit(apnsDeviceToken);

      await vi.waitFor(() => {
        expect(api.registerMobilePushToken).toHaveBeenCalledTimes(1);
      });
      // The rotated token must be handed to Expo directly: left out, the
      // exchange fetches the device token itself, and the native module emits
      // that fetch straight back into this listener.
      expect(notificationsMocks.getExpoPushTokenAsync).toHaveBeenCalledWith({
        projectId: 'project-1',
        devicePushToken: apnsDeviceToken,
      });
      expect(api.registerMobilePushToken).toHaveBeenCalledWith({
        expoPushToken: 'ExponentPushToken[rotated123]',
        platform: 'ios',
        deviceId: 'device-1',
        appVersion: '1.0.0',
      });
      expect(api.registerMobilePushToken).not.toHaveBeenCalledWith(
        expect.objectContaining({ expoPushToken: apnsDeviceToken.data }),
      );
      expect(secureStoreMocks.setItemAsync).toHaveBeenCalledWith(EXPO_PUSH_TOKEN_KEY, 'ExponentPushToken[rotated123]');
      expect(secureStoreMocks.setItemAsync).not.toHaveBeenCalledWith(EXPO_PUSH_TOKEN_KEY, apnsDeviceToken.data);

      unsubscribe();
      expect(remove).toHaveBeenCalledTimes(1);
    });

    it('leaves the backend alone when the exchange returns the token it already holds', async () => {
      // The listener fires on every launch, because the cold-start path's own
      // device-token fetch is emitted through it. Expo maps a rolled device
      // token back to the same Expo token, so most firings change nothing —
      // and each registration counts against the route's rate limit.
      notificationsMocks.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true, status: 'granted' });
      notificationsMocks.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: 'ExponentPushToken[same123]' });
      storeHolds('ExponentPushToken[same123]');
      const api = {
        registerMobilePushToken: vi.fn(async () => ({ success: true })),
      };

      const { emit } = await subscribeAndCaptureListener(api);
      emit(apnsDeviceToken);

      await vi.waitFor(() => {
        expect(notificationsMocks.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
      });
      await settleListener();
      expect(api.registerMobilePushToken).not.toHaveBeenCalled();
      expect(secureStoreMocks.setItemAsync).not.toHaveBeenCalled();
    });

    it('ignores a rotated device token while notification permission is not granted', async () => {
      // Android hands out FCM tokens regardless of the notification permission,
      // so this is the ordinary case for a reader who declined the prompt.
      notificationsMocks.getPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false, status: 'denied' });
      const api = {
        registerMobilePushToken: vi.fn(async () => ({ success: true })),
      };

      const { emit } = await subscribeAndCaptureListener(api);
      emit(fcmDeviceToken);

      await vi.waitFor(() => {
        expect(notificationsMocks.getPermissionsAsync).toHaveBeenCalledTimes(1);
      });
      await settleListener();
      expect(notificationsMocks.getExpoPushTokenAsync).not.toHaveBeenCalled();
      expect(api.registerMobilePushToken).not.toHaveBeenCalled();
      expect(secureStoreMocks.setItemAsync).not.toHaveBeenCalled();
    });

    it('registers nothing when Expo refuses to exchange the rotated device token', async () => {
      notificationsMocks.getPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true, status: 'granted' });
      notificationsMocks.getExpoPushTokenAsync.mockRejectedValue(new Error('ERR_NOTIFICATIONS_NETWORK_ERROR'));
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const api = {
          registerMobilePushToken: vi.fn(async () => ({ success: true })),
        };

        const { emit } = await subscribeAndCaptureListener(api);
        emit(apnsDeviceToken);

        await vi.waitFor(() => {
          expect(consoleError).toHaveBeenCalledWith('Failed to register rotated mobile push token', expect.any(Error));
        });
        // The device token is never a fallback: nothing is registered and the
        // stored token is left as it was.
        expect(api.registerMobilePushToken).not.toHaveBeenCalled();
        expect(secureStoreMocks.setItemAsync).not.toHaveBeenCalled();
      } finally {
        consoleError.mockRestore();
      }
    });
  });
});

describe('app icon badge (HIG S26)', () => {
  it('retires the icon badge when the Alerts list comes into view, and only then', async () => {
    // Badging: "keep badges up to date — update the count when people open
    // notifications." Foreground arrivals set the badge; opening the Alerts
    // screen is the moment it must return to zero.
    const { setAlertsScreenFocused } = await import('../lib/notifications');

    notificationsMocks.setBadgeCountAsync.mockClear();
    setAlertsScreenFocused(false);
    expect(notificationsMocks.setBadgeCountAsync).not.toHaveBeenCalled();

    setAlertsScreenFocused(true);
    expect(notificationsMocks.setBadgeCountAsync).toHaveBeenCalledWith(0);
  });
});
