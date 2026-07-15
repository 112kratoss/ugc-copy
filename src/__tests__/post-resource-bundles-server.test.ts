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

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    storage: {
      from: vi.fn(() => ({
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
                ? { bundle_id: 'bundle-1', buyer_user_id: 'viewer-1' }
                : null,
              error: null,
            };
          },
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
            }
            return query;
          },
          is() {
            return query;
          },
          neq() {
            return query;
          },
          async maybeSingle() {
            return {
              data: eqId === 'post-1'
                ? {
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
                  }
                : null,
              error: null,
            };
          },
          then(resolve: (value: { data: unknown[]; error: null }) => void) {
            resolve({
              data: [{
                id: 'post-1',
                generation_id: 'gen-1',
                title: 'Public recipe post',
                body: 'A visible result.',
                category: 'image',
                post_format: 'media',
                visibility: 'public',
                archived_at: null,
                review_status: 'visible',
                showcase_asset_path: null,
                output_url: null,
                source_kind: 'magicbooklet',
                source_tool: 'magicbooklet',
                source_tool_slug: 'magicbooklet',
                save_count: 0,
                remix_count: 0,
                share_visit_count: 0,
              }],
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
  });

  it('reveals published free recipe resources to anonymous viewers', async () => {
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail?.viewerCanAccess).toBe(true);
    expect(detail?.resources?.promptText).toBe('Public prompt text');
    expect(detail?.resources?.notesMarkdown).toBe('Public notes');
    expect(detail?.resources?.items?.find((item) => item.type === 'reference_image')).toMatchObject({
      type: 'reference_image',
      title: 'Reference image',
    });
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

  it('builds a public generation recipe when no saved bundle exists', async () => {
    bundleRow = null;
    const { getPostResourceBundleDetailByPostId } = await import('@/lib/post-resource-bundles-server');

    const detail = await getPostResourceBundleDetailByPostId('post-1', {
      viewerUserId: null,
    });

    expect(detail).toMatchObject({
      id: 'generation-recipe:post-1',
      postId: 'post-1',
      title: 'Creation recipe',
      accessMode: 'free',
      priceUsdCents: 0,
      viewerCanAccess: true,
      viewerIsOwner: false,
    });
    expect(detail?.resourceKinds).toEqual(['prompt', 'files', 'notes']);
    expect(detail?.lockedPreview.itemCounts).toMatchObject({
      prompt: 1,
      reference_image: 1,
      note: 1,
    });
    expect(detail?.resources?.items?.map((item) => item.type)).toEqual(['prompt', 'reference_image', 'note']);
    expect(detail?.resources?.items?.find((item) => item.type === 'prompt')?.textContent).toBe('Public generated prompt');
    expect(detail?.resources?.items?.find((item) => item.type === 'reference_image')).toMatchObject({
      title: 'Image input',
      storagePath: 'generation_inputs/owner-1/gen-1/00-reference-image.png',
      contentType: 'image/png',
    });
  });

  it('fails closed when bundle presence cannot be checked conclusively', async () => {
    bundlePresenceError = {
      code: 'XX000',
      message: 'temporary database failure',
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { getPublicGenerationRecipeAssetSummaryMap } = await import(
      '@/lib/post-resource-bundles-server'
    );

    const summaries = await getPublicGenerationRecipeAssetSummaryMap([{
      id: 'post-1',
      user_id: 'owner-1',
      generation_id: 'gen-1',
      prompt: 'Post prompt fallback',
      category: 'image',
      source_kind: 'magicbooklet',
    }]);

    expect(summaries.size).toBe(0);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to check existing post resource bundles before recipe fallback:',
      bundlePresenceError,
    );
  });

  it('builds public generation recipes from legacy workflow references when durable input rows are missing', async () => {
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

    expect(detail?.resourceKinds).toEqual(['prompt', 'files', 'notes', 'remix']);
    expect(detail?.lockedPreview.itemCounts).toMatchObject({
      prompt: 1,
      reference_image: 1,
      note: 1,
    });
    expect(detail?.resources?.items?.find((item) => item.type === 'reference_image')).toMatchObject({
      title: '@alisa',
      storagePath: 'generation_inputs/owner-1/gen-1/legacy-reference.png',
      remixUse: 'reference_only',
    });
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
});
