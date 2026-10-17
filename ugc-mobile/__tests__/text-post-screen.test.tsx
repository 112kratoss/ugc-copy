// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import { Share } from 'react-native';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api-client';
import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';
import type { ViewerActionCallbacks } from '@/lib/use-viewer-action-handlers';
import { getViewerSafetyActions } from '@/lib/viewer-actions';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type QueryResult = { data: unknown; isError: boolean; error: unknown; refetch: () => unknown };

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' },
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: vi.fn(() => true), setParams: vi.fn() },
  params: { id: 'post-1' } as Record<string, string | undefined>,
  auth: {
    api: {
      getShowcasePost: vi.fn(),
      getOwnerPost: vi.fn(),
      getProfile: vi.fn(),
      shareShowcasePost: vi.fn(),
      recordShareVisit: vi.fn(),
      resolveShowcasePost: vi.fn(),
    },
    user: { id: 'viewer-1' } as { id: string } | null,
  },
  showcasePost: { data: undefined, isError: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
  // The legacy-id resolver's read (`api.resolveShowcasePost`).
  resolvedPost: { data: undefined, isError: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  },
  queryOptions: [] as Array<{ queryKey: readonly unknown[]; enabled?: boolean; queryFn?: () => unknown }>,
  saveOptions: { current: null as { sourceSurface?: string; authReturnTo?: string } | null },
  callbacksFor: { current: null as ((item: ImmersivePreviewItem) => ViewerActionCallbacks) | null },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('activity-indicator', props),
  FlatList: React.forwardRef(function FlatList(
    { data, renderItem, keyExtractor }: {
      data: string[];
      renderItem: (info: { item: string; index: number }) => React.ReactNode;
      keyExtractor: (item: string) => string;
    },
    _ref: React.ForwardedRef<unknown>
  ) {
    return React.createElement(
      'flat-list',
      null,
      data.map((page, index) => React.createElement(React.Fragment, { key: keyExtractor(page) }, renderItem({ item: page, index })))
    );
  }),
  Platform: mocks.platform,
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  Share: { share: vi.fn(), sharedAction: 'sharedAction' },
  StatusBar: { currentHeight: 0 },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(`${name}-icon`, props);
  return {
    ArrowLeft: icon('arrow-left'),
    ChevronLeft: icon('chevron-left'),
    FileText: icon('file'),
    Heart: icon('heart'),
    MessageCircle: icon('message'),
    MoreVertical: icon('more'),
    Repeat2: icon('repeat'),
    Share: icon('share'),
    Share2: icon('share'),
    X: icon('x'),
  };
});

vi.mock('expo-router', () => ({
  Redirect: (props: MockProps) => React.createElement('redirect', props),
  router: mocks.router,
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mocks.params,
}));

vi.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: readonly unknown[]; enabled?: boolean; queryFn?: () => unknown }): QueryResult => {
    mocks.queryOptions.push(options);
    return options.queryKey[0] === 'showcase-post'
      ? mocks.showcasePost
      : options.queryKey[0] === 'showcase-post-resolve'
        ? mocks.resolvedPost
        : { data: undefined, isError: false, error: null, refetch: vi.fn() };
  },
  useQueryClient: () => ({}),
}));

vi.mock('@/lib/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/env', () => ({ env: { siteUrl: 'https://magicbooklet.test' } }));
vi.mock('@/lib/immersive-preview-source-data', () => ({
  readCachedImmersiveSourceData: () => undefined,
  readCachedProfile: () => undefined,
}));
vi.mock('@/lib/use-hardware-back', () => ({ useHardwareBack: () => undefined }));
vi.mock('@/lib/use-showcase-save-mutation', () => ({
  useShowcaseSaveMutation: (options: { sourceSurface?: string; authReturnTo?: string }) => {
    mocks.saveOptions.current = options;
    return { toggleSave: vi.fn(), isSaving: false };
  },
}));

vi.mock('@/components/comments-sheet', () => ({
  PostComments: React.forwardRef(function PostComments(
    { contentHeader, ...props }: MockProps & { contentHeader?: React.ReactNode },
    _ref: React.ForwardedRef<unknown>
  ) {
    return React.createElement('post-comments', props, contentHeader);
  }),
}));
vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('avatar', props),
}));
vi.mock('@/components/feed-card-shell', () => ({
  FeedCardAction: ({ label, onPress }: { label: string; onPress: () => void }) =>
    React.createElement('feed-card-action', { label, onPress }),
}));
vi.mock('@/components/nsfw-post-notice', () => ({
  NsfwPostNotice: (props: MockProps) => React.createElement('nsfw-post-notice', props),
}));
vi.mock('@/components/post-details-page', () => ({
  PostDetailsPage: (props: MockProps) => React.createElement('post-details-page', props),
}));
vi.mock('@/components/viewer-action-sheet', () => ({
  ViewerActionSheet: (props: MockProps) => React.createElement('viewer-action-sheet', props),
}));
vi.mock('@/components/viewer-actions-menu', () => ({
  ViewerActionsMenuProvider: ({ callbacksFor, children }: {
    callbacksFor: (item: ImmersivePreviewItem) => ViewerActionCallbacks;
    children: React.ReactNode;
  }) => {
    mocks.callbacksFor.current = callbacksFor;
    return children;
  },
  ViewerActionsMenu: ({ item, excludeActions, onFallbackPress, renderButton }: {
    item: ImmersivePreviewItem;
    excludeActions?: string[];
    onFallbackPress: () => void;
    renderButton: (onPress: () => void) => React.ReactNode;
  }) => React.createElement('viewer-actions-menu', { item, excludeActions }, renderButton(onFallbackPress)),
}));

import PostScreen from '../app/post/[id]';
import ShowcaseDetailScreen from '../app/showcase/[id]';

const NSFW_DESCRIPTION = 'This post is marked NSFW. Reveal it only if you are 18 or older and comfortable viewing mature content.';

/** A written post as the by-id read sends it. */
function textPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    title: 'Three hooks that keep working',
    prompt: '',
    body: 'Open with tension.',
    category: 'text',
    postFormat: 'text',
    mediaKind: null,
    mediaUrl: null,
    mediaItems: [],
    generationId: null,
    asset: null,
    canRemix: false,
    creator: { id: 'creator-1', username: 'maya', name: 'Maya', avatar: null },
    createdAt: '2026-10-12T09:00:00.000Z',
    saveCount: 2,
    remixCount: 0,
    commentCount: 3,
    isSaved: false,
    visibility: 'public',
    sourceTool: 'Magicbooklet',
    ...overrides,
  };
}

/** The same post as the server covers it for a viewer who has not revealed it. */
function coveredPost() {
  return textPost({
    title: 'Mature content',
    body: NSFW_DESCRIPTION,
    isNsfw: true,
    nsfwRevealed: false,
    remixCapability: 'none',
    remixTarget: null,
  });
}

function showPost(post: Record<string, unknown>) {
  mocks.showcasePost = { data: { success: true, item: post }, isError: false, error: null, refetch: vi.fn() };
}

function failPost(error: unknown) {
  mocks.showcasePost = { data: undefined, isError: true, error, refetch: vi.fn() };
}

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(PostScreen));
  });
  return tree;
}

/** What the resolver answers: the post an id names, or nothing (its 404). */
function resolveTo(postId: string | null) {
  mocks.resolvedPost = postId
    ? { data: { success: true, postId }, isError: false, error: null, refetch: vi.fn() }
    : { data: undefined, isError: true, error: new ApiError('Post not found.', 404), refetch: vi.fn() };
}

/** The options of the latest render's resolver read. */
function resolverQuery() {
  return mocks.queryOptions.filter((options) => options.queryKey[0] === 'showcase-post-resolve').at(-1);
}

function byType(tree: renderer.ReactTestRenderer, type: string) {
  return tree.root.findAll((node) => String(node.type) === type);
}

function pressable(tree: renderer.ReactTestRenderer, label: string) {
  return byType(tree, 'pressable').find((node) => node.props.accessibilityLabel === label);
}

function textValues(tree: renderer.ReactTestRenderer) {
  return byType(tree, 'text').flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []));
}

function actionLabels(tree: renderer.ReactTestRenderer) {
  return byType(tree, 'feed-card-action').map((node) => node.props.label as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = 'ios';
  mocks.params = { id: 'post-1' };
  mocks.auth.user = { id: 'viewer-1' };
  mocks.auth.api.recordShareVisit.mockResolvedValue({ success: true });
  mocks.saveOptions.current = null;
  mocks.callbacksFor.current = null;
  mocks.queryOptions = [];
  showPost(textPost());
  // The resolver finds nothing unless a test says otherwise.
  resolveTo(null);
});

describe('a covered NSFW post', () => {
  it('keeps the byline and the actions menu, with the notice where the post would be', () => {
    showPost(coveredPost());
    const tree = renderScreen();

    expect(pressable(tree, 'Open @maya')).toBeDefined();
    expect(pressable(tree, 'More options for Mature content')).toBeDefined();
    expect(byType(tree, 'viewer-actions-menu')).toHaveLength(1);

    const notice = byType(tree, 'nsfw-post-notice');
    expect(notice).toHaveLength(1);
    expect(notice[0]!.props.postId).toBe('post-1');
    expect(notice[0]!.props.width).toBe(360);
    // The notice says what the post is; the page does not print the cover too.
    expect(textValues(tree)).not.toContain(NSFW_DESCRIPTION);
    expect(textValues(tree)).not.toContain('Mature content');
  });

  it('keeps save and share, and holds the thread back until the post is revealed', () => {
    showPost(coveredPost());
    const tree = renderScreen();

    const comments = () => byType(tree, 'post-comments')[0]!;
    expect(comments().props.enabled).toBe(false);
    expect(comments().props.unavailableMessage).toBe('Comments appear once you reveal this post.');
    // Save and Share; no Comment for a thread it cannot open, no Details.
    expect(actionLabels(tree)).toEqual(['2', 'Share']);
    expect(byType(tree, 'viewer-actions-menu')[0]!.props.excludeActions).toEqual(['view-details', 'comment']);
    expect(byType(tree, 'post-details-page')).toHaveLength(0);

    const notice = byType(tree, 'nsfw-post-notice')[0]!;
    renderer.act(() => { (notice.props.onRevealedChange as (revealed: boolean) => void)(true); });

    expect(comments().props.enabled).toBe(true);
    expect(comments().props.unavailableMessage).toBeNull();
    expect(actionLabels(tree)).toEqual(['2', '3', 'Share']);
    expect(byType(tree, 'viewer-actions-menu')[0]!.props.excludeActions).toEqual(['view-details']);

    // Hidden again (Hide, the ten-minute expiry, the app leaving the
    // foreground): the thread goes with the post.
    renderer.act(() => { (notice.props.onRevealedChange as (revealed: boolean) => void)(false); });
    expect(comments().props.enabled).toBe(false);
  });

  it('says the thread stays covered where the app cannot reveal the post', () => {
    mocks.platform.OS = 'android';
    showPost(coveredPost());
    const tree = renderScreen();

    expect(byType(tree, 'post-comments')[0]!.props.enabled).toBe(false);
    expect(byType(tree, 'post-comments')[0]!.props.unavailableMessage).toBe('Comments stay hidden on mature posts in this app.');
  });

  it('builds its menu from the cover, so Report and Block are on it', () => {
    showPost(coveredPost());
    const tree = renderScreen();

    const item = byType(tree, 'viewer-actions-menu')[0]!.props.item as ImmersivePreviewItem;
    expect(item.isNsfw).toBe(true);
    // The rows the menu adds for this item (`useViewerActionHandlers`).
    expect(getViewerSafetyActions(item, 'viewer-1')).toEqual(['report-content', 'report-user', 'block-user']);
    expect(item.availableActions).toEqual(expect.arrayContaining(['save', 'share']));
  });
});

describe('a written post', () => {
  it('prints the post itself and offers its details page', () => {
    const tree = renderScreen();

    expect(byType(tree, 'nsfw-post-notice')).toHaveLength(0);
    expect(textValues(tree)).toContain('Three hooks that keep working');
    expect(byType(tree, 'post-comments')[0]!.props.enabled).toBe(true);
    expect(byType(tree, 'post-details-page')).toHaveLength(1);
    expect(byType(tree, 'viewer-actions-menu')[0]!.props.excludeActions).toEqual([]);
  });

  it("gives the creator Edit post on their own post, wherever it was opened from", () => {
    mocks.auth.user = { id: 'creator-1' };
    const own = renderScreen();
    expect((byType(own, 'viewer-actions-menu')[0]!.props.item as ImmersivePreviewItem).availableActions).toContain('edit-post');

    mocks.auth.user = { id: 'viewer-1' };
    const someoneElses = renderScreen();
    expect((byType(someoneElses, 'viewer-actions-menu')[0]!.props.item as ImmersivePreviewItem).availableActions)
      .not.toContain('edit-post');
  });

  it('brings sign-in back to this post from save, the menu, the thread and Unlock', () => {
    const tree = renderScreen();
    const item = byType(tree, 'viewer-actions-menu')[0]!.props.item as ImmersivePreviewItem;

    expect(mocks.saveOptions.current).toEqual({ sourceSurface: 'mobile-post-page', authReturnTo: '/post/post-1' });
    expect(mocks.callbacksFor.current?.(item).authReturnTo).toBe('/post/post-1');
    expect(byType(tree, 'post-comments')[0]!.props.authReturnTo).toBe('/post/post-1');
    expect(byType(tree, 'post-details-page')[0]!.props.authReturnTo).toBe('/post/post-1');
  });

  it('keeps the way the post was opened in that return path', () => {
    mocks.params = { id: 'post-1', source: 'profile-saved' };
    renderScreen();

    expect(mocks.saveOptions.current?.authReturnTo).toBe('/post/post-1?source=profile-saved');
  });

  it('names this page in the link it shares, as the click it records does', async () => {
    // Opened from Saved, the link used to say my-creations while the click said detail-page.
    vi.mocked(Share.share).mockResolvedValue({ action: Share.sharedAction });
    mocks.auth.api.shareShowcasePost.mockResolvedValue({ success: true });
    mocks.params = { id: 'post-1', source: 'profile-saved' };
    const tree = renderScreen();

    const share = byType(tree, 'feed-card-action').find((node) => node.props.label === 'Share')!;
    await renderer.act(async () => { (share.props.onPress as () => void)(); });

    await vi.waitFor(() => expect(mocks.auth.api.shareShowcasePost).toHaveBeenCalledWith('post-1', { sourceSurface: 'detail-page' }));
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://magicbooklet.test/showcase/post-1?s=detail-page',
    }));
  });
});

describe('a post that does not load', () => {
  it('says a missing post is gone, with nothing to retry', () => {
    failPost(new ApiError('Post not found.', 404));
    const tree = renderScreen();

    expect(textValues(tree)).toContain("This post isn't available");
    expect(textValues(tree)).toContain('It may have been deleted or made private.');
    expect(pressable(tree, 'Try again')).toBeUndefined();
    expect(pressable(tree, 'Go back')).toBeDefined();
  });

  it('offers a retry for every other failure', () => {
    failPost(new ApiError('Could not reach Magicbooklet.', 0));
    const tree = renderScreen();

    expect(textValues(tree)).toContain("Couldn't load this post");
    expect(textValues(tree)).not.toContain("This post isn't available");
    renderer.act(() => { pressable(tree, 'Try again')!.props.onPress(); });
    expect(mocks.showcasePost.refetch).toHaveBeenCalledTimes(1);
  });

  it('treats a rate limit as a failure to retry, not a missing post', () => {
    failPost(new ApiError('Too many requests.', 429));
    const tree = renderScreen();

    expect(textValues(tree)).toContain("Couldn't load this post");
    expect(pressable(tree, 'Try again')).toBeDefined();
  });
});

describe('a shared link', () => {
  // A shared URL carries `?s=<surface>`; in-app links never do, so its
  // presence is what makes an open a share visit, as on the web post page.
  it('records one share visit for the post it opened, with the surface the link carried', () => {
    mocks.params = { id: 'post-1', s: 'feed' };
    const tree = renderScreen();
    renderer.act(() => { tree.update(React.createElement(PostScreen)); });

    expect(mocks.auth.api.recordShareVisit).toHaveBeenCalledTimes(1);
    expect(mocks.auth.api.recordShareVisit).toHaveBeenCalledWith('post-1', 'feed');
  });

  it('sends a surface it does not know as the link carried it', () => {
    mocks.params = { id: 'post-1', s: 'a-surface-from-a-newer-app' };
    renderScreen();

    expect(mocks.auth.api.recordShareVisit).toHaveBeenCalledWith('post-1', 'a-surface-from-a-newer-app');
  });

  it('records the visit for a media post too, before handing it to the reel', () => {
    mocks.params = { id: 'post-2', s: 'showcase-reel' };
    showPost(textPost({
      id: 'post-2',
      postFormat: 'media',
      category: 'image',
      mediaKind: 'image',
      mediaUrl: 'https://cdn.example.test/post-2.webp',
    }));
    const tree = renderScreen();

    expect(byType(tree, 'redirect')).toHaveLength(1);
    expect(mocks.auth.api.recordShareVisit).toHaveBeenCalledWith('post-2', 'showcase-reel');
  });

  it('keeps the page as it is when the visit is refused', async () => {
    mocks.auth.api.recordShareVisit.mockRejectedValue(new ApiError('Only public creations can be shared', 404));
    mocks.params = { id: 'post-1', s: 'feed' };
    const tree = renderScreen();
    await renderer.act(async () => { await Promise.resolve(); });

    expect(textValues(tree)).toContain('Three hooks that keep working');
  });

  it('records nothing for an in-app open, a post that is not public, or the owner list', () => {
    renderScreen();
    expect(mocks.auth.api.recordShareVisit).not.toHaveBeenCalled();

    mocks.params = { id: 'post-1', s: 'feed' };
    showPost(textPost({ visibility: 'unlisted' }));
    renderScreen();
    expect(mocks.auth.api.recordShareVisit).not.toHaveBeenCalled();

    mocks.params = { id: 'post-1', s: 'feed', source: 'profile-posts' };
    showPost(textPost());
    renderScreen();
    expect(mocks.auth.api.recordShareVisit).not.toHaveBeenCalled();
  });

  it('is passed on by the showcase link the app opens', () => {
    mocks.params = { id: 'post-1', s: 'feed' };
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(React.createElement(ShowcaseDetailScreen)); });
    expect(byType(tree, 'redirect')[0]!.props.href).toBe('/post/post-1?s=feed');

    mocks.params = { id: 'post-1' };
    renderer.act(() => { tree = renderer.create(React.createElement(ShowcaseDetailScreen)); });
    expect(byType(tree, 'redirect')[0]!.props.href).toBe('/post/post-1');
  });
});

describe('an old link', () => {
  // Old links name a generation; the web's post page has always followed one
  // to its post (src/lib/public-posts.ts), and the app asks the same resolver.
  it('follows a generation id to its post, keeping the link\'s params', () => {
    mocks.params = { id: 'generation-1', s: 'feed' };
    failPost(new ApiError('Post not found.', 404));
    resolveTo('post-9');
    const tree = renderScreen();

    expect(mocks.router.replace).toHaveBeenCalledTimes(1);
    expect(mocks.router.replace).toHaveBeenCalledWith({ pathname: '/post/[id]', params: { id: 'post-9', s: 'feed' } });
    expect(textValues(tree)).not.toContain("This post isn't available");
    expect(byType(tree, 'activity-indicator')).toHaveLength(1);
  });

  it('asks the resolver only once the by-id read has said 404', async () => {
    mocks.params = { id: 'generation-1' };
    renderScreen();
    expect(resolverQuery()?.enabled).toBe(false);

    failPost(new ApiError('Could not reach Magicbooklet.', 0));
    renderScreen();
    expect(resolverQuery()?.enabled).toBe(false);

    failPost(new ApiError('Post not found.', 404));
    mocks.resolvedPost = { data: undefined, isError: false, error: null, refetch: vi.fn() };
    const tree = renderScreen();
    expect(resolverQuery()?.enabled).toBe(true);
    // Not answered yet: the page waits rather than saying the post is gone.
    expect(textValues(tree)).not.toContain("This post isn't available");
    expect(byType(tree, 'activity-indicator')).toHaveLength(1);

    mocks.auth.api.resolveShowcasePost.mockResolvedValue({ success: true, postId: 'post-9' });
    await expect(resolverQuery()?.queryFn?.()).resolves.toEqual({ success: true, postId: 'post-9' });
    expect(mocks.auth.api.resolveShowcasePost).toHaveBeenCalledWith('generation-1');
  });

  it('says the post is gone when the resolver finds nothing, or names the same post', () => {
    mocks.params = { id: 'generation-1' };
    failPost(new ApiError('Post not found.', 404));
    const gone = renderScreen();
    expect(textValues(gone)).toContain("This post isn't available");

    // A post id answers with itself: the by-id read hid it (a block), so the
    // page is not opened again.
    mocks.params = { id: 'post-1' };
    resolveTo('post-1');
    const same = renderScreen();
    expect(textValues(same)).toContain("This post isn't available");
    expect(mocks.router.replace).not.toHaveBeenCalled();
  });

  it("never asks about a post opened from the owner's own list", () => {
    mocks.params = { id: 'post-1', source: 'profile-posts' };
    renderScreen();

    expect(resolverQuery()?.enabled).toBe(false);
  });
});
