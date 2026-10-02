import { beforeEach, describe, expect, it, vi } from 'vitest';

import mobileApiContract from '../../contracts/mobile-api-v1.json';

const routerMocks = vi.hoisted(() => ({ push: vi.fn() }));
/** The push the app was opened from, as the OS hands it over. */
const lastResponse = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  addNotificationReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  getLastNotificationResponseAsync: vi.fn(async () => lastResponse.current),
  clearLastNotificationResponseAsync: vi.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3 },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-router', () => ({ router: routerMocks }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({
  default: { easConfig: { projectId: 'project-1' }, expoConfig: { version: '1.0.0' } },
}));

const { navigateToNotificationDeepLink, syncLastNotificationResponse } = await import('../lib/notifications');

/**
 * Every destination the server writes into a notification, one line per kind.
 * The server suite holds its link builder to these lines; this suite holds the
 * app to opening each of them.
 *
 * The app opens a notification link only when the route is on its own list.
 * A link the server writes and the list lacks does nothing in the Alerts list
 * and falls back to Alerts from a push, with no error on either side: a
 * template step's notification could not have opened its run, because the run
 * screen was never on the list.
 */
const serverDeepLinks = mobileApiContract.endpoints.mobileNotifications.deepLinks;

beforeEach(() => {
  routerMocks.push.mockReset();
  lastResponse.current = null;
});

describe('every destination the server writes into a notification', () => {
  it.each(Object.entries(serverDeepLinks))('opens: %s', (_kind, link) => {
    expect(navigateToNotificationDeepLink(link)).toBe(true);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(link);
  });
});

describe('a template run link', () => {
  // A run id is a UUID. This one is made up.
  const link = '/template-runs/00000000-0000-4000-8000-000000000001';

  it('opens the run the notification names', () => {
    expect(navigateToNotificationDeepLink(link)).toBe(true);
    expect(routerMocks.push).toHaveBeenCalledWith(link);
  });

  it('is where a tapped push for a template step lands', async () => {
    lastResponse.current = {
      notification: {
        request: {
          identifier: 'push-1',
          content: { data: { notificationId: 'notification-1', deepLink: link } },
        },
      },
    };

    // The root layout sends a link the app refuses to Alerts instead. This one
    // is taken, so the push opens the run it is about.
    await expect(syncLastNotificationResponse()).resolves.toBe(true);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(link);
  });

  it.each([
    '/template-runs',
    '/template-runs/',
    '/template-runs/run-1/steps',
    '/template-runs/..',
    '/template-runs/%2e%2e',
    '/template-runs/run-1/../../auth',
    '/template-runs\\run-1',
    '//template-runs/run-1',
    'template-runs/run-1',
    '/templates/a-template',
  ])('opens a run and nothing else: %s is refused', (link) => {
    expect(navigateToNotificationDeepLink(link)).toBe(false);
    expect(routerMocks.push).not.toHaveBeenCalled();
  });
});
