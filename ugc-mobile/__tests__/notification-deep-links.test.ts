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

const {
  deepLinkTargetsAlertsScreen,
  navigateToNotificationDeepLink,
  syncLastNotificationResponse,
} = await import('../lib/notifications');

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

describe('a workflow run link', () => {
  // The canvas is on the web only. The server writes the Alerts route with the
  // canvas on it, which the web turns into the canvas and every installed
  // build of the app takes for the screen the alert is read on.
  const link = serverDeepLinks.workflowCanvas;

  it('is the Alerts screen, so a tap in the list goes nowhere else', () => {
    expect(deepLinkTargetsAlertsScreen(link)).toBe(true);
  });

  it('is where a tapped push for a stopped run lands', async () => {
    lastResponse.current = {
      notification: {
        request: {
          identifier: 'push-2',
          content: { data: { notificationId: 'notification-2', deepLink: link } },
        },
      },
    };

    await expect(syncLastNotificationResponse()).resolves.toBe(true);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(link);
  });
});

describe('a post alert written before post alerts opened the post page', () => {
  // Saved, shared, remixed and recipe-unlocked alerts written before the server
  // linked the post page open the For You reel with the post first. The post
  // page sends a media post on to the reel and keeps a text post, or one behind
  // the mature-content cover, on its page.
  const legacyLink = '/viewer?source=showcase-feed&initialId=post-1';

  it('opens the post page the server writes now', () => {
    expect(navigateToNotificationDeepLink(legacyLink)).toBe(true);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(serverDeepLinks.showcasePost);
  });

  it('is where a tapped push for an old post alert lands', async () => {
    lastResponse.current = {
      notification: {
        request: {
          identifier: 'push-3',
          content: { data: { notificationId: 'notification-3', deepLink: legacyLink } },
        },
      },
    };

    await expect(syncLastNotificationResponse()).resolves.toBe(true);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledWith(serverDeepLinks.showcasePost);
  });

  it('reads the post id wherever it sits among the parameters, and keeps it encoded', () => {
    expect(navigateToNotificationDeepLink('/viewer?initialId=post%201&source=showcase-feed')).toBe(true);
    expect(routerMocks.push).toHaveBeenCalledWith('/showcase/post%201');
  });

  it('leaves every other reel link as it is', () => {
    expect(navigateToNotificationDeepLink(serverDeepLinks.generation)).toBe(true);
    expect(navigateToNotificationDeepLink('/viewer?source=showcase-feed')).toBe(true);
    expect(routerMocks.push.mock.calls).toEqual([
      [serverDeepLinks.generation],
      ['/viewer?source=showcase-feed'],
    ]);
  });

  it.each([
    '/viewer?source=showcase-feed&initialId=..%2Fauth',
    '/viewer?source=showcase-feed&initialId=post-1%2Fedit',
  ])('opens a post and nothing else: %s is refused', (link) => {
    expect(navigateToNotificationDeepLink(link)).toBe(false);
    expect(routerMocks.push).not.toHaveBeenCalled();
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
