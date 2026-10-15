import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setBackendLogSink, type BackendLogRecord } from '@/lib/backend-logger';
import {
  filterMarketplaceItemsForViewer,
  isMarketplaceCreatorBlockedForViewer,
  isPostResourceBundleBuyWithheld,
} from '@/lib/marketplace-viewer-filter';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';

const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;

function item(id: string, sellerId: string) {
  return { id, seller: { id: sellerId, username: null, name: 'Creator', avatar: null } };
}

function detail(overrides: Partial<PostResourceBundleDetail> = {}) {
  return {
    id: 'bundle-1',
    postId: 'post-1',
    seller: { id: 'creator-1', username: 'nova', name: 'Nova', avatar: null },
    viewerIsOwner: false,
    ...overrides,
  } as PostResourceBundleDetail;
}

let restoreLogSink: (() => void) | null = null;

function captureLogs() {
  const records: BackendLogRecord[] = [];
  restoreLogSink = setBackendLogSink((record) => { records.push(record); });
  return records;
}

afterEach(() => {
  restoreLogSink?.();
  restoreLogSink = null;
});

describe('filterMarketplaceItemsForViewer', () => {
  it('drops the recipes of a creator the viewer blocked or who blocked the viewer', async () => {
    const loadBlockedCreatorIds = vi.fn(async () => new Set(['creator-blocked', 'creator-blocker']));
    const items = [
      item('bundle-1', 'creator-1'),
      item('bundle-2', 'creator-blocked'),
      item('bundle-3', 'creator-blocker'),
      item('bundle-4', 'creator-1'),
    ];

    const visible = await filterMarketplaceItemsForViewer(items, 'viewer-1', {
      createServiceClient: () => adminSupabase,
      loadBlockedCreatorIds,
    });

    expect(visible.map((entry) => entry.id)).toEqual(['bundle-1', 'bundle-4']);
    expect(loadBlockedCreatorIds).toHaveBeenCalledWith({
      adminSupabase,
      creatorIds: ['creator-1', 'creator-blocked', 'creator-blocker', 'creator-1'],
      viewerUserId: 'viewer-1',
    });
  });

  it('leaves the page alone for a signed-out caller and asks nothing', async () => {
    const loadBlockedCreatorIds = vi.fn();
    const createServiceClient = vi.fn();
    const items = [item('bundle-1', 'creator-1'), item('bundle-2', 'creator-2')];

    await expect(filterMarketplaceItemsForViewer(items, null, {
      createServiceClient,
      loadBlockedCreatorIds,
    })).resolves.toBe(items);
    expect(loadBlockedCreatorIds).not.toHaveBeenCalled();
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('asks nothing for an empty page', async () => {
    const loadBlockedCreatorIds = vi.fn();

    await expect(filterMarketplaceItemsForViewer([], 'viewer-1', { loadBlockedCreatorIds }))
      .resolves.toEqual([]);
    expect(loadBlockedCreatorIds).not.toHaveBeenCalled();
  });

  it('keeps every recipe when the viewer has no block with any of the creators', async () => {
    const items = [item('bundle-1', 'creator-1'), item('bundle-2', 'creator-2')];

    await expect(filterMarketplaceItemsForViewer(items, 'viewer-1', {
      createServiceClient: () => adminSupabase,
      loadBlockedCreatorIds: vi.fn(async () => new Set<string>()),
    })).resolves.toEqual(items);
  });

  it('shows nothing rather than an unchecked page when the blocks cannot be read', async () => {
    const records = captureLogs();

    await expect(filterMarketplaceItemsForViewer([item('bundle-1', 'creator-1')], 'viewer-1', {
      createServiceClient: () => adminSupabase,
      loadBlockedCreatorIds: vi.fn(async () => {
        throw new Error('user_blocks unavailable');
      }),
    })).resolves.toEqual([]);
    expect(records.map((record) => record.msg)).toContain('marketplace_viewer_block_filter_failed');
  });
});

describe('isMarketplaceCreatorBlockedForViewer', () => {
  it('asks the relationship both ways for the viewer and the creator', async () => {
    const isUserRelationshipBlocked = vi.fn(async () => true);

    await expect(isMarketplaceCreatorBlockedForViewer('viewer-1', 'creator-1', {
      createServiceClient: () => adminSupabase,
      isUserRelationshipBlocked,
    })).resolves.toBe(true);
    expect(isUserRelationshipBlocked).toHaveBeenCalledWith({
      adminSupabase,
      firstUserId: 'viewer-1',
      secondUserId: 'creator-1',
    });
  });

  it('answers no block when there is none', async () => {
    await expect(isMarketplaceCreatorBlockedForViewer('viewer-1', 'creator-1', {
      createServiceClient: () => adminSupabase,
      isUserRelationshipBlocked: vi.fn(async () => false),
    })).resolves.toBe(false);
  });

  it('never asks about the creator reading their own recipe', async () => {
    const isUserRelationshipBlocked = vi.fn();

    await expect(isMarketplaceCreatorBlockedForViewer('creator-1', 'creator-1', { isUserRelationshipBlocked }))
      .resolves.toBe(false);
    expect(isUserRelationshipBlocked).not.toHaveBeenCalled();
  });

  it('counts a relationship it cannot check as a block, as the post page does', async () => {
    const records = captureLogs();

    await expect(isMarketplaceCreatorBlockedForViewer('viewer-1', 'creator-1', {
      createServiceClient: () => adminSupabase,
      isUserRelationshipBlocked: vi.fn(async () => {
        throw new Error('user_blocks unavailable');
      }),
    })).resolves.toBe(true);
    expect(records.map((record) => record.msg)).toContain('marketplace_viewer_block_check_failed');
  });
});

describe('isPostResourceBundleBuyWithheld', () => {
  it('refuses what the detail read withholds from this buyer, before asking about blocks', async () => {
    const getPostResourceBundleDetailByPostId = vi.fn(async () => null);
    const isUserRelationshipBlocked = vi.fn();

    await expect(isPostResourceBundleBuyWithheld(
      { adminSupabase, buyerUserId: 'buyer-1', postId: 'post-1' },
      { getPostResourceBundleDetailByPostId, isUserRelationshipBlocked },
    )).resolves.toBe(true);
    // As for the buyer's own purchase: a repeat buy is still answered
    // "already owned", and a stranger still needs the reveal.
    expect(getPostResourceBundleDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'buyer-1',
      adminSupabase,
      entitledPurchase: true,
    });
    expect(isUserRelationshipBlocked).not.toHaveBeenCalled();
  });

  it('refuses a buyer and a creator who block each other', async () => {
    const isUserRelationshipBlocked = vi.fn(async () => true);

    await expect(isPostResourceBundleBuyWithheld(
      { adminSupabase, buyerUserId: 'buyer-1', postId: 'post-1' },
      {
        getPostResourceBundleDetailByPostId: vi.fn(async () => detail()),
        isUserRelationshipBlocked,
      },
    )).resolves.toBe(true);
    expect(isUserRelationshipBlocked).toHaveBeenCalledWith({
      adminSupabase,
      firstUserId: 'buyer-1',
      secondUserId: 'creator-1',
    });
  });

  it('lets a buy through when the read shows the bundle and no block stands', async () => {
    await expect(isPostResourceBundleBuyWithheld(
      { adminSupabase, buyerUserId: 'buyer-1', postId: 'post-1' },
      {
        getPostResourceBundleDetailByPostId: vi.fn(async () => detail()),
        isUserRelationshipBlocked: vi.fn(async () => false),
      },
    )).resolves.toBe(false);
  });

  it('leaves the owner to the route, which answers them itself', async () => {
    const isUserRelationshipBlocked = vi.fn();

    await expect(isPostResourceBundleBuyWithheld(
      { adminSupabase, buyerUserId: 'creator-1', postId: 'post-1' },
      {
        getPostResourceBundleDetailByPostId: vi.fn(async () => detail({ viewerIsOwner: true })),
        isUserRelationshipBlocked,
      },
    )).resolves.toBe(false);
    expect(isUserRelationshipBlocked).not.toHaveBeenCalled();
  });

  it('throws rather than sell when either check fails', async () => {
    await expect(isPostResourceBundleBuyWithheld(
      { adminSupabase, buyerUserId: 'buyer-1', postId: 'post-1' },
      {
        getPostResourceBundleDetailByPostId: vi.fn(async () => {
          throw new Error('bundle read failed');
        }),
        isUserRelationshipBlocked: vi.fn(async () => false),
      },
    )).rejects.toThrow('bundle read failed');

    await expect(isPostResourceBundleBuyWithheld(
      { adminSupabase, buyerUserId: 'buyer-1', postId: 'post-1' },
      {
        getPostResourceBundleDetailByPostId: vi.fn(async () => detail()),
        isUserRelationshipBlocked: vi.fn(async () => {
          throw new Error('user_blocks unavailable');
        }),
      },
    )).rejects.toThrow('user_blocks unavailable');
  });
});
