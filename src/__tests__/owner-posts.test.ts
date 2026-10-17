import { beforeEach, describe, expect, it, vi } from 'vitest';

const postRows = vi.hoisted(() => ({
  value: [
    {
      id: 'post-1',
      user_id: 'user-1',
      generation_id: null,
      visibility: 'private',
      archived_at: null,
      archived_by_user_id: null,
      output_url: null,
      showcase_asset_path: null,
      prompt: null,
      title: 'Editable post',
      description: '',
      body: 'A post made with multiple tools.',
      category: 'image',
      post_format: 'media',
      source_kind: 'external',
      source_tool: 'Higgsfield',
      source_tool_slug: 'higgsfield',
      comment_count: 7,
      created_at: '2026-06-01T00:00:00.000Z',
      updated_at: '2026-06-01T00:00:00.000Z',
    },
    {
      id: 'post-2',
      user_id: 'user-1',
      generation_id: null,
      visibility: 'private',
      archived_at: null,
      archived_by_user_id: null,
      output_url: null,
      showcase_asset_path: null,
      prompt: null,
      title: null,
      description: '',
      body: null,
      category: 'image',
      post_format: 'media',
      source_kind: 'magicbooklet',
      source_tool: null,
      source_tool_slug: null,
      comment_count: 0,
      created_at: '2026-06-02T00:00:00.000Z',
      updated_at: '2026-06-02T00:00:00.000Z',
    },
    {
      id: 'post-3',
      user_id: 'user-1',
      generation_id: 'gen-1',
      visibility: 'private',
      archived_at: null,
      archived_by_user_id: null,
      output_url: 'generated_images/user-1/out.png',
      showcase_asset_path: null,
      prompt: 'venom',
      title: 'Venom',
      description: '',
      body: null,
      category: 'image',
      post_format: 'media',
      source_kind: 'magicbooklet',
      source_tool: null,
      source_tool_slug: null,
      comment_count: 0,
      created_at: '2026-06-03T00:00:00.000Z',
      updated_at: '2026-06-03T00:00:00.000Z',
    },
  ],
}));

const generationRows = vi.hoisted(() => ({
  value: [
    {
      id: 'gen-1',
      user_id: 'user-1',
      model: 'nano-banana-2',
      preview_url: 'generated_images/user-1/gen-1.preview.webp',
      preview_width: 832,
      preview_height: 1248,
      category: 'image',
    },
  ],
}));

const sourceToolRows = vi.hoisted(() => ({
  value: [
    {
      post_id: 'post-1',
      tool_label: 'Higgsfield',
      tool_slug: 'higgsfield',
      model_label: 'Soul',
      model_slug: 'soul',
      sort_order: 0,
    },
    {
      post_id: 'post-1',
      tool_label: 'Runway',
      tool_slug: 'runway',
      model_label: 'Gen-4',
      model_slug: 'gen-4',
      sort_order: 1,
    },
  ],
}));
const createServiceClientMock = vi.hoisted(() => vi.fn());
// Recipes attached to posts, as `post_resource_bundles` rows.
const bundleRows = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
// The owner's profile, which the listing check reads for the seller identity.
const sellerProfile = vi.hoisted(() => ({
  value: null as Record<string, unknown> | null,
  error: null as unknown,
}));
// Production lists bundles through the compact summary RPC; without it the
// service falls back to selecting the bundle rows.
const compactSummaryRpc = vi.hoisted(() => ({ enabled: false }));
const initialPostRows = postRows.value.slice();

function pickColumns(row: Record<string, unknown>, selectedColumns: string) {
  const columns = selectedColumns.split(',').map((column) => column.trim()).filter(Boolean);
  return Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
}

function createQuery(table: string) {
  const filters = new Map<string, unknown>();
  const nullColumns: string[] = [];
  const notNullColumns: string[] = [];
  let inFilter: { column: string; values: string[] } | null = null;
  let selectedColumns = '';
  let rangeBounds: [number, number] | null = null;

  // The owner list query: equality and null filters, the inner-joined bundle
  // a listings-only read embeds, newest first, then the requested range.
  const listPosts = () => {
    const postIdsWithBundles = new Set(bundleRows.value.map((row) => row.post_id));
    const rows = (postRows.value as Array<Record<string, unknown>>)
      .filter((post) => [...filters].every(([column, value]) => post[column] === value))
      .filter((post) => nullColumns.every((column) => post[column] == null))
      .filter((post) => notNullColumns.every((column) => post[column] != null))
      .filter((post) => !selectedColumns.includes('post_resource_bundles!inner') || postIdsWithBundles.has(post.id))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
    return rangeBounds ? rows.slice(rangeBounds[0], rangeBounds[1] + 1) : rows;
  };

  const query = {
    select(columns?: string) {
      selectedColumns = columns ?? '';
      return query;
    },
    eq(column: string, value: unknown) {
      filters.set(column, value);
      return query;
    },
    is(column: string) {
      nullColumns.push(column);
      return query;
    },
    not(column: string) {
      notNullColumns.push(column);
      return query;
    },
    in(column: string, values: string[]) {
      inFilter = { column, values };
      return query;
    },
    order() {
      return query;
    },
    range(from: number, to: number) {
      rangeBounds = [from, to];
      return query;
    },
    async maybeSingle() {
      if (table === 'profiles') {
        return sellerProfile.error
          ? { data: null, error: sellerProfile.error }
          : { data: sellerProfile.value, error: null };
      }

      if (table !== 'posts') {
        return { data: null, error: null };
      }

      const row = postRows.value.find((post) => {
        const idMatches = !filters.has('id') || filters.get('id') === post.id;
        const userMatches = !filters.has('user_id') || filters.get('user_id') === post.user_id;
        return idMatches && userMatches;
      });

      return { data: row ?? null, error: null };
    },
    then(resolve: (value: { data: unknown[]; error: null }) => void) {
      if (table === 'posts') {
        resolve({ data: listPosts(), error: null });
        return;
      }

      if (table === 'post_resource_bundles') {
        const rows = bundleRows.value
          .filter((row) => !inFilter || (inFilter.column === 'post_id' && inFilter.values.includes(row.post_id as string)))
          .map((row) => pickColumns(row, selectedColumns));
        resolve({ data: rows, error: null });
        return;
      }

      if (table === 'post_source_tools') {
        const rows = sourceToolRows.value
          .filter((row) => !inFilter || (inFilter.column === 'post_id' && inFilter.values.includes(row.post_id)))
          .sort((a, b) => a.sort_order - b.sort_order);
        resolve({ data: rows, error: null });
        return;
      }

      if (table === 'generations') {
        const rows = generationRows.value
          .filter((row) => !inFilter || (inFilter.column === 'id' && inFilter.values.includes(row.id)));
        resolve({ data: rows, error: null });
        return;
      }

      resolve({ data: [], error: null });
    },
  };

  return query;
}

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => {
    createServiceClientMock();

    return {
      from: (table: string) => createQuery(table),
      // Like the SQL: summary columns and the computed kinds, none of the text
      // the listing check grades and no retired_at.
      ...(compactSummaryRpc.enabled
        ? {
            rpc: async (name: string, args: { p_post_ids: string[] }) => {
              if (name !== 'get_owner_post_bundle_summaries') {
                return { data: null, error: { code: 'PGRST202', message: `Could not find ${name}` } };
              }

              return {
                data: bundleRows.value
                  .filter((row) => args.p_post_ids.includes(row.post_id as string))
                  .map((row) => ({
                    ...pickColumns(row, 'id, post_id, access_mode, status, price_usd_cents, sales_count, free_unlock_count, earnings_usd_cents'),
                    resource_kinds: row.prompt_text ? ['prompt'] : [],
                  })),
                error: null,
              };
            },
          }
        : {}),
      storage: {
        from: () => ({
          getPublicUrl: (path: string) => ({
            data: { publicUrl: `https://cdn.example.test/${path}` },
          }),
        }),
      },
    };
  },
  resolveOwnedStoredMediaUrl: vi.fn(async (_client: unknown, outputUrl: string, ownerId: string) => (
    outputUrl.split('/')[1] === ownerId
      ? `https://signed.example.test/${outputUrl}`
      : null
  )),
}));

vi.mock('@/lib/post-resource-bundles-server', async (importOriginal) => ({
  // The real check, so the owner list grades a listing exactly as the web sell page does.
  assessOwnerListingQuality: (await importOriginal<typeof import('@/lib/post-resource-bundles-server')>())
    .assessOwnerListingQuality,
  getPostResourceBundleDetailByPostId: vi.fn(async () => null),
}));

describe('owner posts', () => {
  beforeEach(() => {
    vi.resetModules();
    createServiceClientMock.mockReset();
    postRows.value = initialPostRows.slice();
    bundleRows.value = [];
    sellerProfile.value = { username: 'maya-creates', display_name: 'Maya R', avatar_url: null };
    sellerProfile.error = null;
    compactSummaryRpc.enabled = false;
  });

  it('loads structured source tools for edit prefill', async () => {
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-1', 'user-1');

    expect(post?.sourceTools).toEqual([
      {
        toolLabel: 'Higgsfield',
        toolSlug: 'higgsfield',
        modelLabel: 'Soul',
        modelSlug: 'soul',
      },
      {
        toolLabel: 'Runway',
        toolSlug: 'runway',
        modelLabel: 'Gen-4',
        modelSlug: 'gen-4',
      },
    ]);
    expect(post?.commentCount).toBe(7);
  });

  // A generation-backed post without `post_media` rows used to be served
  // `previewUrl: null`, which the mobile Posts screen renders as a blank
  // poster-less plate. The owner surface must graft the linked generation's
  // preview exactly like the showcase feed does — including for private
  // posts, whose showcase derivative rows are deleted.
  it('grafts the linked generation preview onto a synthesised cover', async () => {
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-3', 'user-1');

    const cover = post?.mediaItems[0];
    expect(cover?.previewUrl).toBe('https://signed.example.test/generated_images/user-1/gen-1.preview.webp');
    expect(cover?.previewStatus).toBe('ready');
    expect(cover?.gridReady).toBe(true);
    expect(cover?.preview?.width).toBe(832);
    expect(cover?.preview?.height).toBe(1248);
    expect(cover?.url).toBe('https://signed.example.test/generated_images/user-1/out.png');
  });

  // The display title falls back to "Untitled post" so lists stay readable,
  // but editors must hydrate from the raw value — echoing the fallback back
  // through PATCH is what made empty-titled posts unsavable.
  it('exposes the raw title separately from the display fallback', async () => {
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-2', 'user-1');

    expect(post?.title).toBe('Untitled post');
    expect(post?.rawTitle).toBe('');

    const titled = await getOwnerPostDetail('post-1', 'user-1');
    expect(titled?.rawTitle).toBe('Editable post');
  });

  it('reuses one admin client while loading owner post detail', async () => {
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-1', 'user-1');

    expect(post?.id).toBe('post-1');
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
  });

  // Decision 6 (2026-10-17): sales_count counts paid unlocks only. The editor's
  // lock still follows any unlock of a paid recipe, as it did while free
  // unlocks were counted as sales, so the composer and the update service agree.
  it.each([
    ['unlocked only while it was free', { salesCount: 0, freeUnlockCount: 3 }, true],
    ['sold', { salesCount: 1, freeUnlockCount: 0 }, true],
    ['never unlocked', { salesCount: 0, freeUnlockCount: 0 }, false],
  ])('locks a paid recipe in the editor when it was %s', async (_label, counts, locked) => {
    const bundles = await import('@/lib/post-resource-bundles-server');
    vi.mocked(bundles.getPostResourceBundleDetailByPostId).mockResolvedValueOnce({
      accessMode: 'paid',
      summary: '',
      previewText: '',
      priceUsdCents: 900,
      resources: null,
      ...counts,
    } as never);
    const { getOwnerPostDetail } = await import('@/lib/owner-posts');

    const post = await getOwnerPostDetail('post-1', 'user-1');

    expect(post?.hasPaidOrders).toBe(locked);
  });

  // 03-3 / 03-7: the app found listings by paging every own post and filtering
  // on the client, and drew "Published · Public" for listings buyers cannot
  // see: the owner list carried no moderation state, no listing check, no
  // retirement and no tombstone.
  describe('listings for the seller dashboard', () => {
    const listingPost = (id: string, createdAt: string, overrides: Record<string, unknown> = {}) => ({
      id,
      user_id: 'user-1',
      generation_id: null,
      visibility: 'public',
      archived_at: null,
      archived_by_user_id: null,
      tombstoned_at: null,
      review_status: 'visible',
      output_url: null,
      showcase_asset_path: null,
      prompt: null,
      title: 'Golden hour portrait recipe',
      description: '',
      body: 'Warm portraits lit by the last hour of sun.',
      category: 'image',
      post_format: 'media',
      source_kind: 'external',
      source_tool: null,
      source_tool_slug: null,
      comment_count: 0,
      created_at: createdAt,
      updated_at: createdAt,
      ...overrides,
    });
    const recipe = (postId: string, overrides: Record<string, unknown> = {}) => ({
      id: `bundle-${postId}`,
      post_id: postId,
      access_mode: 'paid',
      status: 'published',
      price_usd_cents: 900,
      sales_count: 2,
      earnings_usd_cents: 1530,
      title: 'Golden hour portrait',
      summary: 'Prompt and lighting notes for warm portraits.',
      preview_text: '',
      prompt_text: 'A warm golden hour portrait with soft rim light.',
      notes_markdown: null,
      workflow_share_url: null,
      workflow_snapshot: null,
      attachments: [],
      resource_sections: [],
      resource_items: [],
      allow_remix: false,
      retired_at: null,
      ...overrides,
    });
    const deletedAt = '2026-07-03T00:00:00.000Z';

    beforeEach(() => {
      postRows.value = [
        ...initialPostRows,
        listingPost('listing-ready', '2026-07-01T00:00:00.000Z'),
        listingPost('listing-flagged', '2026-07-02T00:00:00.000Z', { review_status: 'flagged' }),
        listingPost('listing-deleted', deletedAt, {
          visibility: 'private',
          archived_at: deletedAt,
          archived_by_user_id: 'user-1',
          tombstoned_at: deletedAt,
        }),
        listingPost('plain-post', '2026-07-04T00:00:00.000Z'),
      ] as unknown as typeof postRows.value;
      bundleRows.value = [
        recipe('listing-ready'),
        recipe('listing-flagged'),
        recipe('listing-deleted', { status: 'draft', retired_at: deletedAt }),
      ];
    });

    // Decision 6 (2026-10-17): "Sales" is paid unlocks, with free unlocks beside it.
    it('carries paid sales and free unlocks apart through the compact summary RPC', async () => {
      compactSummaryRpc.enabled = true;
      bundleRows.value = [recipe('listing-ready', { sales_count: 2, free_unlock_count: 5 })];
      const { getOwnerPostList } = await import('@/lib/owner-posts');

      const listings = await getOwnerPostList('user-1', { includeArchived: true, visibility: 'all', listingsOnly: true });

      expect(listings.find((post) => post.id === 'listing-ready')?.bundle).toMatchObject({ salesCount: 2, freeUnlockCount: 5 });
    });

    it('reads no free unlocks through the select fallback, which serves a database older than the column', async () => {
      compactSummaryRpc.enabled = false;
      bundleRows.value = [recipe('listing-ready', { sales_count: 2, free_unlock_count: 5 })];
      const { getOwnerPostList } = await import('@/lib/owner-posts');

      const listings = await getOwnerPostList('user-1', { includeArchived: true, visibility: 'all', listingsOnly: true });

      expect(listings.find((post) => post.id === 'listing-ready')?.bundle).toMatchObject({ salesCount: 2, freeUnlockCount: 0 });
    });

    it('pages through posts with a recipe only, newest first', async () => {
      const { getOwnerPostList } = await import('@/lib/owner-posts');
      const everything = { includeArchived: true, visibility: 'all' as const };

      const listings = await getOwnerPostList('user-1', { ...everything, listingsOnly: true });
      const secondPage = await getOwnerPostList('user-1', { ...everything, listingsOnly: true, limit: 2, offset: 1 });
      const allPosts = await getOwnerPostList('user-1', everything);

      expect(listings.map((post) => post.id)).toEqual(['listing-deleted', 'listing-flagged', 'listing-ready']);
      expect(secondPage.map((post) => post.id)).toEqual(['listing-flagged', 'listing-ready']);
      expect(allPosts.map((post) => post.id)).toEqual([
        'plain-post',
        'listing-deleted',
        'listing-flagged',
        'listing-ready',
        'post-3',
        'post-2',
        'post-1',
      ]);
    });

    it.each([
      ['the compact summary RPC', true],
      ['the bundle select fallback', false],
    ])('carries moderation, the listing check, retirement and the tombstone through %s', async (_label, rpcEnabled) => {
      compactSummaryRpc.enabled = rpcEnabled;
      const { getOwnerPostList } = await import('@/lib/owner-posts');

      const listings = await getOwnerPostList('user-1', { includeArchived: true, visibility: 'all', listingsOnly: true });
      const byId = new Map(listings.map((post) => [post.id, post]));

      expect(byId.get('listing-ready')).toMatchObject({
        tombstonedAt: null,
        bundle: {
          resourceKinds: ['prompt'],
          reviewStatus: 'visible',
          quality: { eligible: true, message: null },
          retiredAt: null,
        },
      });
      expect(byId.get('listing-flagged')?.bundle).toMatchObject({
        reviewStatus: 'flagged',
        quality: {
          eligible: false,
          message: 'Publish a visible public post before listing this recipe in the marketplace.',
        },
      });
      expect(byId.get('listing-deleted')).toMatchObject({
        tombstonedAt: deletedAt,
        bundle: { status: 'draft', retiredAt: deletedAt, quality: { eligible: false } },
      });
    });

    it('grades with the web sell page\'s display title and seller identity', async () => {
      // An untitled recipe shows as "Recipe" on the dashboard and passes there;
      // a generated handle is the identity issue it names.
      bundleRows.value = [recipe('listing-ready', { title: '  ' })];
      const { getOwnerPostList } = await import('@/lib/owner-posts');

      const [titled] = await getOwnerPostList('user-1', { listingsOnly: true });
      sellerProfile.value = { username: 'creator-1a2b3c4d', display_name: null, avatar_url: null };
      const [unclaimed] = await getOwnerPostList('user-1', { listingsOnly: true });

      expect(titled.bundle?.quality).toEqual({ eligible: true, message: null });
      expect(unclaimed.bundle?.quality).toEqual({
        eligible: false,
        message: 'Choose a custom handle and add your display name before publishing a recipe.',
      });
    });

    it('reports the check unknown, not failed, when the seller profile cannot be read', async () => {
      sellerProfile.error = new Error('profiles unavailable');
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const { getOwnerPostList } = await import('@/lib/owner-posts');

      const listings = await getOwnerPostList('user-1', { includeArchived: true, listingsOnly: true });

      expect(listings.map((post) => post.bundle?.quality)).toEqual([null, null, null]);
      expect(listings.map((post) => post.bundle?.reviewStatus)).toEqual(['visible', 'flagged', 'visible']);
      consoleError.mockRestore();
    });

    it('serves listingsOnly=1 on the owner posts route with paging and fields intact', async () => {
      compactSummaryRpc.enabled = true;
      const { listOwnerPostsForRoute } = await import('@/lib/owner-post-list-route-service');

      const result = await listOwnerPostsForRoute({
        userId: 'user-1',
        searchParams: new URLSearchParams({
          scope: 'owner',
          listingsOnly: '1',
          includeArchived: 'true',
          visibility: 'all',
          limit: '2',
        }),
      });

      expect(result).toMatchObject({
        ok: true,
        pageInfo: { hasMore: true, limit: 2, nextOffset: 2, offset: 0 },
      });
      if (!result.ok) return;
      expect(result.posts).toMatchObject([
        { id: 'listing-deleted', tombstonedAt: deletedAt, bundle: { retiredAt: deletedAt } },
        { id: 'listing-flagged', bundle: { reviewStatus: 'flagged', quality: { eligible: false } } },
      ]);
    });
  });
});
