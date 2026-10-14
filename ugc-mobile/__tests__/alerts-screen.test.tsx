// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { alertsListQueryKey, notificationBadgeQueryKey } from '@/lib/notification-badge';
import type { MobileNotification, MobileNotificationPreferences, MobileNotificationsResponse } from '@/lib/types';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type ListParams = { limit?: number; before?: string | null };
type DevicePush = {
  result: { status: string; expoPushToken?: string } | null;
  isLoading: boolean;
  checkFailed: boolean;
  recheck: () => void;
  enable: () => void;
  isEnabling: boolean;
  enableError: Error | null;
};

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
  api: {
    listMobileNotifications: vi.fn(),
    markMobileNotificationsRead: vi.fn(),
    markAllMobileNotificationsRead: vi.fn(),
    getMobileNotificationPreferences: vi.fn(),
    updateMobileNotificationPreferences: vi.fn(),
  },
  user: { id: 'user-1' } as { id: string } | null,
  devicePush: null as unknown as DevicePush,
  focus: {
    callback: null as null | (() => void | (() => void)),
    cleanup: null as null | void | (() => void),
  },
  navigate: vi.fn(() => true),
  setAlertsScreenFocused: vi.fn(),
  haptic: { light: vi.fn() },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Linking: { openSettings: vi.fn() },
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  RefreshControl: (props: MockProps) => React.createElement('refresh-control', props),
  // The pull control is drawn where a test can reach it.
  ScrollView: ({ children, refreshControl, ...props }: MockProps) => React.createElement(
    'scroll-view',
    props,
    refreshControl as React.ReactNode,
    children,
  ),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
  // The tab coming into view: on mount, and again when a test brings it back.
  useFocusEffect: (callback: () => void | (() => void)) => {
    mocks.focus.callback = callback;
    React.useEffect(() => {
      mocks.focus.cleanup = callback();
      return () => {
        if (typeof mocks.focus.cleanup === 'function') mocks.focus.cleanup();
        mocks.focus.cleanup = null;
      };
    }, [callback]);
  },
  useScrollToTop: () => undefined,
}));

vi.mock('expo-router', () => ({ router: mocks.router }));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return {
    BellRing: icon('bell-ring'),
    CheckCheck: icon('check-check'),
    CheckCircle2: icon('check-circle'),
    Clock3: icon('clock'),
    CreditCard: icon('credit-card'),
    Heart: icon('heart'),
    RefreshCw: icon('refresh'),
    ToggleLeft: icon('toggle-left'),
    ToggleRight: icon('toggle-right'),
    WandSparkles: icon('wand'),
  };
});

vi.mock('@/components/top-scrim', () => ({ TopScrim: () => null }));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  IconButton: (props: MockProps) => React.createElement('icon-button', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));
vi.mock('@/lib/haptics', () => ({ haptic: mocks.haptic }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: mocks.user, api: mocks.api }) }));
vi.mock('@/lib/notifications', () => ({
  ALERTS_ROUTE: '/studio',
  deepLinkTargetsAlertsScreen: (link: unknown) => link === '/studio',
  navigateToNotificationDeepLink: mocks.navigate,
  setAlertsScreenFocused: mocks.setAlertsScreenFocused,
}));
vi.mock('@/lib/push-registration', () => ({ useDevicePushRegistration: () => mocks.devicePush }));
vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (inset: number) => inset,
  resolvedTopInset: (inset: number) => inset,
}));

import StudioScreen from '../app/(tabs)/studio';

/** The time the list is ordered by, as PostgREST prints it: microseconds and an offset. */
function lastEventAt(index: number) {
  return new Date(Date.UTC(2026, 9, 14, 12, 0, 0) - index * 60_000).toISOString().replace('Z', '123+00:00');
}

function alertAt(index: number): MobileNotification {
  return {
    id: `alert-${index}`,
    type: 'post_saved',
    category: 'social',
    title: `Alert ${index}`,
    body: 'It is in their saved media now.',
    deepLink: '/showcase/post-1',
    objectType: 'post',
    objectId: 'post-1',
    eventCount: 1,
    isRead: false,
    createdAt: lastEventAt(index),
    updatedAt: lastEventAt(index),
  };
}

/** One read of the list: `count` alerts from `first` on, newest first. */
function alertsPage(first: number, count: number, unreadCount: number): MobileNotificationsResponse {
  return {
    success: true,
    notifications: Array.from({ length: count }, (_, offset) => alertAt(first + offset)),
    unreadCount,
  };
}

/** The newest 50, then 20 older: two pages, the second short. */
function twoPages(olderUnreadCount = 71) {
  const newest = alertsPage(0, 50, 72);
  mocks.api.listMobileNotifications.mockImplementation(async (params: ListParams) => (
    params.before ? alertsPage(50, 20, olderUnreadCount) : newest
  ));
  return newest;
}

const PREFERENCES: MobileNotificationPreferences = {
  pushEnabled: true,
  generationEnabled: true,
  commerceEnabled: true,
  socialEnabled: true,
};

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function screen(queryClient: QueryClient, wrap: (node: React.ReactElement) => React.ReactElement = (node) => node) {
  return <QueryClientProvider client={queryClient}>{wrap(<StudioScreen />)}</QueryClientProvider>;
}

async function renderAlerts(queryClient = newQueryClient()) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(screen(queryClient));
  });
  await settle();
  return { tree, queryClient };
}

/** React Query tells its observers on a zero timer; a few turns let a read land and draw. */
async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function press(node: renderer.ReactTestInstance | undefined) {
  expect(node).toBeDefined();
  await act(async () => {
    (node!.props.onPress as () => void)();
  });
  await settle();
}

/** The tab leaves view and comes back. */
async function returnToTab() {
  await act(async () => {
    if (typeof mocks.focus.cleanup === 'function') mocks.focus.cleanup();
    mocks.focus.cleanup = mocks.focus.callback?.();
  });
  await settle();
}

const byType = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);
const texts = (tree: renderer.ReactTestRenderer) => byType(tree, 'text').map((node) => [node.props.children].flat().join(''));
const alertTitles = (tree: renderer.ReactTestRenderer) => texts(tree).filter((text) => /^Alert \d+$/.test(text));
const header = (tree: renderer.ReactTestRenderer) => texts(tree).find((text) => text.includes(' unread · '));
const statusTitles = (tree: renderer.ReactTestRenderer) => byType(tree, 'status-block').map((node) => node.props.title);
const button = (tree: renderer.ReactTestRenderer, label: string) => byType(tree, 'secondary-button')
  .find((node) => node.props.label === label);
const refreshControl = (tree: renderer.ReactTestRenderer) => byType(tree, 'refresh-control')[0];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.user = { id: 'user-1' };
  mocks.devicePush = {
    result: { status: 'registered', expoPushToken: 'ExponentPushToken[device-1]' },
    isLoading: false,
    checkFailed: false,
    recheck: vi.fn(),
    enable: vi.fn(),
    isEnabling: false,
    enableError: null,
  };
  mocks.focus.callback = null;
  mocks.focus.cleanup = null;
  mocks.navigate.mockReturnValue(true);
  mocks.api.listMobileNotifications.mockResolvedValue(alertsPage(0, 12, 3));
  mocks.api.getMobileNotificationPreferences.mockResolvedValue({ success: true, preferences: PREFERENCES });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Alerts, signed out', () => {
  // Finding 03-5: signing in from Alerts ended on Home.
  it('signs in and comes back to Alerts', async () => {
    mocks.user = null;
    const { tree } = await renderAlerts();

    await press(byType(tree, 'primary-button').find((node) => node.props.label === 'Sign in'));

    expect(mocks.router.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/studio' } });
    // No list, so nothing to pull or to read.
    expect(byType(tree, 'refresh-control')).toEqual([]);
    expect(mocks.api.listMobileNotifications).not.toHaveBeenCalled();
  });
});

describe('the push switch (decision D8)', () => {
  // Finding 03-6: the card said "this device" while its switch, one setting per
  // account, paused push on every phone signed in to it.
  it('says the switch is for the account on every device, and what this device allows', async () => {
    const { tree } = await renderAlerts();

    expect(texts(tree)).toEqual(expect.arrayContaining([
      'Push alerts',
      'Push notifications for your account on every device.',
      'This device allows notifications.',
    ]));
    const pushSwitch = byType(tree, 'pressable').find((node) => node.props.accessibilityLabel === 'Push alerts for your account');
    expect(pushSwitch?.props).toMatchObject({
      accessibilityRole: 'switch',
      accessibilityHint: 'Turns push alerts on or off on every device signed in to this account.',
      accessibilityState: { checked: true, disabled: false },
    });
  });

  it('says a pause holds on every device', async () => {
    mocks.api.getMobileNotificationPreferences.mockResolvedValue({
      success: true,
      preferences: { ...PREFERENCES, pushEnabled: false },
    });
    const { tree } = await renderAlerts();

    expect(texts(tree)).toEqual(expect.arrayContaining([
      'Push alerts paused',
      'Paused for your account on every device. Alerts still appear here.',
      'This device allows notifications.',
    ]));
  });

  it('speaks of this device alone where the system permission is the subject', async () => {
    mocks.devicePush = { ...mocks.devicePush, result: { status: 'denied' } };
    const { tree } = await renderAlerts();

    expect(texts(tree)).toContain('Notifications are disabled for this device. Re-enable them in system settings.');
    expect(texts(tree)).not.toContain('This device allows notifications.');
    expect(byType(tree, 'pressable').filter((node) => node.props.accessibilityLabel === 'Push alerts for your account')).toEqual([]);
  });
});

describe('older alerts (finding 03-9)', () => {
  // The unread count covers every alert, and unread ones are never pruned: a
  // busy account read "72 unread" over its newest 50 with no way to the rest.
  it('reads on from the oldest alert held, and stops at a short page', async () => {
    const newest = twoPages();
    const { tree, queryClient } = await renderAlerts();

    expect(mocks.api.listMobileNotifications).toHaveBeenCalledWith({ limit: 50, before: null, beforeId: null });
    expect(alertTitles(tree)).toHaveLength(50);
    expect(header(tree)).toBe('72 unread · 50+ alerts · Mobile');

    await press(button(tree, 'Load older alerts'));

    // The oldest alert's last event, exactly as the server printed it.
    expect(newest.notifications[49].updatedAt).toBe('2026-10-14T11:11:00.000123+00:00');
    expect(mocks.api.listMobileNotifications).toHaveBeenLastCalledWith({
      limit: 50,
      before: '2026-10-14T11:11:00.000123+00:00',
      beforeId: newest.notifications[49].id,
    });
    expect(alertTitles(tree)).toEqual(Array.from({ length: 70 }, (_, index) => `Alert ${index}`));
    // The count from the page read last, for the header and the tab's badge.
    expect(header(tree)).toBe('71 unread · 70 alerts · Mobile');
    expect(queryClient.getQueryData(notificationBadgeQueryKey('user-1'))).toBe(71);
    // Twenty is fewer than asked for: that was the end of the list.
    expect(button(tree, 'Load older alerts')).toBeUndefined();
  });

  it('offers nothing older under a list shorter than a page', async () => {
    const { tree } = await renderAlerts();

    expect(alertTitles(tree)).toHaveLength(12);
    expect(header(tree)).toBe('3 unread · 12 alerts · Mobile');
    expect(button(tree, 'Load older alerts')).toBeUndefined();
  });

  it('says it is reading, and asks once, while an older page is on its way', async () => {
    let answer!: (page: MobileNotificationsResponse) => void;
    mocks.api.listMobileNotifications.mockImplementation((params: ListParams) => (
      params.before
        ? new Promise<MobileNotificationsResponse>((resolve) => {
          answer = resolve;
        })
        : Promise.resolve(alertsPage(0, 50, 72))
    ));
    const { tree } = await renderAlerts();

    await press(button(tree, 'Load older alerts'));
    const reading = button(tree, 'Loading older alerts…');
    expect(reading?.props.disabled).toBe(true);
    await press(reading);
    expect(mocks.api.listMobileNotifications).toHaveBeenCalledTimes(2);

    await act(async () => answer(alertsPage(50, 20, 70)));
    await settle();
    expect(alertTitles(tree)).toHaveLength(70);
  });

  it('keeps the list when an older page fails, and offers it again', async () => {
    mocks.api.listMobileNotifications.mockImplementation(async (params: ListParams) => {
      if (params.before) throw new Error('Network request failed');
      return alertsPage(0, 50, 72);
    });
    const { tree } = await renderAlerts();

    await press(button(tree, 'Load older alerts'));

    expect(alertTitles(tree)).toHaveLength(50);
    expect(statusTitles(tree)).toEqual(['Could not load older alerts']);
    expect(button(tree, 'Load older alerts')?.props.disabled).toBe(false);
  });
});

describe('pull to refresh (finding 03-10)', () => {
  it('reads the newest page again, alone, with the control on for the pull only', async () => {
    twoPages();
    const { tree } = await renderAlerts();
    await press(button(tree, 'Load older alerts'));
    expect(alertTitles(tree)).toHaveLength(70);
    expect(refreshControl(tree).props.refreshing).toBe(false);

    let answer!: (page: MobileNotificationsResponse) => void;
    mocks.api.listMobileNotifications.mockClear();
    mocks.api.listMobileNotifications.mockImplementation(() => new Promise<MobileNotificationsResponse>((resolve) => {
      answer = resolve;
    }));
    await act(async () => {
      (refreshControl(tree).props.onRefresh as () => void)();
    });

    expect(refreshControl(tree).props.refreshing).toBe(true);
    expect(mocks.haptic.light).toHaveBeenCalledTimes(1);
    expect(mocks.api.listMobileNotifications.mock.calls).toEqual([[{ limit: 50, before: null, beforeId: null }]]);

    await act(async () => answer(alertsPage(0, 50, 60)));
    await settle();

    expect(refreshControl(tree).props.refreshing).toBe(false);
    // The older page was let go, not read again.
    expect(mocks.api.listMobileNotifications).toHaveBeenCalledTimes(1);
    expect(alertTitles(tree)).toHaveLength(50);
    expect(header(tree)).toBe('60 unread · 50+ alerts · Mobile');
    expect(button(tree, 'Load older alerts')).toBeDefined();
  });

  it('leaves the control alone while a read it did not ask for runs', async () => {
    const { tree, queryClient } = await renderAlerts();
    let answer!: (page: MobileNotificationsResponse) => void;
    mocks.api.listMobileNotifications.mockImplementation(() => new Promise<MobileNotificationsResponse>((resolve) => {
      answer = resolve;
    }));

    await act(async () => {
      void queryClient.invalidateQueries({ queryKey: alertsListQueryKey('user-1') });
    });
    await settle();

    expect(mocks.api.listMobileNotifications).toHaveBeenCalledTimes(2);
    expect(header(tree)).toBe('3 unread · 12 alerts · Syncing');
    expect(refreshControl(tree).props.refreshing).toBe(false);

    await act(async () => answer(alertsPage(0, 12, 2)));
    await settle();
    expect(header(tree)).toBe('2 unread · 12 alerts · Mobile');
  });

  it('keeps the list drawn when a refresh fails, and says so', async () => {
    const { tree } = await renderAlerts();
    mocks.api.listMobileNotifications.mockRejectedValue(new Error('Network request failed'));

    await act(async () => {
      (refreshControl(tree).props.onRefresh as () => void)();
    });
    await settle();

    expect(refreshControl(tree).props.refreshing).toBe(false);
    expect(alertTitles(tree)).toHaveLength(12);
    expect(statusTitles(tree)).toEqual(['Could not refresh alerts']);
  });
});

describe('coming back to the tab (finding 03-10)', () => {
  it('reads a stale list again, every page it holds', async () => {
    const newest = twoPages();
    const { tree } = await renderAlerts();
    await press(button(tree, 'Load older alerts'));
    mocks.api.listMobileNotifications.mockClear();

    // Past the 20 s a read list counts as current.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 21_000);
    await returnToTab();

    expect(mocks.api.listMobileNotifications.mock.calls).toEqual([
      [{ limit: 50, before: null, beforeId: null }],
      [{ limit: 50, before: newest.notifications[49].updatedAt, beforeId: newest.notifications[49].id }],
    ]);
    expect(alertTitles(tree)).toHaveLength(70);
    expect(mocks.setAlertsScreenFocused.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('leaves a list read moments ago alone', async () => {
    const { tree } = await renderAlerts();
    mocks.api.listMobileNotifications.mockClear();

    await returnToTab();

    expect(mocks.api.listMobileNotifications).not.toHaveBeenCalled();
    expect(alertTitles(tree)).toHaveLength(12);
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('reads nothing again when every effect runs again over a fresh list', async () => {
    const queryClient = newQueryClient();
    const inActivity = (mode: 'visible' | 'hidden') => screen(
      queryClient,
      (node) => <React.Activity mode={mode}>{node}</React.Activity>,
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(inActivity('visible'));
    });
    await settle();

    await act(async () => { tree.update(inActivity('hidden')); });
    await act(async () => { tree.update(inActivity('visible')); });
    await settle();

    expect(mocks.api.listMobileNotifications).toHaveBeenCalledTimes(1);
    expect(alertTitles(tree)).toHaveLength(12);
    expect(mocks.setAlertsScreenFocused.mock.calls).toEqual([[true], [false], [true]]);
  });
});
