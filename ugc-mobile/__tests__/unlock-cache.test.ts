import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import {
  applyBundleUnlockToItem,
  refreshUnlockedBundleCaches,
} from '@/lib/unlock-cache';
import type { ImmersiveSourceData } from '@/lib/immersive-preview-source-data';
import type { ShowcaseFeedItem, ShowcaseFeedResponse, ShowcasePostResponse } from '@/lib/types';

function feedItem(overrides: Partial<ShowcaseFeedItem> = {}): ShowcaseFeedItem {
  return {
    id: 'post-123',
    mediaUrl: null,
    mediaKind: 'image',
    model: 'GPT Image 2',
    title: 'Locked recipe',
    prompt: '',
    body: '',
    category: 'image',
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    creator: { id: 'creator-1', username: 'creator', name: 'Creator', avatar: null },
    generationId: 'gen-1',
    asset: null,
    canRemix: false,
    remixCapability: 'unlock_required',
    remixTarget: 'image',
    ...overrides,
  };
}

describe('applyBundleUnlockToItem', () => {
  it('opens remix on the unlocked post the way the server then describes it', () => {
    expect(applyBundleUnlockToItem(feedItem(), 'post-123')).toMatchObject({ canRemix: true, remixCapability: 'public' });
  });

  it('keeps a remix that lands on the web closed in the app, as the server does', () => {
    const patched = applyBundleUnlockToItem(feedItem({ remixTarget: 'workflow' }), 'post-123');
    expect(patched).toMatchObject({ canRemix: false, remixCapability: 'public' });
  });

  it('opens an older item that only its recipe kept locked', () => {
    const legacy = feedItem({
      remixCapability: undefined,
      remixTarget: undefined,
      asset: { id: 'asset-123', postId: 'post-123', title: 'Kit', accessMode: 'paid', priceUsdCents: 900, previewText: '', allowRemix: true },
    });
    expect(applyBundleUnlockToItem(legacy, 'post-123').canRemix).toBe(true);
  });

  // S4 (recipe audit 2026-10-27): a recipe the viewer has reads "Unlocked" on
  // its card instead of its price, from the moment it is unlocked here.
  it('marks the recipe as the viewer\'s, whether or not it opened Remix', () => {
    const recipe = { id: 'asset-123', postId: 'post-123', title: 'Kit', accessMode: 'paid' as const, priceUsdCents: 900, previewText: '', allowRemix: true };
    expect(applyBundleUnlockToItem(feedItem({ asset: recipe }), 'post-123').asset).toMatchObject({ viewerHasUnlocked: true });
    // An upload's recipe opens no Remix, and is still the viewer's now.
    const upload = feedItem({ generationId: null, canRemix: false, remixCapability: 'unsupported', asset: recipe });
    const patched = applyBundleUnlockToItem(upload, 'post-123');
    expect(patched.asset).toMatchObject({ viewerHasUnlocked: true });
    expect(patched).toMatchObject({ canRemix: false, remixCapability: 'unsupported' });
    // The owner's open post, too, keeps its Remix as it was.
    const open = applyBundleUnlockToItem(feedItem({ canRemix: true, remixCapability: 'public', asset: recipe }), 'post-123');
    expect(open).toMatchObject({ canRemix: true, remixCapability: 'public', asset: { viewerHasUnlocked: true } });
  });

  it('leaves other posts, open posts and posts with nothing to remix alone', () => {
    const other = feedItem({ id: 'post-999' });
    const open = feedItem({ canRemix: true, remixCapability: 'public' });
    const none = feedItem({ remixCapability: 'none' });
    expect(applyBundleUnlockToItem(other, 'post-123')).toBe(other);
    expect(applyBundleUnlockToItem(open, 'post-123')).toBe(open);
    expect(applyBundleUnlockToItem(none, 'post-123')).toBe(none);
  });
});

describe('refreshUnlockedBundleCaches', () => {
  it('patches the feed, the saved list, the reel source and the post without refetching them', async () => {
    const queryClient = new QueryClient();
    const feed: InfiniteData<ShowcaseFeedResponse> = {
      pages: [{ items: [feedItem(), feedItem({ id: 'post-other' })] }],
      pageParams: [0],
    };
    queryClient.setQueryData(['showcase-feed', 'infinite', 'buyer-1'], feed);
    queryClient.setQueryData(['profile-saved-media', 'buyer-1'], feed);
    queryClient.setQueryData(['creator-profile', 'infinite', 'creator'], { pages: [{ items: [feedItem()] }], pageParams: [0] });
    queryClient.setQueryData<ImmersiveSourceData>(['immersive-preview-source', 'showcase-feed', 'buyer-1'], {
      showcaseItems: [feedItem()],
    });
    queryClient.setQueryData<ShowcasePostResponse>(['showcase-post', 'post-123', 'buyer-1'], { success: true, item: feedItem() });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await refreshUnlockedBundleCaches(queryClient, { postId: 'post-123', resourceId: 'asset-123' });

    const feedPage = queryClient.getQueryData<InfiniteData<ShowcaseFeedResponse>>(['showcase-feed', 'infinite', 'buyer-1']);
    expect(feedPage?.pages[0]?.items.map((item) => item.canRemix)).toEqual([true, false]);
    const saved = queryClient.getQueryData<InfiniteData<ShowcaseFeedResponse>>(['profile-saved-media', 'buyer-1']);
    expect(saved?.pages[0]?.items[0]?.canRemix).toBe(true);
    const grid = queryClient.getQueryData<InfiniteData<{ items: ShowcaseFeedItem[] }>>(['creator-profile', 'infinite', 'creator']);
    expect(grid?.pages[0]?.items[0]?.canRemix).toBe(true);
    const source = queryClient.getQueryData<ImmersiveSourceData>(['immersive-preview-source', 'showcase-feed', 'buyer-1']);
    expect(source?.showcaseItems?.[0]?.canRemix).toBe(true);
    const post = queryClient.getQueryData<ShowcasePostResponse>(['showcase-post', 'post-123', 'buyer-1']);
    expect(post?.item.canRemix).toBe(true);

    // A refetch of these re-ran ranking and every loaded page under the buyer.
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).not.toContainEqual(['showcase-feed']);
    expect(invalidated).not.toContainEqual(['immersive-preview-source']);
    expect(invalidated).not.toContainEqual(['creator-profile']);
    expect(invalidated).toEqual(expect.arrayContaining([
      ['post-resource-bundle', 'post-123', 'asset-123'],
      ['marketplace-resource', 'asset-123'],
      ['viewer-unlocks'],
      ['showcase-post', 'post-123'],
    ]));
  });

  it('refreshes no marketplace list, since no screen in the app reads one', async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await refreshUnlockedBundleCaches(queryClient, { postId: 'post-123', resourceId: 'asset-123' });

    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).not.toContainEqual(['marketplace-resources']);
  });

  it('waits for the bundle reads only, and refreshes the library and the post behind the result', async () => {
    const pending = new Map<string, () => void>();
    const invalidateQueries = vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => new Promise<void>((resolve) => {
      pending.set(JSON.stringify(queryKey), resolve);
    }));
    const client = { invalidateQueries, setQueriesData: vi.fn() } as unknown as Parameters<typeof refreshUnlockedBundleCaches>[0];

    let settled = false;
    const refresh = refreshUnlockedBundleCaches(client, { postId: 'post-123', resourceId: 'asset-123' })
      .then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    pending.get(JSON.stringify(['post-resource-bundle', 'post-123', 'asset-123']))?.();
    pending.get(JSON.stringify(['marketplace-resource', 'asset-123']))?.();
    await refresh;

    // The library and the post read were asked to refresh, and were never
    // waited for: they are still pending here.
    expect(settled).toBe(true);
    expect(pending.has(JSON.stringify(['viewer-unlocks']))).toBe(true);
    expect(pending.has(JSON.stringify(['showcase-post', 'post-123']))).toBe(true);
  });
});
