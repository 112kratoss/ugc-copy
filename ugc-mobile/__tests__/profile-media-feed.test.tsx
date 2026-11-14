(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import { Share } from 'react-native';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

/**
 * The profile's Posts feed, rendered only as far as what it hands each card's
 * actions (`callbacksFor`): the cards, the list and the sheets are doubles.
 */

// One router object for every render: a new one per render hangs these suites.
const routerState = vi.hoisted(() => ({
  params: { source: 'profile-posts' } as Record<string, string>,
  back: vi.fn(),
  canGoBack: vi.fn(() => true),
  push: vi.fn(),
  replace: vi.fn(),
  setParams: vi.fn(),
}));

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

// One object for every render, as the real context provides.
const authState = vi.hoisted(() => ({
  api: {
    getProfile: vi.fn(),
    shareShowcasePost: vi.fn((_postId: string, _options: { sourceSurface: string }) => Promise.resolve()),
  },
  user: { id: 'owner-1', email: 'owner@example.com' } as { id: string; email: string } | null,
  isGuest: false,
  identityUserId: 'owner-1' as string | null,
}));

const libraryState = vi.hoisted(() => ({
  items: [] as unknown[],
  selection: 'none' as string,
  hasNextPage: false,
  // A read of the library under way, the head's or a page's.
  isFetching: false,
  // What the feed asks the library for its next page with.
  fetchNextPage: vi.fn(() => Promise.resolve()),
}));

// What the feed last asked of the focus and foreground revalidation.
const revalidationState = vi.hoisted(() => ({
  options: null as null | { enabled: boolean; scope: string; refresh: () => Promise<unknown> | unknown },
}));

type CardActions = {
  onShare: () => void;
  onDeleted?: (id: string) => void;
  onRecreate: () => void;
  onComments?: () => void;
  authReturnTo?: string;
};

type CommentsSheetProps = { postId: string; visible: boolean; authReturnTo?: string; initialReplyToId?: string | null; onClose: () => void };

const feedState = vi.hoisted(() => ({
  callbacksFor: null as null | ((item: unknown) => CardActions),
  // What each drawn card was handed, by card id.
  cards: new Map<string, { onAction: (action: string) => void }>(),
  // What the comments sheet was last handed, while it is drawn.
  commentsSheet: null as null | CommentsSheetProps,
}));

const nothing = vi.hoisted(() => () => null);
const passThrough = vi.hoisted(() => ({ children }: { children?: unknown }) => children ?? null);

// The landing as it runs, for the suite that opens the feed on a card. Every
// other suite keeps it idle, so no opened card stands over the cards it presses.
const landingMode = vi.hoisted(() => ({ real: false }));

// What the list was last handed, and the handle the screen scrolls it with:
// every scroll arrives, with the card it went to on screen. `landedTop` is
// where the list then stands that card, from its top (null: it cannot say).
const listState = vi.hoisted(() => {
  const state = {
    props: null as null | {
      data?: Array<{ id: string }>;
      style?: { opacity?: number };
      pointerEvents?: string;
      accessibilityElementsHidden?: boolean;
      onLoad?: () => void;
      onContentSizeChange?: (width: number, height: number) => void;
      onScrollBeginDrag?: () => void;
      onEndReached?: () => void;
    },
    scrolledTo: [] as number[],
    landedTop: null as number | null,
    handle: {
      scrollToIndex: ({ index }: { index: number }) => {
        state.scrolledTo.push(index);
        return Promise.resolve();
      },
      computeVisibleIndices: () => {
        const index = state.scrolledTo.at(-1) ?? 0;
        return { startIndex: index, endIndex: index };
      },
      // Every card 500 tall, under the list's 12 of padding.
      getLayout: (index: number) => (state.landedTop === null ? undefined : { x: 0, y: index * 500, width: 362, height: 500 }),
      getFirstItemOffset: () => 12,
      getAbsoluteLastScrollOffset: () => {
        if (state.landedTop === null) return 0;
        return (state.scrolledTo.at(-1) ?? 0) * 500 + 12 - state.landedTop;
      },
    },
  };
  return state;
});

// Each fade the screen starts, run to its end by hand.
type Fade = { toValue: number; duration?: number; stopped: boolean; finish: (result: { finished: boolean }) => void };
const animationState = vi.hoisted(() => ({ fades: [] as Fade[] }));

// What each render drew, in order: the list at its opacity, and the opened
// card standing over it (the one card drawn for a screen out of reach).
const drawLog = vi.hoisted(() => ({ entries: [] as string[] }));

vi.mock('expo-router', () => ({
  router: routerState,
  useLocalSearchParams: () => routerState.params,
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
  useQueryClient: () => ({ getQueryData: vi.fn(), invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({ ref, ...props }: {
    ref?: { current: unknown } | null;
    data?: Array<{ id: string }>;
    renderItem: (info: { item: unknown; index: number }) => unknown;
  }) => {
    listState.props = props;
    drawLog.entries.push(`list@${(props as { style?: { opacity?: number } }).style?.opacity}`);
    if (ref) ref.current = listState.handle;
    return props.data?.map((item, index) => (
      React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item, index }) as React.ReactNode)
    )) ?? null;
  },
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: nothing,
  Animated: {
    View: passThrough,
    Value: class {
      constructor(public value: number) {}
      setValue(value: number) {
        this.value = value;
      }
    },
    timing: (_value: unknown, config: { toValue: number; duration?: number }) => {
      const fade: Fade = { toValue: config.toValue, duration: config.duration, stopped: false, finish: () => {} };
      animationState.fades.push(fade);
      return {
        start: (callback?: (result: { finished: boolean }) => void) => {
          fade.finish = (result) => callback?.(result);
        },
        // As React Native's: a stopped animation reports that it did not finish.
        stop: () => {
          fade.stopped = true;
          fade.finish({ finished: false });
        },
      };
    },
    sequence: (animations: Array<{ start: (callback?: (result: { finished: boolean }) => void) => void; stop: () => void }>) => ({
      start: (callback?: (result: { finished: boolean }) => void) => {
        const run = (index: number) => {
          if (index === animations.length) {
            callback?.({ finished: true });
            return;
          }
          animations[index].start((result) => (result.finished ? run(index + 1) : callback?.(result)));
        };
        run(0);
      },
      stop: () => animations.forEach((animation) => animation.stop()),
    }),
  },
  Easing: {
    cubic: (t: number) => t,
    out: (easing: (t: number) => number) => easing,
    inOut: (easing: (t: number) => number) => easing,
  },
  Platform: {
    get OS() {
      return platformState.os;
    },
    select: (options: Record<string, unknown>) => options[platformState.os] ?? options.default,
  },
  Pressable: nothing,
  Share: {
    dismissedAction: 'dismissedAction',
    share: vi.fn(),
    sharedAction: 'sharedAction',
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Text: nothing,
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
  View: passThrough,
}));

vi.mock('lucide-react-native', () => ({ RefreshCw: nothing }));

vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenuProvider: ({ callbacksFor, children }: { callbacksFor: (item: unknown) => CardActions; children?: unknown }) => {
    feedState.callbacksFor = callbacksFor;
    return children ?? null;
  },
}));
vi.mock('@/components/comments-sheet', () => ({
  CommentsSheet: (props: CommentsSheetProps) => {
    feedState.commentsSheet = props;
    return null;
  },
}));
vi.mock('@/components/feed-pagination-footer', () => ({ FeedLoadMoreErrorFooter: nothing }));
vi.mock('@/components/media-zoom', () => ({ MediaZoomSurface: passThrough }));
vi.mock('@/components/profile-feed-card', () => ({
  ProfileFeedCardView: ({ card, onAction, screenFocused }: {
    card: { id: string };
    onAction: (action: string) => void;
    screenFocused: boolean;
  }) => {
    if (screenFocused) feedState.cards.set(card.id, { onAction });
    else drawLog.entries.push(`opened:${card.id}`);
    return null;
  },
}));
vi.mock('@/components/ui', async (importOriginal) => {
  // The real controls (`SegmentedControl` and the buttons): what the screen draws is what is pressed.
  const actual = await importOriginal<typeof import('@/components/ui')>();
  return {
    ...actual,
    SecondaryButton: nothing,
    StatusBlock: (props: { title: string }) => React.createElement('status-block', props),
  };
});
vi.mock('@/components/viewer-action-sheet', () => ({ ViewerActionSheet: nothing }));

vi.mock('@/lib/audio-creation-native-player', () => ({ audioCreationPlayback: { pause: vi.fn() } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.com' } }));
vi.mock('@/lib/platform-glyphs', () => ({ BackGlyph: nothing }));
vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (inset: number) => inset,
  resolvedTopInset: (inset: number) => inset,
}));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({
    colors: { background: '#fff', muted: '#666', primary: '#f60', text: '#111' },
    // The notice a landing that gave up puts above the list.
    semantic: { warning: { background: '#fff4e0', border: '#f0c070', foreground: '#7a4a00' } },
  }),
}));
vi.mock('@/lib/post-lifecycle', () => ({
  changePostVisibility: vi.fn(),
  pickPostVisibility: vi.fn(),
  resolveLinkedLifecyclePost: vi.fn(),
  toPostLifecyclePost: (post: unknown) => post,
}));
vi.mock('@/lib/profile-feed-card-view-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/profile-feed-card-view-model')>();
  const idle = { phase: 'idle', targetIndex: -1 };
  return {
    INITIAL_FEED_LANDING: idle,
    buildProfileFeedCards: (items: Array<{ id: string }>) => items.map((item) => ({ id: item.id, item })),
    feedLandingCardPlace: actual.feedLandingCardPlace,
    feedLandingScrollArrived: () => false,
    initialFeedLanding: (index: number) => (landingMode.real ? actual.initialFeedLanding(index) : idle),
    reduceFeedLanding: (state: Parameters<typeof actual.reduceFeedLanding>[0], event: Parameters<typeof actual.reduceFeedLanding>[1]) => (
      landingMode.real ? actual.reduceFeedLanding(state, event) : state
    ),
    shouldScrollToFeedTarget: (state: Parameters<typeof actual.shouldScrollToFeedTarget>[0], cardCount: number) => (
      landingMode.real && actual.shouldScrollToFeedTarget(state, cardCount)
    ),
  };
});
vi.mock('@/lib/profile-library-head', () => ({ refreshProfileLibraryHead: vi.fn() }));
vi.mock('@/lib/use-profile-library-source', () => ({
  useProfileLibrarySource: () => ({
    enrichmentFailed: false,
    fetchNextPage: libraryState.fetchNextPage,
    hasData: true,
    hasNextPage: libraryState.hasNextPage,
    isError: false,
    isFetching: libraryState.isFetching,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    isLoading: false,
    isStale: false,
    items: libraryState.items,
    pageCount: 1,
    refetch: vi.fn(),
    retryEnrichment: vi.fn(),
    retrySelection: vi.fn(),
    selection: libraryState.selection,
  }),
}));
vi.mock('@/lib/use-profile-media-revalidation', () => ({
  useProfileMediaRevalidation: (options: NonNullable<typeof revalidationState.options>) => {
    revalidationState.options = options;
  },
}));
vi.mock('@/lib/use-viewer-action-handlers', () => ({ changeGenerationArchive: vi.fn() }));
vi.mock('@/lib/viewer-media-cache', () => ({ applyPostVisibilityToCaches: vi.fn() }));

import { ProfileFeedCardView } from '@/components/profile-feed-card';
import { ProfileMediaFeedScreen } from '@/components/profile-media-feed';
import { refreshProfileLibraryHead } from '@/lib/profile-library-head';
import { appTheme } from '@/lib/theme';
import { changeGenerationArchive } from '@/lib/use-viewer-action-handlers';

/** One of the owner's public posts, as the Posts library lists it. */
const publicPost = {
  id: 'post-1',
  source: 'profile-posts',
  sourceType: 'owner-post',
  title: 'Neon alley',
  canShare: true,
  sharePath: '/showcase/post-1',
  showcasePostId: 'post-1',
  ownerPostId: 'post-1',
  generationId: null,
  mediaItems: [],
  availableActions: ['share'],
} as unknown as ImmersivePreviewItem;

const trees: renderer.ReactTestRenderer[] = [];

function renderFeed() {
  act(() => {
    trees.push(renderer.create(<ProfileMediaFeedScreen />));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  platformState.os = 'ios';
  routerState.params = { source: 'profile-posts' };
  libraryState.items = [publicPost];
  libraryState.selection = 'none';
  libraryState.hasNextPage = false;
  libraryState.isFetching = false;
  authState.user = { id: 'owner-1', email: 'owner@example.com' };
  authState.isGuest = false;
  authState.identityUserId = 'owner-1';
  revalidationState.options = null;
  feedState.callbacksFor = null;
  feedState.cards.clear();
  feedState.commentsSheet = null;
  landingMode.real = false;
  listState.props = null;
  listState.scrolledTo = [];
  listState.landedTop = null;
  animationState.fades = [];
  drawLog.entries = [];
});

afterEach(() => {
  act(() => {
    for (const tree of trees.splice(0)) tree.unmount();
  });
});

describe("the profile feed's Share", () => {
  // Android's share intent answers "shared" whether or not anything was sent
  // (`invite.tsx`), so only iOS can count a share (audit 04-4).
  it.each([
    ['android', 'sharedAction', false],
    ['ios', 'sharedAction', true],
    ['ios', 'dismissedAction', false],
  ] as const)('on %s, a sheet that answers %s counts a share: %s', async (os, action, counted) => {
    platformState.os = os;
    renderFeed();
    vi.mocked(Share.share).mockResolvedValueOnce({ action: Share[action] } as never);

    await act(async () => {
      feedState.callbacksFor!(publicPost).onShare();
    });

    // The link goes out once: iOS gets it alone, Android in the message.
    const link = expect.stringContaining('/showcase/post-1');
    expect(Share.share).toHaveBeenCalledWith(os === 'ios'
      ? { url: link }
      : { title: expect.any(String), message: link });
    expect(authState.api.shareShowcasePost.mock.calls).toEqual(
      counted ? [['post-1', { sourceSurface: 'my-creations' }]] : []
    );
  });

  it('counts nothing and throws nothing when the sheet fails to open', async () => {
    renderFeed();
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('No activity found to handle Intent'));

    await act(async () => {
      feedState.callbacksFor!(publicPost).onShare();
    });

    expect(authState.api.shareShowcasePost).not.toHaveBeenCalled();
  });
});

/** One of the owner's creations, as the Creations library lists it. */
function creation(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: 'profile-creations',
    sourceType: 'generation',
    title: `Creation ${id}`,
    creatorLabel: '@owner',
    canShare: false,
    sharePath: null,
    showcasePostId: null,
    ownerPostId: null,
    generationId: id,
    recreateTool: 'image',
    recreatePrompt: 'A product still',
    mediaKind: 'image',
    mediaUrl: `https://cdn.example.com/${id}.png`,
    mediaItems: [],
    availableActions: ['publish', 'recreate', 'archive', 'delete-creation', 'download', 'view-details'],
    ...overrides,
  } as unknown as ImmersivePreviewItem;
}

function rerenderFeed() {
  act(() => {
    trees.at(-1)!.update(<ProfileMediaFeedScreen />);
  });
}

const statusTitles = () => trees.at(-1)!.root.findAll((node) => String(node.type) === 'status-block')
  .map((node) => node.props.title);

describe("an archived creation's card", () => {
  // Its only inline action was Share, which opened the composer for a creation
  // that was archived (audit 01-6).
  it('restores through the same path as the •••', () => {
    const archived = creation('gen-archived', {
      archivedAt: '2026-10-01T00:00:00.000Z',
      availableActions: ['restore', 'delete-creation', 'view-details'],
    });
    routerState.params = { source: 'profile-creations', scope: 'archived' };
    libraryState.items = [archived];
    renderFeed();

    act(() => { feedState.cards.get('gen-archived')!.onAction('restore'); });

    expect(changeGenerationArchive).toHaveBeenCalledWith({
      api: authState.api,
      queryClient: expect.anything(),
      userId: 'owner-1',
      item: archived,
      archive: false,
    });
  });

  // The feed reads the Archived scope's own pages, so it revalidates those.
  it("revalidates the Archived scope's pages, never the library's, and a Posts feed its own", async () => {
    routerState.params = { source: 'profile-creations', initialId: 'gen-archived', scope: 'archived' };
    libraryState.items = [creation('gen-archived', { archivedAt: '2026-10-01T00:00:00.000Z' })];
    renderFeed();

    await act(async () => { await revalidationState.options!.refresh(); });
    expect(refreshProfileLibraryHead).toHaveBeenCalledWith(expect.objectContaining({ library: 'Creations', archived: true }));

    vi.mocked(refreshProfileLibraryHead).mockClear();
    routerState.params = { source: 'profile-posts', scope: 'archived' };
    renderFeed();
    await act(async () => { await revalidationState.options!.refresh(); });
    expect(refreshProfileLibraryHead).toHaveBeenCalledWith(expect.objectContaining({ library: 'Posts', archived: false }));
  });
});

describe('a creation deleted from the feed', () => {
  it('keeps the rest of the feed when it was the card the feed was opened on', () => {
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1'), creation('gen-2')];
    libraryState.selection = 'found';
    renderFeed();

    act(() => { feedState.callbacksFor!(libraryState.items[0]).onDeleted?.('gen-1'); });
    // The library no longer holds it, and its own lookup would call it missing.
    libraryState.items = [creation('gen-2')];
    libraryState.selection = 'missing';
    rerenderFeed();

    expect(statusTitles()).toEqual([]);
    expect(feedState.cards.has('gen-2')).toBe(true);
    expect(routerState.back).not.toHaveBeenCalled();
  });

  it('leaves the feed when it was the last card', () => {
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    libraryState.selection = 'found';
    renderFeed();

    act(() => { feedState.callbacksFor!(libraryState.items[0]).onDeleted?.('gen-1'); });

    expect(routerState.back).toHaveBeenCalledTimes(1);
  });

  it('still says a card it was opened on is missing when the reader did not delete it here', () => {
    routerState.params = { source: 'profile-creations', initialId: 'gen-gone' };
    libraryState.items = [creation('gen-2')];
    libraryState.selection = 'missing';
    renderFeed();

    expect(statusTitles()).toEqual(["This creation isn't available"]);
  });
});

describe("a creation's Recreate", () => {
  // The creator drew the full-size original 40pt across (audit 01, below the cut).
  it("hands the creator the media's poster for its thumbnail", () => {
    const item = creation('gen-1', {
      mediaItems: [{ id: 'gen-1:output', url: 'https://cdn.example.com/gen-1.png', mediaKind: 'image', previewUrl: 'https://cdn.example.com/gen-1.poster.webp' }],
    });
    routerState.params = { source: 'profile-creations' };
    libraryState.items = [item];
    renderFeed();

    act(() => { feedState.callbacksFor!(item).onRecreate(); });

    const href = String(routerState.push.mock.calls.at(-1)?.[0]);
    expect(new URL(href, 'https://magicbooklet.local').searchParams.get('sourceThumbnail'))
      .toBe('https://cdn.example.com/gen-1.poster.webp');
  });
});

// Every card action that asks for an account ended on Home after signing in
// (audit 01-12): Recreate, Publish and visibility, the ••• and comments now come
// back to this feed, on the same library, card and scope.
describe('signing in from the card feed', () => {
  const FEED = '/profile-media-feed?source=profile-creations&initialId=gen-1';

  it('comes back to the feed from Recreate', () => {
    authState.user = null;
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    renderFeed();

    act(() => { feedState.callbacksFor!(libraryState.items[0]).onRecreate(); });

    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: FEED } });
  });

  it('comes back to the feed from a card’s Publish', () => {
    authState.user = null;
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    renderFeed();

    act(() => { feedState.cards.get('gen-1')!.onAction('publish'); });

    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: FEED } });
  });

  it('hands the ••• the feed to come back to, archived scope included', () => {
    routerState.params = { source: 'profile-posts', initialId: 'post-1', scope: 'archived' };
    renderFeed();

    expect(feedState.callbacksFor!(publicPost).authReturnTo)
      .toBe('/profile-media-feed?source=profile-posts&initialId=post-1&scope=archived');
  });

  it('hands the comments sheet the feed to come back to', () => {
    const commentable = { ...publicPost, canComment: true, commentCount: 3 } as ImmersivePreviewItem;
    routerState.params = { source: 'profile-posts', initialId: 'post-1' };
    libraryState.items = [commentable];
    renderFeed();

    act(() => { feedState.callbacksFor!(commentable).onComments?.(); });

    expect(feedState.commentsSheet).toMatchObject({
      postId: 'post-1',
      visible: true,
      authReturnTo: '/profile-media-feed?source=profile-posts&initialId=post-1',
    });
  });

  it('opens the thread again, on its reply, when sign-in comes back with it', () => {
    const commentable = { ...publicPost, canComment: true, commentCount: 3 } as ImmersivePreviewItem;
    routerState.params = { source: 'profile-posts', initialId: 'post-1', comments: 'post-1', replyTo: 'comment-9' };
    libraryState.items = [commentable];
    renderFeed();

    expect(feedState.commentsSheet).toMatchObject({ postId: 'post-1', visible: true, initialReplyToId: 'comment-9' });
    expect(routerState.setParams).toHaveBeenCalledWith({ comments: undefined, replyTo: undefined });

    // Closing it forgets the reply, so the next opening starts a new comment.
    act(() => { feedState.commentsSheet!.onClose(); });
    routerState.params = { source: 'profile-posts', initialId: 'post-1' };
    act(() => { feedState.callbacksFor!(commentable).onComments?.(); });
    expect(feedState.commentsSheet).toMatchObject({ visible: true, initialReplyToId: null });
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('keeps the reopened thread when every effect runs again', () => {
    const commentable = { ...publicPost, canComment: true, commentCount: 3 } as ImmersivePreviewItem;
    routerState.params = { source: 'profile-posts', initialId: 'post-1', comments: 'post-1' };
    libraryState.items = [commentable];
    const inActivity = (mode: 'visible' | 'hidden') => (
      <React.Activity mode={mode}><ProfileMediaFeedScreen /></React.Activity>
    );
    act(() => { trees.push(renderer.create(inActivity('visible'))); });
    expect(feedState.commentsSheet).toMatchObject({ postId: 'post-1', visible: true });

    act(() => { trees.at(-1)!.update(inActivity('hidden')); });
    act(() => { trees.at(-1)!.update(inActivity('visible')); });

    expect(feedState.commentsSheet).toMatchObject({ postId: 'post-1', visible: true, initialReplyToId: null });
  });

  it('leaves a thread the feed does not hold alone', () => {
    routerState.params = { source: 'profile-posts', initialId: 'post-1', comments: 'post-elsewhere' };
    libraryState.items = [{ ...publicPost, canComment: true } as ImmersivePreviewItem];
    renderFeed();

    expect(feedState.commentsSheet).toBeNull();
    expect(routerState.setParams).not.toHaveBeenCalled();
  });
});

// 02-1: a guest's Creations are its own library, so its card feed revalidates
// that library under the guest's identity, and its own creation is its to
// restore and to recreate. What an account does still asks it to sign in.
describe("a guest's card feed", () => {
  const FEED = '/profile-media-feed?source=profile-creations&initialId=gen-1';
  const asGuest = () => {
    authState.user = null;
    authState.isGuest = true;
    authState.identityUserId = 'guest-1';
  };

  it('revalidates its Creations under its identity', async () => {
    asGuest();
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    renderFeed();

    expect(revalidationState.options).toMatchObject({ enabled: true, scope: 'Creations' });
    await act(async () => { await revalidationState.options!.refresh(); });
    expect(refreshProfileLibraryHead).toHaveBeenCalledWith(expect.objectContaining({ userId: 'guest-1', library: 'Creations' }));
  });

  it('revalidates no Posts library, which a guest does not have', () => {
    asGuest();
    routerState.params = { source: 'profile-posts' };
    renderFeed();

    expect(revalidationState.options).toMatchObject({ enabled: false, scope: 'Posts' });
  });

  it('restores its own archived creation without signing in', () => {
    asGuest();
    const archived = creation('gen-archived', {
      archivedAt: '2026-10-01T00:00:00.000Z',
      availableActions: ['restore', 'delete-creation', 'view-details'],
    });
    routerState.params = { source: 'profile-creations', scope: 'archived' };
    libraryState.items = [archived];
    renderFeed();

    act(() => { feedState.cards.get('gen-archived')!.onAction('restore'); });

    expect(routerState.push).not.toHaveBeenCalled();
    expect(changeGenerationArchive).toHaveBeenCalledWith({
      api: authState.api,
      queryClient: expect.anything(),
      userId: 'guest-1',
      item: archived,
      archive: false,
    });
  });

  it('recreates its own creation in the creator, as the reel does', () => {
    asGuest();
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    renderFeed();

    act(() => { feedState.cards.get('gen-1')!.onAction('recreate'); });

    expect(routerState.push).toHaveBeenCalledTimes(1);
    expect(String(routerState.push.mock.calls[0][0])).toMatch(/^\/create\/image\?remix=gen-1&/);
  });

  it('is still asked to sign in to publish', () => {
    asGuest();
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    renderFeed();

    act(() => { feedState.cards.get('gen-1')!.onAction('publish'); });

    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: FEED } });
  });

  it('keeps an account’s revalidation under the account', async () => {
    routerState.params = { source: 'profile-creations', initialId: 'gen-1' };
    libraryState.items = [creation('gen-1')];
    renderFeed();

    expect(revalidationState.options).toMatchObject({ enabled: true });
    await act(async () => { await revalidationState.options!.refresh(); });
    expect(refreshProfileLibraryHead).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-1', library: 'Creations' }));
  });
});

// Opened on a card, the list is hidden while it seeks the card, so the card is
// drawn where the list will show it from the first render: the page came in
// empty and the card cut in after (2026-11-03). It answers nothing, and gives
// way to the list once the list has landed.
describe('opening the feed on a card', () => {
  const library = ['gen-1', 'gen-2', 'gen-3', 'gen-4'].map((id) => creation(id));

  function openOn(id: string) {
    landingMode.real = true;
    routerState.params = { source: 'profile-creations', initialId: id };
    libraryState.items = library;
    libraryState.selection = 'found';
    renderFeed();
  }

  const openingCards = () => trees.at(-1)!.root.findAll((node) => node.props.testID === 'profile-media-feed-opening-card');
  const openedCard = () => openingCards()[0].findByType(ProfileFeedCardView);
  /** The view the opened card is laid out in, with the list's padding round it. */
  const cardFrame = () => openingCards()[0].findAll((node) => node.props.style?.paddingHorizontal !== undefined)[0];
  /** Whether the opened card stands on the list's foot, under the space that fills the list above it. */
  const onFoot = () => openingCards()[0].findAll((node) => node.props.style?.flexGrow === 1).length === 1;
  /** What a screen reader is told is under way while the list seeks the card. */
  const openingProgress = () => trees.at(-1)!.root.findAll((node) => node.props.accessibilityRole === 'progressbar');
  const listCard = (index: number) => listState.props!.data![index];

  /** The list's first layout, which starts its landing; every scroll arrives on the card. */
  async function listLaidOut() {
    await act(async () => { listState.props!.onLoad!(); });
  }

  it('draws the opened card over the list while the list is hidden seeking it', () => {
    openOn('gen-3');

    expect(listState.props).toMatchObject({ style: { opacity: 0 }, pointerEvents: 'none', accessibilityElementsHidden: true });
    expect(openingCards()).toHaveLength(1);
    // The list's own card, as wide as the list draws it, its video held at its poster.
    expect(openedCard().props.card).toBe(listCard(2));
    expect(openedCard().props).toMatchObject({ contentWidth: 362, showActiveVideo: false, screenFocused: false });
  });

  it('takes no touches and keeps out of screen readers, which find the list’s card once landed', () => {
    openOn('gen-3');

    expect(openingCards()[0].props).toMatchObject({
      pointerEvents: 'none',
      accessibilityElementsHidden: true,
      importantForAccessibility: 'no-hide-descendants',
    });
  });

  // Review of PR #679, finding 11. The list and the card standing over it are
  // hidden from screen readers while the list seeks the card, and the spinner
  // that said so went when the card came: a screen reader found the top bar alone.
  it('tells a screen reader the creation is opening while the list seeks it, and nothing once landed', async () => {
    openOn('gen-3');

    expect(openingProgress()).toHaveLength(1);
    expect(openingProgress()[0].props).toMatchObject({
      accessible: true,
      accessibilityLabel: 'Opening creation',
      accessibilityState: { busy: true },
      // It draws nothing and takes no touches: the card is what shows.
      pointerEvents: 'none',
    });

    await listLaidOut();
    expect(openingProgress()).toHaveLength(0);
  });

  // Review of PR #712, finding 8: the list's size report is shared with the
  // guard that keeps a covered list within its content, and must still be a
  // chance for the landing to try again.
  it('asks the landing again when the list reports a new size while it seeks the card', async () => {
    openOn('gen-3');
    const visible = listState.handle.computeVisibleIndices;
    // The first scroll ends short of the card.
    listState.handle.computeVisibleIndices = () => ({ startIndex: 0, endIndex: 1 });
    try {
      await listLaidOut();
      expect(listState.scrolledTo).toEqual([2]);

      await act(async () => { listState.props!.onContentSizeChange!(362, 2600); });
      expect(listState.scrolledTo).toEqual([2, 2]);
    } finally {
      listState.handle.computeVisibleIndices = visible;
    }
  });

  it('says a post is opening on the Posts feed', () => {
    landingMode.real = true;
    routerState.params = { source: 'profile-posts', initialId: 'post-1' };
    libraryState.items = [publicPost];
    libraryState.selection = 'found';
    renderFeed();

    expect(openingProgress().map((node) => node.props.accessibilityLabel)).toEqual(['Opening post']);
  });

  it.each([
    // The first card is never scrolled: it keeps the list's top padding.
    ['gen-1', 12, false],
    // A later card is scrolled to the top of the list, its padding with it.
    ['gen-3', 0, false],
    // The scroll stops at the end of the cards: the last stands on the list's foot.
    ['gen-4', 0, true],
  ])('stands %s where the list will show it', (id, paddingTop, onFoot) => {
    openOn(id);

    expect(cardFrame().props.style).toMatchObject({ paddingTop, paddingHorizontal: 14 });
    expect(openingCards()[0].findAll((node) => node.props.style?.flexGrow === 1)).toHaveLength(onFoot ? 1 : 0);
  });

  it('stands a card that arrives after the screen from the render that first holds it', () => {
    landingMode.real = true;
    routerState.params = { source: 'profile-creations', initialId: 'gen-3' };
    // Fetched on its own: the screen comes up before the card does.
    libraryState.items = [];
    libraryState.selection = 'loading';
    renderFeed();
    expect(listState.props).toBeNull();

    libraryState.items = library;
    libraryState.selection = 'found';
    rerenderFeed();

    // That render's landing still waits for the card; the top of the list must
    // not show from under it for a frame before the landing starts.
    expect(drawLog.entries.slice(0, 4)).toEqual(['list@1', 'opened:gen-3', 'list@0', 'opened:gen-3']);
    expect(openingCards()).toHaveLength(1);
  });

  // Review of PR #679, finding 10. Opened on the last card loaded, the landing
  // scroll reaches the end of the list, which asked for the next page; that
  // page landing moved the opened card from the list's foot to its top while
  // the list was still landing it on its foot.
  it('keeps the opened card where it was first drawn when a page lands under it', () => {
    openOn('gen-4');
    expect(onFoot()).toBe(true);

    libraryState.items = [...library, creation('gen-5'), creation('gen-6')];
    rerenderFeed();

    expect(openedCard().props.card).toBe(listCard(3));
    expect(cardFrame().props.style).toMatchObject({ paddingTop: 0 });
    expect(onFoot()).toBe(true);
  });

  it('stands the card afresh when a reorder starts a landing on another index', () => {
    openOn('gen-3');
    expect(onFoot()).toBe(false);

    // A refresh moved it to the end of the loaded cards before the list landed.
    libraryState.items = [library[0], library[1], library[3], library[2]];
    rerenderFeed();

    expect(openedCard().props.card).toBe(listCard(3));
    expect(onFoot()).toBe(true);
  });

  it('asks for the next page only once the list has landed on the card', async () => {
    libraryState.hasNextPage = true;
    openOn('gen-4');

    // The landing's own scroll reaches the end of the list.
    act(() => { listState.props!.onEndReached!(); });
    expect(libraryState.fetchNextPage).not.toHaveBeenCalled();

    await listLaidOut();
    expect(libraryState.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('asks for it once a read of the library that was under way as the list landed is done', async () => {
    libraryState.hasNextPage = true;
    libraryState.isFetching = true;
    openOn('gen-4');
    act(() => { listState.props!.onEndReached!(); });
    await listLaidOut();
    expect(libraryState.fetchNextPage).not.toHaveBeenCalled();

    libraryState.isFetching = false;
    rerenderFeed();
    expect(libraryState.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('asks for it at once when the end is reached after the list has landed', async () => {
    libraryState.hasNextPage = true;
    openOn('gen-4');
    await listLaidOut();

    act(() => { listState.props!.onEndReached!(); });
    expect(libraryState.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('draws nothing over a feed opened without a card', () => {
    landingMode.real = true;
    routerState.params = { source: 'profile-creations' };
    libraryState.items = library;
    renderFeed();

    expect(openingCards()).toHaveLength(0);
    expect(listState.props).toMatchObject({ style: { opacity: 1 } });
  });

  it('stays over the landed list until its fade has run, then goes', async () => {
    openOn('gen-3');
    await listLaidOut();

    expect(listState.scrolledTo).toEqual([2]);
    expect(listState.props).toMatchObject({ style: { opacity: 1 }, pointerEvents: 'auto' });
    expect(openingCards()).toHaveLength(1);
    expect(animationState.fades).toMatchObject([{ toValue: 0, stopped: false }]);

    act(() => { animationState.fades[0].finish({ finished: true }); });
    expect(openingCards()).toHaveLength(0);
  });

  it('only fades where the landed list stands the card where it was drawn', async () => {
    openOn('gen-3');
    act(() => { cardFrame().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 500 } } }); });
    listState.landedTop = 0;
    await listLaidOut();

    expect(animationState.fades.map((fade) => fade.toValue)).toEqual([0]);
  });

  it('moves to where the list stopped short before fading, so it never shows twice', async () => {
    // Cards after it too short to fill the list: the scroll stopped 90 early.
    openOn('gen-3');
    act(() => { cardFrame().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 500 } } }); });
    listState.landedTop = 90;
    await listLaidOut();

    const [fade, move] = animationState.fades;
    expect(move.toValue).toBe(90);
    // Both steps keep the beat of a navigation, from the motion tokens.
    expect([move.duration, fade.duration]).toEqual([appTheme.motion.duration.navigation, appTheme.motion.duration.navigation]);
    expect(cardFrame().props.style.transform).toEqual([{ translateY: expect.anything() }]);
    // The ground still hides the list while the card moves; then it fades.
    act(() => { move.finish({ finished: true }); });
    expect(openingCards()).toHaveLength(1);
    expect(fade.toValue).toBe(0);
    act(() => { fade.finish({ finished: true }); });
    expect(openingCards()).toHaveLength(0);
  });

  it('gives way the same over the first card, which the list lands on without a scroll', async () => {
    openOn('gen-1');
    await listLaidOut();

    expect(listState.scrolledTo).toEqual([]);
    expect(listState.props).toMatchObject({ style: { opacity: 1 } });
    act(() => { animationState.fades[0].finish({ finished: true }); });
    expect(openingCards()).toHaveLength(0);
  });

  it('goes at once when the reader scrolls the list during its fade', async () => {
    openOn('gen-3');
    await listLaidOut();

    act(() => { listState.props!.onScrollBeginDrag!(); });
    expect(openingCards()).toHaveLength(0);
  });

  it('stands whole again when a reorder starts the landing over during its fade', async () => {
    openOn('gen-3');
    await listLaidOut();

    // A refresh put a new creation above the card before the reader moved.
    libraryState.items = [creation('gen-0'), ...library];
    await act(async () => { trees.at(-1)!.update(<ProfileMediaFeedScreen />); });

    expect(animationState.fades[0].stopped).toBe(true);
    expect(listState.scrolledTo).toEqual([2, 3]);
    expect(openingCards()).toHaveLength(1);
    expect(openedCard().props.card).toBe(listCard(3));
    expect(openingCards()[0].props.style.opacity.value).toBe(1);
    // And gives way again once the list has landed afresh.
    expect(animationState.fades).toHaveLength(2);
    act(() => { animationState.fades[1].finish({ finished: true }); });
    expect(openingCards()).toHaveLength(0);
  });

  it('goes when the landing gives up, leaving the list and its notice', () => {
    vi.useFakeTimers();
    try {
      openOn('gen-3');
      // Past the landing's three-second budget, with the list never laid out.
      act(() => { vi.advanceTimersByTime(4000); });

      expect(openingCards()).toHaveLength(0);
      expect(listState.props).toMatchObject({ style: { opacity: 1 }, pointerEvents: 'auto' });
      expect(trees.at(-1)!.root.findAll((node) => (
        node.props.accessibilityLabel === "Couldn't scroll to the creation you opened. Tap to try again."
      ))).not.toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
