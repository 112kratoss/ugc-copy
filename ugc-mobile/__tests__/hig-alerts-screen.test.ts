import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  addNotificationReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  getLastNotificationResponseAsync: vi.fn(async () => null),
  getPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
  getExpoPushTokenAsync: vi.fn(async () => ({ data: 'token' })),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => ({
  default: { easConfig: { projectId: 'project-1' }, expoConfig: { version: '1.0.0', extra: { eas: { projectId: 'project-1' } } } },
}));

const {
  ALERTS_ROUTE,
  deepLinkTargetsAlertsScreen,
  resolveForegroundPresentation,
} = await import('../lib/notifications');

/**
 * S10's rules, in the form a suite can hold. Sources: Managing notifications,
 * Notifications, Toggles, Scroll views — plus Design principles' Familiarity,
 * which is what a screen breaks when it calls itself something other than the
 * tab that opens it.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const alertsScreen = read('app/(tabs)/studio.tsx');
const tabBar = read('components/magic-tab-bar.tsx');
const tabsLayout = read('app/(tabs)/_layout.tsx');
const rootLayout = read('app/_layout.tsx');

describe('one destination, one name', () => {
  /**
   * The tab bar, the navigator and the badge's screen-reader label all said
   * "Alerts"; the screen it opened titled itself "Notifications" and named four
   * of its controls the same way. Design principles: "once you establish a
   * behavior or appearance for an element, apply it throughout."
   */
  it('titles the screen the way the tab that opens it is labelled', () => {
    expect(tabBar).toContain("route: 'studio', label: 'Alerts'");
    expect(tabsLayout).toContain("title: 'Alerts'");
    expect(alertsScreen).toContain('          Alerts\n        </AppText>');
  });

  it('names its own controls the same thing', () => {
    expect(alertsScreen).toContain('label="Refresh alerts"');
    expect(alertsScreen).toContain('label="Mark all alerts read"');
    expect(alertsScreen).toContain('title="Could not load alerts"');
  });

  /**
   * One exception, deliberately: the copy that points at iOS Settings has to
   * use the system's own word for the thing the reader will find there.
   */
  it('keeps the platform word where it points at the platform', () => {
    expect(alertsScreen).toContain('Notifications are disabled for this device. Re-enable them in system settings.');
  });
});

describe('an alert arriving while the app is in front', () => {
  /**
   * HIG Notifications: "present the information in a way that's discoverable
   * but not distracting or invasive … Mail simply adds it to the list of unread
   * messages because sending a notification about it would be unnecessary and
   * distracting." The handler used to return the background presentation
   * verbatim — banner and sound, over the app you were holding.
   */
  it('never plays a sound over the app you are already using', () => {
    expect(resolveForegroundPresentation({ alertsScreenFocused: false }).shouldPlaySound).toBe(false);
    expect(resolveForegroundPresentation({ alertsScreenFocused: true }).shouldPlaySound).toBe(false);
  });

  it('drops the banner only where it would repeat what is on screen', () => {
    expect(resolveForegroundPresentation({ alertsScreenFocused: true }).shouldShowBanner).toBe(false);
    expect(resolveForegroundPresentation({ alertsScreenFocused: false }).shouldShowBanner).toBe(true);
  });

  it('still files it where it will be found later', () => {
    const presentation = resolveForegroundPresentation({ alertsScreenFocused: true });
    expect(presentation.shouldShowList).toBe(true);
    expect(presentation.shouldSetBadge).toBe(true);
  });

  it('lets the screen report itself in and out of view', () => {
    expect(alertsScreen).toContain('setAlertsScreenFocused(true)');
    expect(alertsScreen).toContain('return () => setAlertsScreenFocused(false)');
    expect(alertsScreen).toContain('useFocusEffect(useCallback(');
  });

  /**
   * Suppressing a banner is only honest if the app shows the alert itself.
   * Nothing listened for an arrival before, so the badge learned about one on
   * its next poll — up to a minute later.
   */
  it('refreshes the badge and the list the moment one lands', () => {
    expect(rootLayout).toContain('subscribeToNotificationsReceived(');
    expect(rootLayout).toContain('notificationBadgeQueryKey(user?.id)');
  });
});

describe('a row with nowhere to send anyone', () => {
  /**
   * Two of this account's live rows carry `/studio` — "New follower", whose
   * real destination the server does not name yet — and the screen's fallback
   * for an unresolvable link pushed the same route. Both asked the router for
   * the screen the reader was already on.
   */
  it('recognises a link that points back at this screen', () => {
    expect(deepLinkTargetsAlertsScreen('/studio')).toBe(true);
    expect(deepLinkTargetsAlertsScreen('/studio/')).toBe(true);
    expect(deepLinkTargetsAlertsScreen('/(tabs)/studio')).toBe(true);
    expect(deepLinkTargetsAlertsScreen('/studio?from=push')).toBe(true);
    expect(ALERTS_ROUTE).toBe('/studio');
  });

  it('leaves every other destination alone', () => {
    expect(deepLinkTargetsAlertsScreen('/viewer?source=showcase-feed&initialId=abc')).toBe(false);
    expect(deepLinkTargetsAlertsScreen('/creators/batman')).toBe(false);
    expect(deepLinkTargetsAlertsScreen(null)).toBe(false);
    expect(deepLinkTargetsAlertsScreen(undefined)).toBe(false);
  });

  it('marks such a row read and stays put', () => {
    expect(alertsScreen).toContain('if (deepLinkTargetsAlertsScreen(notification.deepLink)) return;');
    // The old fallback is gone: the screen never pushes itself.
    expect(alertsScreen).not.toContain("router.push('/studio'");
  });

  /**
   * The root layout keeps its own `/studio` fallback, and should: a tap from
   * outside the app has to land somewhere.
   */
  it('keeps the fallback where it is still the right answer', () => {
    expect(rootLayout).toContain("navigateToNotificationDeepLink('/studio')");
  });
});

describe('one clock for the whole app', () => {
  /**
   * This screen had its own relative-time formatter that stopped at days, so a
   * two-month-old alert read "78d ago" where every other surface — feed rows,
   * post details, creator bylines — would have shown a date.
   */
  it('reads times through the shared formatter', () => {
    expect(alertsScreen).toContain("import { formatRelativeTime } from '@/lib/home-view-model'");
    expect(alertsScreen).toContain('formatRelativeTime(notification.updatedAt)');
    expect(alertsScreen).not.toContain('function formatNotificationTime');
  });
});

describe('the toggles that choose what may interrupt', () => {
  /**
   * HIG Toggles: "Make sure the visual differences in a toggle's state are
   * obvious … Avoid relying solely on different colors to communicate state."
   * The Lucide glyph moves its knob as well as changing colour, so both
   * channels carry it — and the same control is now drawn at one size.
   */
  it('carries state in shape as well as colour', () => {
    expect(alertsScreen).toContain('const Icon = enabled ? ToggleRight : ToggleLeft');
    expect(alertsScreen).toContain('accessibilityState={{ checked: enabled, disabled }}');
  });

  it('draws the same control at one size, in the app’s own green', () => {
    expect(alertsScreen).not.toMatch(/Toggle(Right|Left) size=\{3[0-9]\}/);
    expect(alertsScreen).not.toContain('#6ee7b7');
  });

  /** Managing notifications: settings must be changeable inside the app. */
  it('keeps every category switchable in the app', () => {
    for (const key of ['generationEnabled', 'commerceEnabled', 'socialEnabled']) {
      expect(alertsScreen).toContain(key);
    }
  });
});
