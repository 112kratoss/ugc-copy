// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { CommentsSheet } from '../components/comments-sheet';
import type { PostComment, PostCommentsResponse } from '../lib/types';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const listPostComments = vi.fn();

vi.mock('react-native', () => ({
  ActivityIndicator: (props: MockProps) => React.createElement('spinner', props),
  Alert: { alert: vi.fn() },
  FlatList: ({ data, renderItem, keyExtractor, ListEmptyComponent }: MockProps) => {
    const rows = (data as unknown[]) ?? [];
    if (!rows.length) {
      return React.createElement('list', {}, ListEmptyComponent as React.ReactNode);
    }
    return React.createElement(
      'list',
      {},
      rows.map((item, index) => React.createElement(
        React.Fragment,
        { key: (keyExtractor as (row: unknown, i: number) => string)(item, index) },
        (renderItem as (info: { item: unknown }) => React.ReactNode)({ item })
      ))
    );
  },
  KeyboardAvoidingView: ({ children, ...props }: MockProps) => React.createElement('kav', props, children),
  Modal: ({ children, ...props }: MockProps) => React.createElement('modal', props, children),
  Platform: { OS: 'ios' },
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement('pressable', {
    ...props,
    style: resolvePressableStyle(style),
  }, children),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  TextInput: (props: MockProps) => React.createElement('textinput', props),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/lib/motion', () => ({ useReducedMotion: () => false }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
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
    api: { listPostComments },
    user: { id: 'viewer-1' },
  }),
}));

let pages: PostCommentsResponse[] | undefined = [];
let queryState: Record<string, unknown> = {};

vi.mock('@tanstack/react-query', () => ({
  useInfiniteQuery: () => ({
    data: pages ? { pages, pageParams: [0] } : undefined,
    dataUpdatedAt: 1,
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    isError: false,
    fetchNextPage: vi.fn(),
    ...queryState,
  }),
  useQueryClient: () => ({
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
    setQueriesData: vi.fn(),
    invalidateQueries: vi.fn(),
    fetchInfiniteQuery: vi.fn(),
  }),
}));

function comment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    id: 'comment-1',
    parentId: null,
    body: 'This prompt is unreal.',
    status: 'active',
    createdAt: new Date().toISOString(),
    replyCount: 0,
    author: { id: 'creator-2', username: 'batman', displayName: 'Batman', avatarUrl: null },
    ...overrides,
  };
}

function page(comments: PostComment[], commentCount = comments.length): PostCommentsResponse {
  return {
    postId: 'post-1',
    postCreatorId: 'owner-1',
    commentCount,
    comments,
    pageInfo: { hasMore: false, nextOffset: null, limit: 20, offset: 0 },
  };
}

function renderSheet() {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(
      <CommentsSheet
        postId="post-1"
        postCreatorId="owner-1"
        commentCount={0}
        visible
        onClose={vi.fn()}
      />
    );
  });
  if (!tree) throw new Error('CommentsSheet failed to render');
  return tree.root;
}

function texts(root: renderer.ReactTestInstance) {
  return root
    .findAll((node) => String(node.type) === 'text')
    .map((node) => node.children.filter((child) => typeof child === 'string').join(''));
}

describe('comments sheet', () => {
  it('shows the empty state when a post has no comments', () => {
    pages = [page([])];
    queryState = {};

    expect(texts(renderSheet())).toContain('No comments yet');
  });

  it('renders the comment count, author handle, and body', () => {
    pages = [page([comment()])];
    queryState = {};

    const rendered = texts(renderSheet());
    expect(rendered).toContain('Comments · 1');
    expect(rendered).toContain('@batman');
    expect(rendered).toContain('This prompt is unreal.');
  });

  it('renders a removed comment as [deleted] with no options button', () => {
    pages = [page([comment({ status: 'removed_by_author', body: '', author: null, replyCount: 1 })], 0)];
    queryState = {};

    const root = renderSheet();
    expect(texts(root)).toContain('[deleted]');
    expect(root.findAll((node) => String(node.type) === 'icon-more')).toHaveLength(0);
  });

  it('offers a replies toggle for a comment that has replies', () => {
    pages = [page([comment({ replyCount: 3 })])];
    queryState = {};

    expect(texts(renderSheet())).toContain('View 3 replies');
  });

  it('surfaces a failure state when comments cannot load', () => {
    pages = undefined;
    queryState = { isError: true };

    const root = renderSheet();
    expect(root.findAll((node) => String(node.type) === 'status-block')).toHaveLength(1);
  });
});
