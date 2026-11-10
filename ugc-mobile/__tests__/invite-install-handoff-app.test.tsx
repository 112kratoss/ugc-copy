(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

const CODE = '30b5f916c7aa';

const phone = vi.hoisted(() => ({
  os: 'ios',
  store: new Map<string, string>(),
  user: null as null | { id: string },
  authLoading: false,
  neverSignedIn: true,
  introShowing: false,
  introListeners: new Set<() => void>(),
  referrer: 'utm_source=google-play&utm_medium=organic' as string | Error,
  installedAt: Date.now() - 5 * 60 * 1000 as number | null,
  linkWaiting: true as boolean | Error,
  pasteButton: true,
}));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const capture = vi.hoisted(() => ({ fromLink: vi.fn(async () => true) }));
const events = vi.hoisted(() => ({ track: vi.fn(async () => undefined) }));
const clipboard = vi.hoisted(() => ({ hasUrl: vi.fn(), read: vi.fn() }));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: vi.fn(),
    announceForAccessibilityWithOptions: vi.fn(),
    isScreenReaderEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => undefined }),
  },
  Platform: { get OS() { return phone.os; } },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ router }));
vi.mock('expo', () => ({
  requireOptionalNativeModule: () => ({
    getInstallReferrerAsync: async () => {
      if (phone.referrer instanceof Error) throw phone.referrer;
      return phone.referrer;
    },
    getInstallationTimeAsync: async () => phone.installedAt,
  }),
}));
vi.mock('expo-clipboard', () => ({
  get isPasteButtonAvailable() { return phone.pasteButton; },
  hasUrlAsync: clipboard.hasUrl,
  // Never called: the clipboard is read by Apple's button alone.
  getStringAsync: clipboard.read,
  getUrlAsync: clipboard.read,
  ClipboardPasteButton: (props: MockProps) => React.createElement('paste-button', props),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => phone.store.get(key) ?? null,
    setItem: async (key: string, value: string) => { phone.store.set(key, value); },
    removeItem: async (key: string) => { phone.store.delete(key); },
  },
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));
vi.mock('@/components/saver-notice-overlay', () => ({
  SaverNoticeOverlay: ({ children }: MockProps) => React.createElement('overlay', null, children),
}));
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible, animatedStyle: undefined }),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: {}, user: phone.user, isLoading: phone.authLoading }),
}));
vi.mock('@/lib/onboarding', () => ({ trackOnboardingEvent: events.track }));
vi.mock('@/lib/use-invite-share-capture', () => ({ captureInviteFromSharedLink: capture.fromLink }));
vi.mock('@/lib/welcome-promise', () => ({ readWelcomePromise: async () => phone.neverSignedIn }));
vi.mock('@/lib/first-open-intro', () => ({
  isFirstOpenIntroShowing: () => phone.introShowing,
  subscribeFirstOpenIntro: (listener: () => void) => {
    phone.introListeners.add(listener);
    return () => phone.introListeners.delete(listener);
  },
}));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({
    colors: { borderStrong: 'border', panel: 'panel', primaryFill: 'fill', onPrimary: 'ink', pressed: 'pressed' },
    shadow: { floating: { boxShadow: 'shadow' } },
  }),
}));
vi.mock('@/lib/theme', () => ({
  appTheme: { spacing: { compact: 8, card: 16, gap: 12, screen: 16 }, radii: { md: 16, pill: 999 }, touch: { compact: 48 } },
}));

import {
  INVITE_PASTE_KEPT,
  INVITE_PASTE_NOT_AN_INVITE,
  INVITE_PASTE_OFFER_BODY,
  INVITE_PASTE_OFFER_TITLE,
  INVITE_PASTE_RESULT_MS,
  InviteInstallHandoff,
} from '../components/invite-install-handoff';
import {
  INSTALL_HANDOFF_FRESH_INSTALL_MS,
  INSTALL_HANDOFF_STORAGE_KEY,
  decideInstallHandoff,
  inviteHandoffRoute,
  readPastedInvite,
} from '../lib/invite-install-handoff';

const mounted: renderer.ReactTestRenderer[] = [];

async function launch() {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<InviteInstallHandoff />);
  });
  // The stored flags, the install time and the clipboard's answer, each a tick apart.
  for (let tick = 0; tick < 4; tick += 1) await renderer.act(async () => undefined);
  mounted.push(tree);
  return tree;
}

const texts = (tree: renderer.ReactTestRenderer) => tree.root
  .findAll((node) => String(node.type) === 'text')
  .map((node) => node.props.children);
const pasteButton = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'paste-button');
const notNow = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Not now');
const steps = () => events.track.mock.calls.map((call) => (call as unknown as [unknown, string, { step: string }])[2].step);

beforeEach(() => {
  phone.os = 'ios';
  phone.store.clear();
  phone.user = null;
  phone.authLoading = false;
  phone.neverSignedIn = true;
  phone.introShowing = false;
  phone.introListeners.clear();
  phone.referrer = 'utm_source=google-play&utm_medium=organic';
  phone.installedAt = Date.now() - 5 * 60 * 1000;
  phone.linkWaiting = true;
  phone.pasteButton = true;
  router.push.mockReset();
  capture.fromLink.mockClear();
  events.track.mockClear();
  clipboard.read.mockReset();
  clipboard.hasUrl.mockReset();
  clipboard.hasUrl.mockImplementation(async () => {
    if (phone.linkWaiting instanceof Error) throw phone.linkWaiting;
    return phone.linkWaiting;
  });
});

afterEach(() => {
  vi.useRealTimers();
  for (const tree of mounted.splice(0)) renderer.act(() => tree.unmount());
});

describe('which phone looks for an invite handed over at install', () => {
  const base = { platform: 'ios', settled: false, authLoading: false, hasUser: false, neverSignedIn: true, installedAt: 1_000, now: 2_000 } as const;

  it('waits for everything it must know first', () => {
    expect(decideInstallHandoff({ ...base, settled: null })).toBe('wait');
    expect(decideInstallHandoff({ ...base, authLoading: true })).toBe('wait');
    expect(decideInstallHandoff({ ...base, neverSignedIn: null })).toBe('wait');
    expect(decideInstallHandoff({ ...base, installedAt: undefined })).toBe('wait');
  });

  // An account can never be invited, and each install looks once.
  it('skips a phone that has looked, has an account, or ever had one', () => {
    expect(decideInstallHandoff({ ...base, settled: true })).toBe('skip');
    expect(decideInstallHandoff({ ...base, hasUser: true })).toBe('skip');
    expect(decideInstallHandoff({ ...base, neverSignedIn: false })).toBe('skip');
    expect(decideInstallHandoff({ ...base, platform: 'web' })).toBe('skip');
  });

  it('reads the referrer on Android, whenever the app was installed', () => {
    expect(decideInstallHandoff({ ...base, platform: 'android', installedAt: null })).toBe('read-referrer');
  });

  // The web's copy was made minutes before the install: an old install's clipboard is not it.
  it('looks at an iPhone’s clipboard only on a fresh install', () => {
    expect(decideInstallHandoff(base)).toBe('check-clipboard');
    expect(decideInstallHandoff({ ...base, now: 1_000 + INSTALL_HANDOFF_FRESH_INSTALL_MS })).toBe('check-clipboard');
    expect(decideInstallHandoff({ ...base, now: 1_001 + INSTALL_HANDOFF_FRESH_INSTALL_MS })).toBe('skip');
    expect(decideInstallHandoff({ ...base, installedAt: null })).toBe('skip');
    expect(decideInstallHandoff({ ...base, installedAt: 5_000 })).toBe('skip');
  });
});

describe('where a handed-over invite opens', () => {
  it('opens the screen its link would have opened', () => {
    expect(inviteHandoffRoute({ code: CODE, kind: 'shared_link', path: '/creators/mira' })).toBe(`/creators/mira?r=${CODE}`);
    expect(inviteHandoffRoute({ code: CODE, kind: 'shared_link', path: '/showcase/abc' })).toBe(`/showcase/abc?r=${CODE}`);
    expect(inviteHandoffRoute({ code: CODE, kind: 'invite', path: '/create' })).toBe(`/r/${CODE}?next=%2Fcreate`);
    expect(inviteHandoffRoute({ code: CODE, kind: 'invite', path: '/' })).toBe(`/r/${CODE}`);
  });

  it('never opens a screen the web would not have sent an invite to', () => {
    expect(inviteHandoffRoute({ code: CODE, kind: 'shared_link', path: '/settings/delete-account' })).toBe(`/r/${CODE}`);
    expect(inviteHandoffRoute({ code: CODE, kind: 'invite', path: '/admin' })).toBe(`/r/${CODE}`);
  });

  it('takes only a link to this site from the Paste button', () => {
    expect(readPastedInvite({ type: 'text', text: `https://magicbooklet.com/creators/mira?r=${CODE}` }))
      .toEqual({ code: CODE, kind: 'shared_link', path: '/creators/mira' });
    expect(readPastedInvite({ type: 'text', text: 'my password' })).toBeNull();
    expect(readPastedInvite({ type: 'image', text: `https://magicbooklet.com/r/${CODE}` })).toBeNull();
    expect(readPastedInvite(null)).toBeNull();
  });
});

describe('Android: the invite Google Play carried through the install', () => {
  beforeEach(() => {
    phone.os = 'android';
    phone.installedAt = null;
  });

  it('records it, opens the page it was opened on, counts it, and never looks again', async () => {
    phone.referrer = `utm_source=magicbooklet-invite&utm_medium=invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`;
    const tree = await launch();

    expect(capture.fromLink).toHaveBeenCalledWith({}, CODE, '/creators/mira', undefined, undefined, 'shared_link');
    expect(router.push).toHaveBeenCalledWith(`/creators/mira?r=${CODE}`);
    expect(steps()).toEqual(['invite_handoff_play_referrer']);
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
    expect(tree.toJSON()).toBeNull();

    router.push.mockClear();
    await launch();
    expect(router.push).not.toHaveBeenCalled();
  });

  // The landing records an invite link itself: recording it here too sent two visits.
  it('opens an invite link’s landing, which records it', async () => {
    phone.referrer = `utm_source=magicbooklet-invite&utm_medium=invite&utm_content=invite&mb_r=${CODE}&mb_p=%2Fcreate`;
    await launch();
    expect(router.push).toHaveBeenCalledWith(`/r/${CODE}?next=%2Fcreate`);
    expect(capture.fromLink).not.toHaveBeenCalled();
  });

  it('does nothing for an install that carried no invite, and never looks again', async () => {
    await launch();
    expect(router.push).not.toHaveBeenCalled();
    expect(capture.fromLink).not.toHaveBeenCalled();
    expect(steps()).toEqual([]);
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
  });

  it('asks again at the next start when Play could not be asked', async () => {
    phone.referrer = new Error('SERVICE_UNAVAILABLE');
    await launch();
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(false);

    phone.referrer = `utm_source=magicbooklet-invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`;
    await launch();
    expect(router.push).toHaveBeenCalledWith(`/creators/mira?r=${CODE}`);
  });

  it('leaves a phone an account has signed in on alone', async () => {
    phone.referrer = `utm_source=magicbooklet-invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`;
    phone.neverSignedIn = false;
    await launch();
    expect(router.push).not.toHaveBeenCalled();
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
  });

  it('never touches the clipboard', async () => {
    await launch();
    expect(clipboard.hasUrl).not.toHaveBeenCalled();
    expect(clipboard.read).not.toHaveBeenCalled();
  });
});

describe('iPhone: the offer to paste the invite’s link', () => {
  it('offers Apple’s Paste button when a link is waiting, and says who may earn', async () => {
    const tree = await launch();
    expect(texts(tree)).toEqual([INVITE_PASTE_OFFER_TITLE, INVITE_PASTE_OFFER_BODY, 'Not now']);
    expect(pasteButton(tree)).toHaveLength(1);
    expect(pasteButton(tree)[0]!.props.acceptedContentTypes).toEqual(['plain-text', 'url']);
    expect(steps()).toEqual(['invite_handoff_paste_offered']);
    // Asked whether a link waits, which reads nothing; the clipboard itself is never read here.
    expect(clipboard.hasUrl).toHaveBeenCalledTimes(1);
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('keeps a pasted invite: records it, opens its page, says so, and goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const tree = await launch();
    await renderer.act(async () => {
      pasteButton(tree)[0]!.props.onPress({ type: 'text', text: `https://magicbooklet.com/showcase/abc?s=feed&r=${CODE}` });
    });

    expect(capture.fromLink).toHaveBeenCalledWith({}, CODE, '/showcase/abc', undefined, undefined, 'shared_link');
    expect(router.push).toHaveBeenCalledWith(`/showcase/abc?r=${CODE}`);
    expect(texts(tree)).toEqual([INVITE_PASTE_KEPT]);
    expect(pasteButton(tree)).toHaveLength(0);
    expect(steps()).toEqual(['invite_handoff_paste_offered', 'invite_handoff_paste_used']);
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);

    await renderer.act(async () => {
      vi.advanceTimersByTime(INVITE_PASTE_RESULT_MS);
    });
    expect(tree.toJSON()).toBeNull();
  });

  it('keeps nothing from a paste that is not an invite link, and says so', async () => {
    const tree = await launch();
    await renderer.act(async () => {
      pasteButton(tree)[0]!.props.onPress({ type: 'text', text: 'https://example.com/something' });
    });
    expect(texts(tree)).toEqual([INVITE_PASTE_NOT_AN_INVITE]);
    expect(router.push).not.toHaveBeenCalled();
    expect(capture.fromLink).not.toHaveBeenCalled();
    expect(steps()).toEqual(['invite_handoff_paste_offered', 'invite_handoff_paste_not_invite']);
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
  });

  it('goes at Not now, for good', async () => {
    const tree = await launch();
    await renderer.act(async () => {
      notNow(tree).props.onPress();
    });
    expect(tree.toJSON()).toBeNull();
    expect(steps()).toEqual(['invite_handoff_paste_offered', 'invite_handoff_paste_dismissed']);

    const again = await launch();
    expect(again.toJSON()).toBeNull();
    expect(clipboard.hasUrl).toHaveBeenCalledTimes(1);
  });

  // Seen on the simulator, 2026-11-10: a fresh install opens on the intro, over every screen.
  it('waits for the first-open intro to leave before it shows', async () => {
    phone.introShowing = true;
    const tree = await launch();
    expect(tree.toJSON()).toBeNull();
    expect(steps()).toEqual([]);

    phone.introShowing = false;
    await renderer.act(async () => {
      phone.introListeners.forEach((listener) => listener());
    });
    expect(texts(tree)).toContain(INVITE_PASTE_OFFER_TITLE);
    expect(steps()).toEqual(['invite_handoff_paste_offered']);
  });

  it.each([
    ['no link is waiting', () => { phone.linkWaiting = false; }],
    ['the clipboard cannot be asked', () => { phone.linkWaiting = new Error('denied'); }],
    ['the phone has no Paste button (before iOS 16)', () => { phone.pasteButton = false; }],
  ])('offers nothing when %s, and never looks again', async (_name, arrange) => {
    arrange();
    const tree = await launch();
    expect(tree.toJSON()).toBeNull();
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
    expect(steps()).toEqual([]);
  });

  it.each([
    ['an old install', () => { phone.installedAt = Date.now() - INSTALL_HANDOFF_FRESH_INSTALL_MS - 60_000; }],
    ['a phone an account has signed in on', () => { phone.neverSignedIn = false; }],
    ['a signed-in account', () => { phone.user = { id: 'user-1' }; }],
  ])('never asks the clipboard on %s', async (_name, arrange) => {
    arrange();
    const tree = await launch();
    expect(tree.toJSON()).toBeNull();
    expect(clipboard.hasUrl).not.toHaveBeenCalled();
  });

  it('holds off while the session is still being read', async () => {
    phone.authLoading = true;
    const tree = await launch();
    expect(tree.toJSON()).toBeNull();
    expect(clipboard.hasUrl).not.toHaveBeenCalled();
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(false);
  });
});
