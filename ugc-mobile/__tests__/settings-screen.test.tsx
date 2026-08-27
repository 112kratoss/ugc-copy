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

import SettingsScreen from '../app/settings';

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
  routerPush.mockClear();
  openUrl.mockClear();
  authState.user = { id: 'user-1', email: 'creator@example.com' };
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
});
