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
  template_run_id: null,
  template_run_step_id: null,
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

  // Publish files a creation made as a guest under the account the guest was
  // linked to, while the generation keeps the guest's id, so every such post
  // is the account's and its generation the guest's.
  describe('a creation made as a guest, posted by the account it was linked to', () => {
    const GUEST_GENERATION: RemixAccessGeneration = { ...GENERATION, user_id: 'guest-1' };
    const LINKED_GUEST = { id: 'guest-1', merged_into_user_id: 'creator-1' };

    it('opens to anyone else as the account’s own creation does', async () => {
      const { client } = createClient({ tables: { profiles: [LINKED_GUEST] } });

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GUEST_GENERATION,
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

    it('asks about a block with the account, the one a viewer sees on the post', async () => {
      const { client } = createClient({ tables: { profiles: [LINKED_GUEST] } });
      const isUserRelationshipBlocked = vi.fn(
        async ({ secondUserId }: { secondUserId: string }) => secondUserId === 'creator-1',
      );

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GUEST_GENERATION,
        dependencies: { isUserRelationshipBlocked },
      });

      expect(decision).toEqual({ allowed: false, reason: 'not_found' });
      expect(isUserRelationshipBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ firstUserId: 'viewer-1', secondUserId: 'creator-1' }),
      );
    });

    it.each([
      ['another account', [{ id: 'guest-1', merged_into_user_id: 'someone-else' }]],
      ['no account', [{ id: 'guest-1', merged_into_user_id: null }]],
    ] as Array<[string, Row[]]>)('stays closed on the post when the guest was linked to %s', async (_label, profiles) => {
      const { client } = createClient({ tables: { profiles } });

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GUEST_GENERATION,
        dependencies: notBlocked(),
      });

      expect(decision).toEqual({ allowed: false, reason: 'not_found' });
    });

    // A caller that has already settled the viewer's ownership passes its
    // answer in; that answer is about the viewer, not about the post's owner.
    it('opens though a caller answered the viewer’s ownership itself', async () => {
      const { client } = createClient({ tables: { profiles: [LINKED_GUEST] } });

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GUEST_GENERATION,
        dependencies: { ...notBlocked(), isOwnOrLinkedAccountId: vi.fn(async () => false) },
      });

      expect(decision).toMatchObject({ allowed: true, basis: 'public' });
    });

    it('stays closed when who is linked to the account cannot be read', async () => {
      const { client } = createClient({
        tables: { profiles: [LINKED_GUEST] },
        errors: { profiles: { code: '57014', message: 'profiles read timed out' } },
      });

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GUEST_GENERATION,
        dependencies: notBlocked(),
      });

      expect(decision).toEqual({ allowed: false, reason: 'not_found' });
    });
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

  // Recipe audit H1 (2026-10-27): a recipe whose stored remix switch is off
  // used to leave Remix public, and remix-source handed anyone the creation's
  // prompt and settings, the very thing the recipe sold. A creation post's
  // published recipe now includes its Remix, whatever the switch says.
  describe('a published recipe whose stored remix switch is off', () => {
    const SWITCH_OFF_RECIPE = { ...REMIX_RECIPE, allow_remix: false };

    it.each([
      ['paid'],
      ['free'],
    ])('asks someone who has not unlocked a %s recipe to unlock it', async (accessMode) => {
      const { client } = createClient({
        tables: { post_resource_bundles: [{ ...SWITCH_OFF_RECIPE, access_mode: accessMode }] },
      });

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: GENERATION,
        dependencies: notBlocked(),
      });

      expect(decision).toEqual({ allowed: false, reason: 'unlock_required' });
    });

    // Who may remix is normalised; the creation's inputs still go only where
    // the creator's stored switch offered them (`recipeEntitled`).
    it('opens to the viewer who unlocked it, without the creation’s inputs, and to the owner', async () => {
      const { client } = createClient({
        tables: {
          post_resource_bundles: [SWITCH_OFF_RECIPE],
          post_resource_bundle_purchases: [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'buyer-1' }],
        },
      });

      const buyer = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'buyer-1',
        generation: { ...GENERATION, share_input_media_for_remix: false },
        dependencies: notBlocked(),
      });
      const owner = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'creator-1',
        generation: GENERATION,
        dependencies: notBlocked(),
      });

      expect(buyer).toEqual({
        allowed: true,
        basis: 'unlocked',
        post: EXPOSED_POST,
        includeSharedInputMedia: false,
        recipeEntitled: false,
      });
      expect(owner).toMatchObject({ allowed: true, basis: 'owner' });
    });
  });

  it.each([
    ['a recipe that is not published', { ...REMIX_RECIPE, status: 'draft' }],
    ['a recipe removed after people had it', { ...REMIX_RECIPE, allow_remix: false, status: 'draft' }],
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

  // A template's recipe and model are its author's (Studio shows the result's
  // model as `template-workflow`), and a remix restored the model to anyone.
  describe('a template result', () => {
    it.each([
      ['its run', { template_run_id: 'run-1', template_run_step_id: null }],
      ['its step', { template_run_id: null, template_run_step_id: 'step-1' }],
    ])('is restored for nobody when the creation records %s: its owner is told why, before any read', async (_label, link) => {
      const { client, from } = createClient();

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'creator-1',
        generation: { ...GENERATION, ...link },
        dependencies: notBlocked(),
      });

      expect(decision).toEqual({ allowed: false, reason: 'template_result' });
      expect(from).not.toHaveBeenCalled();
    });

    it('answers anyone else as for a private source, though its post is public, without reading the post', async () => {
      const { client, from } = createClient();

      const decision = await resolveRemixAccess({
        adminSupabase: client,
        viewerUserId: 'viewer-1',
        generation: { ...GENERATION, template_run_id: 'run-1', template_run_step_id: 'step-1' },
        dependencies: notBlocked(),
      });

      expect(decision).toEqual({ allowed: false, reason: 'not_found' });
      expect(from).not.toHaveBeenCalledWith('posts');
    });

    it('says the same as the post surface, which offers no Remix on its post, recipe or none', () => {
      const templatePost = {
        generationId: 'gen-1',
        postFormat: 'media',
        category: 'image',
        sourceKind: 'magicbooklet',
        templateResult: true,
      };

      expect(resolvePostRemixCapability({ ...templatePost, resourceBundle: null }))
        .toEqual({ capability: 'none', target: null });
      expect(resolvePostRemixCapability({
        ...templatePost,
        resourceBundle: { viewerCanAccess: false, allowRemix: true, items: [] },
      })).toEqual({ capability: 'none', target: null });
    });
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
