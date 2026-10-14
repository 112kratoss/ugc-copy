// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api-client';
import { UNBLOCK_CONFIRM_MESSAGE } from '@/lib/blocked-users-view-model';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type { NativeMenuAction, NativeMenuModel } from '@/lib/native-menu';
import type { CreatorProfileResponse, ShowcaseFeedItem, ShowcaseFeedResponse } from '@/lib/types';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true) },
  api: {
    getCreatorProfile: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    setCreatorFollowing: vi.fn(),
    reportUser: vi.fn(),
    shareCreatorProfile: vi.fn(),
    listBlockedUsers: vi.fn(),
  },
  user: { id: 'viewer-1' } as { id: string } | null,
  confirm: vi.fn(async (_request: { title: string; message: string; confirmLabel: string; destructive?: boolean }) => true),
  errorDialog: vi.fn(),
  announce: vi.fn(),
  haptic: { success: vi.fn(), error: vi.fn(), light: vi.fn(), select: vi.fn() },
  list: { stickyHeaderIndices: undefined as number[] | undefined },
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: {
    announceForAccessibility: mocks.announce,
    isReduceTransparencyEnabled: vi.fn(async () => false),
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios', Version: '18.0', select: (options: Record<string, unknown>) => options.ios ?? options.default },
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  Share: { share: vi.fn(), sharedAction: 'sharedAction' },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return {
    ChevronRight: icon('chevron-right'),
    ExternalLink: icon('external-link'),
    FileText: icon('file-text'),
    Globe: icon('globe'),
    Heart: icon('heart'),
    ImageIcon: icon('image'),
    Layers3: icon('layers'),
    Lock: icon('lock'),
    MapPin: icon('map-pin'),
    MoreVertical: icon('more'),
    Pencil: icon('pencil'),
    Play: icon('play'),
    Repeat2: icon('repeat'),
    UserCheck: icon('user-check'),
    UserPlus: icon('user-plus'),
  };
});

// The list draws every row it is given, in order, and keeps what it was told
// to pin.
vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data: unknown[];
    keyExtractor: (item: unknown) => string;
    renderItem: (info: { item: unknown; index: number }) => React.ReactNode;
    ListFooterComponent?: React.ReactNode;
    stickyHeaderIndices?: number[];
  }) => {
    mocks.list.stickyHeaderIndices = props.stickyHeaderIndices;
    return React.createElement(
      'flash-list',
      null,
      props.data.map((item, index) => React.createElement(React.Fragment, { key: props.keyExtractor(item) }, props.renderItem({ item, index }))),
      props.ListFooterComponent ?? null,
    );
  },
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ Stack: { Screen: () => null }, router: mocks.router }));
vi.mock('expo-glass-effect', () => ({
  GlassView: ({ children }: MockProps) => React.createElement('glass-view', null, children),
  isGlassEffectAPIAvailable: () => false,
  isLiquidGlassAvailable: () => false,
}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: (props: MockProps) => React.createElement('linear-gradient', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));
vi.mock('@/components/native-menu', () => ({
  NativeMenu: (props: MockProps) => React.createElement('native-menu', props),
}));
vi.mock('@/components/showcase-media-preview', () => ({
  ShowcaseMediaPreview: (props: MockProps) => React.createElement('showcase-media-preview', props),
}));
vi.mock('@/components/feed-pagination-footer', () => ({
  FeedLoadMoreErrorFooter: (props: MockProps) => React.createElement('load-more-error', props),
}));
vi.mock('@/components/media-zoom', () => ({
  MediaZoomSourceView: ({ children }: MockProps) => React.createElement('zoom-source', null, children),
  MediaZoomSurface: ({ children }: MockProps) => React.createElement(React.Fragment, null, children),
  useMediaZoomSource: () => ({ capture: (open: (zoom: null) => void) => open(null), prepare: () => undefined }),
}));
vi.mock('@/components/zoom-veil', () => ({
  ZoomVeilScope: ({ children }: MockProps) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/skeleton', () => ({
  CreatorProfileSkeleton: () => React.createElement('creator-profile-skeleton'),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ api: mocks.api, user: mocks.user, identityUserId: mocks.user?.id ?? null }),
}));
vi.mock('@/lib/dialog', () => ({
  showConfirmDialog: mocks.confirm,
  showErrorDialog: mocks.errorDialog,
  showMessageDialog: vi.fn(),
}));
vi.mock('@/lib/haptics', () => ({ haptic: mocks.haptic }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.test' } }));
vi.mock('@/lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => false }));
vi.mock('@/lib/platform-glyphs', () => ({ BackGlyph: () => null, ShareGlyph: () => null }));
vi.mock('@/lib/safe-area', () => ({
  resolvedBottomInset: (inset: number) => inset,
  resolvedTopInset: (inset: number) => inset,
}));
vi.mock('@/lib/media-zoom-transition', () => ({
  mediaItemAspectRatio: () => 1,
  showcaseMediaZoomPreview: () => null,
}));
vi.mock('@/lib/immersive-preview-view-model', () => ({
  buildImmersiveShowcaseItems: () => [],
  showcaseFeedItemOpenHref: () => '/viewer',
}));
vi.mock('@/lib/viewer-actions', () => ({
  buildShareUrl: (siteUrl: string, path: string, source: string) => `${siteUrl}${path}?s=${source}`,
}));

import { CreatorProfileScreen } from '@/components/creator-profile-screen';

function post(id: string, creatorId = 'creator-1'): ShowcaseFeedItem {
  return {
    id,
    mediaUrl: null,
    mediaKind: null,
    model: 'manual',
    title: `Post ${id}`,
    prompt: 'Prompt',
    body: 'Body',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    creator: { id: creatorId, username: creatorId === 'creator-1' ? 'luna' : 'nova', name: 'Creator', avatar: null },
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

function creatorPage(overrides: Partial<CreatorProfileResponse> = {}): CreatorProfileResponse {
  return {
    profile: {
      id: 'creator-1',
      username: 'luna',
      displayName: 'Luna Studio',
      bio: null,
      avatarUrl: null,
      coverUrl: null,
      websiteUrl: null,
      twitterHandle: null,
      instagramHandle: null,
      tiktokHandle: null,
      location: null,
    },
    stats: { publicCreations: 2, totalSaves: 5, totalRemixes: 1, unlocks: 0, totalUnlockSales: 0, toolsUsed: [] },
    items: [post('post-1'), post('post-2')],
    pageInfo: { hasMore: false, nextLimit: null, nextOffset: null, limit: 24, offset: 0 },
    viewer: { isOwner: false, isFollowing: false, blockedByViewer: false },
    ...overrides,
  };
}

/** What the server answers for a creator the viewer blocked (WP2). */
const blockedPage = () => creatorPage({
  items: [],
  viewer: { isOwner: false, isFollowing: false, blockedByViewer: true },
});

const GRID_KEY = ['creator-profile', 'infinite', 'luna'] as const;

function newQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function screen(queryClient: QueryClient, wrap: (node: React.ReactElement) => React.ReactElement = (node) => node) {
  return (
    <QueryClientProvider client={queryClient}>
      {wrap(<CreatorProfileScreen username="luna" />)}
    </QueryClientProvider>
  );
}

async function renderScreen(queryClient: QueryClient) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(screen(queryClient));
  });
  await settle();
  return tree;
}

/** React Query tells its observers on a zero timer; a few turns let a fetch land and draw. */
async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const byType = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);
const texts = (tree: renderer.ReactTestRenderer) => byType(tree, 'text').map((node) => [node.props.children].flat().join(''));
const tileLabels = (tree: renderer.ReactTestRenderer) => byType(tree, 'pressable')
  .map((node) => String(node.props.accessibilityLabel ?? ''))
  .filter((label) => label.startsWith('Open Post'));
const menuIds = (tree: renderer.ReactTestRenderer) => (byType(tree, 'native-menu')[0].props.model as NativeMenuModel)
  .sections.flatMap((section) => section.items.map((item) => item.id));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { id: 'viewer-1' };
  mocks.list.stickyHeaderIndices = undefined;
  mocks.confirm.mockResolvedValue(true);
  mocks.api.unblockUser.mockResolvedValue({ success: true, blocked: false });
  mocks.api.blockUser.mockResolvedValue({ success: true, blocked: true });
  mocks.api.setCreatorFollowing.mockResolvedValue({ following: true });
});

// Decision "blocked pairs on the creator page" (audit 02-1): the person who
// blocked a creator read "Creator not found" and had no way back from the page.
describe('the page of a creator the viewer blocked', () => {
  it('says so and offers Unblock, without their work or a Follow', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(blockedPage());
    const tree = await renderScreen(newQueryClient());

    // The web's panel says the same (`BlockedCreatorPanel.tsx`).
    expect(byType(tree, 'status-block').map((node) => [node.props.title, node.props.body])).toEqual([[
      'You blocked @luna',
      "You won't see their posts, and neither of you can follow the other.",
    ]]);
    expect(byType(tree, 'primary-button').map((node) => node.props.label)).toEqual(['Unblock']);
    // Who they are stays; their posts, the tabs over them and Follow do not.
    expect(texts(tree)).toContain('Luna Studio');
    expect(tileLabels(tree)).toEqual([]);
    expect(texts(tree)).not.toContain('Posts 2');
    expect(texts(tree)).not.toContain('Follow');
    expect(mocks.list.stickyHeaderIndices).toBeUndefined();
    // Blocking again would do nothing; reporting them still matters.
    expect(menuIds(tree)).toEqual(['report-user']);
  });

  it('unblocks after asking, then reads the page again so their work comes back', async () => {
    let answerUnblock!: () => void;
    mocks.api.unblockUser.mockImplementation(() => new Promise((resolve) => {
      answerUnblock = () => resolve({ success: true, blocked: false });
    }));
    mocks.api.getCreatorProfile.mockResolvedValueOnce(blockedPage()).mockResolvedValue(creatorPage());
    const queryClient = newQueryClient();
    const blockedUser = (id: string) => ({ id, username: id, name: id, avatar: null, blockedAt: '2026-10-10T12:00:00.000Z' });
    queryClient.setQueryData(['blocked-users', 'viewer-1'], {
      success: true,
      blockedUsers: [blockedUser('creator-1'), blockedUser('creator-9')],
      hasMore: false,
    });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const tree = await renderScreen(queryClient);

    await act(async () => {
      (byType(tree, 'primary-button')[0].props.onPress as () => void)();
    });
    expect(mocks.confirm).toHaveBeenCalledWith({
      title: 'Unblock @luna?',
      message: UNBLOCK_CONFIRM_MESSAGE,
      confirmLabel: 'Unblock',
    });
    expect(mocks.api.unblockUser).toHaveBeenCalledWith('creator-1');
    // The wait is narrated on the button, not left as a tap that did nothing.
    expect(byType(tree, 'primary-button')[0].props).toMatchObject({ loading: true, loadingLabel: 'Unblocking…' });

    await act(async () => answerUnblock());
    await settle();

    expect(mocks.api.getCreatorProfile).toHaveBeenCalledTimes(2);
    expect(mocks.api.getCreatorProfile).toHaveBeenLastCalledWith('luna', { limit: 24, offset: 0 });
    expect(byType(tree, 'status-block')).toEqual([]);
    expect(tileLabels(tree)).toEqual(['Open Post post-1', 'Open Post post-2']);
    expect(texts(tree)).toContain('Follow');
    expect(menuIds(tree)).toEqual(['report-user', 'block-user']);
    expect(mocks.haptic.success).toHaveBeenCalledTimes(1);
    expect(mocks.announce).toHaveBeenCalledWith('@luna unblocked.');
    // Settings → Blocked users opens without them.
    expect(queryClient.getQueryData<{ blockedUsers: Array<{ id: string }> }>(['blocked-users', 'viewer-1'])?.blockedUsers
      .map((blocked) => blocked.id)).toEqual(['creator-9']);
    // The lanes are marked stale, not read again (that re-ranks them).
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['showcase-feed'], refetchType: 'none' });
    expect(invalidate.mock.calls.filter(([filters]) => (filters?.queryKey as unknown[] | undefined)?.[0] === 'showcase-feed'))
      .toEqual([[{ queryKey: ['showcase-feed'], refetchType: 'none' }]]);
  });

  it('stays blocked, and says so, when the unblock is refused', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(blockedPage());
    const refusal = new ApiError('Could not unblock.', 500);
    mocks.api.unblockUser.mockRejectedValue(refusal);
    const tree = await renderScreen(newQueryClient());

    await act(async () => {
      (byType(tree, 'primary-button')[0].props.onPress as () => void)();
    });
    await settle();

    expect(mocks.errorDialog).toHaveBeenCalledWith('Could not unblock', refusal);
    expect(mocks.haptic.error).toHaveBeenCalledTimes(1);
    expect(byType(tree, 'status-block').map((node) => node.props.title)).toEqual(['You blocked @luna']);
    expect(byType(tree, 'primary-button')[0].props.loading).toBe(false);
    expect(mocks.api.getCreatorProfile).toHaveBeenCalledTimes(1);
  });

  it('asks nothing when the reader keeps the block', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(blockedPage());
    mocks.confirm.mockResolvedValue(false);
    const tree = await renderScreen(newQueryClient());

    await act(async () => {
      (byType(tree, 'primary-button')[0].props.onPress as () => void)();
    });

    expect(mocks.api.unblockUser).not.toHaveBeenCalled();
    expect(byType(tree, 'primary-button')[0].props.loading).toBe(false);
  });

  // Fast Refresh, or an <Activity> shown again, runs every effect once more over kept state.
  it('keeps the panel, and reads nothing again, after every effect runs again', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(blockedPage());
    const queryClient = newQueryClient();
    const inActivity = (mode: 'visible' | 'hidden') => screen(
      queryClient,
      (node) => <React.Activity mode={mode}>{node}</React.Activity>,
    );
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(inActivity('visible'));
    });
    await settle();

    await act(async () => { tree.update(inActivity('hidden')); });
    expect(tree.toJSON()).toBeNull();
    await act(async () => { tree.update(inActivity('visible')); });
    await settle();

    expect(byType(tree, 'status-block').map((node) => node.props.title)).toEqual(['You blocked @luna']);
    expect(mocks.api.getCreatorProfile).toHaveBeenCalledTimes(1);
  });
});

describe('a page that cannot be drawn', () => {
  // The creator blocked the viewer, or the handle is gone: the same answer.
  it('keeps "Creator not found" for a 404, with Explore as the way on', async () => {
    mocks.api.getCreatorProfile.mockRejectedValue(new ApiError('Creator not found.', 404));
    const tree = await renderScreen(newQueryClient());

    expect(byType(tree, 'status-block').map((node) => node.props.title)).toEqual(['Creator not found']);
    expect(byType(tree, 'secondary-button').map((node) => node.props.label)).toEqual(['Go to Explore']);
  });

  it('asks the reader to wait out a rate limit instead of checking their connection', async () => {
    mocks.api.getCreatorProfile.mockRejectedValue(new ApiError('Too many requests.', 429, { retryAfterSeconds: 30 }));
    const tree = await renderScreen(newQueryClient());

    expect(byType(tree, 'status-block').map((node) => node.props)).toEqual([expect.objectContaining({
      tone: 'danger',
      title: 'Could not load creator',
      body: 'Too many requests in a short time. Try again in 30 seconds.',
    })]);
    expect(byType(tree, 'secondary-button').map((node) => node.props.label)).toEqual(['Try again']);
  });
});

describe('blocking from the page', () => {
  function laneWith(items: ShowcaseFeedItem[]): InfiniteData<ShowcaseFeedResponse> {
    return {
      pages: [{ items, pageInfo: { hasMore: false, nextOffset: null, limit: 12, offset: 0 } } as unknown as ShowcaseFeedResponse],
      pageParams: [{ offset: 0 }],
    };
  }

  // Audit 02-4: the page waited for every feed lane to refetch before it
  // moved, with nothing on screen to say the block had landed.
  it('moves to Explore before any cache is read again, with the creator already out of the lanes', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(creatorPage());
    const queryClient = newQueryClient();
    const laneKey = ['showcase-feed', 'infinite', 'viewer-1', { category: 'all', sort: 'for-you' }];
    queryClient.setQueryData(laneKey, laneWith([post('post-1'), post('other-1', 'creator-2')]));
    const sourceKey = ['immersive-preview-source', 'showcase-feed', 'viewer-1', 'other-1'];
    queryClient.setQueryData<ImmersiveSourceData>(sourceKey, { showcaseItems: [post('post-1'), post('other-1', 'creator-2')] });
    const untouchedSourceKey = ['immersive-preview-source', 'showcase-feed', 'viewer-1', 'other-2'];
    const untouchedSource: ImmersiveSourceData = { showcaseItems: [post('other-2', 'creator-2')] };
    queryClient.setQueryData(untouchedSourceKey, untouchedSource);
    // No invalidation ever settles: a page that waited on one would never move.
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockImplementation(() => new Promise<void>(() => undefined));
    const tree = await renderScreen(queryClient);

    const blockAction = (byType(tree, 'native-menu')[0].props.model as NativeMenuModel).sections[0].items
      .find((item) => item.id === 'block-user') as NativeMenuAction;
    await act(async () => {
      blockAction.onSelect();
    });
    await settle();

    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ title: 'Block @luna?', confirmLabel: 'Block user' }));
    expect(mocks.api.blockUser).toHaveBeenCalledWith('creator-1');
    expect(mocks.router.replace).toHaveBeenCalledWith('/(tabs)/showcase');
    expect(mocks.haptic.success).toHaveBeenCalledTimes(1);
    expect(mocks.announce).toHaveBeenCalledWith('@luna blocked.');
    // Navigation came before any invalidation was even asked for, and only the
    // Saved list and its count are read again, behind the move.
    expect(mocks.router.replace.mock.invocationCallOrder[0]).toBeLessThan(invalidate.mock.invocationCallOrder[0]);
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      ['profile-saved-media', 'viewer-1'],
      ['profile', 'viewer-1'],
    ]);
    // The lanes and the reel sources lose the creator's posts without a read.
    const lane = queryClient.getQueryData<InfiniteData<ShowcaseFeedResponse>>(laneKey);
    expect(lane?.pages.flatMap((lanePage) => lanePage.items.map((item) => item.id))).toEqual(['other-1']);
    expect(queryClient.getQueryData<ImmersiveSourceData>(sourceKey)?.showcaseItems?.map((item) => item.id)).toEqual(['other-1']);
    expect(queryClient.getQueryData(untouchedSourceKey)).toBe(untouchedSource);
    // The grid holds what the server now answers for them, and no Follow.
    const grid = queryClient.getQueryData<InfiniteData<CreatorProfileResponse>>(GRID_KEY);
    expect(grid?.pages).toHaveLength(1);
    expect(grid?.pages[0]).toMatchObject({ items: [], viewer: { blockedByViewer: true, isFollowing: false } });
    expect(queryClient.getQueryData(['creator-follow-state', 'creator-1'])).toEqual({ following: false });
    expect(mocks.api.getCreatorProfile).toHaveBeenCalledTimes(1);
  });

  it('stays on the page and says why when the block is refused', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(creatorPage());
    const refusal = new ApiError('Could not block.', 500);
    mocks.api.blockUser.mockRejectedValue(refusal);
    const tree = await renderScreen(newQueryClient());

    const blockAction = (byType(tree, 'native-menu')[0].props.model as NativeMenuModel).sections[0].items
      .find((item) => item.id === 'block-user') as NativeMenuAction;
    await act(async () => {
      blockAction.onSelect();
    });
    await settle();

    expect(mocks.errorDialog).toHaveBeenCalledWith('Could not block user', refusal);
    expect(mocks.router.replace).not.toHaveBeenCalled();
    expect(tileLabels(tree)).toEqual(['Open Post post-1', 'Open Post post-2']);
  });
});

describe('the header', () => {
  // Decision D10: the same stat labels on both clients.
  it('labels the counts Posts, Saves, Remixes and Recipes', async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(creatorPage());
    const tree = await renderScreen(newQueryClient());

    expect(texts(tree).filter((text) => ['Posts', 'Saves', 'Saves received', 'Remixes', 'Recipes'].includes(text)))
      .toEqual(['Posts', 'Saves', 'Remixes', 'Recipes']);
    expect(texts(tree)).toContain('Posts 2');
  });

  // The reel keeps its own answer for a creator (`useCreatorFollow`), for five
  // minutes; a Follow pressed here must not leave it saying otherwise.
  it("hands a Follow pressed here to the reel's own record of it", async () => {
    mocks.api.getCreatorProfile.mockResolvedValue(creatorPage());
    const queryClient = newQueryClient();
    queryClient.setQueryData(['creator-follow-state', 'creator-1'], { following: false });
    const tree = await renderScreen(queryClient);

    // The one control that reports itself busy while its answer is out.
    const follow = byType(tree, 'pressable').find((node) => node.props.accessibilityState && 'busy' in node.props.accessibilityState);
    await act(async () => {
      (follow!.props.onPress as () => void)();
    });
    await settle();

    expect(mocks.api.setCreatorFollowing).toHaveBeenCalledWith('creator-1', true);
    expect(queryClient.getQueryData(['creator-follow-state', 'creator-1'])).toEqual({ following: true });
  });
});
