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
  // The screen in front, as expo-router names it: Home is `/`.
  pathname: '/',
  reducedMotion: true,
  haptics: [] as string[],
  announced: [] as string[],
  primed: [] as unknown[],
  exits: [] as Array<() => void>,
}));

vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
    setValue() {}
    interpolate() { return 0; }
  }
  return {
    AccessibilityInfo: { announceForAccessibility: (text: string) => harness.announced.push(text) },
    Animated: { Value, View: (props: MockProps) => React.createElement('animated-view', props, props.children), timing: (_value: unknown, config: { toValue: number }) => ({ start(done?: () => void) { if (config.toValue === 0 && done) harness.exits.push(done); }, stop() {} }), parallel: () => ({ start() {}, stop() {} }), sequence: () => ({ start() {}, stop() {} }) },
    Easing: { out: () => () => 0, quad: () => 0, bezier: () => () => 0, linear: () => 0 },
    Modal: ({ visible, children, onRequestClose }: MockProps) => (visible ? React.createElement('modal', { onRequestClose }, children) : null),
    Pressable: ({ children, ...props }: MockProps) => React.createElement('pressable', props, typeof children === 'function' ? null : children),
    Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  };
});
vi.mock('expo-linear-gradient', () => ({ LinearGradient: ({ children }: MockProps) => React.createElement('linear-gradient', null, children) }));
vi.mock('lucide-react-native', () => Object.fromEntries(['Check', 'Sparkles'].map((name) => [name, () => React.createElement(`icon-${name}`)])));
vi.mock('react-native-svg', () => ({
  default: ({ children }: MockProps) => React.createElement('svg', null, children),
  Circle: (props: MockProps) => React.createElement('circle', props),
}));
vi.mock('expo-router', () => ({ usePathname: () => harness.pathname }));
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
  useAppTheme: () => ({
    colors: new Proxy({}, { get: (_target, name) => `token-${String(name)}` }),
    shadow: new Proxy({}, { get: () => ({ boxShadow: 'none' }) }),
  }),
  ThemeScope: ({ children }: MockProps) => React.createElement('theme-scope', null, children),
}));
// The phone's record of the invite claim a sign-up made, in memory.
const secureStore = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStore.delete(key);
  },
}));
vi.mock('@/lib/use-onboarding-destination', () => ({
  useWelcomeCreditsQuery: () => ({ data: harness.welcome }),
  primeWelcomeCredits: (_client: unknown, _id: string, value: unknown) => harness.primed.push(value),
}));

import { CLAIM_CONFETTI_MS } from '../components/claim-confetti';
import { WelcomeCreditsPopup } from '../components/welcome-credits-popup';
import { markWelcomeReturn, resetWelcomePopupThisRun, wasWelcomePopupDismissedThisRun, WELCOME_COUNT_UP_MS } from '../lib/welcome-popup';

const trees: renderer.ReactTestRenderer[] = [];
// Every host view measures to the same window frame, so the figure has an origin for the burst.
const nodeMock = { measureInWindow: (done: (x: number, y: number, width: number, height: number) => void) => done(40, 300, 240, 88) };
function mount() {
  let tree!: renderer.ReactTestRenderer;
  act(() => { tree = renderer.create(<WelcomeCreditsPopup />, { createNodeMock: () => nodeMock }); });
  trees.push(tree);
  return tree;
}
const text = (tree: renderer.ReactTestRenderer) => JSON.stringify(tree.toJSON());
const button = (tree: renderer.ReactTestRenderer, label: string) =>
  tree.root.find((node) => String(node.type) === 'primary-button' && node.props.label === label);
const close = (tree: renderer.ReactTestRenderer) =>
  tree.root.find((node) => String(node.type) === 'icon-button' && node.props.label === 'Close');
const modal = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => String(node.type) === 'modal');
// The confetti pieces: the only animated views placed by a numeric left and width.
const confetti = (tree: renderer.ReactTestRenderer) =>
  tree.root.findAll((node) => String(node.type) === 'animated-view' && typeof node.props.style?.left === 'number' && typeof node.props.style?.width === 'number');
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('the welcome-credits popup over Home (owner 11-09)', () => {
  beforeEach(() => {
    resetWelcomePopupThisRun();
    harness.api.claimWelcomeCredits.mockReset();
    harness.updateCredits.mockClear();
    harness.refreshProfile.mockClear();
    harness.welcome = { status: 'eligible', identityComplete: true, amount: 25 };
    harness.user = { id: 'creator-1' };
    harness.pathname = '/';
    harness.reducedMotion = true;
    harness.haptics.length = 0;
    harness.announced.length = 0;
    harness.primed.length = 0;
    harness.exits.length = 0;
  });
  afterEach(() => {
    act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
  });

  it('says the invite the sign-up claimed was applied, in the web\'s words (owner 11-11)', async () => {
    secureStore.set('magicbooklet.referral.recentClaim.v1', JSON.stringify({
      code: 'a43ea71e6475',
      claimedAt: new Date().toISOString(),
      response: { success: true, claimed: true },
      program: { inviterPercent: 5, inviteeFirstPurchasePercent: 10, attributionWindowDays: 30 },
    }));
    const tree = mount();
    await act(async () => { await flush(); await flush(); });
    expect(text(tree)).toContain('Invite applied: your first credit-pack purchase gets 10% bonus credits.');
    secureStore.clear();
  });

  it('says why an invite was not applied, and nothing without one', async () => {
    secureStore.set('magicbooklet.referral.recentClaim.v1', JSON.stringify({
      code: 'a43ea71e6475',
      claimedAt: new Date().toISOString(),
      response: { success: true, claimed: false, reason: 'self_referral' },
    }));
    let tree = mount();
    await act(async () => { await flush(); await flush(); });
    expect(text(tree)).toContain('Invite not applied: you cannot use your own invite.');
    act(() => tree.unmount());
    trees.splice(trees.indexOf(tree), 1);

    secureStore.clear();
    resetWelcomePopupThisRun();
    tree = mount();
    await act(async () => { await flush(); await flush(); });
    expect(text(tree)).not.toContain('Invite');
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
      () => { harness.pathname = '/post/123'; },
      () => { harness.pathname = '/creator'; },
    ]) {
      harness.user = { id: 'creator-1' };
      harness.welcome = { status: 'eligible', identityComplete: true, amount: 25 };
      harness.pathname = '/';
      setup();
      expect(mount().toJSON()).toBeNull();
    }
  });

  // A sign-up from a creator's Generate went back to the creator with no popup
  // and 0 credits, and the creator offered a top-up (iPhone simulator, 2026-11-09).
  it('offers the credits on the screen a finished sign-up went back to, and on no other', () => {
    markWelcomeReturn('/(tabs)/creator?tool=image');
    harness.pathname = '/creator';
    const tree = mount();
    expect(text(tree)).toContain('Claim your welcome credits');
    act(() => tree.unmount());
    trees.splice(trees.indexOf(tree), 1);

    harness.pathname = '/create/image';
    expect(mount().toJSON()).toBeNull();
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
    // Claim gives way to the outcome; no second button to press.
    expect(text(tree)).toContain('Added to your balance');
    expect(tree.root.findAll((node) => String(node.type) === 'primary-button')).toHaveLength(0);
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
      expect(wasWelcomePopupDismissedThisRun('creator-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fills up with a haptic tick for every credit, then the success haptic as it lands (owner 11-09: "like games")', async () => {
    vi.useFakeTimers();
    try {
      harness.reducedMotion = false;
      harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
      const tree = mount();
      await act(async () => {
        button(tree, 'Claim').props.onPress();
        await flush();
      });
      await act(async () => { vi.advanceTimersByTime(600); });
      expect(text(tree)).toContain('Adding your credits');
      expect(harness.haptics).not.toContain('success');
      // The header's balance waits for the landing; Close waits with it.
      expect(harness.updateCredits).not.toHaveBeenCalled();
      expect(close(tree).props.disabled).toBe(true);
      // Fast off the mark: most of the credits are in before the halfway mark.
      const shown = Number(text(tree).match(/\+(\d+)/)?.[1]);
      expect(shown).toBeGreaterThanOrEqual(15);
      expect(shown).toBeLessThan(25);
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(harness.haptics).toEqual(['light', ...Array<string>(24).fill('select'), 'success']);
      expect(text(tree)).toContain('+25');
      expect(text(tree)).toContain('Credits added!');
      expect(harness.updateCredits).toHaveBeenCalledWith(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bursts confetti out of the figure as it lands, sinks away beneath it and goes once the last piece has fallen', async () => {
    vi.useFakeTimers();
    try {
      harness.reducedMotion = false;
      harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
      const tree = mount();
      await act(async () => {
        button(tree, 'Claim').props.onPress();
        await flush();
      });
      // Mounted invisible during the fill, so the landing has nothing to build.
      expect(confetti(tree)).toHaveLength(48);
      await act(async () => { vi.advanceTimersByTime(WELCOME_COUNT_UP_MS + 50); });
      expect(text(tree)).toContain('Credits added!');
      expect(confetti(tree)).toHaveLength(48);
      // Not yet leaving: a beat for the landing.
      expect(harness.exits).toHaveLength(0);
      await act(async () => { vi.advanceTimersByTime(300); });
      expect(harness.exits).toHaveLength(1);
      // The card has faded, but the Modal stays for the confetti still falling.
      act(() => { harness.exits[0](); });
      expect(tree.toJSON()).not.toBeNull();
      await act(async () => { vi.advanceTimersByTime(CLAIM_CONFETTI_MS + 200); });
      expect(tree.toJSON()).toBeNull();
      expect(wasWelcomePopupDismissedThisRun('creator-1')).toBe(true);
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

  it('keeps the card when the server refuses, with no retry to press and Close open', async () => {
    harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'legacy_ineligible', identityComplete: true, amount: 25 });
    const tree = mount();
    await act(async () => {
      button(tree, 'Claim').props.onPress();
      await flush();
    });
    expect(text(tree)).toContain('can’t be claimed on this account');
    expect(tree.root.findAll((node) => String(node.type) === 'primary-button')).toHaveLength(0);
    expect(close(tree).props.disabled).toBe(false);
    expect(harness.updateCredits).not.toHaveBeenCalled();
  });

  it('ignores Android\'s back key while the claim is in flight, so a failed claim is not lost behind a hidden card', async () => {
    let answer!: (value: unknown) => void;
    harness.api.claimWelcomeCredits.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const tree = mount();
    await act(async () => {
      button(tree, 'Claim').props.onPress();
      await flush();
    });
    act(() => { modal(tree).props.onRequestClose(); });
    expect(tree.toJSON()).not.toBeNull();
    expect(wasWelcomePopupDismissedThisRun('creator-1')).toBe(false);
    expect(close(tree).props.disabled).toBe(true);
    await act(async () => {
      answer({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
      await flush();
    });
    expect(text(tree)).toContain('Credits added!');
    act(() => { modal(tree).props.onRequestClose(); });
    expect(tree.toJSON()).toBeNull();
  });

  it('never writes one account\'s balance over the next: a switch mid-fill reads the profile again instead', async () => {
    vi.useFakeTimers();
    try {
      harness.reducedMotion = false;
      harness.api.claimWelcomeCredits.mockResolvedValue({ status: 'claimed', identityComplete: true, amount: 25, credits: 25 });
      const tree = mount();
      await act(async () => {
        button(tree, 'Claim').props.onPress();
        await flush();
      });
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(text(tree)).toContain('Adding your credits');
      harness.user = { id: 'creator-2' };
      harness.welcome = { status: 'eligible', identityComplete: true, amount: 25 };
      act(() => { tree.update(<WelcomeCreditsPopup />); });
      expect(harness.updateCredits).not.toHaveBeenCalled();
      expect(harness.refreshProfile).toHaveBeenCalledTimes(1);
      expect(text(tree)).toContain('Claim your welcome credits');
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(harness.updateCredits).not.toHaveBeenCalled();
      expect(text(tree)).toContain('Claim your welcome credits');
      expect(harness.haptics).not.toContain('success');
    } finally {
      vi.useRealTimers();
    }
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
    expect(wasWelcomePopupDismissedThisRun('creator-1')).toBe(true);
    expect(mount().toJSON()).toBeNull();
  });

  it('fades out before it goes, rather than vanishing in one frame (owner 11-09: "smoother")', () => {
    harness.reducedMotion = false;
    const tree = mount();
    act(() => { close(tree).props.onPress(); });
    expect(text(tree)).toContain('Claim your welcome credits');
    expect(harness.exits).toHaveLength(1);
    act(() => { close(tree).props.onPress(); });
    expect(harness.exits).toHaveLength(1);
    act(() => { harness.exits[0](); });
    expect(tree.toJSON()).toBeNull();
  });
});
