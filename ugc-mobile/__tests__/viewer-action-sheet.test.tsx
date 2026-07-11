// Define React Native development global
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api-client';
import type { ImmersivePreviewItem } from '../lib/immersive-preview-view-model';
import { ViewerActionSheet } from '../components/viewer-action-sheet';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

const alertState = vi.hoisted(() => ({
  alert: vi.fn(),
}));

const routerState = vi.hoisted(() => ({
  push: vi.fn(),
}));

const queryClientState = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  setQueryData: vi.fn(),
  setQueriesData: vi.fn(),
}));

const authState = vi.hoisted(() => ({
  user: { id: 'user-123', email: 'creator@example.com' },
  api: {
    deletePost: vi.fn(),
    archivePost: vi.fn(),
    archiveGeneration: vi.fn(),
    restorePost: vi.fn(),
    restoreGeneration: vi.fn(),
    saveShowcasePost: vi.fn(),
    updatePost: vi.fn(),
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => queryClientState,
}));

vi.mock('expo-router', () => ({
  router: routerState,
}));

vi.mock('react-native', () => ({
  Alert: {
    alert: alertState.alert,
  },
  Linking: {
    openURL: vi.fn(),
  },
  Modal: ({ children, ...props }: MockProps) => React.createElement('modal', props, children),
  Pressable: ({ children, style, ...props }: MockProps) =>
    React.createElement('pressable', {
      ...props,
      style: resolvePressableStyle(style),
    }, children),
  ScrollView: ({ children, ...props }: MockProps) => React.createElement('scrollview', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => authState,
}));

function manualOwnerPostItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-123',
    source: 'profile-posts',
    sourceType: 'owner-post',
    title: 'Manual post',
    displayText: 'Manual caption',
    mediaUrl: null,
    mediaKind: null,
    mediaItems: [],
    creatorLabel: '@batman',
    creatorAvatar: null,
    badge: 'Post',
    saveLabel: '0',
    saveCount: 0,
    isSaved: false,
    canSave: false,
    canShare: true,
    sharePath: '/showcase/post-123',
    recreateTool: 'image',
    recreatePrompt: 'Manual caption',
    showcasePostId: 'post-123',
    generationId: null,
    ownerPostId: 'post-123',
    linkedPostId: null,
    linkedPostTitle: null,
    linkedPostVisibility: null,
    archivedAt: null,
    visibility: 'public',
    isManualOwnerPost: true,
    availableActions: ['delete-post'],
    disabledActions: {},
    ...overrides,
  };
}

function findPressableByAccessibilityLabel(root: renderer.ReactTestInstance, accessibilityLabel: string) {
  const pressable = root.findAll(
    (node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === accessibilityLabel
  )[0];
  if (!pressable) {
    throw new Error(`No pressable with accessibility label "${accessibilityLabel}" was found`);
  }
  return pressable;
}

function getAlertAction(label: string, callIndex = 0) {
  const actions = alertState.alert.mock.calls[callIndex]?.[2] as Array<{ text: string; onPress?: () => void | Promise<void> }> | undefined;
  const action = actions?.find((candidate) => candidate.text === label);
  if (!action) {
    throw new Error(`No alert action "${label}" was found`);
  }
  return action;
}

describe('ViewerActionSheet permanent delete', () => {
  beforeEach(() => {
    alertState.alert.mockClear();
    routerState.push.mockClear();
    queryClientState.invalidateQueries.mockClear();
    queryClientState.setQueryData.mockClear();
    queryClientState.setQueriesData.mockClear();
    authState.api.deletePost.mockReset();
  });

  it('confirms and permanently deletes a manual owner post', async () => {
    authState.api.deletePost.mockResolvedValue({ success: true, deleted: true });
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    const onSourceRefresh = vi.fn();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <ViewerActionSheet
          item={manualOwnerPostItem()}
          onClose={onClose}
          onDeleted={onDeleted}
          onDetails={vi.fn()}
          onRecreate={vi.fn()}
          onShare={vi.fn()}
          onSourceRefresh={onSourceRefresh}
          visible
        />
      );
    });

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree!.root, 'Delete permanently').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
    expect(alertState.alert).toHaveBeenCalledWith(
      'Delete post permanently?',
      expect.stringContaining('permanently delete'),
      expect.any(Array)
    );

    await renderer.act(async () => {
      await getAlertAction('Delete').onPress?.();
    });

    expect(authState.api.deletePost).toHaveBeenCalledWith('post-123');
    expect(queryClientState.setQueryData).toHaveBeenCalledWith(
      ['profile-owner-posts', 'user-123'],
      expect.any(Function)
    );
    const profileCacheCall = queryClientState.setQueryData.mock.calls.find(([queryKey]) =>
      Array.isArray(queryKey) && queryKey[0] === 'profile-owner-posts'
    );
    const updateProfilePosts = profileCacheCall?.[1] as
      | ((current: { success: boolean; posts: Array<{ id: string }> }) => { posts: Array<{ id: string }> })
      | undefined;
    expect(updateProfilePosts?.({
      success: true,
      posts: [{ id: 'post-123' }, { id: 'keep-post' }],
    }).posts).toEqual([{ id: 'keep-post' }]);
    expect(onSourceRefresh).toHaveBeenCalled();
    expect(onDeleted).toHaveBeenCalledWith('post-123');
  });

  it('shows a second force-delete confirmation when paid unlock sales exist', async () => {
    authState.api.deletePost
      .mockRejectedValueOnce(new ApiError('This post already has paid unlocks.', 409, {
        requiresForceDelete: true,
      }))
      .mockResolvedValueOnce({ success: true, deleted: true });
    const onDeleted = vi.fn();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <ViewerActionSheet
          item={manualOwnerPostItem()}
          onClose={vi.fn()}
          onDeleted={onDeleted}
          onDetails={vi.fn()}
          onRecreate={vi.fn()}
          onShare={vi.fn()}
          onSourceRefresh={vi.fn()}
          visible
        />
      );
    });

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree!.root, 'Delete permanently').props.onPress();
    });
    await renderer.act(async () => {
      await getAlertAction('Delete').onPress?.();
    });

    expect(alertState.alert).toHaveBeenCalledWith(
      'Delete post with paid unlocks?',
      expect.stringContaining('paid unlock sales'),
      expect.any(Array)
    );

    await renderer.act(async () => {
      await getAlertAction('Delete permanently', 1).onPress?.();
    });

    expect(authState.api.deletePost).toHaveBeenNthCalledWith(1, 'post-123');
    expect(authState.api.deletePost).toHaveBeenNthCalledWith(2, 'post-123', { force: true });
    expect(onDeleted).toHaveBeenCalledWith('post-123');
  });

  it('opens the unlock remix prompt when a locked remix action is selected', () => {
    const onClose = vi.fn();
    const onDetails = vi.fn();
    const onUnlockRemix = vi.fn();

    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <ViewerActionSheet
          item={manualOwnerPostItem({
            availableActions: ['unlock-remix'],
            sourceType: 'showcase',
            showcasePostId: 'post-123',
          })}
          onClose={onClose}
          onDeleted={vi.fn()}
          onDetails={onDetails}
          onRecreate={vi.fn()}
          onShare={vi.fn()}
          onUnlockRemix={onUnlockRemix}
          onSourceRefresh={vi.fn()}
          visible
        />
      );
    });

    renderer.act(() => {
      findPressableByAccessibilityLabel(tree!.root, 'Remix').props.onPress();
    });

    expect(onClose).toHaveBeenCalled();
    expect(onDetails).not.toHaveBeenCalled();
    expect(onUnlockRemix).toHaveBeenCalled();
  });

  it('adds recommendation feedback actions only when callbacks are supplied', () => {
    const onClose = vi.fn();
    const onNotInterested = vi.fn();
    const onHideCreator = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <ViewerActionSheet
          item={manualOwnerPostItem({ sourceType: 'showcase', availableActions: ['share'] })}
          onClose={onClose}
          onDetails={vi.fn()}
          onHideCreator={onHideCreator}
          onNotInterested={onNotInterested}
          onRecreate={vi.fn()}
          onShare={vi.fn()}
          onSourceRefresh={vi.fn()}
          visible
        />
      );
    });

    renderer.act(() => findPressableByAccessibilityLabel(tree!.root, 'Not interested').props.onPress());
    expect(onClose).toHaveBeenCalled();
    expect(onNotInterested).toHaveBeenCalledOnce();

    renderer.act(() => findPressableByAccessibilityLabel(tree!.root, 'Hide this creator').props.onPress());
    expect(onHideCreator).toHaveBeenCalledOnce();
  });
});
