(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

/** The card's node, as `findNodeHandle` hands it to VoiceOver. */
const CARD_NODE = 7301;

const native = vi.hoisted(() => ({
  os: 'android' as 'android' | 'ios',
  appState: 'active',
  insetsTop: 47,
  screenReader: false,
  screenReaderListeners: [] as Array<(running: boolean) => void>,
  /** Every announcement, whichever API made it. */
  announced: [] as unknown[][],
  focused: [] as unknown[],
  /** By event name, as React Native's AppState keeps them. */
  appStateListeners: new Map<string, Array<(state?: string) => void>>(),
}));
const presence = vi.hoisted(() => ({ leaving: false }));
const auth = vi.hoisted(() => ({
  user: null as { id: string } | null,
  refreshProfile: vi.fn(async () => {}),
  api: {
    getProfile: vi.fn(async () => ({})),
    recordSaverNotice: vi.fn(async () => ({ seen: true })),
  },
}));
const storage = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  /** Reads a case holds open, by key: the phone still reading an account's memory. */
  held: new Map<string, Promise<string | null>>(),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: (...args: unknown[]) => native.announced.push(args),
    announceForAccessibilityWithOptions: (...args: unknown[]) => native.announced.push(args),
    isScreenReaderEnabled: () => Promise.resolve(native.screenReader),
    addEventListener: (event: string, listener: (running: boolean) => void) => {
      if (event !== 'screenReaderChanged') throw new Error(`AccessibilityInfo has no "${event}" event here`);
      native.screenReaderListeners.push(listener);
      return {
        remove: () => {
          native.screenReaderListeners = native.screenReaderListeners.filter((candidate) => candidate !== listener);
        },
      };
    },
    setAccessibilityFocus: (node: unknown) => native.focused.push(node),
  },
  AppState: {
    get currentState() {
      return native.appState;
    },
    addEventListener: (event: string, listener: (state?: string) => void) => {
      // React Native's four: a listener under any other name would never be called.
      if (!['change', 'memoryWarning', 'blur', 'focus'].includes(event)) throw new Error(`AppState has no "${event}" event`);
      native.appStateListeners.set(event, [...(native.appStateListeners.get(event) ?? []), listener]);
      return {
        remove: () => {
          native.appStateListeners.set(event, (native.appStateListeners.get(event) ?? []).filter((candidate) => candidate !== listener));
        },
      };
    },
  },
  Platform: {
    get OS() {
      return native.os;
    },
  },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style,
  }, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  findNodeHandle: (instance: unknown) => (instance as { nodeHandle?: number } | null)?.nodeHandle ?? null,
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: native.insetsTop, bottom: 34, left: 0, right: 0 }),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));
vi.mock('@/lib/motion', () => ({
  MotionView: ({ children, ...props }: MockProps) => React.createElement('motion-view', props, children),
  useOverlayPresence: (visible: boolean) => ({ mounted: visible || presence.leaving, animatedStyle: undefined }),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ api: auth.api, user: auth.user, refreshProfile: auth.refreshProfile }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.held.get(key) ?? storage.stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.stored.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.stored.delete(key);
    }),
  },
}));
// The real module, with how each notice ended kept for the cases to read.
vi.mock('@/lib/saver-notice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/saver-notice')>();
  return { ...actual, settleSaverNotice: vi.fn(actual.settleSaverNotice) };
});

import { SaverNoticeBar, SaverNoticeSync } from '@/components/saver-notice-bar';
import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  creatorSeesSaverFields,
  readSaverNotice,
  resetSaverNoticeForTests,
  settleSaverNotice,
  type SaverNoticeFields,
} from '@/lib/saver-notice';
import { saverNoticeStorageKey } from '@/lib/saver-notice-policy/saver-notice-policy';
import type { ProfileResponse } from '@/lib/types';
import { VIEWER_TOP_CONTROL_SIZE, viewerTopBadgeTop, viewerTopControlTop } from '@/lib/viewer-chrome';

const NOT_YET_TOLD = { saverNotYetTold: true };
const NAMES_SAVER = { creatorSeesSaver: true };
const USER_1_KEY = saverNoticeStorageKey('user-1');
const USER_2_KEY = saverNoticeStorageKey('user-2');

const trees: renderer.ReactTestRenderer[] = [];
const clients: QueryClient[] = [];

/** Lets storage reads, records and the query cache's notifications land. */
async function flush() {
  await renderer.act(async () => {
    for (let turn = 0; turn < 4; turn += 1) {
      vi.advanceTimersByTime(0);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
}

async function mount(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(element, {
      createNodeMock: (node) => ({ nodeHandle: String(node.type) === 'motion-view' ? CARD_NODE : -1 }),
    });
  });
  trees.push(tree);
  // The reader's state is read once, after mount.
  await flush();
  return tree;
}

/** A save tapped by the account. */
function tapSave(accountId = 'user-1') {
  let fields: SaverNoticeFields = {};
  renderer.act(() => {
    fields = creatorSeesSaverFields(accountId, true);
  });
  return fields;
}

function shownNotice() {
  const notice = readSaverNotice();
  expect(notice).not.toBeNull();
  return notice!;
}

const okButton = (tree: renderer.ReactTestRenderer) => tree.root.find(
  (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'OK',
);
const card = (tree: renderer.ReactTestRenderer) => tree.root.find((node) => String(node.type) === 'motion-view');
const placement = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'view')[0].props.style;
const texts = (tree: renderer.ReactTestRenderer) => tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
const endings = () => vi.mocked(settleSaverNotice).mock.calls;

function press(tree: renderer.ReactTestRenderer) {
  renderer.act(() => okButton(tree).props.onPress());
}

function advance(ms: number) {
  renderer.act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function appStateChangesTo(state: 'active' | 'inactive' | 'background') {
  native.appState = state;
  renderer.act(() => {
    for (const listener of [...(native.appStateListeners.get('change') ?? [])]) listener(state);
  });
}

/** Android: the activity's window loses the focus (a Modal, the shade) or gets it back. */
function windowFocus(event: 'blur' | 'focus') {
  renderer.act(() => {
    for (const listener of [...(native.appStateListeners.get(event) ?? [])]) listener();
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  native.os = 'android';
  native.appState = 'active';
  native.insetsTop = 47;
  native.screenReader = false;
  native.screenReaderListeners = [];
  native.announced = [];
  native.focused = [];
  native.appStateListeners = new Map();
  presence.leaving = false;
  auth.user = null;
  auth.api.getProfile.mockClear();
  auth.api.recordSaverNotice.mockReset().mockResolvedValue({ seen: true });
  auth.refreshProfile.mockReset().mockResolvedValue(undefined);
  storage.stored.clear();
  storage.held.clear();
  vi.mocked(settleSaverNotice).mockClear();
});

afterEach(() => {
  renderer.act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
  for (const client of clients.splice(0)) client.clear();
  resetSaverNoticeForTests();
  vi.useRealTimers();
});

describe('SaverNoticeBar', () => {
  it('draws the one-line notice below the top control row, wherever the safe area puts it, with an OK of a full touch size', async () => {
    const tree = await mount(<SaverNoticeBar />);
    expect(tree.toJSON()).toBeNull();

    tapSave();

    expect(texts(tree)).toEqual([SAVER_NOTICE_MESSAGE, 'OK']);
    expect(placement(tree)).toMatchObject({ position: 'absolute', top: viewerTopBadgeTop(47) });
    // Under the reel's Back and mute, so a press meant for them never lands on OK.
    expect(placement(tree).top).toBeGreaterThanOrEqual(viewerTopControlTop(47) + VIEWER_TOP_CONTROL_SIZE);
    expect(okButton(tree).props.style.minHeight).toBeGreaterThanOrEqual(44);
    expect(card(tree).props.accessibilityLiveRegion).toBe('polite');

    native.insetsTop = 0;
    renderer.act(() => tree.update(<SaverNoticeBar />));
    expect(placement(tree).top).toBe(viewerTopBadgeTop(0));
  });

  // Review finding #3.
  it('ignores an OK pressed in its first moments, and tells the account at an OK pressed after them', async () => {
    const tree = await mount(<SaverNoticeBar />);
    expect(tapSave()).toEqual(NOT_YET_TOLD);
    const { id } = shownNotice();

    advance(300);
    press(tree);
    expect(shownNotice().id).toBe(id);
    expect(endings()).toEqual([]);

    advance(500);
    press(tree);
    expect(endings()).toEqual([[id, 'closed']]);
    expect(readSaverNotice()).toBeNull();
    expect(tapSave()).toEqual(NAMES_SAVER);
  });

  it('leaves by itself after six seconds in view, which counts as read', async () => {
    await mount(<SaverNoticeBar />);
    tapSave();
    const { id } = shownNotice();

    advance(SAVER_NOTICE_DURATION_MS - 1);
    expect(shownNotice().id).toBe(id);
    advance(1);

    expect(endings()).toEqual([[id, 'expired']]);
    expect(readSaverNotice()).toBeNull();
    expect(tapSave()).toEqual(NAMES_SAVER);
  });

  it('counts nothing read when the app is left while it is up', async () => {
    await mount(<SaverNoticeBar />);
    tapSave();
    const { id } = shownNotice();

    appStateChangesTo('background');

    expect(endings()).toEqual([[id, 'interrupted']]);
    expect(readSaverNotice()).toBeNull();
    appStateChangesTo('active');
    expect(tapSave()).toEqual(NOT_YET_TOLD);
  });

  // Review finding #20.
  it('on iOS, stops counting while the app is inactive and goes on with the time it had left', async () => {
    native.os = 'ios';
    await mount(<SaverNoticeBar />);
    tapSave();
    const { id } = shownNotice();

    advance(2_000);
    // Control Centre, a call, the app switcher: still in memory, not in view.
    appStateChangesTo('inactive');
    advance(SAVER_NOTICE_DURATION_MS * 10);
    expect(shownNotice().id).toBe(id);
    expect(endings()).toEqual([]);

    appStateChangesTo('active');
    advance(SAVER_NOTICE_DURATION_MS - 2_000 - 1);
    expect(shownNotice().id).toBe(id);
    advance(1);
    expect(endings()).toEqual([[id, 'expired']]);
  });

  // Review finding #20, Android's half.
  it('on Android, stops counting while another window has the focus and goes on with the time it had left', async () => {
    await mount(<SaverNoticeBar />);
    tapSave();
    const { id } = shownNotice();

    advance(2_000);
    // A Modal opens over it, or the notification shade comes down.
    windowFocus('blur');
    advance(SAVER_NOTICE_DURATION_MS * 10);
    expect(shownNotice().id).toBe(id);
    expect(endings()).toEqual([]);

    windowFocus('focus');
    advance(SAVER_NOTICE_DURATION_MS - 2_000 - 1);
    expect(shownNotice().id).toBe(id);
    advance(1);
    expect(endings()).toEqual([[id, 'expired']]);
  });

  // Review finding #2.
  it('on Android, does not count down a notice that appears while a Modal already has the focus until the Modal goes', async () => {
    await mount(<SaverNoticeBar />);
    // The save is made from inside a Modal: the window lost the focus before the notice existed.
    windowFocus('blur');
    tapSave();
    const { id } = shownNotice();

    advance(SAVER_NOTICE_DURATION_MS * 5);
    expect(shownNotice().id).toBe(id);
    expect(endings()).toEqual([]);

    windowFocus('focus');
    advance(SAVER_NOTICE_DURATION_MS - 1);
    expect(shownNotice().id).toBe(id);
    advance(1);
    expect(endings()).toEqual([[id, 'expired']]);
  });

  it('gives each new notice its own six seconds, and ignores its own first moments', async () => {
    const tree = await mount(<SaverNoticeBar />);
    tapSave();
    advance(4_000);
    appStateChangesTo('background');
    appStateChangesTo('active');

    tapSave();
    const { id } = shownNotice();
    advance(300);
    press(tree);
    expect(shownNotice().id).toBe(id);

    advance(SAVER_NOTICE_DURATION_MS - 300 - 1);
    expect(shownNotice().id).toBe(id);
    advance(1);
    expect(endings().at(-1)).toEqual([id, 'expired']);
  });

  it('waits for OK while a screen reader runs, and moves VoiceOver onto it on iOS', async () => {
    native.os = 'ios';
    native.screenReader = true;
    const tree = await mount(<SaverNoticeBar />);
    tapSave();
    const { id } = shownNotice();

    advance(249);
    expect(native.focused).toEqual([]);
    advance(1);
    expect(native.focused).toEqual([CARD_NODE]);

    advance(SAVER_NOTICE_DURATION_MS * 3);
    expect(shownNotice().id).toBe(id);
    // Moved onto, not announced over as well: VoiceOver reads it once.
    expect(native.announced).toEqual([]);

    press(tree);
    expect(endings()).toEqual([[id, 'closed']]);
    expect(tapSave()).toEqual(NAMES_SAVER);
  });

  it('stops counting when a screen reader is turned on while it shows', async () => {
    await mount(<SaverNoticeBar />);
    tapSave();

    advance(2_000);
    renderer.act(() => native.screenReaderListeners.forEach((listener) => listener(true)));
    advance(SAVER_NOTICE_DURATION_MS * 3);

    expect(readSaverNotice()).not.toBeNull();
    expect(endings()).toEqual([]);
  });

  it('leaves the reading to the live region on Android, and moves nothing', async () => {
    await mount(<SaverNoticeBar />);
    tapSave();

    advance(1_000);

    expect(native.focused).toEqual([]);
    expect(native.announced).toEqual([]);
  });

  it("counts a reader's dismiss as read", async () => {
    native.screenReader = true;
    const tree = await mount(<SaverNoticeBar />);
    tapSave();
    const { id } = shownNotice();

    renderer.act(() => card(tree).props.onAccessibilityEscape());

    expect(endings()).toEqual([[id, 'closed']]);
    expect(tapSave()).toEqual(NAMES_SAVER);
  });

  it('cannot be pressed or reached while it fades out', async () => {
    presence.leaving = true;
    const tree = await mount(<SaverNoticeBar />);
    tapSave();
    advance(800);
    press(tree);
    expect(endings()).toHaveLength(1);

    // Still drawn while it fades.
    expect(texts(tree)[0]).toBe(SAVER_NOTICE_MESSAGE);
    expect(card(tree).props.pointerEvents).toBe('none');
    expect(card(tree).props.accessibilityElementsHidden).toBe(true);
    expect(okButton(tree).props.disabled).toBe(true);
    press(tree);
    expect(endings()).toHaveLength(1);
  });
});

describe('SaverNoticeSync', () => {
  function profile(saverNoticeSeen?: boolean, id = 'user-1'): ProfileResponse {
    return {
      id,
      username: 'maya',
      displayName: 'Maya',
      credits: 10,
      ...(saverNoticeSeen === undefined ? {} : { saverNoticeSeen }),
    } as ProfileResponse;
  }

  function newClient() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    return client;
  }

  /** The root layout's pair, signed in as `auth.user`. */
  function app(client: QueryClient) {
    return (
      <QueryClientProvider client={client}>
        <SaverNoticeSync />
        <SaverNoticeBar />
      </QueryClientProvider>
    );
  }

  async function signIn(tree: renderer.ReactTestRenderer, client: QueryClient, accountId: string | null) {
    auth.user = accountId ? { id: accountId } : null;
    await renderer.act(async () => {
      tree.update(app(client));
    });
    await flush();
  }

  async function profileLoads(client: QueryClient, data: ProfileResponse) {
    await renderer.act(async () => {
      client.setQueryData(['profile', data.id], data);
    });
    await flush();
  }

  /** The phone still reading the account's memory, until the case lets it. */
  function holdRead(key: string) {
    let release!: (value: string | null) => void;
    storage.held.set(key, new Promise<string | null>((resolve) => {
      release = (value) => {
        storage.held.delete(key);
        resolve(value);
      };
    }));
    return { release };
  }

  it('takes the server record from the profile the app already loaded, and never asks for it', async () => {
    auth.user = { id: 'user-1' };
    const client = newClient();
    client.setQueryData(['profile', 'user-1'], profile(true));

    await mount(app(client));

    expect(tapSave()).toEqual(NAMES_SAVER);
    expect(readSaverNotice()).toBeNull();
    expect(storage.stored.get(USER_1_KEY)).toBe('recorded');
    expect(auth.api.getProfile).not.toHaveBeenCalled();
    expect(auth.api.recordSaverNotice).not.toHaveBeenCalled();
  });

  it("goes by the phone's memory while no profile, or one from an older server, says otherwise", async () => {
    storage.stored.set(USER_1_KEY, 'recorded');
    auth.user = { id: 'user-1' };
    const client = newClient();
    const tree = await mount(app(client));
    expect(tapSave()).toEqual(NAMES_SAVER);

    await profileLoads(client, profile(undefined));

    expect(tapSave()).toEqual(NAMES_SAVER);
    expect(tree.toJSON()).toBeNull();
    expect(auth.api.getProfile).not.toHaveBeenCalled();
  });

  // Review finding #14.
  it('tells the person again once the profile says the server no longer has their telling on record', async () => {
    storage.stored.set(USER_1_KEY, 'recorded');
    auth.user = { id: 'user-1' };
    const client = newClient();
    const tree = await mount(app(client));
    expect(creatorSeesSaverFields('user-1', true)).toEqual(NAMES_SAVER);

    await profileLoads(client, profile(false));

    expect(storage.stored.has(USER_1_KEY)).toBe(false);
    expect(tapSave()).toEqual(NOT_YET_TOLD);
    expect(texts(tree)).toEqual([SAVER_NOTICE_MESSAGE, 'OK']);
  });

  it('puts a telling read at OK on record, as the account signed in', async () => {
    auth.user = { id: 'user-1' };
    const client = newClient();
    const tree = await mount(app(client));
    tapSave();
    advance(800);

    press(tree);
    await flush();

    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(1);
    expect(storage.stored.get(USER_1_KEY)).toBe('recorded');
  });

  // The profile the phone keeps for the next launch was read before the
  // telling, and would come back saying "no record".
  it('has the profile read again once a telling is on record, and not when it could not be put there', async () => {
    auth.user = { id: 'user-1' };
    const client = newClient();
    const tree = await mount(app(client));
    auth.api.recordSaverNotice.mockRejectedValueOnce(new Error('Network request failed'));
    tapSave();
    advance(800);
    press(tree);
    await flush();
    expect(auth.refreshProfile).not.toHaveBeenCalled();

    appStateChangesTo('background');
    appStateChangesTo('active');
    await flush();

    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(2);
    expect(auth.refreshProfile).toHaveBeenCalledTimes(1);
    expect(storage.stored.get(USER_1_KEY)).toBe('recorded');
  });

  // Review finding #10.
  it('takes the notice down unread when another account signs in', async () => {
    auth.user = { id: 'user-1' };
    const client = newClient();
    const tree = await mount(app(client));
    tapSave('user-1');
    expect(shownNotice().accountId).toBe('user-1');

    await signIn(tree, client, 'user-2');

    expect(readSaverNotice()).toBeNull();
    expect(tree.toJSON()).toBeNull();
    expect(endings()).toEqual([]);
    advance(SAVER_NOTICE_DURATION_MS * 2);
    expect(auth.api.recordSaverNotice).not.toHaveBeenCalled();
    expect(storage.stored.has(USER_1_KEY)).toBe(false);

    // Back on this phone: told at its next save.
    await signIn(tree, client, 'user-1');
    expect(tapSave('user-1')).toEqual(NOT_YET_TOLD);
  });

  // Review finding #10: the record goes out only as the account told.
  it("never puts one account's telling on record as the next account, and puts it on record when its own account is back", async () => {
    auth.user = { id: 'user-1' };
    const client = newClient();
    const tree = await mount(app(client));
    tapSave('user-1');
    const { id } = shownNotice();
    advance(800);

    // user-2 signs in on this phone, and its memory is still being read when
    // user-1's OK lands: the notice is user-1's, the signed-in account user-2's.
    const read = holdRead(USER_2_KEY);
    await signIn(tree, client, 'user-2');
    expect(shownNotice().id).toBe(id);
    press(tree);
    await flush();
    // A POST now would go out as user-2.
    expect(endings()).toEqual([[id, 'closed']]);
    expect(auth.api.recordSaverNotice).not.toHaveBeenCalled();
    expect(storage.stored.get(USER_1_KEY)).toBe('pending');

    read.release(null);
    await flush();
    expect(auth.api.recordSaverNotice).not.toHaveBeenCalled();

    await signIn(tree, client, 'user-1');
    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(1);
    expect(storage.stored.get(USER_1_KEY)).toBe('recorded');
  });

  it('asks again for a telling not on record whenever the app comes back to the front', async () => {
    storage.stored.set(USER_1_KEY, 'pending');
    auth.api.recordSaverNotice.mockRejectedValueOnce(new Error('Network request failed'));
    auth.user = { id: 'user-1' };
    await mount(app(newClient()));
    // Signing in asks first.
    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(1);
    expect(storage.stored.get(USER_1_KEY)).toBe('pending');

    appStateChangesTo('inactive');
    appStateChangesTo('background');
    await flush();
    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(1);

    appStateChangesTo('active');
    await flush();
    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(2);
    expect(storage.stored.get(USER_1_KEY)).toBe('recorded');

    // On record now: coming back asks nothing more.
    appStateChangesTo('background');
    appStateChangesTo('active');
    await flush();
    expect(auth.api.recordSaverNotice).toHaveBeenCalledTimes(2);
  });

  it('asks nothing with no one signed in', async () => {
    storage.stored.set(USER_1_KEY, 'pending');
    await mount(app(newClient()));

    appStateChangesTo('background');
    appStateChangesTo('active');
    await flush();

    expect(auth.api.recordSaverNotice).not.toHaveBeenCalled();
    expect(auth.api.getProfile).not.toHaveBeenCalled();
  });
});
