(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImmersivePreviewItem } from '@/lib/immersive-preview-view-model';

const mocks = vi.hoisted(() => ({
  router: { push: vi.fn() },
  announce: vi.fn(),
  showActionSheet: vi.fn(),
  showConfirmDialog: vi.fn(),
  showErrorDialog: vi.fn(),
  showMessageDialog: vi.fn(),
  auth: {
    user: { id: 'viewer-1' } as { id: string } | null,
    api: {
      reportPost: vi.fn(),
      reportUser: vi.fn(),
      blockUser: vi.fn(),
      saveShowcasePost: vi.fn(),
      archiveGeneration: vi.fn(),
      restoreGeneration: vi.fn(),
      deleteGeneration: vi.fn(),
    },
  },
  queryClient: { setQueryData: vi.fn(), setQueriesData: vi.fn(), invalidateQueries: vi.fn() },
}));

vi.mock('expo-router', () => ({ router: mocks.router }));
vi.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: mocks.announce },
  Linking: { openURL: vi.fn() },
  Platform: { OS: 'ios' },
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock('@/lib/auth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: mocks.showActionSheet }));
vi.mock('@/lib/dialog', () => ({
  showConfirmDialog: mocks.showConfirmDialog,
  showErrorDialog: mocks.showErrorDialog,
  showMessageDialog: mocks.showMessageDialog,
}));
vi.mock('@/lib/haptics', () => ({ haptic: { error: vi.fn(), light: vi.fn(), select: vi.fn(), success: vi.fn() } }));
vi.mock('@/lib/viewer-media-cache', () => ({
  applyGenerationArchiveToCaches: vi.fn(async () => undefined),
  refreshViewerMediaCaches: vi.fn(async () => undefined),
  removeGenerationFromCaches: vi.fn(),
}));

import { haptic } from '@/lib/haptics';
import type { CreatorProfileResponse } from '@/lib/types';
import { applyGenerationArchiveToCaches, refreshViewerMediaCaches, removeGenerationFromCaches } from '@/lib/viewer-media-cache';
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

  // The server files the report as that delivery's `report` feed event: the
  // one the reel's impression went to.
  it('names the delivery the reel showed a ranked post under, and none for a post read on its own', () => {
    mountHandlers(postItem({
      recommendation: { deliveryId: '812', position: 3, algorithmVersion: 'for-you-rules-v4' },
    })).handleAction('report-content');
    pickReason('Spam');
    expect(mocks.auth.api.reportPost).toHaveBeenLastCalledWith('post-1', {
      reason: 'spam',
      details: 'Reported from the mobile Showcase viewer.',
      deliveryId: '812',
    });

    mountHandlers(postItem()).handleAction('report-content');
    pickReason('Spam');
    expect(mocks.auth.api.reportPost).toHaveBeenLastCalledWith('post-1', {
      reason: 'spam',
      details: 'Reported from the mobile Showcase viewer.',
    });
    expect(mocks.auth.api.reportPost.mock.calls.at(-1)?.[1]).not.toHaveProperty('deliveryId');
  });

  it('hands the reported post to the screen once the report is filed, so the reel moves on', async () => {
    const onReported = vi.fn();
    const item = postItem();
    mocks.auth.api.reportPost.mockResolvedValueOnce({ success: true });
    mountHandlers(item, { onReported }).handleAction('report-content');

    pickReason('Spam');
    await vi.waitFor(() => expect(onReported).toHaveBeenCalledWith(item));
    expect(mocks.showMessageDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Report received' }));
  });

  it('keeps the post where it is when the report fails', async () => {
    const onReported = vi.fn();
    mocks.auth.api.reportPost.mockRejectedValueOnce(new Error('Network request failed'));
    mountHandlers(postItem(), { onReported }).handleAction('report-content');

    pickReason('Spam');
    await vi.waitFor(() => expect(mocks.showErrorDialog).toHaveBeenCalledWith('Could not report content', expect.any(Error)));
    expect(onReported).not.toHaveBeenCalled();
  });
});

describe('Save from the menu', () => {
  it("goes through the screen's own Save when it has one: no second request, no refresh of every feed", () => {
    const onSave = vi.fn();
    const item = postItem({ isSaved: false });
    const handlers = mountHandlers(item, { onSave });

    handlers.handleAction('save');
    handlers.handleAction('unsave');

    expect(onSave.mock.calls).toEqual([[item], [item]]);
    expect(mocks.auth.api.saveShowcasePost).not.toHaveBeenCalled();
    expect(refreshViewerMediaCaches).not.toHaveBeenCalled();
  });

  it('saves through the API where the screen has no Save of its own', async () => {
    mocks.auth.api.saveShowcasePost.mockResolvedValueOnce({ success: true, isSaved: true, saveCount: 1 });
    mountHandlers(postItem()).handleAction('save');

    await vi.waitFor(() => expect(refreshViewerMediaCaches).toHaveBeenCalledTimes(1));
    expect(mocks.auth.api.saveShowcasePost).toHaveBeenCalledWith('post-1', { shouldSave: true, sourceSurface: 'mobile-viewer-actions' });
  });
});

describe('rows with nowhere to go', () => {
  it('does nothing for the retired Open original post and Edit linked post rows', () => {
    const handlers = mountHandlers(postItem({ linkedPostId: 'post-9' }));
    handlers.handleAction('open-original');
    handlers.handleAction('edit-linked');
    expect(mocks.router.push).not.toHaveBeenCalled();
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

describe('Block user', () => {
  const invalidatedKeys = () => mocks.queryClient.invalidateQueries.mock.calls
    .map(([filters]) => (filters as { queryKey: unknown[] }).queryKey);

  /** A page of a creator's grid, as the creator page caches it. */
  const gridPage = (creatorId: string): CreatorProfileResponse => ({
    profile: { id: creatorId, username: creatorId, displayName: creatorId } as CreatorProfileResponse['profile'],
    stats: undefined,
    items: [{ id: `${creatorId}-post` } as CreatorProfileResponse['items'][number]],
    pageInfo: { hasMore: true, nextLimit: 48, nextOffset: 24, limit: 24, offset: 0 },
    viewer: { isOwner: false, isFollowing: true, blockedByViewer: false },
  });

  /** What the block writes over every cached creator grid, applied to one. */
  function blockedGrid(creatorId: string) {
    const [filters, write] = mocks.queryClient.setQueriesData.mock.calls[0] as unknown as [
      { queryKey: unknown[] },
      (data: { pages: CreatorProfileResponse[]; pageParams: unknown[] } | undefined) => unknown,
    ];
    expect(filters).toEqual({ queryKey: ['creator-profile'] });
    return write({ pages: [gridPage(creatorId), gridPage(creatorId)], pageParams: [0, 24] });
  }

  // The reel used to refresh every feed and close: each lane behind it was read
  // again as a new ranked session, a reshuffle and dozens of deliveries served
  // that nobody saw (audit 02-4). The screen now takes the creator out itself.
  // Every creator's grid was read again too, page by page (audit 02-8): the
  // blocked creator's cached pages now say so instead.
  it('hands the creator to the screen, writes their grid as blocked, and reads again only the Saved list and count, never a lane or a grid', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.blockUser.mockResolvedValueOnce({ success: true });
    const onBlocked = vi.fn();
    const onSourceRefresh = vi.fn();
    mountHandlers(postItem(), { onBlocked, onSourceRefresh }).handleAction('block-user');

    await vi.waitFor(() => expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledTimes(2));
    expect(mocks.auth.api.blockUser).toHaveBeenCalledWith('creator-1');
    expect(onBlocked.mock.calls).toEqual([['creator-1']]);
    expect(invalidatedKeys()).toEqual([
      ['profile-saved-media', 'viewer-1'],
      ['profile', 'viewer-1'],
    ]);
    expect(invalidatedKeys().some((key) => ['showcase-feed', 'immersive-preview-source', 'creator-profile'].includes(key[0] as string))).toBe(false);
    expect(refreshViewerMediaCaches).not.toHaveBeenCalled();
    expect(onSourceRefresh).not.toHaveBeenCalled();
    // The creator's page, under a reel or later, says "You blocked": one page, no posts.
    expect(blockedGrid('creator-1')).toMatchObject({
      pages: [{ items: [], viewer: { blockedByViewer: true, isFollowing: false }, pageInfo: { hasMore: false } }],
      pageParams: [0],
    });
    // Another creator's grid is left as it was.
    expect(blockedGrid('creator-2')).toBeUndefined();
    // A block ends both follows; nothing is cut to its first page under a reader.
    expect(mocks.queryClient.setQueryData.mock.calls).toEqual([[['creator-follow-state', 'creator-1'], { following: false }]]);
    // The grid says so before the screen moves on, and the reads come after it.
    expect(mocks.queryClient.setQueriesData.mock.invocationCallOrder[0])
      .toBeLessThan(onBlocked.mock.invocationCallOrder[0]);
    expect(onBlocked.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.queryClient.invalidateQueries.mock.invocationCallOrder[0]);
    expect(haptic.success).toHaveBeenCalledTimes(1);
    expect(mocks.announce).toHaveBeenCalledWith('@maya blocked.');
    expect(mocks.showErrorDialog).not.toHaveBeenCalled();
  });

  // The text post page offers Block with nowhere of its own to take the posts
  // out of, so it keeps the full refresh it had; the creator's grid says
  // "You blocked" there too.
  it('refreshes every cache, as before, on a screen that takes no posts out itself', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.blockUser.mockResolvedValueOnce({ success: true });
    const onSourceRefresh = vi.fn();
    mountHandlers(postItem(), { onSourceRefresh }).handleAction('block-user');

    await vi.waitFor(() => expect(onSourceRefresh).toHaveBeenCalledTimes(1));
    expect(refreshViewerMediaCaches).toHaveBeenCalledWith(mocks.queryClient, 'viewer-1');
    expect(mocks.queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(blockedGrid('creator-1')).toMatchObject({ pages: [{ items: [], viewer: { blockedByViewer: true } }] });
    expect(mocks.queryClient.setQueryData).toHaveBeenCalledWith(['creator-follow-state', 'creator-1'], { following: false });
  });

  it('leaves the reel and every cache alone when the block fails', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.blockUser.mockRejectedValueOnce(new Error('Network request failed'));
    const onBlocked = vi.fn();
    mountHandlers(postItem(), { onBlocked }).handleAction('block-user');

    await vi.waitFor(() => expect(mocks.showErrorDialog).toHaveBeenCalledWith('Could not block user', expect.any(Error)));
    expect(onBlocked).not.toHaveBeenCalled();
    expect(mocks.queryClient.invalidateQueries).not.toHaveBeenCalled();
    expect(mocks.queryClient.setQueriesData).not.toHaveBeenCalled();
    expect(mocks.queryClient.setQueryData).not.toHaveBeenCalled();
    expect(refreshViewerMediaCaches).not.toHaveBeenCalled();
    expect(mocks.announce).not.toHaveBeenCalled();
  });

  it('blocks nobody when the reader backs out of the confirmation', async () => {
    mocks.showConfirmDialog.mockResolvedValue(false);
    const onBlocked = vi.fn();
    mountHandlers(postItem(), { onBlocked }).handleAction('block-user');

    await vi.waitFor(() => expect(mocks.showConfirmDialog).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(mocks.auth.api.blockUser).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
    expect(mocks.queryClient.invalidateQueries).not.toHaveBeenCalled();
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

/** One of the owner's creations, as the Creations library lists it. */
function creationItem(overrides: Partial<ImmersivePreviewItem> = {}): ImmersivePreviewItem {
  return postItem({
    id: 'gen-1',
    source: 'profile-creations',
    sourceType: 'generation',
    creatorId: null,
    showcasePostId: null,
    generationId: 'gen-1',
    availability: 'available',
    availableActions: ['publish', 'recreate', 'archive', 'delete-creation', 'download', 'view-details'],
    ...overrides,
  });
}

describe('Delete creation', () => {
  it('asks first, in red, and says nothing of a post when there is none', async () => {
    mocks.showConfirmDialog.mockResolvedValue(false);
    mountHandlers(creationItem()).handleAction('delete-creation');

    await vi.waitFor(() => expect(mocks.showConfirmDialog).toHaveBeenCalledWith({
      title: 'Delete this creation?',
      message: 'This can’t be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    }));
    await Promise.resolve();
    expect(mocks.auth.api.deleteGeneration).not.toHaveBeenCalled();
    expect(removeGenerationFromCaches).not.toHaveBeenCalled();
  });

  it("says what becomes of the creation's post", async () => {
    mocks.showConfirmDialog.mockResolvedValue(false);
    mountHandlers(creationItem({ linkedPostId: 'post-9' })).handleAction('delete-creation');

    await vi.waitFor(() => expect(mocks.showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      message: 'This can’t be undone. Its post stays up, but remixes based on this creation may stop working.',
    })));
  });

  it('deletes it, tells the screen, then takes it out of every cache and the count', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.deleteGeneration.mockResolvedValueOnce({ success: true, deleted: true, linkedPostRetained: false, message: '' });
    const onDeleted = vi.fn();
    const onSourceRefresh = vi.fn();
    mountHandlers(creationItem(), { onDeleted, onSourceRefresh }).handleAction('delete-creation');

    await vi.waitFor(() => expect(mocks.queryClient.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['profile', 'viewer-1'] }));
    expect(mocks.auth.api.deleteGeneration).toHaveBeenCalledWith('gen-1');
    expect(onDeleted).toHaveBeenCalledWith('gen-1');
    expect(removeGenerationFromCaches).toHaveBeenCalledWith(mocks.queryClient, 'viewer-1', 'gen-1');
    expect(onDeleted.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(removeGenerationFromCaches).mock.invocationCallOrder[0]);
    expect(haptic.success).toHaveBeenCalledTimes(1);
    // The library's total moves by the one creation it counted.
    expect(mocks.queryClient.setQueryData).toHaveBeenCalledWith(['profile', 'viewer-1'], expect.any(Function));
    // Nothing is read again, and no library is cut to its first page.
    expect(refreshViewerMediaCaches).not.toHaveBeenCalled();
    expect(onSourceRefresh).not.toHaveBeenCalled();
  });

  it('leaves the count alone for a run the library never counted', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.deleteGeneration.mockResolvedValueOnce({ success: true, deleted: true, linkedPostRetained: false, message: '' });
    mountHandlers(creationItem({ availability: 'failed', availableActions: ['recreate', 'archive', 'delete-creation', 'view-details'] }))
      .handleAction('delete-creation');

    await vi.waitFor(() => expect(removeGenerationFromCaches).toHaveBeenCalledTimes(1));
    expect(mocks.queryClient.setQueryData).not.toHaveBeenCalled();
  });

  it("keeps everything as it was and says the server's reason when the delete is refused", async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    const refused = new Error('Creation not found.');
    mocks.auth.api.deleteGeneration.mockRejectedValueOnce(refused);
    const onDeleted = vi.fn();
    mountHandlers(creationItem(), { onDeleted }).handleAction('delete-creation');

    await vi.waitFor(() => expect(mocks.showErrorDialog).toHaveBeenCalledWith('Could not delete creation', refused));
    expect(haptic.error).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(removeGenerationFromCaches).not.toHaveBeenCalled();
  });
});

describe('Archive and Restore of a creation', () => {
  it('writes the change into the loaded pages instead of cutting every library and reading the feeds again', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.archiveGeneration.mockResolvedValueOnce({ success: true });
    const onSourceRefresh = vi.fn();
    mountHandlers(creationItem(), { onSourceRefresh }).handleAction('archive');

    await vi.waitFor(() => expect(applyGenerationArchiveToCaches).toHaveBeenCalledTimes(1));
    expect(mocks.auth.api.archiveGeneration).toHaveBeenCalledWith('gen-1');
    expect(applyGenerationArchiveToCaches).toHaveBeenCalledWith({
      api: mocks.auth.api,
      queryClient: mocks.queryClient,
      userId: 'viewer-1',
      generationId: 'gen-1',
      archivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(refreshViewerMediaCaches).not.toHaveBeenCalled();
    expect(onSourceRefresh).not.toHaveBeenCalled();
  });

  it('restores with no archive date', async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    mocks.auth.api.restoreGeneration.mockResolvedValueOnce({ success: true });
    mountHandlers(creationItem({ archivedAt: '2026-10-01T00:00:00.000Z', availableActions: ['restore', 'delete-creation', 'view-details'] }))
      .handleAction('restore');

    await vi.waitFor(() => expect(applyGenerationArchiveToCaches).toHaveBeenCalledWith(expect.objectContaining({
      generationId: 'gen-1',
      archivedAt: null,
    })));
    expect(mocks.auth.api.restoreGeneration).toHaveBeenCalledWith('gen-1');
  });

  // The app said "Could not update media / Please try again." to a refusal
  // the server explains (below the cut, audit 01).
  it("says the server's reason when it refuses", async () => {
    mocks.showConfirmDialog.mockResolvedValue(true);
    const refused = new Error('Creation not found.');
    mocks.auth.api.restoreGeneration.mockRejectedValueOnce(refused);
    mountHandlers(creationItem({ archivedAt: '2026-10-01T00:00:00.000Z' })).handleAction('restore');

    await vi.waitFor(() => expect(mocks.showErrorDialog).toHaveBeenCalledWith('Could not restore creation', refused));
    expect(applyGenerationArchiveToCaches).not.toHaveBeenCalled();
    expect(mocks.showMessageDialog).not.toHaveBeenCalled();
  });
});

describe("a template output's Open run", () => {
  it('opens the run that made it', () => {
    mountHandlers(creationItem({
      templateRun: { runId: 'run 7', endedAs: 'cancelled' },
      availableActions: ['open-run', 'download', 'view-details'],
    })).handleAction('open-run');

    expect(mocks.router.push).toHaveBeenCalledWith('/template-runs/run%207');
  });
});
