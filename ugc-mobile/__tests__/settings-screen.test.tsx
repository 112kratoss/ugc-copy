// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const authState = vi.hoisted(() => ({
  api: { getContentPreferences: vi.fn() },
  credits: 120 as number | null,
  deleteAccount: vi.fn(),
  isGuest: false,
  signOutEverywhere: vi.fn(),
  user: { id: 'user-1', email: 'creator@example.com' } as { id: string; email: string } | null,
}));

const platform = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));
const contentPreferences = vi.hoisted(() => ({
  query: { data: undefined as { showMature: boolean } | undefined, isError: false },
  options: null as null | { queryKey: unknown; enabled: boolean; queryFn: unknown },
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown; enabled: boolean; queryFn: unknown }) => {
    contentPreferences.options = options;
    return contentPreferences.query;
  },
}));

const routerPush = vi.hoisted(() => vi.fn());
const openUrl = vi.hoisted(() => vi.fn());
const VERSION_LABEL = 'Version 0.1.4 (52) · update 00b2999e';
const versionLabel = vi.hoisted(() => ({ value: null as string | null }));
const updateRuntime = vi.hoisted(() => ({ value: { runtimeVersion: null as string | null, channel: null as string | null } }));

vi.mock('expo-router', () => ({
  router: { push: routerPush },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Linking: { openURL: openUrl },
  Platform: {
    get OS() {
      return platform.os;
    },
  },
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement('icon', { name, ...props });
  return {
    ArrowUpRight: icon('ArrowUpRight'),
    Ban: icon('Ban'),
    Bell: icon('Bell'),
    ChevronRight: icon('ChevronRight'),
    CircleHelp: icon('CircleHelp'),
    CreditCard: icon('CreditCard'),
    EyeOff: icon('EyeOff'),
    FileText: icon('FileText'),
    Gift: icon('Gift'),
    LogOut: icon('LogOut'),
    ShieldCheck: icon('ShieldCheck'),
    Sparkles: icon('Sparkles'),
    Trash2: icon('Trash2'),
    UserRound: icon('UserRound'),
  };
});

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
}));

vi.mock('@/components/onboarding-resume-card', () => ({
  OnboardingResumeCard: (props: MockProps) => React.createElement('onboarding-resume-card', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/pricing', () => ({
  CREDIT_BALANCE_LOADING_LABEL: 'Balance loading…',
  formatCreditAmount: (amount: number) => String(amount),
}));

vi.mock('@/lib/env', () => ({
  env: { siteUrl: 'https://site.example' },
}));

vi.mock('@/lib/app-version-label', () => ({
  formatAppVersionLabel: () => versionLabel.value,
  readAppVersionParts: () => ({ version: null, build: null, update: null }),
  readUpdateRuntime: () => updateRuntime.value,
}));

const copyToClipboard = vi.hoisted(() => vi.fn(async (_text: string, _announcement?: string) => undefined));
const showMessageDialog = vi.hoisted(() => vi.fn());
const showConfirmDialog = vi.hoisted(() => vi.fn());

vi.mock('@/lib/copy-to-clipboard', () => ({ copyToClipboard }));

const appearance = vi.hoisted(() => ({
  available: true,
  preference: 'system' as 'system' | 'light' | 'dark',
  set: vi.fn(),
}));

vi.mock('@/lib/appearance', () => ({
  APPEARANCE_PREFERENCES: ['system', 'light', 'dark'],
  isAppearanceChoiceAvailable: () => appearance.available,
  useAppearancePreference: () => appearance.preference,
  setAppearancePreference: appearance.set,
}));
vi.mock('@/lib/dialog', () => ({ showConfirmDialog, showMessageDialog }));

const aiDataConsent = vi.hoisted(() => ({ grantedAt: null as string | null }));

// The Playback row is the real one; nothing has been stored yet.
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) },
}));

vi.mock('@/lib/ai-data-consent', () => ({
  useAiDataConsent: () => ({ hydrated: true, grantedAt: aiDataConsent.grantedAt }),
}));

import SettingsScreen from '../app/settings';
import { recordCreatorSession, resetCreatorSessionForTests } from '../lib/creator-session-diagnostics';

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(SettingsScreen));
  });
  return tree;
}

function rows(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'pressable');
}

function rowByTitle(tree: renderer.ReactTestRenderer, title: string) {
  const match = rows(tree).find((node) => String(node.props.accessibilityLabel).startsWith(`${title}.`));
  if (!match) throw new Error(`No settings row titled "${title}"`);
  return match;
}

beforeEach(() => {
  appearance.available = true;
  appearance.preference = 'system';
  appearance.set.mockClear();
  aiDataConsent.grantedAt = null;
  routerPush.mockClear();
  openUrl.mockClear();
  authState.user = { id: 'user-1', email: 'creator@example.com' };
  authState.isGuest = false;
  authState.credits = 120;
  authState.deleteAccount.mockReset();
  authState.signOutEverywhere.mockReset();
  showConfirmDialog.mockReset();
  showMessageDialog.mockClear();
  platform.os = 'ios';
  contentPreferences.query = { data: { showMature: false }, isError: false };
  contentPreferences.options = null;
  versionLabel.value = VERSION_LABEL;
  updateRuntime.value = { runtimeVersion: null, channel: null };
  resetCreatorSessionForTests();
});

function radioGroups(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'view' && node.props.accessibilityRole === 'radiogroup');
}

function radioOptions(tree: renderer.ReactTestRenderer, group: string) {
  return radioGroups(tree)
    .filter((node) => node.props.accessibilityLabel === group)
    .flatMap((node) => node.findAll((child) => String(child.type) === 'pressable' && child.props.accessibilityRole === 'radio'));
}

function appearanceOptions(tree: renderer.ReactTestRenderer) {
  return radioOptions(tree, 'Appearance');
}

function groupLabels(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text' && node.props.variant === 'label' && node.props.color === 'muted')
    .map((node) => node.props.children);
}

describe('settings screen — appearance', () => {
  it('offers System, Light and Dark as one radio group, checked by the stored choice', () => {
    appearance.preference = 'light';
    const tree = renderScreen();
    expect(radioGroups(tree).map((node) => node.props.accessibilityLabel)).toEqual(['Appearance', 'Autoplay previews']);

    const options = appearanceOptions(tree);
    expect(options.map((node) => node.props.accessibilityLabel)).toEqual(['System', 'Light', 'Dark']);
    expect(options.map((node) => node.props.accessibilityState.checked)).toEqual([false, true, false]);
  });

  it('switches on a tap, and does nothing for the choice already made', () => {
    const tree = renderScreen();
    const [system, , dark] = appearanceOptions(tree);

    renderer.act(() => { (dark.props.onPress as () => void)(); });
    expect(appearance.set).toHaveBeenCalledWith('dark');

    appearance.set.mockClear();
    renderer.act(() => { (system.props.onPress as () => void)(); });
    expect(appearance.set).not.toHaveBeenCalled();
  });

  it('says what System means right now', () => {
    const tree = renderScreen();
    const body = tree.root.findAll((node) => String(node.type) === 'text' && node.props.variant === 'bodySm')
      .map((node) => node.props.children as string);
    expect(body).toContain('Matches your phone — dark right now.');
  });

  it('hides the choice on a binary that still pins the app dark', () => {
    appearance.available = false;
    const tree = renderScreen();
    expect(appearanceOptions(tree)).toHaveLength(0);
  });
});

describe('settings screen — playback', () => {
  it('groups Autoplay previews under Playback, between Display and Privacy', () => {
    const tree = renderScreen();
    expect(groupLabels(tree)).toEqual(['Account', 'Display', 'Playback', 'Privacy', 'Support & legal']);
    const autoplay = radioOptions(tree, 'Autoplay previews');
    expect(autoplay.map((node) => node.props.accessibilityLabel)).toEqual(['Wi-Fi only', 'Always', 'Never']);
    expect(autoplay.map((node) => node.props.accessibilityState.checked)).toEqual([true, false, false]);
  });

  it('keeps Playback on a binary that still pins the app dark', () => {
    appearance.available = false;
    const tree = renderScreen();
    expect(groupLabels(tree)).toEqual(['Account', 'Playback', 'Privacy', 'Support & legal']);
    expect(radioOptions(tree, 'Autoplay previews')).toHaveLength(3);
  });
});

describe('settings screen (HIG S16)', () => {
  it('names the alerts row after the screen it opens, not "Notifications"', () => {
    const tree = renderScreen();
    const alerts = rowByTitle(tree, 'Alerts');
    renderer.act(() => { (alerts.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/studio');
    expect(rows(tree).some((node) => String(node.props.accessibilityLabel).startsWith('Notifications'))).toBe(false);
  });

  it('marks every row that leaves the app as a link with an external arrow, never a drill-down chevron', () => {
    const tree = renderScreen();
    const links = rows(tree).filter((node) => node.props.accessibilityRole === 'link');
    expect(links.map((node) => String(node.props.accessibilityLabel).split('.')[0])).toEqual([
      'Mature content',
      'Privacy policy',
      'Terms of service',
      'Child safety standards',
    ]);
    for (const link of links) {
      expect(link.props.accessibilityHint).toBe('Opens in your browser.');
      expect(link.findAll((node) => String(node.type) === 'icon' && node.props.name === 'ArrowUpRight')).toHaveLength(1);
      expect(link.findAll((node) => String(node.type) === 'icon' && node.props.name === 'ChevronRight')).toHaveLength(0);
    }
  });

  it('keeps in-app rows as buttons with the drill-down chevron', () => {
    const tree = renderScreen();
    const profile = rowByTitle(tree, 'Profile');
    expect(profile.props.accessibilityRole).toBe('button');
    expect(profile.props.accessibilityHint).toBeUndefined();
    expect(profile.findAll((node) => String(node.type) === 'icon' && node.props.name === 'ChevronRight')).toHaveLength(1);
  });

  it('offers help from settings', () => {
    const tree = renderScreen();
    const help = rowByTitle(tree, 'Help & support');
    renderer.act(() => { (help.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/help');
  });

  it('opens AI data sharing, whose row says whether prompts and media may go to AI services', () => {
    const notAllowed = rowByTitle(renderScreen(), 'AI data sharing');
    expect(notAllowed.props.accessibilityRole).toBe('button');
    // The answer is kept on this phone, not on the account (D7).
    expect(notAllowed.props.accessibilityLabel).toContain('Not allowed on this phone. You’ll be asked before anything is sent to AI services.');
    renderer.act(() => { (notAllowed.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/ai-data-sharing');

    aiDataConsent.grantedAt = '2026-09-25T08:00:00.000Z';
    const allowed = rowByTitle(renderScreen(), 'AI data sharing');
    expect(allowed.props.accessibilityLabel).toContain('Allowed on this phone. Your prompts and media go to AI services when you create.');
  });

  // Signing in from the Profile row ended on Home (audit 01-12).
  it('opens the profile for an account, and signs a visitor in back to Settings', () => {
    const signedIn = rowByTitle(renderScreen(), 'Profile');
    renderer.act(() => { (signedIn.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenLastCalledWith('/profile');

    authState.user = null;
    const visitor = rowByTitle(renderScreen(), 'Profile');
    renderer.act(() => { (visitor.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenLastCalledWith({ pathname: '/auth', params: { returnTo: '/settings' } });
  });

  // The one place a block can be taken back: a blocked creator is left out of everywhere else.
  it('opens the list of blocked users for a signed-in account, and offers none to a signed-out visitor', () => {
    const blocked = rowByTitle(renderScreen(), 'Blocked users');
    expect(blocked.props.accessibilityRole).toBe('button');
    expect(blocked.props.accessibilityLabel).toBe('Blocked users. See whom you blocked, and unblock them.');
    renderer.act(() => { (blocked.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/blocked-users');

    authState.user = null;
    expect(() => rowByTitle(renderScreen(), 'Blocked users')).toThrow('No settings row titled "Blocked users"');
  });

  it('copies media diagnostics, named by the running version, from a long-press on the version line', async () => {
    copyToClipboard.mockClear();
    showMessageDialog.mockClear();
    const tree = renderScreen();
    const version = rows(tree).find((node) => node.props.accessibilityLabel === VERSION_LABEL);
    expect(version?.props.accessibilityHint).toBe('Long-press to copy media diagnostics.');

    await renderer.act(async () => {
      (version!.props.onLongPress as () => void)();
      for (let tick = 0; tick < 3; tick += 1) await Promise.resolve();
    });

    expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining(VERSION_LABEL), 'Media diagnostics copied');
    expect(showMessageDialog).toHaveBeenCalledWith({
      title: 'Media diagnostics copied',
      message: 'No media problems recorded this session.',
    });
  });

  it('paints only the destructive row title in the danger color', () => {
    const tree = renderScreen();
    const titles = tree.root.findAll((node) => String(node.type) === 'text' && node.props.variant === 'cardTitle');
    const danger = titles.filter((node) => node.props.color === 'danger');
    expect(danger).toHaveLength(1);
    expect(danger[0]?.props.children).toBe('Delete account');
  });

  it('sends signed-out account deletion to the web explainer as a link', () => {
    authState.user = null;
    const tree = renderScreen();
    const deletion = rowByTitle(tree, 'Account deletion');
    expect(deletion.props.accessibilityRole).toBe('link');
    renderer.act(() => { (deletion.props.onPress as () => void)(); });
    expect(openUrl).toHaveBeenCalledWith('https://site.example/delete-account');
  });

  it('ends with the version line: store version, build and running update', () => {
    const tree = renderScreen();
    const texts = tree.root.findAll((node) => String(node.type) === 'text');
    expect(texts.at(-1)?.props.children).toBe(VERSION_LABEL);
    expect(texts.at(-1)?.props.variant).toBe('caption');
  });

  // Audit, "OTA and the reported iPhone issue": non-sensitive support
  // diagnostics. They go above the version, which stays the last line.
  it('shows the OTA runtime and how the last draft came back, just above the version line', () => {
    updateRuntime.value = { runtimeVersion: '0.1.4', channel: 'production' };
    recordCreatorSession({ tool: 'video', outcome: 'recovered', referenceCount: 2, catalogRevision: 'rev-1', draftFormat: 'v1 per identity, remix 4' });
    const tree = renderScreen();
    const texts = tree.root.findAll((node) => String(node.type) === 'text');
    expect(texts.at(-1)?.props.children).toBe(VERSION_LABEL);
    expect(texts.at(-2)?.props.children).toBe(
      'Runtime 0.1.4 · channel production · video draft repaired from its source, 2 references · catalog rev-1 · drafts v1 per identity, remix 4',
    );
    expect(texts.at(-2)?.props.variant).toBe('caption');
  });

  it('leaves the version line out when no version can be read', () => {
    versionLabel.value = null;
    const tree = renderScreen();
    const texts = tree.root.findAll((node) => String(node.type) === 'text');
    expect(texts.some((node) => String(node.props.children).startsWith('Version'))).toBe(false);
  });
});

// Someone who had turned mature content on could turn it off only from the next
// mature post they opened (audit 04-9, D6).
describe('settings screen — mature content', () => {
  it("reads the signed-in account's setting", () => {
    renderScreen();
    expect(contentPreferences.options).toMatchObject({ queryKey: ['content-preferences', 'user-1'], enabled: true });
    expect(contentPreferences.options?.queryFn).toBe(authState.api.getContentPreferences);
  });

  it('shows the setting on iOS without changing it, and sends a change to the website', () => {
    const off = rowByTitle(renderScreen(), 'Mature content');
    expect(off.props.accessibilityRole).toBe('link');
    expect(off.props.accessibilityLabel).toBe('Mature content. Off. Mature posts stay covered. Change on the website.');
    renderer.act(() => { (off.props.onPress as () => void)(); });
    expect(openUrl).toHaveBeenCalledWith('https://site.example/profile');

    contentPreferences.query = { data: { showMature: true }, isError: false };
    expect(rowByTitle(renderScreen(), 'Mature content').props.accessibilityLabel)
      .toBe('Mature content. On. Mature posts can be revealed one at a time. Change on the website.');
  });

  it('never guesses the setting while it is read, or when the read fails', () => {
    contentPreferences.query = { data: undefined, isError: false };
    expect(rowByTitle(renderScreen(), 'Mature content').props.accessibilityLabel)
      .toBe('Mature content. Change on the website.');

    contentPreferences.query = { data: undefined, isError: true };
    expect(rowByTitle(renderScreen(), 'Mature content').props.accessibilityLabel)
      .toBe('Mature content. Could not be checked. Change on the website.');
  });

  it('has no row on Android, which never reveals a mature post, or for a signed-out visitor', () => {
    platform.os = 'android';
    expect(() => rowByTitle(renderScreen(), 'Mature content')).toThrow('No settings row titled "Mature content"');
    expect(contentPreferences.options).toBeNull();

    platform.os = 'ios';
    authState.user = null;
    expect(() => rowByTitle(renderScreen(), 'Mature content')).toThrow('No settings row titled "Mature content"');
    expect(contentPreferences.options).toBeNull();
  });
});

// D5 (C2): a guest deletes itself and what it made from Settings, behind one
// confirmation. An account is deleted on the Delete Account screen.
describe('settings screen — guest data (D5)', () => {
  const ROW = 'Delete guest data';
  const DELETED = {
    title: 'Guest data deleted',
    message: 'Your guest creations, uploads and credits are deleted and can’t be brought back. You’re now a new guest on this phone.',
  };

  function asGuest() {
    authState.user = null;
    authState.isGuest = true;
  }

  async function settle() {
    await renderer.act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  async function press(row: renderer.ReactTestInstance) {
    await renderer.act(async () => {
      (row.props.onPress as () => void)();
    });
    await settle();
  }

  it('offers a guest the row as a destructive action, beside the deletion policy link', () => {
    asGuest();
    const tree = renderScreen();
    const row = rowByTitle(tree, ROW);

    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe('Delete guest data. Permanently delete your guest creations, uploads and credits.');
    // It acts here, behind a confirmation: no chevron promising another screen.
    expect(row.findAll((node) => String(node.type) === 'icon' && ['ChevronRight', 'ArrowUpRight'].includes(String(node.props.name))))
      .toHaveLength(0);
    const danger = tree.root.findAll((node) => String(node.type) === 'text' && node.props.variant === 'cardTitle' && node.props.color === 'danger');
    expect(danger.map((node) => node.props.children)).toEqual([ROW]);
    expect(() => rowByTitle(tree, 'Delete account')).toThrow('No settings row titled "Delete account"');
    expect(rowByTitle(tree, 'Account deletion').props.accessibilityRole).toBe('link');
  });

  it('never offers it to an account, whose deletion stays on the Delete Account screen, or to a phone with no session', () => {
    const account = renderScreen();
    expect(() => rowByTitle(account, ROW)).toThrow(`No settings row titled "${ROW}"`);
    renderer.act(() => { (rowByTitle(account, 'Delete account').props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/delete-account');

    // Keyed on the account first: whatever else is said, an account never sees it.
    authState.isGuest = true;
    expect(() => rowByTitle(renderScreen(), ROW)).toThrow(`No settings row titled "${ROW}"`);

    authState.user = null;
    authState.isGuest = false;
    const noSession = renderScreen();
    expect(() => rowByTitle(noSession, ROW)).toThrow(`No settings row titled "${ROW}"`);
    expect(rowByTitle(noSession, 'Account deletion').props.accessibilityRole).toBe('link');
  });

  it('asks first, saying the creations and credits go for good and how to keep them, and stops at Cancel', async () => {
    asGuest();
    showConfirmDialog.mockResolvedValue(false);
    await press(rowByTitle(renderScreen(), ROW));

    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(showConfirmDialog).toHaveBeenCalledWith({
      title: 'Delete guest data?',
      message: 'Your guest creations, uploads and 120 credits are deleted for good. To keep them, create an account first.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    expect(authState.deleteAccount).not.toHaveBeenCalled();
    expect(showMessageDialog).not.toHaveBeenCalled();
  });

  it.each([
    [0, 'any credits'],
    [null, 'any credits'],
    [1, '1 credit'],
    [12500, '12500 credits'],
  ])('names a balance of %s as "%s"', async (credits, words) => {
    asGuest();
    authState.credits = credits;
    showConfirmDialog.mockResolvedValue(false);
    await press(rowByTitle(renderScreen(), ROW));

    expect(showConfirmDialog.mock.calls[0]?.[0]).toMatchObject({
      message: `Your guest creations, uploads and ${words} are deleted for good. To keep them, create an account first.`,
    });
  });

  it.each(['scheduled', 'deleted'])(
    'deletes on confirmation, with no sign-in, and says so once the server has %s it',
    async (outcome) => {
      asGuest();
      showConfirmDialog.mockResolvedValue(true);
      authState.deleteAccount.mockResolvedValue(outcome);
      await press(rowByTitle(renderScreen(), ROW));

      expect(authState.deleteAccount).toHaveBeenCalledOnce();
      expect(authState.deleteAccount).toHaveBeenCalledWith();
      expect(showMessageDialog).toHaveBeenCalledOnce();
      expect(showMessageDialog).toHaveBeenCalledWith(DELETED);
    },
  );

  it('says when the deletion could not be confirmed, and the row is ready to try again', async () => {
    asGuest();
    showConfirmDialog.mockResolvedValue(true);
    authState.deleteAccount.mockResolvedValue('unconfirmed');
    const tree = renderScreen();
    await press(rowByTitle(tree, ROW));

    expect(showMessageDialog).toHaveBeenCalledOnce();
    expect(showMessageDialog).toHaveBeenCalledWith({
      title: 'Deletion not confirmed',
      message: 'We could not confirm the deletion. Check the connection and try again.',
    });
    const row = rowByTitle(tree, ROW);
    expect(row.props.disabled).toBeFalsy();
    await press(row);
    expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    expect(authState.deleteAccount).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'the server could not start it',
      Object.assign(new Error('Account deletion could not be completed. Please try again.'), {
        status: 500,
        code: 'ACCOUNT_DELETION_NOT_STARTED',
        details: { code: 'ACCOUNT_DELETION_NOT_STARTED', deletionScheduled: false },
      }),
      'The deletion did not go through. Nothing was deleted.',
    ],
    [
      'a server from before guests could delete their data',
      Object.assign(new Error('Create an account to use this feature.'), {
        status: 403,
        code: 'REGISTRATION_REQUIRED',
        details: { code: 'REGISTRATION_REQUIRED' },
      }),
      'The deletion did not go through. Nothing was deleted.',
    ],
    [
      "a platform failure with none of the server's words",
      Object.assign(new Error('Request failed with status 502'), { status: 502, details: '<html>Bad gateway</html>' }),
      'The deletion did not go through. Nothing was deleted.',
    ],
    [
      'a refused session',
      Object.assign(new Error('Unauthorized'), { status: 401, code: 'UNAUTHORIZED', details: { code: 'UNAUTHORIZED' } }),
      'The deletion did not go through. Nothing was deleted.',
    ],
    [
      'a rate limit',
      Object.assign(new Error('Too many requests. Try again in 60 seconds.'), { status: 429, code: 'RATE_LIMITED', details: {} }),
      'Too many requests. Try again in 60 seconds. Nothing was deleted.',
    ],
    [
      'a request that never left the phone',
      Object.assign(new Error('Network request failed. Please check your connection and try again.'), {
        status: 0,
        details: { sent: false },
      }),
      'Network request failed. Please check your connection and try again. Nothing was deleted.',
    ],
  ])('says nothing was deleted after %s, in words for people', async (_name, error, message) => {
    asGuest();
    showConfirmDialog.mockResolvedValue(true);
    authState.deleteAccount.mockRejectedValue(error);
    await press(rowByTitle(renderScreen(), ROW));

    expect(showMessageDialog).toHaveBeenCalledOnce();
    expect(showMessageDialog).toHaveBeenCalledWith({ title: 'Guest data was not deleted', message });
  });

  it("leaves a guest linked to an account meanwhile to the sign-in screen's notice", async () => {
    asGuest();
    showConfirmDialog.mockResolvedValue(true);
    authState.deleteAccount.mockRejectedValue(Object.assign(
      new Error('This guest session has been linked to an account. Sign in to continue.'),
      { status: 409, code: 'SESSION_MERGED' },
    ));
    await press(rowByTitle(renderScreen(), ROW));

    expect(authState.deleteAccount).toHaveBeenCalledOnce();
    expect(showMessageDialog).not.toHaveBeenCalled();
  });

  it('takes one deletion at a time, and says one is under way', async () => {
    asGuest();
    let confirm: (answer: boolean) => void = () => undefined;
    showConfirmDialog.mockImplementation(() => new Promise<boolean>((resolve) => {
      confirm = resolve;
    }));
    let answer: (outcome: string) => void = () => undefined;
    authState.deleteAccount.mockImplementation(() => new Promise((resolve) => {
      answer = resolve;
    }));
    const tree = renderScreen();

    // A second tap before the confirmation is drawn asks nothing more.
    await press(rowByTitle(tree, ROW));
    await press(rowByTitle(tree, ROW));
    expect(showConfirmDialog).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      confirm(true);
    });
    await settle();
    const busy = rowByTitle(tree, ROW);
    expect(busy.props.accessibilityLabel).toBe('Delete guest data. Deleting guest data…');
    expect(busy.props.accessibilityState).toEqual({ busy: true, disabled: true });
    expect(busy.props.accessibilityLiveRegion).toBe('polite');
    expect(busy.props.disabled).toBe(true);
    expect(busy.findAll((node) => String(node.type) === 'activity-indicator')).toHaveLength(1);
    await press(busy);
    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(authState.deleteAccount).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      answer('scheduled');
    });
    await settle();
    expect(showMessageDialog).toHaveBeenCalledWith(DELETED);
    expect(rowByTitle(tree, ROW).props.disabled).toBeFalsy();
    // Booleans, not undefined: Android keeps a busy that goes back to undefined.
    expect(rowByTitle(tree, ROW).props.accessibilityState).toEqual({ busy: false, disabled: false });
  });
});

// Product decisions 2026-10-17, item 9.
describe('settings screen — sign out of all devices', () => {
  const ROW = 'Sign out of all devices';

  async function settle() {
    await renderer.act(async () => {
      for (let tick = 0; tick < 6; tick += 1) await Promise.resolve();
    });
  }

  async function press(row: renderer.ReactTestInstance) {
    await renderer.act(async () => {
      (row.props.onPress as () => void)();
    });
    await settle();
  }

  it("offers an account the row in its Account group, as an action here with no chevron", () => {
    const tree = renderScreen();
    const row = rowByTitle(tree, ROW);

    expect(row.props.accessibilityRole).toBe('button');
    expect(row.props.accessibilityLabel).toBe('Sign out of all devices. Sign out here and on every other phone or browser.');
    expect(row.findAll((node) => String(node.type) === 'icon' && ['ChevronRight', 'ArrowUpRight'].includes(String(node.props.name))))
      .toHaveLength(0);
    // Right after Alerts, the last of the Account rows.
    const titles = rows(tree).map((node) => String(node.props.accessibilityLabel).split('.')[0]);
    expect(titles.indexOf(ROW)).toBe(titles.indexOf('Alerts') + 1);
  });

  it('never offers it to a guest, whose one session is this phone, or to a phone with no session', () => {
    authState.user = null;
    authState.isGuest = true;
    expect(() => rowByTitle(renderScreen(), ROW)).toThrow(`No settings row titled "${ROW}"`);

    authState.isGuest = false;
    expect(() => rowByTitle(renderScreen(), ROW)).toThrow(`No settings row titled "${ROW}"`);
  });

  it('asks first, in the web menu\'s words, and stops at Cancel', async () => {
    showConfirmDialog.mockResolvedValue(false);
    await press(rowByTitle(renderScreen(), ROW));

    expect(showConfirmDialog).toHaveBeenCalledOnce();
    expect(showConfirmDialog).toHaveBeenCalledWith({
      title: 'Sign out of all devices?',
      message: 'You’ll be signed out here and on every other device.',
      confirmLabel: 'Sign out',
      destructive: true,
    });
    expect(authState.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('signs out everywhere on confirmation, and says nothing more', async () => {
    showConfirmDialog.mockResolvedValue(true);
    authState.signOutEverywhere.mockResolvedValue(undefined);
    await press(rowByTitle(renderScreen(), ROW));

    expect(authState.signOutEverywhere).toHaveBeenCalledOnce();
    expect(showMessageDialog).not.toHaveBeenCalled();
  });

  it('says when it did not go through, with this phone still signed in, and is ready to try again', async () => {
    showConfirmDialog.mockResolvedValue(true);
    authState.signOutEverywhere.mockRejectedValue(new Error('Supabase auth request timed out after 10000ms'));
    const tree = renderScreen();
    await press(rowByTitle(tree, ROW));

    expect(showMessageDialog).toHaveBeenCalledOnce();
    expect(showMessageDialog).toHaveBeenCalledWith({
      title: 'Could not sign out of all devices',
      message: 'The sign-out did not go through, and you’re still signed in on this phone. Check your connection and try again.',
    });
    await press(rowByTitle(tree, ROW));
    expect(showConfirmDialog).toHaveBeenCalledTimes(2);
    expect(authState.signOutEverywhere).toHaveBeenCalledTimes(2);
  });

  it('asks once for a second tap made before the first question is answered', async () => {
    let answer: (confirmed: boolean) => void = () => undefined;
    showConfirmDialog.mockImplementation(() => new Promise<boolean>((resolve) => {
      answer = resolve;
    }));
    const tree = renderScreen();

    await press(rowByTitle(tree, ROW));
    await press(rowByTitle(tree, ROW));
    expect(showConfirmDialog).toHaveBeenCalledOnce();

    await renderer.act(async () => {
      answer(false);
    });
    await settle();
    await press(rowByTitle(tree, ROW));
    expect(showConfirmDialog).toHaveBeenCalledTimes(2);
  });
});
