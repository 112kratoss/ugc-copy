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
} = mocks;

let authUser: { id: string } | null = { id: 'viewer-1' };
let pages: PostCommentsResponse[] | undefined = [];
let replyPages: PostCommentsResponse[] | undefined = [];
let queryState: Record<string, unknown> = {};
let replyQueryState: Record<string, unknown> = {};

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('spinner', props),
  Alert: { alert: mocks.alert },
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
  Modal: ({ children, ...props }: MockProps) => React.createElement('modal', props, children),
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

function renderSheet(overrides: Partial<React.ComponentProps<typeof CommentsSheet>> = {}) {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(
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
    const tree = renderSheet();

    renderer.act(() => {
      pressable(tree.root, "Options for @batman's comment").props.onPress();
    });
    const optionButtons = alert.mock.calls.at(-1)?.[2] as Array<{
      text: string;
      onPress?: () => void;
    }>;
    renderer.act(() => {
      optionButtons.find((option) => option.text === 'Report')?.onPress?.();
    });
    await renderer.act(async () => {
      await pressable(tree.root, 'Report as Spam or misleading').props.onPress();
    });

    expect(reportComment).toHaveBeenCalledWith('comment-1', { reason: 'spam' });
  });
});
