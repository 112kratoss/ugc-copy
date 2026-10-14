// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

// The consent store is the real one; only the phone's storage under it is a double.
const storage = vi.hoisted(() => ({
  value: null as string | null,
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
    removeItem: (key: string) => storage.removeItem(key),
  },
}));

// The store asks through this before a request; this screen never asks.
vi.mock('@/lib/dialog', () => ({ showConfirmDialog: vi.fn(async () => false) }));

vi.mock('react-native', () => ({
  Linking: { openURL: vi.fn() },
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Record<string, unknown>) => React.createElement('icon', { name, ...props });
  return { ArrowUpRight: icon('ArrowUpRight'), Building2: icon('Building2'), Send: icon('Send'), ShieldCheck: icon('ShieldCheck') };
});

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
}));

vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://site.example' } }));
vi.mock('@/lib/haptics', () => ({ haptic: { select: vi.fn() } }));

import AiDataSharingScreen from '../app/ai-data-sharing';
import {
  AI_DATA_CONSENT_STORAGE_KEY,
  AI_DATA_CONSENT_VERSION,
  AI_DATA_SHARED_ITEMS,
  resetAiDataConsentForTests,
  withdrawAiDataConsent,
} from '../lib/ai-data-consent';

const STORED = JSON.stringify({ version: AI_DATA_CONSENT_VERSION, grantedAt: '2026-09-25T08:00:00.000Z' });
const NOT_ALLOWED_LINE = 'Nothing is sent from this phone until you allow it. You’ll be asked the first time you create.';
const WITHDRAW_LINE = 'If you withdraw, nothing more is sent from this phone, and you’ll be asked again the next time you create.';

beforeEach(() => {
  resetAiDataConsentForTests();
  storage.value = null;
  storage.getItem.mockReset().mockImplementation(async () => storage.value);
  storage.setItem.mockReset().mockImplementation(async (_key: string, value: string) => { storage.value = value; });
  storage.removeItem.mockReset().mockImplementation(async () => { storage.value = null; });
});

/** Lets the stored answer's read land: it is a short chain of promise callbacks. */
const flush = () => renderer.act(async () => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
});

async function renderScreen(element: React.ReactElement = <AiDataSharingScreen />) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => { tree = renderer.create(element); });
  await flush();
  return tree;
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => String(node.props.children));
}

function button(tree: renderer.ReactTestRenderer, type: 'primary-button' | 'secondary-button') {
  return tree.root.find((node) => String(node.type) === type);
}

// The answer lives on this phone, not on the account: another phone asks afresh and the
// website never asks. So the screen says what a choice here covers, and no more.
describe('AI data sharing screen', () => {
  it('says nothing leaves this phone before permission, and lists every action that sends', async () => {
    const tree = await renderScreen();

    expect(texts(tree)).toContain('Not allowed');
    expect(texts(tree)).toContain(NOT_ALLOWED_LINE);
    expect(button(tree, 'primary-button').props).toMatchObject({ label: 'Allow', disabled: false });
    // "What is sent" names the Seedance prepare beside generate, enhance and templates.
    expect(texts(tree)).toContain(AI_DATA_SHARED_ITEMS);
    expect(AI_DATA_SHARED_ITEMS).toContain('prepare a Seedance reference');
  });

  it('says a withdrawal stops this phone, once permission is given', async () => {
    storage.value = STORED;
    const tree = await renderScreen();

    expect(texts(tree)).toContain('Allowed');
    const line = texts(tree).find((entry) => entry.startsWith('You allowed this on '));
    expect(line).toMatch(/2026/);
    expect(line?.endsWith(WITHDRAW_LINE)).toBe(true);
  });

  it('withdraws and allows again from the card, saying each time what it covers', async () => {
    storage.value = STORED;
    const tree = await renderScreen();

    await renderer.act(async () => { button(tree, 'secondary-button').props.onPress(); });
    expect(storage.removeItem).toHaveBeenCalledWith(AI_DATA_CONSENT_STORAGE_KEY);
    expect(texts(tree)).toContain(NOT_ALLOWED_LINE);

    await renderer.act(async () => { button(tree, 'primary-button').props.onPress(); });
    expect(storage.setItem).toHaveBeenCalledWith(AI_DATA_CONSENT_STORAGE_KEY, expect.any(String));
    expect(texts(tree)).toContain('Allowed');
    expect(texts(tree).some((entry) => entry.endsWith(WITHDRAW_LINE))).toBe(true);
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('still follows the answer after every effect runs again', async () => {
    storage.value = STORED;
    const inActivity = (mode: 'visible' | 'hidden') => <React.Activity mode={mode}><AiDataSharingScreen /></React.Activity>;
    const tree = await renderScreen(inActivity('visible'));
    expect(texts(tree)).toContain('Allowed');

    await renderer.act(async () => { tree.update(inActivity('hidden')); });
    // Really hidden, so its effects were cleaned up.
    expect(tree.toJSON()).toBeNull();
    await renderer.act(async () => { tree.update(inActivity('visible')); });
    await flush();
    expect(texts(tree)).toContain('Allowed');
    // The read is not repeated, so it cannot overwrite an answer given since.
    expect(storage.getItem).toHaveBeenCalledTimes(1);

    // A withdrawal from anywhere in the app reaches the screen: it subscribed again.
    await renderer.act(async () => { await withdrawAiDataConsent(); });
    expect(texts(tree)).toContain('Not allowed');
    expect(texts(tree)).toContain(NOT_ALLOWED_LINE);
  });
});
