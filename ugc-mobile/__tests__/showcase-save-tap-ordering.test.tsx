(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SaverNoticeFields } from '@/lib/saver-notice';

import type { ShowcaseFeedResponse } from '../lib/types';

const mocks = vi.hoisted(() => {
  const state = {
    saveShowcasePost: vi.fn(),
    routerPush: vi.fn(),
    hapticLight: vi.fn(),
    hapticError: vi.fn(),
    announce: vi.fn(),
    announceWithOptions: vi.fn(),
    os: 'ios' as 'ios' | 'android',
    user: { id: 'user-1' } as { id: string } | null,
    /** The real notice module, for the cases that need it to tell someone. */
    realSaverNotice: null as null | typeof import('@/lib/saver-notice'),
    useRealSaverNotice: false,
    // An account that has been told already, unless a case says otherwise.
    creatorSeesSaverFields: vi.fn((accountId: string | null | undefined, shouldSave: boolean): SaverNoticeFields => {
      if (state.useRealSaverNotice) return state.realSaverNotice!.creatorSeesSaverFields(accountId, shouldSave);
      return accountId && shouldSave ? { creatorSeesSaver: true as const } : {};
    }),
  };
  return state;
});

vi.mock('expo-router', () => ({ router: { push: mocks.routerPush } }));
vi.mock('@/lib/haptics', () => ({ haptic: { light: mocks.hapticLight, error: mocks.hapticError } }));
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: mocks.announce,
    announceForAccessibilityWithOptions: mocks.announceWithOptions,
  },
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: { saveShowcasePost: mocks.saveShowcasePost }, user: mocks.user }),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('@/lib/saver-notice', async (importOriginal) => {
  mocks.realSaverNotice = await importOriginal<typeof import('@/lib/saver-notice')>();
  return { creatorSeesSaverFields: mocks.creatorSeesSaverFields };
});

import { useShowcaseSaveMutation } from '../lib/use-showcase-save-mutation';

const FEED_KEY = ['showcase-feed', 'for-you'];

let postSeq = 0;
/** The ledger is app-wide, so each case works on a post no other case touched. */
const nextPostId = () => `post-${(postSeq += 1)}`;

type Deferred = { resolve: (value: { isSaved: boolean; saveCount: number }) => void; reject: (error: Error) => void };

/**
 * A save whose response the test releases by hand, so two taps can be put in
 * flight together and settled in whichever order the case is about.
 */
function deferResponses() {
  const pending: Deferred[] = [];
  mocks.saveShowcasePost.mockImplementation(() => new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
  }));
  return pending;
}

function seedFeed(client: QueryClient, postId: string, isSaved: boolean, saveCount: number) {
  client.setQueryData<InfiniteData<ShowcaseFeedResponse>>(FEED_KEY, {
    pageParams: [null],
    pages: [{ items: [{ id: postId, isSaved, saveCount }] }],
  } as never);
}

function readSaveState(client: QueryClient) {
  const data = client.getQueryData<InfiniteData<ShowcaseFeedResponse>>(FEED_KEY);
  const item = data?.pages[0]?.items[0] as { isSaved: boolean; saveCount: number } | undefined;
  return { isSaved: item?.isSaved, saveCount: item?.saveCount };
}

type Toggle = (options: { postId: string; isSaved: boolean; saveCount: number; onSaved?: (isSaved: boolean) => void }) => void;

/**
 * Mounts `surfaceCount` independent copies of the real hook against one real
 * QueryClient — the scope queue lives in query-core's own MutationCache and the
 * ledger is app-wide, so stubbing either would prove nothing. Two surfaces is
 * the feed with the viewer open over it: separate mutations, separate pending
 * flags, one post.
 */
async function mountSaveSurfaces(surfaceCount = 1) {
  const postId = nextPostId();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  seedFeed(client, postId, false, 4);

  // Seeded with the state the feed already renders, so the recorded run is the
  // whole journey the heart takes rather than everything after the first tap.
  const states: Array<boolean | undefined> = [readSaveState(client).isSaved];
  const unsubscribe = client.getQueryCache().subscribe(() => {
    const { isSaved } = readSaveState(client);
    if (isSaved !== states[states.length - 1]) states.push(isSaved);
  });

  const toggles: Toggle[] = [];
  function Probe({ index }: { index: number }) {
    toggles[index] = useShowcaseSaveMutation().toggleSave;
    return null;
  }

  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      React.createElement(
        QueryClientProvider,
        { client },
        ...Array.from({ length: surfaceCount }, (_, index) =>
          React.createElement(Probe, { key: index, index }))
      )
    );
  });

  return {
    client,
    postId,
    states,
    tap: async (isSaved: boolean, saveCount: number, surface = 0, onSaved?: (isSaved: boolean) => void) => {
      await act(async () => { toggles[surface]({ postId, isSaved, saveCount, onSaved }); });
    },
    cleanup: () => { unsubscribe(); tree.unmount(); client.clear(); },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'user-1' };
  mocks.os = 'ios';
});

describe('what a save from Home sends', () => {
  it('asks the saver notice for the signed-in account and sends exactly what it gives', async () => {
    mocks.saveShowcasePost.mockImplementation(async (_postId: string, options: { shouldSave: boolean }) => ({
      isSaved: options.shouldSave,
      saveCount: options.shouldSave ? 5 : 4,
    }));
    // The first save is the one that tells them, so it tells the creator nothing.
    mocks.creatorSeesSaverFields.mockReturnValueOnce({ saverNotYetTold: true });
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await surface.tap(true, 5);
    await surface.tap(false, 4);

    expect(mocks.creatorSeesSaverFields.mock.calls).toEqual([['user-1', true], ['user-1', false], ['user-1', true]]);
    expect(mocks.saveShowcasePost.mock.calls).toEqual([
      [surface.postId, { shouldSave: true, sourceSurface: 'mobile-home-feed', saverNotYetTold: true }],
      [surface.postId, { shouldSave: false, sourceSurface: 'mobile-home-feed' }],
      [surface.postId, { shouldSave: true, sourceSurface: 'mobile-home-feed', creatorSeesSaver: true }],
    ]);

    surface.cleanup();
  });
});

// Review finding #11: a save that brings the saver notice up must not cut
// VoiceOver off while it reads the notice, so "Saved" waits behind it.
describe('what a save from Home says to a screen reader', () => {
  function answerEveryTap() {
    mocks.saveShowcasePost.mockImplementation(async (_postId: string, options: { shouldSave: boolean }) => ({
      isSaved: options.shouldSave,
      saveCount: options.shouldSave ? 5 : 4,
    }));
  }

  it('queues "Saved" and "Removed from saved" behind what VoiceOver is reading, on iOS', async () => {
    mocks.os = 'ios';
    answerEveryTap();
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await surface.tap(true, 5);

    expect(mocks.announceWithOptions.mock.calls).toEqual([
      ['Saved', { queue: true }],
      ['Removed from saved', { queue: true }],
    ]);
    expect(mocks.announce).not.toHaveBeenCalled();

    surface.cleanup();
  });

  it('announces them as before on Android, which has no queue', async () => {
    mocks.os = 'android';
    answerEveryTap();
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await surface.tap(true, 5);

    expect(mocks.announce.mock.calls).toEqual([['Saved'], ['Removed from saved']]);
    expect(mocks.announceWithOptions).not.toHaveBeenCalled();

    surface.cleanup();
  });
});

// Review finding #21: what a save tells its creator about who saved is
// decided at the tap. Saves leave one at a time, so a save tapped while the
// notice was telling the person can leave after they read it, and must still
// tell the creator nothing.
describe('a save tapped while an earlier one is on the wire and the notice is up', () => {
  let unsubscribe = () => {};

  beforeEach(() => {
    mocks.useRealSaverNotice = true;
    // The root layout's bar, which draws the notice.
    unsubscribe = mocks.realSaverNotice!.subscribeToSaverNotice(() => {});
  });

  afterEach(() => {
    unsubscribe();
    mocks.realSaverNotice!.resetSaverNoticeForTests();
    mocks.useRealSaverNotice = false;
  });

  /** One feed holding the posts, so each tap saves a different one. */
  async function mountFeed(postIds: string[]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<InfiniteData<ShowcaseFeedResponse>>(FEED_KEY, {
      pageParams: [null],
      pages: [{ items: postIds.map((id) => ({ id, isSaved: false, saveCount: 0 })) }],
    } as never);
    let toggle!: Toggle;
    function Probe() {
      toggle = useShowcaseSaveMutation().toggleSave;
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    return {
      tap: async (postId: string) => {
        await act(async () => { toggle({ postId, isSaved: false, saveCount: 0 }); });
      },
      cleanup: () => { tree.unmount(); client.clear(); },
    };
  }

  it('sends it telling the creator nothing after the notice was read, and the save tapped after that names the saver', async () => {
    const notice = mocks.realSaverNotice!;
    const pending = deferResponses();
    const [first, second, third] = [nextPostId(), nextPostId(), nextPostId()];
    const feed = await mountFeed([first, second, third]);

    await feed.tap(first);
    expect(notice.readSaverNotice()).toMatchObject({ accountId: 'user-1' });
    await feed.tap(second);
    // One request on the wire; the second waits behind it.
    expect(mocks.saveShowcasePost).toHaveBeenCalledTimes(1);

    // OK on the notice while the second waits; then a third save.
    await act(async () => { notice.settleSaverNotice(notice.readSaverNotice()!.id, 'closed'); });
    expect(notice.readSaverNotice()).toBeNull();
    await feed.tap(third);
    expect(mocks.saveShowcasePost).toHaveBeenCalledTimes(1);

    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 1 }); });
    await act(async () => { pending[1].resolve({ isSaved: true, saveCount: 1 }); });

    expect(mocks.saveShowcasePost.mock.calls).toEqual([
      [first, { shouldSave: true, sourceSurface: 'mobile-home-feed', saverNotYetTold: true }],
      [second, { shouldSave: true, sourceSurface: 'mobile-home-feed', saverNotYetTold: true }],
      [third, { shouldSave: true, sourceSurface: 'mobile-home-feed', creatorSeesSaver: true }],
    ]);

    feed.cleanup();
  });
});

describe('two quick taps on one save button', () => {
  it('holds the second request until the first settles, so the server sees tap order', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await surface.tap(true, 5);

    // Both taps have been made, but only one POST is on the wire.
    expect(mocks.saveShowcasePost).toHaveBeenCalledTimes(1);
    expect(mocks.saveShowcasePost.mock.calls[0][1]).toMatchObject({ shouldSave: true });

    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 5 }); });

    expect(mocks.saveShowcasePost).toHaveBeenCalledTimes(2);
    expect(mocks.saveShowcasePost.mock.calls[1][1]).toMatchObject({ shouldSave: false });

    surface.cleanup();
  });

  it('never flicks the heart back to the overtaken tap', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await surface.tap(true, 5);
    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 5 }); });
    await act(async () => { pending[1].resolve({ isSaved: false, saveCount: 4 }); });

    // Saved on the first tap, unsaved on the second, and never back again — the
    // first response describes an intent the viewer already replaced.
    expect(surface.states).toEqual([false, true, false]);
    expect(readSaveState(surface.client)).toEqual({ isSaved: false, saveCount: 4 });

    surface.cleanup();
  });

  it('keeps the last tap when the overtaken request fails', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await surface.tap(true, 5);
    await act(async () => { pending[0].reject(new Error('offline')); });
    await act(async () => { pending[1].resolve({ isSaved: false, saveCount: 4 }); });

    // No rollback and no error buzz for a tap that has been superseded: the
    // viewer's latest intent is still in flight, and it is the one that lands.
    expect(surface.states).toEqual([false, true, false]);
    expect(mocks.hapticError).not.toHaveBeenCalled();
    expect(readSaveState(surface.client)).toEqual({ isSaved: false, saveCount: 4 });

    surface.cleanup();
  });

  it('still rolls back and buzzes when the last tap is the one that fails', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();

    await surface.tap(false, 4);
    await act(async () => { pending[0].reject(new Error('offline')); });

    expect(readSaveState(surface.client)).toEqual({ isSaved: false, saveCount: 4 });
    expect(mocks.hapticError).toHaveBeenCalledTimes(1);

    surface.cleanup();
  });
});

describe('a save on one surface overtaken by a save on another', () => {
  it('queues the second surface behind the first, so one post is one conversation', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces(2);

    // Saved from the feed, then unsaved from the viewer it opened into, before
    // the feed's own request came back.
    await surface.tap(false, 4, 0);
    await surface.tap(true, 5, 1);

    expect(mocks.saveShowcasePost).toHaveBeenCalledTimes(1);
    expect(mocks.saveShowcasePost.mock.calls[0][1]).toMatchObject({ shouldSave: true });

    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 5 }); });

    expect(mocks.saveShowcasePost).toHaveBeenCalledTimes(2);
    expect(mocks.saveShowcasePost.mock.calls[1][1]).toMatchObject({ shouldSave: false });

    surface.cleanup();
  });

  it('lets the other surface silence a reconcile the first surface cannot know is stale', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces(2);

    await surface.tap(false, 4, 0);
    await surface.tap(true, 5, 1);
    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 5 }); });
    await act(async () => { pending[1].resolve({ isSaved: false, saveCount: 4 }); });

    // The feed's mutation has its own pending flag and its own onSuccess; only
    // the shared ledger tells it the viewer has since spoken for this post.
    expect(surface.states).toEqual([false, true, false]);
    expect(readSaveState(surface.client)).toEqual({ isSaved: false, saveCount: 4 });

    surface.cleanup();
  });
});

// Feed ranking v4, §4: Home reports its saves to the feed's ranking, as the
// reel does, through the tap's `onSaved` (`components/home-dashboard.tsx`).
describe('a save reported to the feed', () => {
  it('reports the state the server settled on, once it has answered', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();
    const onSaved = vi.fn();

    await surface.tap(false, 4, 0, onSaved);
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 5 }); });

    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith(true);

    surface.cleanup();
  });

  it('reports nothing for a save that failed', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();
    const onSaved = vi.fn();

    await surface.tap(false, 4, 0, onSaved);
    await act(async () => { pending[0].reject(new Error('offline')); });

    expect(onSaved).not.toHaveBeenCalled();

    surface.cleanup();
  });

  it('reports only the last of two quick taps, with its own answer', async () => {
    const pending = deferResponses();
    const surface = await mountSaveSurfaces();
    const first = vi.fn();
    const second = vi.fn();

    await surface.tap(false, 4, 0, first);
    await surface.tap(true, 5, 0, second);
    await act(async () => { pending[0].resolve({ isSaved: true, saveCount: 5 }); });
    await act(async () => { pending[1].resolve({ isSaved: false, saveCount: 4 }); });

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(false);

    surface.cleanup();
  });
});

// A guest's tap goes to sign-in first; the screen says where sign-in returns
// to, or the guest signs up and lands on Home without the post.
describe('a signed-out tap', () => {
  async function mountSignedOut(options?: { authReturnTo?: string }) {
    mocks.user = null;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    let toggle!: Toggle;
    function Probe() {
      toggle = useShowcaseSaveMutation(options).toggleSave;
      return null;
    }
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    return {
      tap: async () => { await act(async () => { toggle({ postId: 'post-signed-out', isSaved: false, saveCount: 0 }); }); },
      cleanup: () => { tree.unmount(); client.clear(); },
    };
  }

  it('sends the reader to sign in and back to the screen the post is on', async () => {
    const surface = await mountSignedOut({ authReturnTo: '/post/post-signed-out' });

    await surface.tap();

    expect(mocks.routerPush).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/post/post-signed-out' } });
    expect(mocks.saveShowcasePost).not.toHaveBeenCalled();

    surface.cleanup();
  });

  it('keeps the plain sign-in for a surface that names no way back', async () => {
    const surface = await mountSignedOut();

    await surface.tap();

    expect(mocks.routerPush).toHaveBeenCalledWith('/auth');

    surface.cleanup();
  });
});
