import type { MarketplaceResourceListItem } from '@/lib/post-resource-bundles-server';

/**
 * The Marketplace list's fakes, shared by its tests: a free prompt recipe numbered `index` ("Unlock
 * 3" by "Creator 3", opening `post-3`), as the list API answers it.
 */
export function createMarketplaceItem(index: number): MarketplaceResourceListItem {
  const date = '2026-04-25T10:00:00.000Z';
  return {
    id: `bundle-${index}`,
    postId: `post-${index}`,
    legacyAssetId: null,
    title: `Unlock ${index}`,
    summary: 'A reusable creator prompt.',
    previewText: 'Prompt included.',
    accessMode: 'free',
    priceUsdCents: 0,
    salesCount: 0,
    freeUnlockCount: 0,
    earningsUsdCents: 0,
    allowRemix: false,
    resourceKinds: ['prompt'],
    lockedPreview: {
      resourceKinds: ['prompt'],
      attachmentPreviews: [],
      itemCounts: { prompt: 1 },
      itemPreviews: [],
      hasPrompt: true,
      hasNotes: false,
      hasWorkflow: false,
      hasRemix: false,
      updatedAt: date,
    },
    createdAt: date,
    updatedAt: date,
    seller: {
      id: `creator-${index}`,
      username: `creator-${index}`,
      name: `Creator ${index}`,
      avatar: null,
    },
    post: null,
    priceQuote: {
      currency: 'USD',
      amountSubunits: 0,
      formatted: '$0.00',
      note: null,
    },
    remixCapability: 'none',
    remixTarget: null,
  };
}

/** A page of the list API: recipes `startAt + 1` to `startAt + count`, and a next page from where it ends when `hasMore`. */
export function createMarketplacePage(count: number, hasMore: boolean, startAt = 0, limit = 3) {
  return {
    items: Array.from({ length: count }, (_, index) => createMarketplaceItem(startAt + index + 1)),
    pageInfo: {
      hasMore,
      nextOffset: hasMore ? startAt + count : null,
      offset: startAt,
      limit,
    },
  };
}
