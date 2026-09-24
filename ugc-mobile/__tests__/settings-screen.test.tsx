// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const authState = vi.hoisted(() => ({
  credits: 120,
  user: { id: 'user-1', email: 'creator@example.com' } as { id: string; email: string } | null,
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
  Linking: { openURL: openUrl },
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement('icon', { name, ...props });
  return {
    ArrowUpRight: icon('ArrowUpRight'),
    Bell: icon('Bell'),
    ChevronRight: icon('ChevronRight'),
    CircleHelp: icon('CircleHelp'),
    CreditCard: icon('CreditCard'),
    FileText: icon('FileText'),
    Gift: icon('Gift'),
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
vi.mock('@/lib/dialog', () => ({ showMessageDialog }));

const aiDataConsent = vi.hoisted(() => ({ grantedAt: null as string | null }));

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
  versionLabel.value = VERSION_LABEL;
  updateRuntime.value = { runtimeVersion: null, channel: null };
  resetCreatorSessionForTests();
});

function appearanceOptions(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityRole === 'radio');
}

describe('settings screen — appearance', () => {
  it('offers System, Light and Dark as one radio group, checked by the stored choice', () => {
    appearance.preference = 'light';
    const tree = renderScreen();
    const group = tree.root.find((node) => String(node.type) === 'view' && node.props.accessibilityRole === 'radiogroup');
    expect(group.props.accessibilityLabel).toBe('Appearance');

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
    expect(notAllowed.props.accessibilityLabel).toContain('Not allowed. You’ll be asked before anything is sent to AI services.');
    renderer.act(() => { (notAllowed.props.onPress as () => void)(); });
    expect(routerPush).toHaveBeenCalledWith('/ai-data-sharing');

    aiDataConsent.grantedAt = '2026-09-25T08:00:00.000Z';
    const allowed = rowByTitle(renderScreen(), 'AI data sharing');
    expect(allowed.props.accessibilityLabel).toContain('Allowed. Your prompts and media go to AI services when you create.');
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
