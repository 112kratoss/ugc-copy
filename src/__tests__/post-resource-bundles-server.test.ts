import { beforeEach, describe, expect, it, vi } from 'vitest';

type BundleRow = {
  id: string;
  post_id: string;
  owner_user_id: string;
  legacy_asset_id: string | null;
  access_mode: 'free' | 'paid';
  status: 'published';
  title: string;
  summary: string;
  preview_text: string;
  prompt_text: string | null;
  notes_markdown: string | null;
  workflow_share_url: string | null;
  workflow_snapshot: null;
  attachments: unknown[];
  allow_remix: boolean;
  resource_sections: unknown[];
  resource_items: unknown[];
  price_usd_cents: number;
  sales_count: number;
  earnings_usd_cents: number;
  created_at: string;
  updated_at: string;
};

let bundleRow: BundleRow | null;
let generationRow: {
  id: string;
  user_id: string | null;
  is_public: boolean | null;
  share_input_media_for_remix: boolean | null;
  model: string | null;
  category: string | null;
  prompt: string | null;
  workflow_settings: Record<string, unknown> | null;
} | null;
let generationInputRows: Array<{
  id: string;
  generation_id: string;
  user_id: string;
  media_type: 'image' | 'video' | 'audio';
  role: string;
  label: string | null;
  storage_path: string;
  source_generation_id: string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
}>;
let viewerHasPurchased: boolean;
let bundlePresenceError: unknown;
let postRow: Record<string, unknown> | null;
let purchasedRevisionRow: Record<string, unknown> | null;
let purchasedMediaRows: Record<string, unknown>[];

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === 'get_purchased_post_resource_bundle_revision') {
        // The projection is buyer-scoped; returning nothing for anyone else is
        // what the SQL does too.
        const isBuyer = args.p_buyer_user_id === 'buyer-1';
        return { data: isBuyer && purchasedRevisionRow ? [purchasedRevisionRow] : [], error: null };
      }

      throw new Error(`Unexpected rpc: ${name}`);
    },
    storage: {
      from: vi.fn(() => ({
        getPublicUrl: (filePath: string) => ({
          data: { publicUrl: `https://public.example.com/${filePath}` },
        }),
        createSignedUrl: vi.fn(async (filePath: string) => ({
          data: { signedUrl: `https://signed.example.com/${filePath}` },
          error: null,
        })),
        createSignedUrls: vi.fn(async (filePaths: string[]) => ({
          data: filePaths.map((filePath) => ({
            error: null,
            path: filePath,
            signedUrl: `https://signed.example.com/${filePath}`,
          })),
          error: null,
        })),
      })),
    },
    from(table: string) {
      if (table === 'post_resource_bundles') {
        let checksPresence = false;
        const query = {
          select() {
            return query;
          },
          in() {
            checksPresence = true;
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: bundleRow,
              error: null,
            };
          },
          then(resolve: (value: { data: unknown[] | null; error: unknown }) => void) {
            resolve({
              data: checksPresence && bundleRow ? [{ post_id: bundleRow.post_id }] : [],
              error: checksPresence ? bundlePresenceError : null,
            });
          },
        };

        return query;
      }

      if (table === 'post_resource_bundle_purchases') {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: viewerHasPurchased
                ? { id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'viewer-1' }
                : null,
              error: null,
            };
          },
        };

        return query;
      }

      if (table === 'post_resource_purchase_media') {
        const query = {
          select() { return query; },
          eq() { return query; },
          async order() { return { data: purchasedMediaRows, error: null }; },
        };
        return query;
      }

      if (table === 'profiles') {
        return {
          select() {
            return {
              async in() {
                return {
                  data: [{
                    id: 'owner-1',
                    username: 'creator',
                    display_name: 'Creator',
                    avatar_url: null,
                  }],
                  error: null,
                };
              },
            };
          },
        };
      }

      if (table === 'posts') {
        let eqId: string | null = null;
        const equalityFilters: Record<string, unknown> = {};
        const nullFilters: string[] = [];

        // The service narrows post visibility per viewer scope; the mock has to
        // honour those filters or an entitlement test proves nothing.
        const matchesFilters = () => {
          if (!postRow) return false;
          if (nullFilters.some((column) => postRow?.[column] != null)) return false;
          return Object.entries(equalityFilters).every(([column, value]) => postRow?.[column] === value);
        };

        const query = {
          select() {
            return query;
          },
          in() {
            return query;
          },
          eq(column?: string, value?: unknown) {
            if (column === 'id' && typeof value === 'string') {
              eqId = value;
            } else if (column) {
              equalityFilters[column] = value;
            }
            return query;
          },
          is(column?: string) {
            if (column) {
              nullFilters.push(column);
            }
            return query;
          },
          neq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: eqId === 'post-1' && matchesFilters() ? postRow : null,
              error: null,
            };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            resolve({
              data: matchesFilters() && postRow ? [postRow] : [],
              error: null,
            });
          },
        };

        return query;
      }

      if (table === 'generations') {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return {
                      data: generationRow,
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (table === 'generation_input_media') {
        let generationIds: unknown[] = [];

        const query = {
          select() {
            return query;
          },
          in(column: string, values: unknown[]) {
            if (column === 'generation_id') {
              generationIds = values;
            }
            return query;
          },
          async order() {
            return {
              data: generationInputRows.filter((row) => generationIds.includes(row.generation_id)),
              error: null,
            };
          },
        };

        return {
          select: query.select,
          in: query.in,
          order: query.order,
        };
      }

      throw new Error(`Unexpected table access: ${table}`);
    },
  }),
}));

describe('post resource bundle server access', () => {
  it('commits post, bundle, and proof media through the combined mutation RPC', async () => {
    const rpc = vi.fn(async () => ({
      data: {
        post_id: 'post-1',
        visibility: 'private',
        bundle_id: 'bundle-1',
        bundle_status: 'draft',
      },
      error: null,
    }));
    const { updatePostWithResourceBundleAtomically } = await import('@/lib/post-resource-bundles-server');

    await updatePostWithResourceBundleAtomically({
      supabase: { rpc } as never,
      postId: 'post-1',
      ownerUserId: 'user-1',
      patch: { title: 'Atomic edit' },
      hasBundlePayload: false,
      bundle: null,
      mediaItems: [{
        mediaKey: 'proof-new',
        storagePath: 'posts/post-1/new.jpg',
        mediaKind: 'image',
        contentType: 'image/jpeg',
        originalName: 'new.jpg',
        sortOrder: 0,
      }],
    });

    expect(rpc).toHaveBeenCalledWith('update_post_with_resource_bundle_and_media', {
      p_post_id: 'post-1',
      p_owner_user_id: 'user-1',
      p_post_patch: { title: 'Atomic edit' },
      p_has_bundle: false,
      p_bundle: null,
      p_media_items: [expect.objectContaining({ mediaKey: 'proof-new' })],
    });
  });

  beforeEach(() => {
    vi.resetModules();
    bundleRow = {
      id: 'bundle-1',
      post_id: 'post-1',
      owner_user_id: 'owner-1',
      legacy_asset_id: null,
      access_mode: 'free',
      status: 'published',
      title: 'Creation recipe',
      summary: 'Public recipe resources.',
      preview_text: 'Prompt, notes, and references.',
      prompt_text: 'Public prompt text',
      notes_markdown: 'Public notes',
      workflow_share_url: null,
      workflow_snapshot: null,
      attachments: [],
      allow_remix: false,
      resource_sections: [],
      resource_items: [
        {
          type: 'prompt',
          title: 'Prompt',
          textContent: 'Public prompt text',
        },
        {
          type: 'reference_image',
          title: 'Reference image',
          storagePath: 'owner-1/generation-references/gen-1/input.png',
          contentType: 'image/png',
        },
      ],
      price_usd_cents: 0,
      sales_count: 0,
      earnings_usd_cents: 0,
      created_at: '2026-06-05T00:00:00.000Z',
      updated_at: '2026-06-05T00:00:00.000Z',
    };
    generationRow = {
      id: 'gen-1',
      user_id: 'owner-1',
      is_public: true,
      share_input_media_for_remix: true,
      model: 'nano-banana-2',
      category: 'image',
      prompt: 'Public generated prompt',
      workflow_settings: {
        model: 'nano-banana-2',
        aspectRatio: '9:16',
      },
    };
    generationInputRows = [{
      id: 'input-1',
      generation_id: 'gen-1',
      user_id: 'owner-1',
      media_type: 'image',
      role: 'reference_image',
      label: 'Image input',
      storage_path: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      source_generation_id: null,
      sort_order: 0,
      metadata: {},
    }];
    viewerHasPurchased = false;
    bundlePresenceError = null;
    postRow = {
      id: 'post-1',
      user_id: 'owner-1',
      generation_id: 'gen-1',
      title: 'Public recipe post',
      body: 'A visible result.',
      prompt: 'Post prompt fallback',
      category: 'image',
      post_format: 'media',
      visibility: 'public',
      archived_at: null,
      tombstoned_at: null,
      review_status: 'visible',
      showcase_asset_path: null,
      output_url: null,
      source_kind: 'magicbooklet',
      source_tool: 'magicbooklet',
      source_tool_slug: 'magicbooklet',
      save_count: 0,
      remix_count: 0,
      share_visit_count: 0,
      created_at: '2026-06-05T00:00:00.000Z',
    };
    purchasedRevisionRow = null;
    purchasedMediaRows = [{
      purchase_id: 'purchase-1',
      source_media_id: 'proof-media-1',
      media_key: 'purchased-output-1',
      storage_path: 'owner-1/posts/original.png',
      external_url: null,
      preview_storage_path: 'owner-1/posts/original-preview.png',
      preview_thumbhash: 'thumbhash-original',
      media_kind: 'image',
      content_type: 'image/png',
      original_name: 'original.png',
      width: 800,
      height: 1000,
      duration_seconds: null,
      sort_order: 0,
    }];
  });

  it('keeps a published free recipe gated until the viewer adds it', async () => {
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(false);
    expect(detail?.resources).toBeNull();
  });

  it('grants access on entitlement alone, never on the shape of the bundle id', async () => {
    // A legacy branch granted access to any published bundle whose id started
    // with 'generation-recipe:'. post_resource_bundles.id is a uuid column, so
    // no such row can exist, and nothing in the app constructs that id any more
    // -- synthetic feed recipes are resolved in showcase-feed, never here. The
    // clause was unreachable, but "grant access if the id looks special" has no
    // business inside an entitlement predicate, so it is gone. This pins that.
    bundleRow = {
      ...(bundleRow as BundleRow),
      id: 'generation-recipe:post-1',
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(false);
    expect(detail?.resources).toBeNull();
  });

  it('keeps published paid recipe resources locked before purchase', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(false);
    expect(detail?.resources).toBeNull();
    expect(detail?.lockedPreview.itemCounts).toMatchObject({
      prompt: 1,
      reference_image: 1,
    });
  });

  it('does not expose paid remix inputs before the viewer purchases the bundle', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import(
      '@/lib/post-resource-bundles-server'
    );

    await expect(loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    })).resolves.toEqual([]);
  });

  it('exposes paid remix inputs only after purchase and explicit remix opt-in', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    viewerHasPurchased = true;
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import(
      '@/lib/post-resource-bundles-server'
    );

    const media = await loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    });

    expect(media).toEqual([
      expect.objectContaining({
        id: 'input-1',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
        url: 'https://signed.example.com/owner-1/gen-1/00-reference-image.png',
      }),
    ]);
  });

  it('does not expose remix inputs when the bundle owner disabled remixing', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'free',
      allow_remix: false,
    };
    const { loadGenerationRecipeRemixInputMediaByPostId } = await import(
      '@/lib/post-resource-bundles-server'
    );

    await expect(loadGenerationRecipeRemixInputMediaByPostId({
      postId: 'post-1',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    })).resolves.toEqual([]);
  });

  it('surfaces saved references in the unlocked bundle after purchase', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reference_image',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      }),
    ]));
  });

  it('shows buyers the references even when remix restoration is not shared', async () => {
    // share_input_media_for_remix gates restoring the files into a remix, not
    // seeing them in an unlock the viewer paid for — no product surface sets
    // the flag today, so gating display on it would hide references from
    // every buyer.
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      share_input_media_for_remix: false,
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reference_image',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      }),
    ]));
  });

  it('withholds live references from non-owners once the generation is no longer public', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      access_mode: 'paid',
      price_usd_cents: 900,
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      is_public: false,
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.items?.some(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    )).toBe(false);
  });

  it('always shows the owner their own saved references', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      is_public: false,
      share_input_media_for_remix: false,
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'owner-1',
    });

    expect(detail?.viewerIsOwner).toBe(true);
    expect(detail?.resources?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reference_image',
        storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      }),
    ]));
  });

  it('keeps references out of bundles whose creator disabled remixing', async () => {
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    // allow_remix stays false from the fixture.
    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.items?.some(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    )).toBe(false);
  });

  it('refuses to attach references from a generation the post creator does not own', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
    };
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      user_id: 'someone-else',
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    expect(detail?.resources?.items?.some(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    )).toBe(false);
  });

  it('does not duplicate a reference the bundle already stores', async () => {
    bundleRow = {
      ...(bundleRow as BundleRow),
      allow_remix: true,
      resource_items: [
        {
          type: 'reference_image',
          title: 'Reference image',
          storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
          contentType: 'image/png',
        },
      ],
    };
    viewerHasPurchased = true;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: 'viewer-1',
    });

    const matches = (detail?.resources?.items ?? []).filter(
      (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
    );
    expect(matches).toHaveLength(1);
  });

  it('does not infer a public recipe when no saved bundle exists', async () => {
    bundleRow = null;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail).toBeNull();
  });

  it('keeps legacy workflow references private when no recipe was saved', async () => {
    bundleRow = null;
    generationInputRows = [];
    generationRow = {
      ...(generationRow as NonNullable<typeof generationRow>),
      workflow_settings: {
        model: 'nano-banana-2',
        elements: [{
          id: 'element-1',
          displayName: 'Image input',
          handle: '@alisa',
          storagePath: 'generation_inputs/owner-1/gen-1/legacy-reference.png',
        }],
      },
    };
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail).toBeNull();
  });

  it('requires a deliberately claimed profile before any public post publish', async () => {
    const { getMarketplaceQualityErrorForPostBundle } = await import('@/lib/post-resource-bundles-server');
    const profileClient = {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                username: 'creator-a1b2c3d4',
                display_name: 'New Creator',
                avatar_url: null,
              },
              error: null,
            };
          },
        };
        return query;
      },
    };

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: null,
    })).resolves.toMatch(/custom handle/i);
  });

  it('allows a claimed public profile without an avatar until an unlock is attached', async () => {
    const { getMarketplaceQualityErrorForPostBundle } = await import('@/lib/post-resource-bundles-server');
    const profileClient = {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return {
              data: {
                username: 'launch-maker',
                display_name: 'Launch Maker',
                avatar_url: null,
              },
              error: null,
            };
          },
        };
        return query;
      },
    };

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: null,
    })).resolves.toBeNull();

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: { accessMode: 'free' },
    })).resolves.toMatch(/profile photo/i);
  });

  it('distinguishes profile lookup failures from incomplete profiles', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getMarketplaceQualityErrorForPostBundle } = await import('@/lib/post-resource-bundles-server');
    const profileClient = {
      from() {
        const query = {
          select() { return query; },
          eq() { return query; },
          async maybeSingle() {
            return { data: null, error: new Error('database unavailable') };
          },
        };
        return query;
      },
    };

    await expect(getMarketplaceQualityErrorForPostBundle({
      supabase: profileClient as never,
      ownerUserId: 'owner-1',
      post: { visibility: 'public', body: 'A useful public post.' },
      bundle: null,
    })).resolves.toBe('Could not verify your creator profile right now. Try again.');
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  describe('what a buyer keeps', () => {
    const editedRevision = {
      revision_number: 2,
      is_latest: false,
      content_fingerprint: 'fingerprint-of-what-they-bought',
      title: 'Launch hook recipe',
      summary: 'Original buyer-facing summary',
      preview_text: 'The version you unlocked.',
      access_mode: 'paid',
      price_usd_cents: 500,
      prompt_text: 'THE PROMPT THEY PAID FOR',
      notes_markdown: 'Notes they paid for',
      workflow_share_url: null,
      workflow_snapshot: null,
      attachments: [],
      allow_remix: false,
      resource_sections: [],
      resource_items: [
        { id: 'item-1', type: 'prompt', title: 'Prompt', textContent: 'THE PROMPT THEY PAID FOR', sortOrder: 0 },
      ],
      created_at: '2026-07-01T00:00:00.000Z',
    };

    it('offers the purchased revision once the creator edits a sold bundle', async () => {
      viewerHasPurchased = true;
      purchasedRevisionRow = editedRevision;
      bundleRow = { ...(bundleRow as BundleRow), prompt_text: 'Rewritten to something useless' };

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail?.viewerCanAccess).toBe(true);
      // Current content is still served -- honest edits reach buyers for free.
      expect(detail?.resources?.promptText).toBe('Rewritten to something useless');
      // ...but what they actually paid for stays retrievable.
      expect(detail?.purchasedRevision?.revisionNumber).toBe(2);
      expect(detail?.purchasedRevision).toMatchObject({
        title: 'Launch hook recipe',
        summary: 'Original buyer-facing summary',
        previewText: 'The version you unlocked.',
        accessMode: 'paid',
        priceUsdCents: 500,
      });
      expect(detail?.purchasedRevision?.resources.promptText).toBe('THE PROMPT THEY PAID FOR');
      expect(detail?.purchasedRevision?.mediaItems).toEqual([
        expect.objectContaining({
          mediaKey: 'purchased-output-1',
          url: 'https://public.example.com/owner-1/posts/original.png',
          previewUrl: 'https://public.example.com/owner-1/posts/original-preview.png',
        }),
      ]);
    });

    it('omits the purchased revision while the bundle is unchanged', async () => {
      viewerHasPurchased = true;
      purchasedRevisionRow = { ...editedRevision, is_latest: true };

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail?.purchasedRevision).toBeNull();
    });

    it('never hands a purchased revision to someone who has not bought it', async () => {
      viewerHasPurchased = false;
      purchasedRevisionRow = editedRevision;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1' });

      expect(detail?.viewerCanAccess).toBe(false);
      expect(detail?.resources).toBeNull();
      expect(detail?.purchasedRevision).toBeNull();
    });

    it('keeps a buyer reading after the creator deletes the post', async () => {
      // Tombstoned: private and archived, so every public surface drops it.
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail).not.toBeNull();
      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.tombstoned).toBe(true);
      expect(detail?.resources?.promptText).toBe('Public prompt text');
    });

    it('opens a retired bundle for its buyer after the creator removes the unlock', async () => {
      // Caught in live verification: the publish gate ran before the purchase
      // lookup, so a retired bundle (status 'draft') 404'd for the very buyers
      // whose entitlement it was supposed to preserve. The library listed the
      // unlock and opening it failed.
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft' as BundleRow['status'] };
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail).not.toBeNull();
      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.tombstoned).toBe(true);
    });

    it('still hides a retired bundle from someone who never bought it', async () => {
      bundleRow = { ...(bundleRow as BundleRow), status: 'draft' as BundleRow['status'] };
      viewerHasPurchased = false;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1' });

      expect(detail).toBeNull();
    });

    it('keeps reference media for a buyer once the post is tombstoned', async () => {
      // Deleting a post flips its generation to is_public=false, so a gate that
      // reads only that flag silently strips the references a buyer paid for at
      // the exact moment the tombstone promises to retain them.
      bundleRow = { ...(bundleRow as BundleRow), access_mode: 'paid', price_usd_cents: 900, allow_remix: true };
      generationRow = { ...(generationRow as NonNullable<typeof generationRow>), is_public: false };
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail?.viewerCanAccess).toBe(true);
      expect(detail?.resources?.items?.some(
        (item) => item.storagePath === 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      )).toBe(true);
    });

    it('hides a tombstoned post from everyone who did not buy it', async () => {
      postRow = {
        ...(postRow as Record<string, unknown>),
        visibility: 'private',
        archived_at: '2026-07-02T00:00:00.000Z',
        tombstoned_at: '2026-07-02T00:00:00.000Z',
      };
      viewerHasPurchased = false;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'stranger-1' });

      expect(detail).toBeNull();
    });

    it('retracts a buyer\'s access when moderation hides the post', async () => {
      // The one case where entitlement does not survive: violating content must
      // stop being served to everyone, buyers included.
      postRow = { ...(postRow as Record<string, unknown>), review_status: 'hidden' };
      viewerHasPurchased = true;

      const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');
      const detail = await getPostResourceBundleDetailByPostId('post-1', { viewerUserId: 'buyer-1' });

      expect(detail).toBeNull();
    });
  });

});
