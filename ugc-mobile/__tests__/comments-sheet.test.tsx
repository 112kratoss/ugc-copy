// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { requestAnimationFrame: (callback: FrameRequestCallback) => number })
  .requestAnimationFrame = (callback) => {
    callback(0);
    return 1;
  };

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CommentsSheet,
  PostComments,
  type PostCommentsHandle,
} from '../components/comments-sheet';
import { registerActionSheetPresenter, type ActionSheetRequest } from '../lib/action-sheet';
import { ApiError } from '../lib/api-client';
import type { PostComment, PostCommentsResponse } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const mocks = vi.hoisted(() => ({
  listPostComments: vi.fn(),
  createPostComment: vi.fn(),
  deletePostComment: vi.fn(),
  reportComment: vi.fn(),
  querySetData: vi.fn(),
  querySetQueriesData: vi.fn(),
  queryInvalidate: vi.fn(),
  topRefetch: vi.fn(),
  replyRefetch: vi.fn(),
  topFetchNext: vi.fn(),
  replyFetchNext: vi.fn(),
  alert: vi.fn(),
  composerFocus: vi.fn(),
  listScrollToOffset: vi.fn(),
  queryOptions: vi.fn(),
  routerPush: vi.fn(),
  routerSetParams: vi.fn(),
  blockUser: vi.fn(),
  announce: vi.fn(),
}));
const {
  listPostComments,
  createPostComment,
  deletePostComment,
  reportComment,
  querySetData,
  querySetQueriesData,
  queryInvalidate,
  topRefetch,
  replyRefetch,
  topFetchNext,
  replyFetchNext,
  alert,
  composerFocus,
  listScrollToOffset,
  queryOptions,
  routerPush,
  routerSetParams,
  blockUser,
  announce,
} = mocks;

let authUser: { id: string } | null = { id: 'viewer-1' };
let pages: PostCommentsResponse[] | undefined = [];
let replyPages: PostCommentsResponse[] | undefined = [];
let queryState: Record<string, unknown> = {};
let replyQueryState: Record<string, unknown> = {};

vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  ActivityIndicator: (props: MockProps) => React.createElement('spinner', props),
  Alert: { alert: mocks.alert },
  Animated: {
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
    Value: class {
      constructor(private value: number) {}
      setValue(next: number) { this.value = next; }
      interpolate() { return this.value; }
    },
    timing: () => ({ start: (done?: (r: { finished: boolean }) => void) => done?.({ finished: true }), stop: () => {} }),
    spring: () => ({ start: () => {}, stop: () => {} }),
    // The sheet composes its slide with the drag offset.
    add: (a: unknown, _b: unknown) => a,
  },
  Easing: { in: (fn: unknown) => fn, out: (fn: unknown) => fn, cubic: 'cubic' },
  // The sheet's grabber owns a swipe-to-dismiss responder; the double only
  // needs to hand back inert pan handlers so the tree renders.
  PanResponder: { create: () => ({ panHandlers: {} }) },
  FlatList: React.forwardRef(({
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListEmptyComponent,
    ListFooterComponent,
    ...props
  }: MockProps, ref: React.ForwardedRef<{ scrollToOffset: typeof mocks.listScrollToOffset }>) => {
    React.useImperativeHandle(ref, () => ({ scrollToOffset: mocks.listScrollToOffset }));
    const rows = (data as unknown[]) ?? [];
    const children: React.ReactNode[] = [];
    if (ListHeaderComponent) children.push(ListHeaderComponent as React.ReactNode);
    if (!rows.length) {
      children.push(ListEmptyComponent as React.ReactNode);
    } else {
      children.push(...rows.map((item, index) => React.createElement(
        React.Fragment,
        { key: (keyExtractor as (row: unknown, i: number) => string)(item, index) },
        (renderItem as (info: { item: unknown }) => React.ReactNode)({ item })
      )));
    }
    if (ListFooterComponent) children.push(ListFooterComponent as React.ReactNode);
    return React.createElement('list', props, children);
  }),
  KeyboardAvoidingView: ({ children, ...props }: MockProps) => React.createElement('kav', props, children),
  Platform: { OS: 'ios' },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  StatusBar: { currentHeight: 0 },
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: React.forwardRef((props: MockProps, ref: React.ForwardedRef<{ focus: typeof mocks.composerFocus }>) => {
    React.useImperativeHandle(ref, () => ({ focus: mocks.composerFocus }));
    return React.createElement('textinput', props);
  }),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('expo-router', () => ({
  router: { push: mocks.routerPush, setParams: mocks.routerSetParams },
}));
vi.mock('lucide-react-native', () => ({
  MoreHorizontal: (props: MockProps) => React.createElement('icon-more', props),
  SendHorizontal: (props: MockProps) => React.createElement('icon-send', props),
}));
vi.mock('@/components/ui', () => ({
  CreatorAvatar: (props: MockProps) => React.createElement('avatar', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    api: {
      blockUser: mocks.blockUser,
      createPostComment: mocks.createPostComment,
      deletePostComment: mocks.deletePostComment,
      listPostComments: mocks.listPostComments,
      reportComment: mocks.reportComment,
    },
    user: authUser,
  }),
}));
vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: (options: { queryKey: readonly unknown[] }) => {
    mocks.queryOptions(options);
    const isReplyQuery = options.queryKey[0] === 'post-comment-replies';
    return {
      data: (isReplyQuery ? replyPages : pages)
        ? { pages: isReplyQuery ? replyPages : pages, pageParams: [0] }
        : undefined,
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
      isRefetching: false,
      fetchNextPage: isReplyQuery ? mocks.replyFetchNext : mocks.topFetchNext,
      refetch: isReplyQuery ? mocks.replyRefetch : mocks.topRefetch,
      ...(isReplyQuery ? replyQueryState : queryState),
    };
  },
  useQueryClient: () => ({
    getQueryData: vi.fn(),
    setQueryData: mocks.querySetData,
    setQueriesData: mocks.querySetQueriesData,
    invalidateQueries: mocks.queryInvalidate,
  }),
}));

function comment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    id: 'comment-1',
    parentId: null,
    body: 'This prompt is unreal.',
    status: 'active',
    createdAt: '2026-07-27T10:00:00.000Z',
    replyCount: 0,
    author: { id: 'creator-2', username: 'batman', displayName: 'Batman', avatarUrl: null },
    ...overrides,
  };
}

function page(
  comments: PostComment[],
  commentCount = comments.length,
  pageInfo: PostCommentsResponse['pageInfo'] = {
    hasMore: false,
    nextOffset: null,
    limit: 20,
    offset: 0,
  }
): PostCommentsResponse {
  return {
    postId: 'post-1',
    postCreatorId: 'owner-1',
    commentCount,
    comments,
    pageInfo,
  };
}

function sheetElement(overrides: Partial<React.ComponentProps<typeof CommentsSheet>> = {}) {
  return (
    <CommentsSheet
      authReturnTo="/viewer?source=showcase-feed&initialId=post-1"
      postId="post-1"
      postCreatorId="owner-1"
      commentCount={0}
      visible
      onClose={vi.fn()}
      {...overrides}
    />
  );
}

function renderSheet(overrides: Partial<React.ComponentProps<typeof CommentsSheet>> = {}) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(sheetElement(overrides));
  });
  if (!tree) throw new Error('CommentsSheet failed to render');
  return tree;
}

function renderInline(overrides: Partial<React.ComponentProps<typeof PostComments>> = {}) {
  const ref = React.createRef<PostCommentsHandle>();
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(
      <PostComments
        ref={ref}
        authReturnTo="/post/post-1"
        postId="post-1"
        postCreatorId="owner-1"
        commentCount={0}
        contentHeader={<TextFixture value="Post content" />}
        enabled
        presentation="inline"
        {...overrides}
      />
    );
  });
  if (!tree) throw new Error('PostComments failed to render');
  return { ref, tree };
}

function TextFixture({ value }: { value: string }) {
  return React.createElement('text', null, value);
}

function texts(root: renderer.ReactTestInstance) {
  return root
    .findAll((node) => String(node.type) === 'text')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''));
}

function pressable(root: renderer.ReactTestInstance, label: string) {
  return root.find(
    (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label
  );
}

function pressables(root: renderer.ReactTestInstance, label: string) {
  return root.findAll(
    (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === label
  );
}

function composerInput(root: renderer.ReactTestInstance) {
  return root.find((node) => String(node.type) === 'textinput');
}

/** The rows a comment's ••• offers, as the action sheet a build without native menus shows. */
function commentOptions(root: renderer.ReactTestInstance, authorLabel: string) {
  const presented: ActionSheetRequest[] = [];
  const unregister = registerActionSheetPresenter((request) => presented.push(request));
  try {
    renderer.act(() => {
      pressable(root, `Options for ${authorLabel}'s comment`).props.onPress();
    });
  } finally {
    unregister();
  }
  return presented[0];
}

/** Presses a button on the dialog `showConfirmDialog` drew (the system alert on iOS). */
function pressDialogButton(title: string, buttonText: string) {
  const call = alert.mock.calls.find(([shownTitle]) => shownTitle === title);
  if (!call) throw new Error(`No dialog titled ${title}`);
  const button = (call[2] as Array<{ text: string; onPress?: () => void }>)
    .find((candidate) => candidate.text === buttonText);
  if (!button) throw new Error(`No ${buttonText} button on ${title}`);
  button.onPress?.();
}

function flushPromises() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function postFromComposer(root: renderer.ReactTestInstance, body: string) {
  renderer.act(() => {
    composerInput(root).props.onChangeText(body);
  });
  await renderer.act(async () => {
    await pressable(root, 'Post comment').props.onPress();
  });
}

beforeEach(() => {
  authUser = { id: 'viewer-1' };
  pages = [];
  replyPages = [];
  queryState = {};
  replyQueryState = {};
  for (const mock of [
    listPostComments,
    createPostComment,
    deletePostComment,
    reportComment,
    querySetData,
    querySetQueriesData,
    queryInvalidate,
    topRefetch,
    replyRefetch,
    topFetchNext,
    replyFetchNext,
    alert,
    composerFocus,
    listScrollToOffset,
    queryOptions,
    routerPush,
    routerSetParams,
    blockUser,
    announce,
  ]) {
    mock.mockReset();
  }
});

describe('inline post comments', () => {
  it('renders the post and first comment page in one list without a modal', () => {
    pages = [page([comment()])];
    const { tree } = renderInline();

    expect(texts(tree.root)).toEqual(expect.arrayContaining([
      'Post content',
      'Comments · 1',
      'This prompt is unreal.',
    ]));
    expect(tree.root.findAll((node) => String(node.type) === 'modal')).toHaveLength(0);
    expect(queryOptions).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it('scrolls to the attached thread and focuses its composer through the imperative API', () => {
    const { ref, tree } = renderInline();
    const commentsHeader = tree.root.find(
      (node) => String(node.type) === 'view' && typeof node.props.onLayout === 'function'
    );

    renderer.act(() => {
      commentsHeader.props.onLayout({ nativeEvent: { layout: { y: 420 } } });
    });

    renderer.act(() => {
      ref.current?.scrollToComments();
    });

    expect(listScrollToOffset).toHaveBeenCalledWith({ offset: 420, animated: true });
    expect(composerFocus).toHaveBeenCalledTimes(1);
  });

  it('shows the private-post note without querying or rendering a composer', () => {
    const { tree } = renderInline({
      enabled: false,
      unavailableMessage: 'Comments become available when this post is public.',
    });

    expect(texts(tree.root)).toContain('Comments become available when this post is public.');
    expect(tree.root.findAll((node) => String(node.type) === 'textinput')).toHaveLength(0);
    expect(queryOptions).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("opens a comment author's profile without closing anything first", () => {
    pages = [page([comment()])];
    const onClose = vi.fn();
    const { tree } = renderInline({ onClose });

    renderer.act(() => {
      pressable(tree.root, 'Open @batman profile').props.onPress();
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith('/creators/batman');
  });
});

describe('comments sheet', () => {
  it('shows the empty state when a post has no comments', () => {
    pages = [page([])];
    const root = renderSheet().root;
    expect(texts(root)).toContain('No comments yet');
    expect(root.find((node) => String(node.type) === 'textinput').props.placeholder)
      .toBe('Add a comment…');
  });

  it('renders the count and uses accessible 48pt comment actions', () => {
    pages = [page([comment()])];
    const root = renderSheet().root;

    expect(texts(root)).toEqual(expect.arrayContaining([
      'Comments · 1',
      '@batman',
      'This prompt is unreal.',
    ]));
    expect(pressable(root, 'Reply to @batman').props.style).toMatchObject({ minHeight: 48 });
    expect(pressable(root, "Options for @batman's comment").props.style)
      .toMatchObject({ width: 48, height: 48 });
  });

  it('renders a removed comment as [deleted] with no actions button', () => {
    pages = [page([comment({
      status: 'removed_by_author',
      body: '',
      author: null,
      replyCount: 1,
    })], 0)];

    const root = renderSheet().root;
    expect(texts(root)).toContain('[deleted]');
    expect(root.findAll((node) => String(node.type) === 'icon-more')).toHaveLength(0);
    // No author to open either.
    expect(root.findAll(
      (node) => String(node.type) === 'pressable' && typeof node.props.onPress === 'function'
        && (String(node.props.accessibilityLabel).startsWith('Open ') || node.props.accessibilityElementsHidden)
    )).toHaveLength(0);
  });

  it('paginates replies and never offers a nested reply action', () => {
    pages = [page([comment({ replyCount: 21 })], 22)];
    replyPages = [page([
      comment({
        id: 'reply-1',
        parentId: 'comment-1',
        author: { id: 'creator-3', username: 'robin', displayName: 'Robin', avatarUrl: null },
      }),
    ], 22, { hasMore: true, nextOffset: 20, limit: 20, offset: 0 })];
    replyQueryState = { hasNextPage: true };
    const tree = renderSheet();

    renderer.act(() => {
      pressable(tree.root, 'View 21 replies').props.onPress();
    });

    expect(texts(tree.root)).toContain('@robin');
    expect(tree.root.findAll(
      (node) => String(node.type) === 'pressable'
        && String(node.props.accessibilityLabel).startsWith('Reply to ')
    )).toHaveLength(1);

    renderer.act(() => {
      pressable(tree.root, 'Load more replies').props.onPress();
    });
    expect(replyFetchNext).toHaveBeenCalledTimes(1);
  });

  it('offers a real retry and disables posting while the initial load is broken', () => {
    pages = undefined;
    queryState = { isError: true };
    const tree = renderSheet();

    expect(tree.root.findAll((node) => String(node.type) === 'status-block')).toHaveLength(1);
    expect(tree.root.find((node) => String(node.type) === 'textinput').props.editable).toBe(false);
    renderer.act(() => {
      pressable(tree.root, 'Try loading comments again').props.onPress();
    });
    expect(topRefetch).toHaveBeenCalledTimes(1);
  });

  it('hides dead anonymous options and preserves post/reply context through auth', () => {
    authUser = null;
    pages = [page([comment()])];
    const onClose = vi.fn();
    const tree = renderSheet({ onClose });

    expect(tree.root.findAll((node) => String(node.type) === 'icon-more')).toHaveLength(0);
    renderer.act(() => {
      pressable(tree.root, 'Reply to @batman').props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/auth',
      params: {
        returnTo: '/viewer?source=showcase-feed&initialId=post-1&comments=post-1&replyTo=comment-1',
      },
    });
  });

  it('shows a successful reply immediately and writes it into an existing cache', async () => {
    const createdReply = comment({
      id: 'reply-created',
      parentId: 'comment-1',
      body: 'Fresh reply',
      author: { id: 'viewer-1', username: 'viewer', displayName: 'Viewer', avatarUrl: null },
    });
    pages = [page([comment()])];
    replyPages = [page([], 1)];
    createPostComment.mockResolvedValue({ comment: createdReply, commentCount: 2 });
    const tree = renderSheet();

    renderer.act(() => {
      pressable(tree.root, 'Reply to @batman').props.onPress();
    });
    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'textinput').props.onChangeText('Fresh reply');
    });
    await renderer.act(async () => {
      await pressable(tree.root, 'Post comment').props.onPress();
    });

    expect(createPostComment).toHaveBeenCalledWith('post-1', {
      body: 'Fresh reply',
      parentId: 'comment-1',
    });
    expect(texts(tree.root)).toContain('Fresh reply');

    const replyCacheCall = querySetData.mock.calls.find(
      ([key]) => Array.isArray(key) && key[0] === 'post-comment-replies'
    );
    expect(replyCacheCall).toBeDefined();
    const update = replyCacheCall?.[1] as (
      data: { pages: PostCommentsResponse[]; pageParams: number[] }
    ) => { pages: PostCommentsResponse[]; pageParams: number[] };
    const updated = update({ pages: [page([])], pageParams: [0] });
    expect(updated.pages[0].comments.map((item) => item.id)).toContain('reply-created');
  });

  // Feed ranking v4, §4: a comment written under a ranked card (Home's sheet,
  // the reel it opened, a text post opened from Home) names that delivery.
  it("credits a comment to the feed delivery it was written under", async () => {
    pages = [page([])];
    createPostComment.mockResolvedValue({
      comment: comment({ id: 'comment-created', body: 'Fresh thought' }),
      commentCount: 1,
    });
    const tree = renderSheet({ deliveryId: '9001' });

    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'textinput').props.onChangeText('Fresh thought');
    });
    await renderer.act(async () => {
      await pressable(tree.root, 'Post comment').props.onPress();
    });

    expect(createPostComment).toHaveBeenCalledWith('post-1', {
      body: 'Fresh thought',
      parentId: null,
      deliveryId: '9001',
    });
  });

  it('publishes updated counts to showcase, saved, owner, source, and detail caches', async () => {
    const onCommentCountChange = vi.fn();
    pages = [page([])];
    createPostComment.mockResolvedValue({
      comment: comment({
        id: 'comment-created',
        body: 'Fresh thought',
        author: { id: 'viewer-1', username: 'viewer', displayName: 'Viewer', avatarUrl: null },
      }),
      commentCount: 1,
    });
    const tree = renderSheet({ onCommentCountChange });

    renderer.act(() => {
      tree.root.find((node) => String(node.type) === 'textinput').props.onChangeText('Fresh thought');
    });
    await renderer.act(async () => {
      await pressable(tree.root, 'Post comment').props.onPress();
    });

    const synchronizedPrefixes = querySetQueriesData.mock.calls.map(
      ([filters]) => (filters as { queryKey: string[] }).queryKey[0]
    );
    expect(synchronizedPrefixes).toEqual(expect.arrayContaining([
      'showcase-feed',
      'profile-saved-media',
      'showcase-post',
      'immersive-preview-source',
      'profile-owner-posts',
      'owner-text-post',
    ]));
    expect(onCommentCountChange).toHaveBeenCalledWith(1);
  });

  it('resets draft and reply state when the sheet changes posts', () => {
    pages = [page([comment()])];
    const tree = renderSheet();
    renderer.act(() => {
      pressable(tree.root, 'Reply to @batman').props.onPress();
      tree.root.find((node) => String(node.type) === 'textinput').props.onChangeText('Post A draft');
    });
    expect(texts(tree.root)).toContain('Replying to @batman');

    renderer.act(() => {
      tree.update(
        <CommentsSheet
          authReturnTo="/viewer?source=showcase-feed&initialId=post-2"
          postId="post-2"
          postCreatorId="owner-2"
          commentCount={0}
          visible
          onClose={vi.fn()}
        />
      );
    });

    expect(tree.root.find((node) => String(node.type) === 'textinput').props.value).toBe('');
    expect(texts(tree.root)).not.toContain('Replying to @batman');
  });

  it('restores a reply target after returning from authentication', () => {
    pages = [page([comment()])];
    const tree = renderSheet({ initialReplyToId: 'comment-1' });

    expect(texts(tree.root)).toContain('Replying to @batman');
    expect(tree.root.find((node) => String(node.type) === 'textinput').props.placeholder)
      .toBe('Write a reply…');
  });

  it('asks for a report reason instead of hardcoding harassment', async () => {
    pages = [page([comment()])];
    reportComment.mockResolvedValue({ success: true });
    const presented: ActionSheetRequest[] = [];
    const unregister = registerActionSheetPresenter((request) => presented.push(request));
    const tree = renderSheet();

    try {
      renderer.act(() => {
        pressable(tree.root, "Options for @batman's comment").props.onPress();
      });
      // Both steps are action sheets now: the options list can hold four
      // entries where an alert caps at three, and the reason picker used to be
      // a second sheet drawn inside the first one.
      expect(presented[0].title).toBe('Comment options');
      renderer.act(() => {
        presented[0].actions.find((action) => action.label === 'Report')?.onPress?.();
      });

      expect(presented[1].title).toBe('Why are you reporting this?');
      // The web thread's labels, so a report reads the same from either client.
      expect(presented[1].actions.map((action) => action.label)).toEqual([
        'Spam',
        'Harassment',
        'Unsafe content',
        'Other',
      ]);
      await renderer.act(async () => {
        presented[1].actions.find((action) => action.label === 'Spam')?.onPress?.();
      });
    } finally {
      unregister();
    }

    expect(reportComment).toHaveBeenCalledWith('comment-1', { reason: 'spam' });
  });

  it('marks every comment option destructive so the sheet leads with them', () => {
    pages = [page([comment()])];
    const presented: ActionSheetRequest[] = [];
    const unregister = registerActionSheetPresenter((request) => presented.push(request));
    const tree = renderSheet();

    try {
      renderer.act(() => {
        pressable(tree.root, "Options for @batman's comment").props.onPress();
      });
    } finally {
      unregister();
    }

    expect(presented[0].actions.every((action) => action.destructive)).toBe(true);
  });

  it("opens a comment author's profile from the handle or the avatar, closing the sheet first", () => {
    pages = [page([comment()])];
    const onClose = vi.fn();
    const tree = renderSheet({ onClose });

    renderer.act(() => {
      pressable(tree.root, 'Open @batman profile').props.onPress();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith('/creators/batman');
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(routerPush.mock.invocationCallOrder[0]);

    // The avatar takes the same tap; the handle is the one a screen reader lists.
    const avatarTarget = tree.root.find(
      (node) => String(node.type) === 'pressable' && node.props.accessibilityElementsHidden === true
    );
    expect(avatarTarget.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(avatarTarget.findAll((node) => String(node.type) === 'avatar')).toHaveLength(1);
    renderer.act(() => {
      avatarTarget.props.onPress();
    });
    expect(routerPush).toHaveBeenCalledTimes(2);
    expect(routerPush).toHaveBeenLastCalledWith('/creators/batman');
  });

  it('opens the author of a reply too', () => {
    pages = [page([comment({ replyCount: 1 })], 2)];
    replyPages = [page([
      comment({
        id: 'reply-1',
        parentId: 'comment-1',
        author: { id: 'creator-3', username: 'robin', displayName: 'Robin', avatarUrl: null },
      }),
    ], 2)];
    const tree = renderSheet();

    renderer.act(() => {
      pressable(tree.root, 'View 1 reply').props.onPress();
    });
    renderer.act(() => {
      pressable(tree.root, 'Open @robin profile').props.onPress();
    });

    expect(routerPush).toHaveBeenCalledWith('/creators/robin');
  });

  it('blocks another author from the comment menu after a confirmation, then refreshes every cached thread', async () => {
    pages = [page([comment()])];
    blockUser.mockResolvedValue({ success: true, blocked: true });
    const tree = renderSheet();

    const options = commentOptions(tree.root, '@batman');
    expect(options.actions.map((action) => action.label)).toEqual(['Report', 'Block @batman']);
    renderer.act(() => {
      options.actions.find((action) => action.label === 'Block @batman')?.onPress?.();
    });

    expect(alert).toHaveBeenCalledWith(
      'Block @batman?',
      'Their posts and comments will be hidden, and neither of you will be able to follow the other.',
      expect.any(Array),
      expect.anything()
    );
    expect(blockUser).not.toHaveBeenCalled();

    await renderer.act(async () => {
      pressDialogButton('Block @batman?', 'Block user');
      await flushPromises();
    });

    expect(blockUser).toHaveBeenCalledWith('creator-2');
    expect(queryInvalidate).toHaveBeenCalledWith({ queryKey: ['post-comments'] });
    expect(queryInvalidate).toHaveBeenCalledWith({ queryKey: ['post-comment-replies'] });
    expect(announce).toHaveBeenCalledWith('@batman blocked.');
  });

  it('leaves every thread alone when the block fails', async () => {
    pages = [page([comment()])];
    blockUser.mockRejectedValue(new ApiError('Failed to block user.', 500));
    const tree = renderSheet();

    const options = commentOptions(tree.root, '@batman');
    renderer.act(() => {
      options.actions.find((action) => action.label === 'Block @batman')?.onPress?.();
    });
    await renderer.act(async () => {
      pressDialogButton('Block @batman?', 'Block user');
      await flushPromises();
    });

    expect(alert).toHaveBeenCalledWith('Could not block user', 'Failed to block user.');
    expect(queryInvalidate).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("offers no Block on the viewer's own comment or on the post creator's", () => {
    pages = [page([
      comment({
        id: 'mine',
        author: { id: 'viewer-1', username: 'viewer', displayName: 'Viewer', avatarUrl: null },
      }),
      comment({
        id: 'by-creator',
        author: { id: 'owner-1', username: 'owner', displayName: 'Owner', avatarUrl: null },
      }),
    ])];
    const tree = renderSheet();

    expect(commentOptions(tree.root, '@viewer').actions.map((action) => action.label)).toEqual(['Delete']);
    expect(commentOptions(tree.root, '@owner').actions.map((action) => action.label)).toEqual(['Report']);
  });

  it('keeps a just-posted comment on top when the refetched first page ranks it out', async () => {
    // Under Top a busy post's first page is all comments with replies; a new
    // one, with none yet, is not on it when the refetch after posting answers.
    const busyFirstPage = Array.from({ length: 20 }, (_, index) => comment({
      id: `popular-${index}`,
      body: `Popular ${index}`,
      replyCount: 20 - index,
    }));
    const mine = comment({
      id: 'mine',
      body: 'First time here',
      author: { id: 'viewer-1', username: 'viewer', displayName: 'Viewer', avatarUrl: null },
    });
    pages = [page(busyFirstPage, 40, { hasMore: true, nextOffset: 20, limit: 20, offset: 0 })];
    createPostComment.mockResolvedValue({ comment: mine, commentCount: 41 });
    const tree = renderSheet();

    await postFromComposer(tree.root, 'First time here');

    expect(topRefetch).toHaveBeenCalledTimes(1);
    const shown = texts(tree.root);
    expect(shown).toContain('First time here');
    expect(shown.indexOf('First time here')).toBeLessThan(shown.indexOf('Popular 0'));

    // Once a loaded page holds it, it is listed once, still on top.
    pages = [page([...busyFirstPage, mine], 41, { hasMore: true, nextOffset: 21, limit: 20, offset: 0 })];
    renderer.act(() => {
      tree.update(sheetElement());
    });
    const refreshed = texts(tree.root);
    expect(refreshed.filter((text) => text === 'First time here')).toHaveLength(1);
    expect(refreshed.indexOf('First time here')).toBeLessThan(refreshed.indexOf('Popular 0'));
  });

  it('says a comment with no replies will be removed, and drops it from the pinned list', async () => {
    const mine = comment({
      id: 'mine',
      body: 'Typo, sorry',
      author: { id: 'viewer-1', username: 'viewer', displayName: 'Viewer', avatarUrl: null },
    });
    pages = [page([comment({ replyCount: 3 })], 4)];
    createPostComment.mockResolvedValue({ comment: mine, commentCount: 5 });
    deletePostComment.mockResolvedValue({ status: 'removed_by_author', commentCount: 4 });
    const tree = renderSheet();

    await postFromComposer(tree.root, 'Typo, sorry');
    expect(texts(tree.root)).toContain('Typo, sorry');

    const options = commentOptions(tree.root, '@viewer');
    renderer.act(() => {
      options.actions.find((action) => action.label === 'Delete')?.onPress?.();
    });
    expect(alert).toHaveBeenCalledWith(
      'Delete your comment?',
      'It will be removed.',
      expect.any(Array),
      expect.anything()
    );

    await renderer.act(async () => {
      pressDialogButton('Delete your comment?', 'Delete');
      await flushPromises();
    });

    expect(deletePostComment).toHaveBeenCalledWith('post-1', 'mine');
    expect(texts(tree.root)).not.toContain('Typo, sorry');
    expect(texts(tree.root)).toContain('This prompt is unreal.');
  });

  it('says comments are closed on a 404, with nothing to retry and no composer', () => {
    pages = undefined;
    queryState = { isError: true, error: new ApiError('Post not found.', 404) };
    const tree = renderSheet();

    const status = tree.root.find((node) => String(node.type) === 'status-block');
    expect(status.props).toMatchObject({ tone: 'neutral', title: 'Comments are closed on this post' });
    expect(pressables(tree.root, 'Try loading comments again')).toHaveLength(0);
    expect(tree.root.findAll((node) => String(node.type) === 'textinput')).toHaveLength(0);
  });

  it('asks a rate-limited reader to wait as long as the server said, and keeps Try again', () => {
    pages = undefined;
    queryState = {
      isError: true,
      error: new ApiError('Too many requests. Please wait before trying again.', 429, {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 30,
      }),
    };
    const tree = renderSheet();

    const status = tree.root.find((node) => String(node.type) === 'status-block');
    expect(status.props).toMatchObject({
      tone: 'danger',
      title: 'Comments are unavailable',
      body: 'Too many requests in a short time. Try again in 30 seconds.',
    });
    expect(pressables(tree.root, 'Try loading comments again')).toHaveLength(1);
  });

  it('offers sign-in, back to the same reply, when posting finds the session ended', async () => {
    pages = [page([comment()])];
    createPostComment.mockRejectedValue(new ApiError('Unauthorized', 401));
    const onClose = vi.fn();
    const tree = renderSheet({ onClose });

    renderer.act(() => {
      pressable(tree.root, 'Reply to @batman').props.onPress();
    });
    await postFromComposer(tree.root, 'Late reply');

    expect(alert).toHaveBeenCalledWith(
      'Your session ended',
      'Sign in to post.',
      expect.any(Array),
      expect.anything()
    );
    expect(alert.mock.calls.some(([, message]) => message === 'Unauthorized')).toBe(false);
    expect(composerInput(tree.root).props.value).toBe('Late reply');

    await renderer.act(async () => {
      pressDialogButton('Your session ended', 'Sign in');
      await flushPromises();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: '/auth',
      params: {
        returnTo: '/viewer?source=showcase-feed&initialId=post-1&comments=post-1&replyTo=comment-1',
      },
    });
  });

  it('names one reply in the singular and reports whether the replies are open', () => {
    pages = [page([comment({ replyCount: 1 })], 2)];
    replyPages = [page([comment({ id: 'reply-1', parentId: 'comment-1' })], 2)];
    const tree = renderSheet();

    expect(pressable(tree.root, 'View 1 reply').props.accessibilityState).toEqual({ expanded: false });
    expect(texts(tree.root)).toContain('View 1 reply');
    renderer.act(() => {
      pressable(tree.root, 'View 1 reply').props.onPress();
    });
    expect(pressable(tree.root, 'Hide replies').props.accessibilityState).toEqual({ expanded: true });
  });

  it('labels the composer for the reply being written', () => {
    pages = [page([comment()])];
    const tree = renderSheet();

    expect(composerInput(tree.root).props.accessibilityLabel).toBe('Write a comment');
    renderer.act(() => {
      pressable(tree.root, 'Reply to @batman').props.onPress();
    });
    expect(composerInput(tree.root).props.accessibilityLabel).toBe('Write a reply to @batman');
  });
});
