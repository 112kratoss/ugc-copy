import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const harness = vi.hoisted(() => ({
  api: { claimWelcomeCredits: vi.fn() },
  user: { id: 'creator-1' } as { id: string } | null,
  updateCredits: vi.fn(),
  refreshProfile: vi.fn(async () => undefined),
  welcome: { status: 'eligible', identityComplete: true, amount: 25 } as Record<string, unknown> | undefined,
  focused: true,
  reducedMotion: true,
  haptics: [] as string[],
  announced: [] as string[],
  primed: [] as unknown[],
}));

vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
    setValue() {}
    interpolate() { return 0; }
  }
  return {
    AccessibilityInfo: { announceForAccessibility: (text: string) => harness.announced.push(text) },
    Animated: { Value, View: (props: MockProps) => React.createElement('animated-view', props, props.children), timing: () => ({ start() {}, stop() {} }), parallel: () => ({ start() {}, stop() {} }) },
    Easing: { out: () => () => 0, quad: () => 0 },
    Modal: ({ visible, children }: MockProps) => (visible ? React.createElement('modal', null, children) : null),
    Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, typeof children === 'function' ? null : children),
    Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  };
});
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: MockProps) => React.createElement('linear-gradient', null, children) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Clapperboard', 'Gift', 'ImageIcon', 'Rocket', 'Sparkles'].map((name) => [name, () => React.createElement(`icon-${name}`)])));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => harness.focused }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@/components/ui', () => ({
  AppText: ({ children }: MockProps) => React.createElement('app-text', null, children),
  IconButton: (props: MockProps) => React.createElement('icon-button', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
}));
vi.mock('@/lib/platform-glyphs', () => ({ CloseGlyph: () => null }));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: harness.api, user: harness.user, updateCredits: harness.updateCredits, refreshProfile: harness.refreshProfile }),
}));
vi.mock('@/lib/haptics', () => ({
  haptic: Object.fromEntries(['select', 'light', 'soft', 'medium', 'success', 'error'].map((kind) => [kind, () => harness.haptics.push(kind)])),
}));
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useReducedMotion: () => harness.reducedMotion,
  useSpringState: () => null,
}));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({ colors: new Proxy({}, { get: (_target, name) => `token-${String(name)}` }) }),
  ThemeScope: ({ children }: MockProps) => React.createElement('theme-scope', null, children),
}));
vi.mock('@/lib/use-onboarding-destination', () => ({
  useWelcomeCreditsQuery: () => ({ data: harness.welcome }),
  primeWelcomeCredits: (_client: unknown, _id: string, value: unknown) => harness.primed.push(value),
}));

import { WelcomeCreditsPopup } from '../components/welcome-credits-popup';
import { resetWelcomePopupThisRun, wasWelcomePopupDismissedThisRun } from '../lib/welcome-popup';

const trees: renderer.ReactTestRenderer[] = [];
function mount() {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<WelcomeCreditsPopup />); });
  trees.push(tree);
  return tree;
}
const text = (tree: renderer.ReactTestRenderer) => JSON.stringify(tree.toJSON());
const button = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === label);
const close = (tree: renderer.ReactTestRenderer) =>
  tree.root.find((node) => String(node.type) === 'icon-button' && node.props.label === 'Close');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('the welcome-credits popup over Home (owner 11-09)', () => {
  beforeEach(() => {
    resetWelcomePopupThisRun();
    harness.api.claimWelcomeCredits.mockReset();
    harness.updateCredits.mockClear();
    harness.welcome = { status: 'eligible', identityComplete: true, amount: 25 };
    harness.user = { id: 'creator-1' };
    harness.focused = true;
    harness.reducedMotion = true;
    harness.haptics.length = 0;
    harness.announced.length = 0;
    harness.primed.length = 0;
  });
  afterEach(() => {
    act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  });

  it('offers the credits with one Claim button and no "later"', () => {
    const tree = mount();
    expect(text(tree)).toContain('Claim your welcome credits');
    expect(button(tree, 'Claim')).toBeTruthy();
    expect(text(tree)).toContain('can only be used for creating media');
    expect(text(tree)).not.toContain('later');
  });

  it('stays away from a guest, an account without a name, a claimed one, or while Home is covered', () => {
    for (const setup of [
      () => { harness.user = null; },
      () => { harness.welcome = { status: 'not_eligible', identityComplete: false, amount: 25 }; },
      () => { harness.welcome = { status: 'claimed', identityComplete: true, amount: 25 }; },
      () => { harness.focused = false; },
    ]) {
      harness.user = { id: 'creator-1' };
      harness.welcome = { status: 'eligible', identityComplete: true, amount: 25 };
      harness.focused = true;
      setup();
      expect(mount().toJSON()).toBeNull();
    }
  });

  it('claims on tap: a light tap, the balance, the count, the success haptic and a word for VoiceOver', async () => {
    harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
    const tree = mount();
    await act(async () => {
      button(tree, 'Claim').props.onPress();
      await flush();
    });

    expect(harness.api.claimWelcomeCredits).toHaveBeenCalledTimes(1);
    expect(harness.updateCredits).toHaveBeenCalledWith(25);
    expect(harness.primed).toHaveLength(1);
    // Still up after the answer turns to "claimed": the card is latched once offered.
    expect(text(tree)).toContain('Credits added!');
    expect(text(tree)).toContain('+25');
    expect(harness.haptics).toEqual(['light', 'success']);
    expect(harness.announced).toEqual(['25 credits added to your balance.']);
    expect(button(tree, 'Claimed').props.disabled).toBe(true);
    expect(tree.root.findAll((node) => String(node.type) === 'primary-button' && node.props.label === 'Start creating')).toHaveLength(0);
  });

  it('closes by itself a moment after the claim (owner 11-09)', async () => {
    vi.useFakeTimers();
    try {
      harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
      const tree = mount();
      await act(async () => {
        button(tree, 'Claim').props.onPress();
        await flush();
      });
      expect(text(tree)).toContain('Credits added!');
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(tree.toJSON()).not.toBeNull();
      await act(async () => { vi.advanceTimersByTime(1500); });
      expect(tree.toJSON()).toBeNull();
      expect(wasWelcomePopupDismissedThisRun()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ticks a haptic every five credits as they count up, then the success haptic', async () => {
    vi.useFakeTimers();
    try {
      harness.reducedMotion = false;
      harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
      const tree = mount();
      await act(async () => {
        button(tree, 'Claim').props.onPress();
        await flush();
      });
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(harness.haptics).toEqual(['light', 'select', 'select', 'select', 'select', 'success']);
      expect(text(tree)).toContain('+25');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the card and offers a retry when the claim fails', async () => {
    harness.api.claimWelcomeCredits
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
    const tree = mount();
    await act(async () => {
      button(tree, 'Claim').props.onPress();
      await flush();
    });
    expect(text(tree)).toContain('Network request failed');
    expect(harness.haptics).toContain('error');
    await act(async () => {
      button(tree, 'Try again').props.onPress();
      await flush();
    });
    expect(text(tree)).toContain('Credits added!');
  });

  it('starts afresh for the next account rather than showing one account\'s claim to another', async () => {
    harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
    const tree = mount();
    await act(async () => {
      button(tree, 'Claim').props.onPress();
      await flush();
    });
    expect(text(tree)).toContain('Credits added!');

    harness.user = { id: 'creator-2' };
    harness.welcome = { status: 'eligible', identityComplete: true, amount: 25 };
    act(() => { tree.update(<WelcomeCreditsPopup />); });
    expect(text(tree)).toContain('Claim your welcome credits');
    expect(text(tree)).not.toContain('Credits added!');
  });

  it('closes until the next app start', () => {
    const tree = mount();
    act(() => { close(tree).props.onPress(); });
    expect(tree.toJSON()).toBeNull();
    expect(wasWelcomePopupDismissedThisRun()).toBe(true);
    expect(mount().toJSON()).toBeNull();
  });
});
