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
}));

const platformState = vi.hoisted(() => ({ os: 'ios' as 'ios' | 'android' }));

// One object for every render, as the real context provides.
const authState = vi.hoisted(() => ({
  api: {
    getProfile: vi.fn(),
    shareShowcasePost: vi.fn((_postId: string, _options: { sourceSurface: string }) => Promise.resolve()),
  },
  user: { id: 'owner-1', email: 'owner@example.com' },
}));

const libraryState = vi.hoisted(() => ({ items: [] as unknown[], selection: 'none' as string }));

type CardActions = { onShare: () => void; onDeleted?: (id: string) => void; onRecreate: () => void };

const feedState = vi.hoisted(() => ({
  callbacksFor: null as null | ((item: unknown) => CardActions),
  // What each drawn card was handed, by card id.
  cards: new Map<string, { onAction: (action: string) => void }>(),
}));

const nothing = vi.hoisted(() => () => null);
const passThrough = vi.hoisted(() => ({ children }: { children?: unknown }) => children ?? null);

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
  FlashList: ({ data, renderItem }: { data?: Array<{ id: string }>; renderItem: (info: { item: unknown; index: number }) => unknown }) => (
    data?.map((item, index) => renderItem({ item, index })) ?? null
  ),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: vi.fn() },
  ActivityIndicator: nothing,
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
vi.mock('@/components/comments-sheet', () => ({ CommentsSheet: nothing }));
vi.mock('@/components/feed-pagination-footer', () => ({ FeedLoadMoreErrorFooter: nothing }));
vi.mock('@/components/media-zoom', () => ({ MediaZoomSurface: passThrough }));
vi.mock('@/components/zoom-veil', () => ({ ZoomVeilScope: passThrough }));
vi.mock('@/components/profile-feed-card', () => ({
  ProfileFeedCardView: ({ card, onAction }: { card: { id: string }; onAction: (action: string) => void }) => {
    feedState.cards.set(card.id, { onAction });
    return null;
  },
}));
vi.mock('@/components/ui', () => ({
  SecondaryButton: nothing,
  StatusBlock: (props: { title: string }) => React.createElement('status-block', props),
}));
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
  useAppTheme: () => ({ colors: { background: '#fff', muted: '#666', primary: '#f60', text: '#111' } }),
}));
vi.mock('@/lib/post-lifecycle', () => ({
  changePostVisibility: vi.fn(),
  pickPostVisibility: vi.fn(),
  resolveLinkedLifecyclePost: vi.fn(),
  toPostLifecyclePost: (post: unknown) => post,
}));
vi.mock('@/lib/profile-feed-card-view-model', () => ({
  INITIAL_FEED_LANDING: { phase: 'idle', targetIndex: -1 },
  buildProfileFeedCards: (items: Array<{ id: string }>) => items.map((item) => ({ id: item.id, item })),
  reduceFeedLanding: (state: unknown) => state,
  shouldScrollToFeedTarget: () => false,
}));
vi.mock('@/lib/profile-library-head', () => ({ refreshProfileLibraryHead: vi.fn() }));
vi.mock('@/lib/use-profile-library-source', () => ({
  useProfileLibrarySource: () => ({
    enrichmentFailed: false,
    fetchNextPage: vi.fn(),
    hasData: true,
    hasNextPage: false,
    isError: false,
    isFetching: false,
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
vi.mock('@/lib/use-profile-media-revalidation', () => ({ useProfileMediaRevalidation: () => undefined }));
vi.mock('@/lib/use-viewer-action-handlers', () => ({ changeGenerationArchive: vi.fn() }));
vi.mock('@/lib/viewer-media-cache', () => ({ applyPostVisibilityToCaches: vi.fn() }));

import { ProfileMediaFeedScreen } from '@/components/profile-media-feed';
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
  feedState.callbacksFor = null;
  feedState.cards.clear();
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

    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      url: expect.stringContaining('/showcase/post-1'),
    }));
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
