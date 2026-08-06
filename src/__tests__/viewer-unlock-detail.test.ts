import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getLiveDetail, loadMediaItems } = vi.hoisted(() => ({
  getLiveDetail: vi.fn(),
  loadMediaItems: vi.fn(),
}));

vi.mock('@/lib/post-resource-bundles-server', () => ({
  getPostResourceBundleDetailByPostId: getLiveDetail,
}));

vi.mock('@/lib/post-media', () => ({
  loadPostMediaItemsMap: loadMediaItems,
}));

import { getViewerUnlockDetail } from '@/lib/viewer-unlock-detail';

const revision = {
  id: 'revision-1',
  revision_number: 2,
  title: 'Purchased recipe',
  summary: 'Purchased summary',
  preview_text: 'Purchased preview',
  access_mode: 'paid',
  price_usd_cents: 500,
  prompt_text: 'Purchased prompt',
  notes_markdown: null,
  workflow_share_url: null,
  workflow_snapshot: null,
  attachments: [],
  allow_remix: false,
  resource_sections: [],
  resource_items: [],
  created_at: '2026-07-01T00:00:00.000Z',
};

const purchasedProofMedia = [
  {
    purchase_id: 'purchase-1',
    source_media_id: 'media-1',
    media_key: 'proof-one',
    storage_path: 'creator/post/one.jpg',
    external_url: null,
    preview_storage_path: 'creator/post/one-preview.jpg',
    preview_thumbhash: 'thumb-one',
    media_kind: 'image',
    content_type: 'image/jpeg',
    original_name: 'one.jpg',
    width: 800,
    height: 1000,
    duration_seconds: null,
    sort_order: 0,
  },
  {
    purchase_id: 'purchase-1',
    source_media_id: 'media-2',
    media_key: 'proof-two',
    storage_path: 'creator/post/two.mp4',
    external_url: null,
    preview_storage_path: 'creator/post/two-preview.jpg',
    preview_thumbhash: 'thumb-two',
    media_kind: 'video',
    content_type: 'video/mp4',
    original_name: 'two.mp4',
    width: 1080,
    height: 1920,
    duration_seconds: 12,
    sort_order: 1,
  },
];

function adminClient(
  projection: Record<string, unknown>,
  proofRows: Record<string, unknown>[] = purchasedProofMedia,
  revisionRow: Record<string, unknown> = revision,
) {
  return {
    rpc: vi.fn(async () => ({ data: [projection], error: null })),
    from: vi.fn((table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => {
          if (table === 'post_resource_bundle_revisions') return { data: revisionRow, error: null };
          if (table === 'post_resource_bundle_revision_supplements') return { data: null, error: null };
          return { data: null, error: null };
        },
        order: async () => table === 'post_resource_purchase_media'
          ? { data: proofRows, error: null }
          : { data: [], error: null },
      };
      return query;
    }),
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example.test/${path}` } }),
      })),
    },
  };
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    purchase_id: 'purchase-1',
    bundle_id: null,
    post_id: null,
    revision_id: 'revision-1',
    purchased_at: '2026-07-02T00:00:00.000Z',
    purchase_price_usd_cents: 500,
    seller_display_name: 'Creator',
    captured_post_title: 'Original post',
    bundle_retired: true,
    post_tombstoned: true,
    post_visibility: null,
    post_review_status: null,
    current_revision_id: null,
    purchased_revision_number: 2,
    current_revision_number: null,
    ...overrides,
  };
}

describe('viewer unlock proof media', () => {
  beforeEach(() => {
    getLiveDetail.mockReset();
    loadMediaItems.mockReset();
    getLiveDetail.mockResolvedValue(null);
    loadMediaItems.mockResolvedValue(new Map());
  });

  it('retains stable scoped-output identity for a detached purchase', async () => {
    const result = await getViewerUnlockDetail({
      adminSupabase: adminClient(projection()) as never,
      unlockId: 'purchase-1',
      viewerUserId: 'buyer-1',
    });

    expect(result?.detached).toBe(true);
    expect(result?.salesCount).toBeNull();
    expect(result?.mediaItems.map((item) => [item.mediaKey, item.sortOrder, item.mediaKind])).toEqual([
      ['proof-one', 0, 'image'],
      ['proof-two', 1, 'video'],
    ]);
    expect(result?.purchasedRevision.mediaItems).toEqual(result?.mediaItems);
    // Account deletion removes creator-owned showcase objects. The stable
    // identity remains usable with numbered placeholders instead of broken URLs.
    expect(result?.mediaItems.every((item) => item.url === '')).toBe(true);
  });

  it('uses the full live media array for a retained tombstoned post', async () => {
    const liveMedia = [
      { id: 'current-1', mediaKey: 'proof-one', url: 'https://cdn.example.test/current.jpg', mediaKind: 'image', contentType: 'image/jpeg', originalName: 'current.jpg', width: 800, height: 1000, durationSeconds: null, sortOrder: 0 },
      { id: 'current-2', mediaKey: 'proof-two', url: 'https://cdn.example.test/current.mp4', mediaKind: 'video', contentType: 'video/mp4', originalName: 'current.mp4', width: 1080, height: 1920, durationSeconds: 12, sortOrder: 1 },
    ];
    getLiveDetail.mockResolvedValue({
      title: 'Latest recipe',
      summary: 'Latest summary',
      previewText: 'Latest preview',
      accessMode: 'paid',
      priceUsdCents: 900,
      salesCount: 7,
      resources: { ...revision, promptText: 'Latest prompt', attachments: [], items: [], sections: [] },
      seller: { name: 'Creator' },
      retiredAt: null,
      tombstoned: true,
      post: { id: 'post-1' },
    });
    loadMediaItems.mockResolvedValue(new Map([['post-1', liveMedia]]));

    const result = await getViewerUnlockDetail({
      adminSupabase: adminClient(projection({ bundle_id: 'bundle-1', post_id: 'post-1' })) as never,
      unlockId: 'purchase-1',
      viewerUserId: 'buyer-1',
    });

    expect(result?.detached).toBe(false);
    expect(result?.tombstoned).toBe(true);
    expect(result?.salesCount).toBe(7);
    expect(result?.mediaItems).toEqual(liveMedia);
    expect(result?.purchasedRevision.mediaItems[0]).toMatchObject({
      mediaKey: 'proof-one',
      previewUrl: 'https://cdn.example.test/creator/post/one-preview.jpg',
    });
  });

  it('does not mix purchased proof media into a latest revision with an empty gallery', async () => {
    getLiveDetail.mockResolvedValue({
      title: 'Latest recipe',
      summary: 'Latest summary',
      previewText: 'Latest preview',
      accessMode: 'paid',
      priceUsdCents: 900,
      salesCount: 7,
      resources: { ...revision, promptText: 'Latest prompt', attachments: [], items: [], sections: [] },
      seller: { name: 'Creator' },
      retiredAt: null,
      tombstoned: false,
      post: { id: 'post-1' },
    });
    loadMediaItems.mockResolvedValue(new Map([['post-1', []]]));

    const result = await getViewerUnlockDetail({
      adminSupabase: adminClient(projection({ bundle_id: 'bundle-1', post_id: 'post-1' })) as never,
      unlockId: 'purchase-1',
      viewerUserId: 'buyer-1',
    });

    expect(result?.mediaItems).toEqual([]);
    expect(result?.purchasedRevision.mediaItems).toHaveLength(2);
  });

  it('reconstructs numbered scope targets for purchases detached before the snapshot migration', async () => {
    const result = await getViewerUnlockDetail({
      adminSupabase: adminClient(
        projection(),
        [],
        {
          ...revision,
          resource_sections: [{
            id: 'scoped-card',
            title: 'Scoped card',
            kind: 'asset_group',
            sortOrder: 0,
            scope: { kind: 'media', mediaKeys: ['proof-two', 'proof-one'] },
          }],
          resource_items: [{
            id: 'prompt-1',
            type: 'prompt',
            title: 'Prompt',
            textContent: 'Purchased prompt',
            sectionId: 'scoped-card',
            scope: { kind: 'media', mediaKeys: ['proof-two', 'proof-one'] },
            sortOrder: 0,
          }],
        },
      ) as never,
      unlockId: 'purchase-1',
      viewerUserId: 'buyer-1',
    });

    expect(result?.mediaItems.map((item) => item.mediaKey)).toEqual(['proof-two', 'proof-one']);
    expect(result?.mediaItems.every((item) => item.url === '')).toBe(true);
  });
});
