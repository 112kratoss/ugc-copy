// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const openUrl = vi.hoisted(() => vi.fn());
const VERSION_LABEL = 'Version 0.1.8 (59) · update a79c7580';
const versionLabel = vi.hoisted(() => ({ value: null as string | null }));
const updateRuntime = vi.hoisted(() => ({ value: { runtimeVersion: null as string | null, channel: null as string | null } }));

vi.mock('react-native', () => ({
  Linking: { openURL: openUrl },
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement('icon', { name, ...props });
  return {
    ArrowUpRight: icon('ArrowUpRight'),
    Mail: icon('Mail'),
    MessageCircle: icon('MessageCircle'),
    ShieldCheck: icon('ShieldCheck'),
  };
});

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
}));

vi.mock('@/lib/app-version-label', () => ({
  formatAppVersionLabel: () => versionLabel.value,
  readAppVersionParts: () => ({ version: null, build: null, update: null }),
  readUpdateRuntime: () => updateRuntime.value,
}));

import HelpScreen from '../app/help';
import { recordCreatorSession, resetCreatorSessionForTests } from '../lib/creator-session-diagnostics';

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(HelpScreen));
  });
  return tree;
}

function cardTitles(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text' && node.props.variant === 'cardTitle')
    .map((node) => node.props.children);
}

function contactSupport(tree: renderer.ReactTestRenderer) {
  const link = tree.root.findAll((node) => String(node.type) === 'pressable')
    .find((node) => String(node.props.accessibilityLabel).startsWith('Contact support.'));
  if (!link) throw new Error('No Contact support link');
  return link;
}

beforeEach(() => {
  openUrl.mockClear();
  versionLabel.value = VERSION_LABEL;
  updateRuntime.value = { runtimeVersion: '0.1.8', channel: 'production' };
  resetCreatorSessionForTests();
});

describe('help screen', () => {
  // The subtitle promised guidance on credits and publishing that no card gave.
  it('says what its cards cover, in the words of the Settings row that opens it', () => {
    const tree = renderScreen();

    expect(tree.root.findByType('section-title' as never).props.body)
      .toBe('Find quick guidance for creations, recipes, and contacting support.');
    expect(cardTitles(tree)).toEqual(['Creation help', 'Recipes and sales', 'Contact support']);
  });

  // Settings builds these lines for support, and the mail never carried them.
  it('mails support with the version and runtime lines Settings shows, below room for the message', () => {
    recordCreatorSession({ tool: 'video', outcome: 'recovered', referenceCount: 2, catalogRevision: 'rev-1', draftFormat: 'v1 per identity, remix 4' });
    const tree = renderScreen();

    renderer.act(() => { (contactSupport(tree).props.onPress as () => void)(); });

    const url = new URL(openUrl.mock.calls[0][0] as string);
    expect(`${url.protocol}${url.pathname}`).toBe('mailto:info@magicbooklet.com');
    expect(url.searchParams.get('subject')).toBe('Magicbooklet app support');
    expect(url.searchParams.get('body')).toBe([
      '',
      '',
      VERSION_LABEL,
      'Runtime 0.1.8 · channel production · video draft repaired from its source, 2 references · catalog rev-1 · drafts v1 per identity, remix 4',
    ].join('\n'));
  });

  it('sends a plain mail when there is nothing to report', () => {
    versionLabel.value = null;
    updateRuntime.value = { runtimeVersion: null, channel: null };
    const tree = renderScreen();

    renderer.act(() => { (contactSupport(tree).props.onPress as () => void)(); });

    expect(openUrl).toHaveBeenCalledWith('mailto:info@magicbooklet.com?subject=Magicbooklet%20app%20support');
  });
});
