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
const screen = vi.hoisted(() => ({ pathname: '/', r: undefined as string | undefined }));
const referral = vi.hoisted(() => ({
  capture: vi.fn(),
  pending: vi.fn(),
}));
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
vi.mock('expo-router', () => ({
  router,
  usePathname: () => screen.pathname,
  useGlobalSearchParams: () => ({ r: screen.r }),
}));
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
vi.mock('@/lib/referral-attribution', () => ({ capturePendingReferral: referral.capture, getPendingReferral: referral.pending }));
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
  INVITE_PASTE_NOT_AN_INVITE,
  INVITE_PASTE_OFFER_BODY,
  INVITE_PASTE_OFFER_TITLE,
  INVITE_PASTE_RESULTS,
  INVITE_PASTE_RESULT_MS,
  INVITE_PASTE_WORKING,
  InviteInstallHandoff,
} from '../components/invite-install-handoff';
import {
  INSTALL_HANDOFF_FRESH_INSTALL_MS,
  INSTALL_HANDOFF_RECORD_TIMEOUT_MS,
  INSTALL_HANDOFF_STORAGE_KEY,
  decideInstallHandoff,
  inviteHandoffRoute,
  readPastedInvite,
  recordInstallHandoff,
  shouldOpenHandoffScreen,
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
  screen.pathname = '/';
  screen.r = undefined;
  referral.capture.mockReset();
  referral.capture.mockResolvedValue({ pending: { code: CODE }, keptEarlierInvite: false });
  referral.pending.mockReset();
  referral.pending.mockResolvedValue(null);
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

describe('recording a handed-over invite, and where the app goes with it', () => {
  const handoff = { code: CODE, kind: 'shared_link' as const, path: '/creators/mira' };

  it('says what became of it', async () => {
    const pendingNone = async () => null;
    const kept = async () => ({ pending: { code: CODE }, keptEarlierInvite: false });
    const earlier = async () => ({ pending: { code: 'earlier12' }, keptEarlierInvite: true });
    const fails = async () => { throw new Error('offline'); };
    const run = (capture: unknown, pending: unknown = pendingNone) => recordInstallHandoff({} as never, handoff, {
      capture: capture as never, pending: pending as never, timeoutMs: 50,
    });
    await expect(run(kept)).resolves.toBe('kept');
    await expect(run(earlier)).resolves.toBe('kept-earlier');
    // A refused code is taken off the phone; a failed request leaves it saved.
    await expect(run(fails)).resolves.toBe('unavailable');
    await expect(run(fails, async () => ({ code: CODE }))).resolves.toBe('saved');
    await expect(run(() => new Promise(() => undefined))).resolves.toBe('saved');
  });

  it('moves the app only from Home for an invite that arrived unasked, and always for a paste', () => {
    const at = (via: 'referrer' | 'paste', pathname: string, shownInvite?: string) => shouldOpenHandoffScreen({ via, handoff, pathname, shownInvite });
    expect(at('referrer', '/')).toBe(true);
    expect(at('referrer', '/showcase/abc')).toBe(false);
    expect(at('referrer', '/auth')).toBe(false);
    expect(at('paste', '/auth')).toBe(true);
    // Never over a screen already showing that invite.
    expect(at('paste', '/creators/mira', CODE)).toBe(false);
    expect(at('paste', `/r/${CODE}`)).toBe(false);
    expect(at('paste', '/creators/mira', 'another1')).toBe(true);
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

    expect(referral.capture).toHaveBeenCalledTimes(1);
    expect(referral.capture).toHaveBeenCalledWith({}, CODE, { next: '/creators/mira', kind: 'shared_link' });
    expect(router.push).toHaveBeenCalledWith(`/creators/mira?r=${CODE}`);
    expect(steps()).toEqual(['invite_handoff_play_referrer']);
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
    expect(tree.toJSON()).toBeNull();

    router.push.mockClear();
    await launch();
    expect(router.push).not.toHaveBeenCalled();
  });

  // Recorded here first, as an invite link's: the landing it opens finds the visit made.
  it('records an invite link as one, then opens its landing', async () => {
    phone.referrer = `utm_source=magicbooklet-invite&utm_medium=invite&utm_content=invite&mb_r=${CODE}&mb_p=%2Fcreate`;
    const order: string[] = [];
    referral.capture.mockImplementation(async () => {
      order.push('recorded');
      return { pending: { code: CODE }, keptEarlierInvite: false };
    });
    router.push.mockImplementation(() => { order.push('opened'); });
    await launch();
    expect(referral.capture).toHaveBeenCalledWith({}, CODE, { next: '/create', kind: 'invite' });
    expect(router.push).toHaveBeenCalledWith(`/r/${CODE}?next=%2Fcreate`);
    expect(order).toEqual(['recorded', 'opened']);
  });

  // Someone tapped the shared link itself after installing: the app is already on that page.
  it('opens nothing over a screen a link already opened, and still records the invite', async () => {
    phone.referrer = `utm_source=magicbooklet-invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`;
    screen.pathname = '/creators/mira';
    screen.r = CODE;
    await launch();
    expect(referral.capture).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();

    phone.store.clear();
    screen.pathname = '/showcase/other-post';
    screen.r = undefined;
    await launch();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('opens nothing for a code the server refuses', async () => {
    phone.referrer = `utm_source=magicbooklet-invite&utm_content=shared_link&mb_r=${CODE}&mb_p=%2Fcreators%2Fmira`;
    referral.capture.mockRejectedValue(Object.assign(new Error('Invalid referral code.'), { status: 404 }));
    await launch();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('does nothing for an install that carried no invite, and never looks again', async () => {
    await launch();
    expect(router.push).not.toHaveBeenCalled();
    expect(referral.capture).not.toHaveBeenCalled();
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

    await renderer.act(async () => undefined);
    expect(referral.capture).toHaveBeenCalledWith({}, CODE, { next: '/showcase/abc', kind: 'shared_link' });
    expect(router.push).toHaveBeenCalledWith(`/showcase/abc?r=${CODE}`);
    // What the bonus really is: the first top-up's, not a gift for joining.
    expect(texts(tree)).toEqual(['Invite kept. Your first credit top-up gets its bonus.']);
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
    expect(referral.capture).not.toHaveBeenCalled();
    expect(steps()).toEqual(['invite_handoff_paste_offered', 'invite_handoff_paste_not_invite']);
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
  });

  // "Invite kept" was said whatever happened (review of 2026-11-11).
  it.each([
    ['another invite was already on the phone', () => referral.capture.mockResolvedValue({ pending: { code: 'earlier12' }, keptEarlierInvite: true }), 'kept-earlier', true],
    ['the server refuses the code', () => referral.capture.mockRejectedValue(Object.assign(new Error('gone'), { status: 404 })), 'unavailable', false],
    ['the phone is offline', () => {
      referral.capture.mockRejectedValue(new TypeError('Network request failed'));
      referral.pending.mockResolvedValue({ code: CODE, kind: 'shared_link' });
    }, 'saved', true],
  ] as const)('says what became of the invite when %s', async (_name, arrange, outcome, opens) => {
    arrange();
    const tree = await launch();
    await renderer.act(async () => {
      pasteButton(tree)[0]!.props.onPress({ type: 'text', text: `https://magicbooklet.com/creators/mira?r=${CODE}` });
    });
    await renderer.act(async () => undefined);
    expect(texts(tree)).toEqual([INVITE_PASTE_RESULTS[outcome]]);
    expect(router.push.mock.calls.length).toBe(opens ? 1 : 0);
  });

  it('says it is keeping the invite while the visit is on its way, then carries on with it saved', async () => {
    referral.capture.mockImplementation(() => new Promise(() => undefined));
    const tree = await launch();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await renderer.act(async () => {
      pasteButton(tree)[0]!.props.onPress({ type: 'text', text: `https://magicbooklet.com/creators/mira?r=${CODE}` });
    });
    expect(texts(tree)).toEqual([INVITE_PASTE_WORKING]);
    expect(router.push).not.toHaveBeenCalled();

    await renderer.act(async () => {
      vi.advanceTimersByTime(INSTALL_HANDOFF_RECORD_TIMEOUT_MS);
    });
    await renderer.act(async () => undefined);
    expect(texts(tree)).toEqual([INVITE_PASTE_RESULTS.saved]);
    expect(router.push).toHaveBeenCalledWith(`/creators/mira?r=${CODE}`);
  });

  // A link that is no post's and no creator's goes to the invite's landing, which
  // recorded it a second time while the first request was on its way.
  it('records a pasted invite once, before the screen that would record it opens', async () => {
    const order: string[] = [];
    referral.capture.mockImplementation(async () => {
      order.push('recorded');
      return { pending: { code: CODE }, keptEarlierInvite: false };
    });
    router.push.mockImplementation(() => { order.push('opened'); });
    const tree = await launch();
    await renderer.act(async () => {
      pasteButton(tree)[0]!.props.onPress({ type: 'text', text: `https://magicbooklet.com/?r=${CODE}` });
    });
    await renderer.act(async () => undefined);
    expect(router.push).toHaveBeenCalledWith(`/r/${CODE}`);
    expect(order).toEqual(['recorded', 'opened']);
    expect(referral.capture).toHaveBeenCalledTimes(1);
  });

  it('puts the offer away when an account signs in while it is up', async () => {
    const tree = await launch();
    expect(pasteButton(tree)).toHaveLength(1);
    phone.user = { id: 'user-1' };
    await renderer.act(async () => {
      tree.update(<InviteInstallHandoff />);
    });
    expect(tree.toJSON()).toBeNull();
    expect(phone.store.has(INSTALL_HANDOFF_STORAGE_KEY)).toBe(true);
    expect(referral.capture).not.toHaveBeenCalled();
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
