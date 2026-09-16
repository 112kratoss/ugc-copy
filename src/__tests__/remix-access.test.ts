import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import { resolvePostRemixCapability } from '@/lib/post-resource-bundles';
import { resolveRemixAccess, type RemixAccessGeneration } from '@/lib/remix-access';

type Row = Record<string, unknown>;

const GENERATION: RemixAccessGeneration = {
  id: 'gen-1',
  user_id: 'creator-1',
  is_public: true,
  share_input_media_for_remix: true,
};

const EXPOSED_POST = {
  id: 'post-1',
  user_id: 'creator-1',
  generation_id: 'gen-1',
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

const REMIX_RECIPE = {
  id: 'bundle-1',
  post_id: 'post-1',
  status: 'published',
  allow_remix: true,
};

/**
 * Answers each table the gate reads by applying every `eq` filter, so a query
 * that forgets a filter (the buyer, the linked account) matches rows it must
 * not and the test fails.
 */
function createClient({
  tables = {},
  errors = {},
}: {
  tables?: Partial<Record<'posts' | 'post_resource_bundles' | 'post_resource_bundle_purchases' | 'profiles', Row[]>>;
  errors?: Partial<Record<string, unknown>>;
} = {}) {
  const rows: Record<string, Row[]> = {
    posts: [EXPOSED_POST],
    post_resource_bundles: [],
    post_resource_bundle_purchases: [],
    profiles: [],
    ...tables,
  };
  const from = vi.fn((table: string) => {
    if (!(table in rows)) throw new Error(`Unexpected table: ${table}`);
    const filters: Array<[string, unknown]> = [];
    const outcome = (single: boolean) => {
      if (errors[table]) return { data: null, error: errors[table] };
      const matches = rows[table].filter((row) => filters.every(([column, value]) => row[column] === value));
      return { data: single ? matches[0] ?? null : matches, error: null };
    };
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return builder;
      },
      maybeSingle: async () => outcome(true),
      then: (
        resolve: (value: ReturnType<typeof outcome>) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => Promise.resolve(outcome(false)).then(resolve, reject),
    };
    return builder;
  });

  return { client: { from } as unknown as SupabaseClient, from };
}

function notBlocked() {
  return { isUserRelationshipBlocked: vi.fn(async () => false) };
}

describe('resolveRemixAccess', () => {
  it('lets the owner restore everything without reading the post', async () => {
    const { client, from } = createClient();

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'creator-1',
      generation: { ...GENERATION, is_public: false, share_input_media_for_remix: false },
      dependencies: notBlocked(),
    });

    expect(decision).toEqual({
      allowed: true,
      basis: 'owner',
      post: null,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('treats a guest creation linked to the viewer as their own', async () => {
    const { client } = createClient({
      tables: { profiles: [{ id: 'guest-1', merged_into_user_id: 'viewer-1' }] },
    });

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: { ...GENERATION, user_id: 'guest-1', is_public: false },
      dependencies: notBlocked(),
    });

    expect(decision).toMatchObject({ allowed: true, basis: 'owner' });
  });

  it('does not treat a guest linked to someone else as the viewer', async () => {
    const { client } = createClient({
      tables: { profiles: [{ id: 'guest-1', merged_into_user_id: 'other-account' }] },
    });

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: { ...GENERATION, user_id: 'guest-1', is_public: false },
      dependencies: notBlocked(),
    });

    expect(decision).toEqual({ allowed: false, reason: 'not_found' });
  });

  it('refuses a private generation to anyone else before reading its post', async () => {
    const { client, from } = createClient();

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: { ...GENERATION, is_public: false },
      dependencies: notBlocked(),
    });

    expect(decision).toEqual({ allowed: false, reason: 'not_found' });
    expect(from).not.toHaveBeenCalledWith('posts');
  });

  it('opens a public creation on an exposed post that sells no recipe', async () => {
    const { client } = createClient();

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      requestedPostId: 'post-1',
      dependencies: notBlocked(),
    });

    expect(decision).toEqual({
      allowed: true,
      basis: 'public',
      post: EXPOSED_POST,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });
  });

  it('keeps the creator’s unshared input files out of a public remix', async () => {
    const { client } = createClient();

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: { ...GENERATION, share_input_media_for_remix: false },
      dependencies: notBlocked(),
    });

    expect(decision).toMatchObject({ allowed: true, includeSharedInputMedia: false });
  });

  it.each([
    ['has no post', []],
    ['has a post by someone else', [{ ...EXPOSED_POST, user_id: 'someone-else' }]],
    ['is private', [{ ...EXPOSED_POST, visibility: 'private' }]],
    ['is unlisted', [{ ...EXPOSED_POST, visibility: 'unlisted' }]],
    ['is archived', [{ ...EXPOSED_POST, archived_at: '2026-09-15T10:00:00.000Z' }]],
    ['is hidden by moderation', [{ ...EXPOSED_POST, review_status: 'hidden' }]],
    ['is flagged for review', [{ ...EXPOSED_POST, review_status: 'flagged' }]],
  ] as Array<[string, Row[]]>)(
    'refuses a public generation whose post %s',
    async (_label, posts) => {
      const { client } = createClient({ tables: { posts } });

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GENERATION,
        dependencies: notBlocked(),
      });

      expect(decision).toEqual({ allowed: false, reason: 'not_found' });
    },
  );

  it('refuses a post id that is not the generation’s own post', async () => {
    const { client } = createClient();

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      requestedPostId: 'some-other-post',
      dependencies: notBlocked(),
    });

    expect(decision).toEqual({ allowed: false, reason: 'not_found' });
  });

  it('refuses a viewer the creator has blocked, and a block check that fails', async () => {
    const { client } = createClient();

    const blocked = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      dependencies: { isUserRelationshipBlocked: vi.fn(async () => true) },
    });
    const unverifiable = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      dependencies: {
        isUserRelationshipBlocked: vi.fn(async () => {
          throw new Error('blocks unavailable');
        }),
      },
    });

    expect(blocked).toEqual({ allowed: false, reason: 'not_found' });
    expect(unverifiable).toEqual({ allowed: false, reason: 'not_found' });
  });

  it('answers unlock_required where the post surface does, for a remix-enabled recipe nobody bought', async () => {
    const { client } = createClient({ tables: { post_resource_bundles: [REMIX_RECIPE] } });

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      dependencies: notBlocked(),
    });

    expect(decision).toEqual({ allowed: false, reason: 'unlock_required' });
    expect(resolvePostRemixCapability({
      generationId: 'gen-1',
      postFormat: 'media',
      category: 'image',
      sourceKind: 'magicbooklet',
      resourceBundle: { viewerCanAccess: false, allowRemix: true, items: [] },
    }).capability).toBe('unlock_required');
  });

  it('opens a remix-enabled recipe to the viewer who bought it, and only to them', async () => {
    const { client } = createClient({
      tables: {
        post_resource_bundles: [REMIX_RECIPE],
        post_resource_bundle_purchases: [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'buyer-1' }],
      },
    });

    const buyer = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'buyer-1',
      generation: { ...GENERATION, share_input_media_for_remix: false },
      dependencies: notBlocked(),
    });
    const stranger = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      dependencies: notBlocked(),
    });

    expect(buyer).toEqual({
      allowed: true,
      basis: 'unlocked',
      post: EXPOSED_POST,
      includeSharedInputMedia: false,
      recipeEntitled: true,
    });
    expect(stranger).toEqual({ allowed: false, reason: 'unlock_required' });
  });

  it.each([
    ['a recipe that does not sell remixing', { ...REMIX_RECIPE, allow_remix: false }],
    ['a remix-enabled recipe that is not published', { ...REMIX_RECIPE, status: 'draft' }],
  ])('keeps remixing public for %s', async (_label, bundle) => {
    const { client } = createClient({ tables: { post_resource_bundles: [bundle] } });

    const decision = await resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      dependencies: notBlocked(),
    });

    expect(decision).toMatchObject({ allowed: true, basis: 'public', recipeEntitled: false });
  });

  it.each([
    ['posts'],
    ['post_resource_bundles'],
    ['post_resource_bundle_purchases'],
  ])('fails closed when %s cannot be read', async (table) => {
    const failure = { code: '57014', message: `${table} read timed out` };
    const { client } = createClient({
      tables: { post_resource_bundles: [REMIX_RECIPE] },
      errors: { [table]: failure },
    });

    await expect(resolveRemixAccess({
      adminSupabase: client,
      viewerUserId: 'viewer-1',
      generation: GENERATION,
      dependencies: notBlocked(),
    })).rejects.toBe(failure);
  });
});
