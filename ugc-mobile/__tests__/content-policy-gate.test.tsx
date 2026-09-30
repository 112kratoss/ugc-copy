// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async (_key: string, _value: string) => undefined),
}));

const navigation = vi.hoisted(() => ({
  back: vi.fn(),
  replace: vi.fn(),
  canGoBack: vi.fn(() => true),
}));

const linking = vi.hoisted(() => ({ openURL: vi.fn(async () => true) }));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  },
}));

vi.mock('expo-router', () => ({ router: navigation }));

vi.mock('react-native', () => ({
  Linking: linking,
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  ShieldCheck: (props: Record<string, unknown>) => React.createElement('icon', { name: 'ShieldCheck', ...props }),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
}));

vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.com' } }));
vi.mock('@/lib/haptics', () => ({ haptic: { light: vi.fn() } }));
vi.mock('@/lib/theme', () => ({ appTheme: { icon: { compact: 18 } } }));
vi.mock('@/lib/theme-context', () => ({ useAppTheme: () => ({ colors: { primary: 'primary-token' } }) }));

import { ContentPolicyGate } from '../components/content-policy-gate';
import { CONTENT_POLICY_RULES, CONTENT_POLICY_STORAGE_KEY, resetContentPolicyForTests } from '../lib/content-policy';

function Creation() {
  return React.createElement('creation-screen');
}

function textOf(tree: ReactTestRenderer) {
  return tree.root.findAll((node) => (node.type as unknown) === 'text').map((node) => node.children.join('')).join('\n');
}

function button(tree: ReactTestRenderer, label: string) {
  return tree.root.find((node) => typeof node.props.label === 'string' && node.props.label === label);
}

async function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(element);
  });
  // Let the stored answer's read settle.
  await act(async () => {
    await Promise.resolve();
  });
  return tree;
}

beforeEach(() => {
  resetContentPolicyForTests();
  storage.getItem.mockReset().mockResolvedValue(null);
  storage.setItem.mockReset().mockResolvedValue(undefined);
  navigation.back.mockReset();
  navigation.replace.mockReset();
  navigation.canGoBack.mockReset().mockReturnValue(true);
  linking.openURL.mockClear();
});

describe('ContentPolicyGate', () => {
  it('shows nothing until the stored answer is read, so no one sees the rules flash past', async () => {
    storage.getItem.mockReturnValue(new Promise(() => undefined));
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ContentPolicyGate><Creation /></ContentPolicyGate>);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('shows the rules instead of the creation screen the first time', async () => {
    const tree = await render(<ContentPolicyGate><Creation /></ContentPolicyGate>);

    expect(tree.root.findAll((node) => (node.type as unknown) === 'creation-screen')).toHaveLength(0);
    const text = textOf(tree);
    for (const rule of CONTENT_POLICY_RULES) expect(text).toContain(rule);

    button(tree, 'Read the Terms of Service').props.onPress();
    expect(linking.openURL).toHaveBeenCalledWith('https://magicbooklet.com/terms');
  });

  it('opens the creation screen once the rules are accepted, and remembers it', async () => {
    const tree = await render(<ContentPolicyGate><Creation /></ContentPolicyGate>);

    await act(async () => {
      button(tree, 'I agree').props.onPress();
    });

    expect(tree.root.findAll((node) => (node.type as unknown) === 'creation-screen')).toHaveLength(1);
    expect(storage.setItem).toHaveBeenCalledWith(CONTENT_POLICY_STORAGE_KEY, expect.stringContaining('"version":1'));
  });

  it('leaves without creating on Not now', async () => {
    const tree = await render(<ContentPolicyGate><Creation /></ContentPolicyGate>);
    button(tree, 'Not now').props.onPress();
    expect(navigation.back).toHaveBeenCalled();

    navigation.canGoBack.mockReturnValue(false);
    button(tree, 'Not now').props.onPress();
    expect(navigation.replace).toHaveBeenCalledWith('/(tabs)');
  });

  it('goes straight to the creation screen for someone who already agreed', async () => {
    storage.getItem.mockResolvedValue(JSON.stringify({ version: 1, acceptedAt: '2026-09-30T10:00:00.000Z' }));
    const tree = await render(<ContentPolicyGate><Creation /></ContentPolicyGate>);
    expect(tree.root.findAll((node) => (node.type as unknown) === 'creation-screen')).toHaveLength(1);
    expect(textOf(tree)).not.toContain(CONTENT_POLICY_RULES[0]);
  });
});
