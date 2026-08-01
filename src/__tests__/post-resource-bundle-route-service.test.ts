import { describe, expect, it, vi } from 'vitest';

const cacheMocks = vi.hoisted(() => ({
  SHOWCASE_FEED_CACHE_TAG: 'showcase-feed:v2',
  invalidateShowcaseFeedCache: vi.fn(),
}));

vi.mock('@/lib/showcase-feed-cache', () => cacheMocks);

import { getPostResourceBundleForRoute } from '@/lib/post-resource-bundle-route-service';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';






describe('getPostResourceBundleForRoute', () => {
  it('loads bundle detail with viewer and country context', async () => {
    const bundleDetail = {
      id: 'bundle-1',
      accessMode: 'free',
    } as unknown as PostResourceBundleDetail;
    const getDetailByPostId = vi.fn(async () => bundleDetail);

    const result = await getPostResourceBundleForRoute({
      postId: 'post-1',
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
      getDetailByPostId,
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        bundle: bundleDetail,
      },
    });
    expect(getDetailByPostId).toHaveBeenCalledWith('post-1', {
      viewerUserId: 'viewer-1',
      countryCode: 'IN',
    });
  });
});
