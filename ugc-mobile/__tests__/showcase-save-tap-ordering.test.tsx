(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ShowcaseFeedResponse } from '../lib/types';

const mocks = vi.hoisted(() => ({
  saveShowcasePost: vi.fn(),
  routerPush: vi.fn(),
  hapticLight: vi.fn(),
  hapticError: vi.fn(),
  announce: vi.fn(),
}));

vi.mock('expo-router', () => ({ router: { push: mocks.routerPush } }));
vi.mock('@/lib/haptics', () => ({ haptic: { light: mocks.hapticLight, error: mocks.hapticError } }));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: { saveShowcasePost: mocks.saveShowcasePost }, user: { id: 'user-1' } }),
}));

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

type Toggle = (options: { postId: string; isSaved: boolean; saveCount: number }) => void;

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
    tap: async (isSaved: boolean, saveCount: number, surface = 0) => {
      await act(async () => { toggles[surface]({ postId, isSaved, saveCount }); });
    },
    cleanup: () => { unsubscribe(); tree.unmount(); client.clear(); },
  };
}

afterEach(() => { vi.clearAllMocks(); });

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
