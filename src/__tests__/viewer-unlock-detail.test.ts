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
import { createViewerUnlockFileUrl } from '@/lib/viewer-unlock-file-url-service';

const UNLOCK_ID = '11111111-1111-4111-8111-111111111111';

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
  {
    nsfwPostIds = [] as string[],
    payment = null as Record<string, unknown> | null,
    blocked = false,
    blockError = null as Error | null,
  } = {},
) {
  const createSignedUrl = vi.fn(async (path: string) => ({
    data: { signedUrl: `https://signed.example.test/${path}` },
    error: null,
  }));
  // Reads that are awaited as lists: the NSFW flag, the payment and blocks.
  const listFor = (table: string, inFilter: unknown[]) => {
    if (table === 'posts') {
      return { data: (inFilter as string[]).map((id) => ({ id, is_nsfw: nsfwPostIds.includes(id) })), error: null };
    }
    if (table === 'post_resource_bundle_purchases') return { data: payment ? [payment] : [], error: null };
    if (table === 'user_blocks') {
      if (blockError) return { data: null, error: blockError };
      return { data: blocked ? [{ blocked_user_id: 'creator-1', blocker_user_id: 'creator-1' }] : [], error: null };
    }
    return { data: [], error: null };
  };
  return {
    rpc: vi.fn(async (name: string) => (name === 'check_backend_rate_limit'
      ? { data: { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0 }, error: null }
      : { data: [projection], error: null })),
    from: vi.fn((table: string) => {
      let inFilter: unknown[] = [];
      const query = {
        select: () => query,
        eq: () => query,
        in: (_column: string, values: unknown[]) => {
          inFilter = values;
          return query;
        },
        maybeSingle: async () => {
          if (table === 'post_resource_bundle_revisions') return { data: revisionRow, error: null };
          if (table === 'post_resource_bundle_revision_supplements') return { data: null, error: null };
          return { data: null, error: null };
        },
        order: async () => table === 'post_resource_purchase_media'
          ? { data: proofRows, error: null }
          : { data: [], error: null },
        then: (
          onFulfilled: (value: { data: unknown; error: unknown }) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => Promise.resolve(listFor(table, inFilter)).then(onFulfilled, onRejected),
      };
      return query;
    }),
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.example.test/${path}` } }),
        createSignedUrl,
      })),
    },
    createSignedUrl,
  };
}

/** The bundle loader's answer for a buyer whose post is still live. */
function liveDetail(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Latest recipe',
    summary: 'Latest summary',
    previewText: 'Latest preview',
    accessMode: 'paid',
    priceUsdCents: 900,
    salesCount: 7,
    resources: {
      promptText: 'Latest prompt',
      notesMarkdown: null,
      workflowShareUrl: null,
      workflowSnapshot: null,
      allowRemix: false,
      attachments: [],
      sections: [],
      items: [{
        id: 'guide',
        type: 'file',
        title: 'Latest guide',
        storagePath: 'creator-1/resources/latest-guide.pdf',
        contentType: 'application/pdf',
        sortOrder: 0,
      }],
    },
    seller: { id: 'creator-1', name: 'Creator' },
    retiredAt: null,
    tombstoned: false,
    post: {
      id: 'post-1',
      visibility: 'public',
      archivedAt: null,
      tombstoned: false,
      mediaUrl: '/api/media?bucket=post_media&path=private-posts%2Fpost-1%2Foriginal.png',
      mediaPreviewUrl: null,
      mediaKind: 'image',
    },
    ...overrides,
  };
}

const liveProjection = (overrides: Record<string, unknown> = {}) => projection({
  bundle_id: 'bundle-1',
  post_id: 'post-1',
  bundle_retired: false,
  post_tombstoned: false,
  post_visibility: 'public',
  current_revision_id: 'revision-1',
  current_revision_number: 2,
  ...overrides,
});

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
      unlockId: UNLOCK_ID,
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
      unlockId: UNLOCK_ID,
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
      unlockId: UNLOCK_ID,
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
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });

    expect(result?.mediaItems.map((item) => item.mediaKey)).toEqual(['proof-two', 'proof-one']);
    expect(result?.mediaItems.every((item) => item.url === '')).toBe(true);
  });
});

describe('viewer unlock entitlement and state', () => {
  beforeEach(() => {
    getLiveDetail.mockReset();
    loadMediaItems.mockReset();
    getLiveDetail.mockResolvedValue(liveDetail());
    loadMediaItems.mockResolvedValue(new Map());
  });

  it('opens an NSFW purchase without a reveal: live bundle, current files signed, not detached, flagged', async () => {
    const admin = adminClient(liveProjection(), purchasedProofMedia, revision, { nsfwPostIds: ['post-1'] });

    const detail = await getViewerUnlockDetail({
      adminSupabase: admin as never,
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });

    // The buyer's own purchase skips the reveal gate; the loader's purchase
    // lookup is what lets them through (post-resource-bundles-server.test.ts).
    expect(getLiveDetail).toHaveBeenCalledWith('post-1', expect.objectContaining({
      viewerUserId: 'buyer-1',
      isNsfw: true,
      entitledPurchase: true,
    }));
    expect(detail).toMatchObject({ detached: false, isNsfw: true, creatorUserId: 'creator-1' });
    expect(detail?.currentResources?.items?.[0].storagePath).toBe('creator-1/resources/latest-guide.pdf');

    const signed = await createViewerUnlockFileUrl({
      adminSupabase: admin as never,
      body: { storagePath: 'creator-1/resources/latest-guide.pdf' },
      countryCode: null,
      rateLimitKey: 'buyer-1',
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });

    expect(signed).toEqual({
      ok: true,
      body: { success: true, signedUrl: 'https://signed.example.test/creator-1/resources/latest-guide.pdf' },
    });
    // Signed where the creator keeps it, never looked up as a retained copy.
    expect(admin.storage.from).toHaveBeenCalledWith('post_resource_files');
    expect(admin.from).not.toHaveBeenCalledWith('post_resource_bundle_revision_files');
  });

  it('carries the live recipe\'s paid sales and free unlocks apart, and neither once detached', async () => {
    getLiveDetail.mockResolvedValue(liveDetail({ accessMode: 'free', priceUsdCents: 0, salesCount: 2, freeUnlockCount: 9 }));

    const live = await getViewerUnlockDetail({
      adminSupabase: adminClient(liveProjection()) as never,
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });
    expect(live).toMatchObject({ salesCount: 2, freeUnlockCount: 9 });

    getLiveDetail.mockResolvedValue(null);
    const detached = await getViewerUnlockDetail({
      adminSupabase: adminClient(projection()) as never,
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });
    expect(detached).toMatchObject({ detached: true, salesCount: null, freeUnlockCount: null });
  });

  it('falls back to the purchased version when the live read comes back empty, without calling it detached', async () => {
    getLiveDetail.mockResolvedValue(null);

    const detail = await getViewerUnlockDetail({
      adminSupabase: adminClient(liveProjection()) as never,
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });

    expect(detail).toMatchObject({ detached: false, currentResources: null, post: null, postReachable: false });
    expect(detail?.purchasedRevision.resources.promptText).toBe('Purchased prompt');
    expect(detail?.mediaItems).toEqual(detail?.purchasedRevision.mediaItems);
    // Still attached, so the snapshot keeps its addresses.
    expect(detail?.mediaItems[0].previewUrl).toBe('https://cdn.example.test/creator/post/one-preview.jpg');
  });

  it('flags nothing for a post without an NSFW label', async () => {
    const detail = await getViewerUnlockDetail({
      adminSupabase: adminClient(liveProjection()) as never,
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });

    expect(detail?.isNsfw).toBe(false);
    expect(getLiveDetail).toHaveBeenCalledWith('post-1', expect.objectContaining({ isNsfw: false }));
  });

  it('draws the cover from the first media item\'s preview', async () => {
    loadMediaItems.mockResolvedValue(new Map([['post-1', [
      { id: 'current-1', mediaKey: 'proof-one', url: 'https://cdn.example.test/current.mp4', previewUrl: 'https://cdn.example.test/current-poster.webp', mediaKind: 'video', contentType: 'video/mp4', originalName: null, width: 1080, height: 1920, durationSeconds: 12, sortOrder: 0 },
      { id: 'current-2', mediaKey: 'proof-two', url: 'https://cdn.example.test/second.jpg', previewUrl: 'https://cdn.example.test/second-preview.webp', mediaKind: 'image', contentType: 'image/jpeg', originalName: null, width: 800, height: 1000, durationSeconds: null, sortOrder: 1 },
    ]]]));

    const detail = await getViewerUnlockDetail({
      adminSupabase: adminClient(liveProjection()) as never,
      unlockId: UNLOCK_ID,
      viewerUserId: 'buyer-1',
    });

    expect(detail?.post).toMatchObject({
      id: 'post-1',
      mediaUrl: '/api/media?bucket=post_media&path=private-posts%2Fpost-1%2Foriginal.png',
      mediaPreviewUrl: 'https://cdn.example.test/current-poster.webp',
    });
  });

  describe('postReachable', () => {
    it('is true for a public post with no block either way', async () => {
      const admin = adminClient(liveProjection());

      const detail = await getViewerUnlockDetail({ adminSupabase: admin as never, unlockId: UNLOCK_ID, viewerUserId: 'buyer-1' });

      expect(detail?.postReachable).toBe(true);
      expect(admin.from).toHaveBeenCalledWith('user_blocks');
    });

    it('is false across a block', async () => {
      const detail = await getViewerUnlockDetail({
        adminSupabase: adminClient(liveProjection(), purchasedProofMedia, revision, { blocked: true }) as never,
        unlockId: UNLOCK_ID,
        viewerUserId: 'buyer-1',
      });

      // The buyer keeps the unlock; only the way to the post closes.
      expect(detail).toMatchObject({ postReachable: false, detached: false });
      expect(detail?.currentResources).not.toBeNull();
    });

    it('is false when the block state cannot be read', async () => {
      const detail = await getViewerUnlockDetail({
        adminSupabase: adminClient(liveProjection(), purchasedProofMedia, revision, { blockError: new Error('blocks unavailable') }) as never,
        unlockId: UNLOCK_ID,
        viewerUserId: 'buyer-1',
      });

      expect(detail?.postReachable).toBe(false);
    });

    it('is false for a private, archived or deleted post, without asking about blocks', async () => {
      for (const post of [
        { visibility: 'private' },
        { archivedAt: '2026-07-02T00:00:00.000Z' },
        { tombstoned: true },
      ]) {
        getLiveDetail.mockResolvedValue(liveDetail({ post: { ...liveDetail().post, ...post } }));
        const admin = adminClient(liveProjection());

        const detail = await getViewerUnlockDetail({ adminSupabase: admin as never, unlockId: UNLOCK_ID, viewerUserId: 'buyer-1' });

        expect(detail?.postReachable).toBe(false);
        expect(admin.from).not.toHaveBeenCalledWith('user_blocks');
      }
    });

    it('is true for an unlisted post', async () => {
      getLiveDetail.mockResolvedValue(liveDetail({ post: { ...liveDetail().post, visibility: 'unlisted' } }));

      const detail = await getViewerUnlockDetail({
        adminSupabase: adminClient(liveProjection()) as never,
        unlockId: UNLOCK_ID,
        viewerUserId: 'buyer-1',
      });

      expect(detail?.postReachable).toBe(true);
    });
  });

  it('says what the buyer paid: cash, credits or free', async () => {
    const cases = [
      [
        { id: 'purchase-1', price_usd_cents: 900, amount_subunits: 75000, currency: 'INR', checkout: { razorpay_order_id: 'order_Qx81' } },
        { paidWith: 'cash', paidAmountSubunits: 75000, paidCurrency: 'INR' },
      ],
      [
        { id: 'purchase-1', price_usd_cents: 900, amount_subunits: 900, currency: 'USD', checkout: { razorpay_order_id: 'credits_bundle_bundle-1_buyer-1' } },
        { paidWith: 'credits', paidAmountSubunits: 900, paidCurrency: null },
      ],
      [
        { id: 'purchase-1', price_usd_cents: 0, amount_subunits: 0, currency: 'USD', checkout: { razorpay_order_id: 'free_bundle_abc' } },
        { paidWith: 'free', paidAmountSubunits: null, paidCurrency: null },
      ],
    ] as const;

    for (const [payment, expected] of cases) {
      const detail = await getViewerUnlockDetail({
        adminSupabase: adminClient(liveProjection(), purchasedProofMedia, revision, { payment }) as never,
        unlockId: UNLOCK_ID,
        viewerUserId: 'buyer-1',
      });

      expect(detail).toMatchObject(expected);
    }
  });

  it('answers a malformed id as no unlock, without asking the database', async () => {
    const admin = adminClient(liveProjection());

    await expect(getViewerUnlockDetail({
      adminSupabase: admin as never,
      unlockId: 'not-a-purchase-id',
      viewerUserId: 'buyer-1',
    })).resolves.toBeNull();
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
