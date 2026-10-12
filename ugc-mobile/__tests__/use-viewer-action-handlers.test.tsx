(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
  showActionSheet: vi.fn(),
  showConfirmDialog: vi.fn(),
  showErrorDialog: vi.fn(),
  showMessageDialog: vi.fn(),
  auth: {
    user: { id: 'viewer-1' } as { id: string } | null,
    api: { reportPost: vi.fn(), reportUser: vi.fn(), blockUser: vi.fn() },
  },
  queryClient: { setQueryData: vi.fn(), setQueriesData: vi.fn(), invalidateQueries: vi.fn() },
}));

vi.mock('expo-router', () => ({ router: mocks.router }));
vi.mock('react-native', () => ({ Linking: { openURL: vi.fn() }, Platform: { OS: 'ios' } }));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock('@/lib/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: mocks.showActionSheet }));
vi.mock('@/lib/dialog', () => ({
  showConfirmDialog: mocks.showConfirmDialog,
  showErrorDialog: mocks.showErrorDialog,
  showMessageDialog: mocks.showMessageDialog,
}));
vi.mock('@/lib/haptics', () => ({ haptic: { error: vi.fn(), light: vi.fn(), select: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/viewer-media-cache', () => ({ refreshViewerMediaCaches: vi.fn(async () => undefined) }));

import { useViewerActionHandlers, type ViewerActionCallbacks } from '@/lib/use-viewer-action-handlers';

function postItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return {
    id: 'post-1',
    source: 'showcase-feed',
    sourceType: 'showcase',
    title: 'Neon alley',
    displayText: 'Neon alley',
    mediaItems: [],
    mediaUrl: null,
    creatorLabel: '@maya',
    creatorId: 'creator-1',
    creatorUsername: 'maya',
    showcasePostId: 'post-1',
    generationId: null,
    ownerPostId: null,
    linkedPostId: null,
    visibility: 'public',
    archivedAt: null,
    availableActions: ['save', 'comment', 'share', 'view-details'],
    details: {
      title: 'Neon alley',
      prompt: '',
      body: '',
      categoryLabel: 'Image',
      sourceLabel: 'Showcase',
      creatorLabel: '@maya',
      creatorAvatar: null,
      saveCount: 0,
      remixCount: 0,
      unlock: null,
    },
    ...overrides,
  } as unknown as ImmersivePreviewItem;
}

/** A post with a recipe: its unlock carries the bundle's own id. */
function postWithRecipe() {
  const item = postItem();
  return postItem({
    details: {
      ...item.details!,
      unlock: {
        resourceId: 'bundle-1',
        postId: 'post-1',
        title: 'Neon alley',
        accessMode: 'paid',
        priceLabel: '900 credits',
        previewText: null,
        resourceKinds: ['prompt'],
        allowRemix: false,
      },
    },
  });
}

const trees: renderer.ReactTestRenderer[] = [];

function mountHandlers(item: ImmersivePreviewItem, callbacks: Partial<ViewerActionCallbacks> = {}) {
  let handlers!: ReturnType<typeof useViewerActionHandlers>;
  function Probe() {
    handlers = useViewerActionHandlers({
      item,
      onDetails: vi.fn(),
      onRecreate: vi.fn(),
      onShare: vi.fn(),
      onSourceRefresh: vi.fn(),
      ...callbacks,
    });
    return null;
  }
  act(() => { trees.push(renderer.create(React.createElement(Probe))); });
  return handlers;
}

function reportReasons() {
  const request = mocks.showActionSheet.mock.calls.at(-1)?.[0] as { actions: Array<{ label: string; onPress: () => void }> };
  return request.actions;
}

function pickReason(label: string) {
  const reason = reportReasons().find((action) => action.label === label);
  if (!reason) throw new Error(`No "${label}" reason`);
  reason.onPress();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = { id: 'viewer-1' };
});

afterEach(() => {
  act(() => { for (const tree of trees.splice(0)) tree.unmount(); });
});

describe('Report content', () => {
  it('offers the two recipe reasons only on a post that has a recipe', () => {
    mountHandlers(postItem()).handleAction('report-content');
    expect(reportReasons().map((action) => action.label)).toEqual([
      'Spam',
      'Stolen content',
      'Unsafe content',
      'Something else',
    ]);

    mountHandlers(postWithRecipe()).handleAction('report-content');
    expect(reportReasons().map((action) => action.label)).toEqual([
      'Spam',
      'Stolen content',
      'Misleading recipe',
      'Unsafe content',
      'Payment issue',
      'Something else',
    ]);
  });

  it('names the recipe a recipe report is about', () => {
    mountHandlers(postWithRecipe()).handleAction('report-content');

    pickReason('Misleading recipe');
    expect(mocks.auth.api.reportPost).toHaveBeenLastCalledWith('post-1', {
      reason: 'misleading_unlock',
      details: 'Reported from the mobile Showcase viewer.',
      bundleId: 'bundle-1',
    });

    pickReason('Payment issue');
    expect(mocks.auth.api.reportPost).toHaveBeenLastCalledWith('post-1', {
      reason: 'payment_issue',
      details: 'Reported from the mobile Showcase viewer.',
      bundleId: 'bundle-1',
    });
  });

  it('files every other reason about the post alone', () => {
    mountHandlers(postWithRecipe()).handleAction('report-content');

    pickReason('Spam');
    expect(mocks.auth.api.reportPost).toHaveBeenLastCalledWith('post-1', {
      reason: 'spam',
      details: 'Reported from the mobile Showcase viewer.',
    });
  });
});

describe('Report user', () => {
  it('files the creator under harassment, the reason the web files, and keeps the reel surface', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mountHandlers(postItem()).handleAction('report-user');

    await vi.waitFor(() => expect(mocks.auth.api.reportUser).toHaveBeenCalledTimes(1));
    expect(mocks.auth.api.reportUser).toHaveBeenCalledWith('creator-1', {
      reason: 'harassment',
      sourceSurface: 'showcase-reel',
      details: 'Reported from post post-1.',
    });
  });
});

describe('a signed-out reader', () => {
  it('goes to sign in from Report and Block, and comes back to the screen the item is on', () => {
    mocks.auth.user = null;
    const handlers = mountHandlers(postItem(), { authReturnTo: '/post/post-1' });

    handlers.handleAction('report-content');
    handlers.handleAction('report-user');
    handlers.handleAction('block-user');

    const signIn = { pathname: '/auth', params: { returnTo: '/post/post-1' } };
    expect(mocks.router.push.mock.calls).toEqual([[signIn], [signIn], [signIn]]);
    expect(mocks.showActionSheet).not.toHaveBeenCalled();
    expect(mocks.showConfirmDialog).not.toHaveBeenCalled();
  });

  it('keeps the plain sign-in where the screen names no way back', () => {
    mocks.auth.user = null;
    mountHandlers(postItem()).handleAction('block-user');

    expect(mocks.router.push).toHaveBeenCalledWith('/auth');
  });
});
