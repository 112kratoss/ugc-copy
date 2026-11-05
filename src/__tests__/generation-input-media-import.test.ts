import { describe, expect, it, vi } from 'vitest';

import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import { importSharedGenerationInputMedia, resolveRemixResultMedia } from '@/lib/generation-input-media-import';

const CREATOR = 'creator-1';
const VIEWER = 'viewer-1';
const SOURCE_PATH = `generation_inputs/${CREATOR}/gen-9/00-reference_image.jpg`;
const DEST_PATH = `${VIEWER}/remix-imports/gen-9/00-reference_image.jpg`;

// A creation made before the viewer registered keeps its guest UUID, so
// Recreate restores its references as signed URLs under the guest's prefix.
const GUEST = 'guest-1';
const GUEST_SOURCE_PATH = `generation_inputs/${GUEST}/gen-4/00-reference_image.png`;
const GUEST_SIGNED_SOURCE = `https://project.supabase.co/storage/v1/object/sign/${GUEST_SOURCE_PATH}?token=restored`;
const GUEST_DEST_PATH = `${VIEWER}/remix-imports/gen-4/00-reference_image.png`;

const SHARING_GENERATION = {
  id: 'gen-9',
  user_id: CREATOR,
  is_public: true,
  share_input_media_for_remix: true,
  template_run_id: null,
  template_run_step_id: null,
  remix_recipe_mode: null,
};

// The creation's post as the feed shows it: public, live and visible.
const EXPOSED_POST = {
  id: 'post-9',
  user_id: CREATOR,
  generation_id: 'gen-9',
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

const PAID_REMIX_RECIPE = {
  id: 'bundle-9',
  post_id: 'post-9',
  owner_user_id: CREATOR,
  access_mode: 'paid',
  price_usd_cents: 499,
  status: 'published',
  allow_remix: true,
  retired_at: null,
};

type AdminStubOptions = {
  mediaRows?: Array<Record<string, unknown>>;
  generationRow?: Record<string, unknown> | null;
  postRows?: Array<Record<string, unknown>>;
  bundleRows?: Array<Record<string, unknown>>;
  purchaseRows?: Array<Record<string, unknown>>;
  profileRows?: Array<Record<string, unknown>>;
  /** The caller's Auth user, or the error reading it returns. */
  viewer?: { id: string; is_anonymous: boolean };
  viewerError?: { message: string } | null;
  readErrors?: Partial<Record<string, { message: string; code?: string }>>;
  copyError?: { statusCode?: string; message: string; error?: string } | null;
  signError?: { message: string } | null;
};

/** A table whose every read fails, as a timed-out query does. */
function failingTable(error: { message: string; code?: string }) {
  const failed = { data: null, error };
  const query = {
    select: () => query,
    eq: () => query,
    limit: () => query,
    maybeSingle: async () => failed,
    then: (resolve: (value: typeof failed) => unknown) => Promise.resolve(failed).then(resolve),
  };
  return query;
}

function createAdminStub(options: AdminStubOptions = {}) {
  const {
    mediaRows = [{ id: 'media-1', generation_id: 'gen-9', user_id: CREATOR, storage_path: SOURCE_PATH, metadata: {} }],
    generationRow = SHARING_GENERATION,
    postRows = [EXPOSED_POST],
    bundleRows = [],
    purchaseRows = [],
    profileRows = [],
    viewer = { id: VIEWER, is_anonymous: false },
    viewerError = null,
    readErrors = {},
    copyError = null,
    signError = null,
  } = options;

  const copy = vi.fn(async () => ({ data: copyError ? null : { path: DEST_PATH }, error: copyError }));
  const createSignedUrl = vi.fn(async (path: string) => (
    signError
      ? { data: null, error: signError }
      : { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/generation_inputs/${path}?token=copy` }, error: null }
  ));
  const getUserById = vi.fn(async () => (
    viewerError ? { data: { user: null }, error: viewerError } : { data: { user: viewer }, error: null }
  ));
  // Reads answer as the database would: filters applied (a lookup that forgets
  // the buyer or the post's creation matches rows it must not), only the
  // columns selected (a generation read without its run links reads as no
  // template's result), and an unknown table or column refused.
  const stored = createStoredRows({
    generation_input_media: mediaRows,
    generations: generationRow ? [generationRow] : [],
    posts: postRows,
    post_resource_bundles: bundleRows,
    post_resource_bundle_purchases: purchaseRows,
    profiles: profileRows,
  });
  const from = vi.fn((table: string) => {
    const readError = readErrors[table];
    return readError ? failingTable(readError) : stored.client.from(table);
  });

  const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://project.supabase.co/storage/v1/object/public/showcase_media/${path}` } }));
  const storageFrom = vi.fn((bucket: string) => ({ bucket, copy, createSignedUrl, getPublicUrl }));
  const client = {
    from,
    auth: { admin: { getUserById } },
    storage: { from: storageFrom },
  };

  return { client, from, copy, createSignedUrl, getPublicUrl, getUserById, storageFrom };
}

function postsReads(stub: ReturnType<typeof createAdminStub>) {
  return stub.from.mock.calls.filter(([table]) => table === 'posts').length;
}

function createDependencies(stub: ReturnType<typeof createAdminStub>, overrides: {
  blocked?: boolean | (() => Promise<boolean>);
  recipeItems?: Array<{ storagePath: string | null }>;
} = {}) {
  const blockedOption = overrides.blocked ?? false;
  return {
    createServiceClient: (() => stub.client) as never,
    isUserRelationshipBlocked: vi.fn(async () => {
      if (typeof blockedOption === 'function') return blockedOption();
      return blockedOption;
    }) as never,
    loadGenerationRecipeRemixInputMediaByPostId: vi.fn(async () => (overrides.recipeItems ?? []) as never),
  };
}

function createLinkedGuestStub(overrides: AdminStubOptions = {}) {
  return createAdminStub({
    mediaRows: [{ id: 'media-4', generation_id: 'gen-4', user_id: GUEST, storage_path: GUEST_SOURCE_PATH, metadata: {} }],
    generationRow: { ...SHARING_GENERATION, id: 'gen-4', user_id: GUEST, is_public: false, share_input_media_for_remix: false },
    profileRows: [{ id: GUEST, merged_into_user_id: VIEWER }],
    ...overrides,
  });
}

describe('importSharedGenerationInputMedia', () => {
  // Owner, 2026-11-03: a creator's run that used a seller's recipe file through their unlock keeps it
  // as an input of their own. A remix of the creator's creation is never handed it, whatever they share.
  describe('an input that was a file of someone else’s recipe', () => {
    it.each([
      ['marked as it was kept', { sourceKind: 'recipe-file', sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row.png' }],
      ['known by the seller’s file it came from', { sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row.png' }],
      ['known by the run start’s import of it', { sourceUrl: `https://project.supabase.co/storage/v1/object/sign/generation_inputs/${CREATOR}/recipe-imports/gen-0/00-reference-image-row.png?token=x` }],
    ])('is never imported for anyone else, shared freely or not: %s', async (_, metadata) => {
      const stub = createAdminStub({
        mediaRows: [{ id: 'media-1', generation_id: 'gen-9', user_id: CREATOR, storage_path: SOURCE_PATH, metadata }],
      });
      const dependencies = createDependencies(stub, { recipeItems: [{ storagePath: SOURCE_PATH }] });

      const result = await importSharedGenerationInputMedia({ source: SOURCE_PATH, viewerUserId: VIEWER, dependencies });

      expect(result).toEqual({ outcome: 'not-eligible' });
      expect(stub.copy).not.toHaveBeenCalled();
      expect(stub.createSignedUrl).not.toHaveBeenCalled();
    });

    it('is still the creator’s own to use again', async () => {
      const stub = createLinkedGuestStub({
        mediaRows: [{ id: 'media-4', generation_id: 'gen-4', user_id: GUEST, storage_path: GUEST_SOURCE_PATH, metadata: { sourceKind: 'recipe-file' } }],
      });

      const result = await importSharedGenerationInputMedia({ source: GUEST_SOURCE_PATH, viewerUserId: VIEWER, dependencies: createDependencies(stub) });

      expect(result).toMatchObject({ outcome: 'imported' });
    });
  });

  it('imports a freely shared input into the viewer prefix', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(stub.copy).toHaveBeenCalledWith(`${CREATOR}/gen-9/00-reference_image.jpg`, DEST_PATH);
    expect(result).toEqual({
      outcome: 'imported',
      storagePath: `generation_inputs/${DEST_PATH}`,
      signedUrl: expect.stringContaining(DEST_PATH),
    });
  });

  it('accepts the signed-URL form of the same source, even when expired', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      // The token is never fetched — authorization derives from the path alone.
      source: `https://project.supabase.co/storage/v1/object/sign/${SOURCE_PATH}?token=expired`,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result.outcome).toBe('imported');
  });

  it('rejects sources outside the durable inputs bucket without touching the database', async () => {
    const stub = createAdminStub();
    const result = await importSharedGenerationInputMedia({
      source: `uploads/${CREATOR}/reference.jpg`,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.from).not.toHaveBeenCalled();
  });

  // The review of phase 2, finding 1: the post's "Allow remixes" off stops new remixes only, so a run
  // keeps using the inputs a remix handed the viewer.
  it('imports a freely shared input after its post’s Allow remixes went off', async () => {
    const stub = createAdminStub({ postRows: [{ ...EXPOSED_POST, remixes_allowed: false }] });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toMatchObject({ outcome: 'imported', storagePath: `generation_inputs/${DEST_PATH}` });
  });

  it('is not eligible when the generation no longer shares its inputs', async () => {
    const stub = createAdminStub({
      generationRow: { ...SHARING_GENERATION, share_input_media_for_remix: false },
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('is not eligible when there is no durable input row for the path', async () => {
    const stub = createAdminStub({ mediaRows: [] });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
  });

  // The import's own block check guards what the creator shares with everyone, and only that (owner,
  // 2026-11-06: "blocking means no more post of A can be visible or can be purchased to B, but
  // already bought posts won't be affected"). A bought recipe's hand-over of the creation's inputs
  // goes through a block, and through a block check that fails: it never asks one.
  const BLOCK_PATHS: Array<[string, AdminStubOptions, Array<{ storagePath: string }>, 'not-eligible' | 'imported']> = [
    ['a freely shared input', {}, [], 'not-eligible'],
    [
      "a bought recipe's input",
      { generationRow: { ...SHARING_GENERATION, share_input_media_for_remix: false } },
      [{ storagePath: SOURCE_PATH }],
      'imported',
    ],
  ];

  it.each(BLOCK_PATHS)('answers %s when the viewer and creator block each other: %s', async (_path, stubOptions, recipeItems, outcome) => {
    const stub = createAdminStub(stubOptions);
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, { blocked: true, recipeItems }),
    });

    expect(result.outcome).toBe(outcome);
    expect(stub.copy).toHaveBeenCalledTimes(outcome === 'imported' ? 1 : 0);
  });

  it.each(BLOCK_PATHS)('answers %s when the block check fails, which counts as a block: %s', async (_path, stubOptions, recipeItems, outcome) => {
    const stub = createAdminStub(stubOptions);
    const dependencies = createDependencies(stub, {
      blocked: async () => {
        throw new Error('moderation outage');
      },
      recipeItems,
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies,
    });

    expect(result.outcome).toBe(outcome);
    expect(stub.copy).toHaveBeenCalledTimes(outcome === 'imported' ? 1 : 0);
    // Free sharing asks; the bought hand-over never does.
    expect(dependencies.isUserRelationshipBlocked).toHaveBeenCalledTimes(outcome === 'imported' ? 0 : 1);
  });

  // The same input, shared freely and handed over by a recipe on its post: what the viewer bought
  // stays theirs after a block, and what they did not buy ends with it.
  describe('an input its creator shares freely and a recipe on its post hands over', () => {
    it('keeps the bought hand-over for a buyer the creator blocked', async () => {
      const stub = createAdminStub({ postRows: [{ ...EXPOSED_POST, id: 'post-7' }] });
      const dependencies = createDependencies(stub, { blocked: true, recipeItems: [{ storagePath: SOURCE_PATH }] });

      const result = await importSharedGenerationInputMedia({ source: SOURCE_PATH, viewerUserId: VIEWER, dependencies });

      expect(result).toMatchObject({ outcome: 'imported', storagePath: `generation_inputs/${DEST_PATH}` });
      expect(dependencies.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith(expect.objectContaining({
        postId: 'post-7',
        viewerUserId: VIEWER,
      }));
    });

    it('still refuses a viewer the creator blocked who never bought the recipe', async () => {
      const stub = createAdminStub({ postRows: [{ ...EXPOSED_POST, id: 'post-7' }] });
      // The recipe's unlock hands nothing to someone who did not buy it.
      const dependencies = createDependencies(stub, { blocked: true, recipeItems: [] });

      const result = await importSharedGenerationInputMedia({ source: SOURCE_PATH, viewerUserId: VIEWER, dependencies });

      expect(result).toEqual({ outcome: 'not-eligible' });
      expect(stub.copy).not.toHaveBeenCalled();
      // The shared path's gate is never asked once the block refuses it.
      expect(stub.getUserById).not.toHaveBeenCalled();
    });
  });

  // The generation's sharing flags are not the gate on their own: the import
  // asks what the remix routes ask before they hand over a creator's inputs.
  // Remixing someone else's creation takes an account (/api/remix-source
  // refuses a guest, /api/showcase/remix admits none), while a generation
  // start admits guests.
  it('is not eligible for a guest caller, however the creation is shared', async () => {
    const stub = createAdminStub({ viewer: { id: VIEWER, is_anonymous: true } });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.getUserById).toHaveBeenCalledWith(VIEWER);
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it("fails without importing when the caller's account cannot be read", async () => {
    const stub = createAdminStub({ viewerError: { message: 'Auth service unavailable' } });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'failed' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('is not eligible while a recipe on the post is locked to the viewer', async () => {
    const stub = createAdminStub({
      bundleRows: [PAID_REMIX_RECIPE],
      // Someone else's purchase unlocks nothing for this viewer.
      purchaseRows: [{ id: 'purchase-2', bundle_id: 'bundle-9', buyer_user_id: 'buyer-2' }],
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('imports a shared input for a viewer who unlocked the recipe on its post', async () => {
    const stub = createAdminStub({
      bundleRows: [PAID_REMIX_RECIPE],
      purchaseRows: [{ id: 'purchase-1', bundle_id: 'bundle-9', buyer_user_id: VIEWER }],
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result.outcome).toBe('imported');
  });

  it.each([
    ['archived', [{ ...EXPOSED_POST, archived_at: '2026-10-28T09:00:00.000Z' }]],
    ['private', [{ ...EXPOSED_POST, visibility: 'private' }]],
    ['unlisted', [{ ...EXPOSED_POST, visibility: 'unlisted' }]],
    ['hidden by moderation', [{ ...EXPOSED_POST, review_status: 'hidden' }]],
    ['held for review', [{ ...EXPOSED_POST, review_status: 'flagged' }]],
    ['deleted', []],
  ])('is not eligible when the post is %s, though the generation still reads public and shared', async (_state, postRows) => {
    const stub = createAdminStub({ postRows });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it.each([
    ['run', { template_run_id: 'run-1' }],
    ['run step', { template_run_step_id: 'step-1' }],
  ])('is not eligible for a template result (linked to its %s)', async (_link, templateLink) => {
    const stub = createAdminStub({ generationRow: { ...SHARING_GENERATION, ...templateLink } });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it.each(['posts', 'post_resource_bundles', 'post_resource_bundle_purchases'])(
    'fails without importing when the %s read behind the sharing gate fails',
    async (table) => {
      const stub = createAdminStub({
        bundleRows: [PAID_REMIX_RECIPE],
        readErrors: { [table]: { message: 'canceling statement due to statement timeout' } },
      });
      const dependencies = createDependencies(stub);
      const result = await importSharedGenerationInputMedia({
        source: SOURCE_PATH,
        viewerUserId: VIEWER,
        dependencies,
      });

      expect(result).toEqual({ outcome: 'failed' });
      // The gate's failure ends the import there: the bought-recipe half,
      // which reads the post again, is never asked.
      expect(postsReads(stub)).toBe(1);
      expect(dependencies.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
      expect(stub.copy).not.toHaveBeenCalled();
    },
  );

  // The block check asks about the account the creation is posted under. For
  // one made under the account's own id that is the creator: their profile
  // names no account they were linked to. The cases above answer "blocked"
  // whoever is asked, so they cannot tell.
  it('refuses a viewer the creator blocked, having asked about the creator', async () => {
    const stub = createAdminStub({ profileRows: [{ id: CREATOR, merged_into_user_id: null }] });
    const dependencies = {
      ...createDependencies(stub),
      isUserRelationshipBlocked: vi.fn(
        async ({ secondUserId }: { secondUserId: string }) => secondUserId === CREATOR,
      ) as never,
    };

    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies,
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  // Publish files a creation made as a guest under the account the guest was
  // linked to, while its saved inputs keep the guest's id and folder. The
  // account is whom a viewer sees on the post, and so whom they block.
  describe('a creation made as a guest, posted by the account it was linked to', () => {
    const accountGuestStub = (overrides: AdminStubOptions = {}) => createLinkedGuestStub({
      generationRow: { ...SHARING_GENERATION, id: 'gen-4', user_id: GUEST },
      postRows: [{ ...EXPOSED_POST, id: 'post-4', generation_id: 'gen-4' }],
      profileRows: [{ id: GUEST, merged_into_user_id: CREATOR }],
      ...overrides,
    });

    it('imports its freely shared input for a viewer the account has not blocked, having asked about the account', async () => {
      const stub = accountGuestStub();
      const dependencies = createDependencies(stub);

      const result = await importSharedGenerationInputMedia({
        source: GUEST_SIGNED_SOURCE,
        viewerUserId: VIEWER,
        dependencies,
      });

      expect(result.outcome).toBe('imported');
      expect(dependencies.isUserRelationshipBlocked).toHaveBeenCalledWith(
        expect.objectContaining({ firstUserId: VIEWER, secondUserId: CREATOR }),
      );
    });

    it('refuses a viewer the account blocked', async () => {
      const stub = accountGuestStub();
      const dependencies = {
        ...createDependencies(stub),
        isUserRelationshipBlocked: vi.fn(
          async ({ secondUserId }: { secondUserId: string }) => secondUserId === CREATOR,
        ) as never,
      };

      const result = await importSharedGenerationInputMedia({
        source: GUEST_SIGNED_SOURCE,
        viewerUserId: VIEWER,
        dependencies,
      });

      expect(result).toEqual({ outcome: 'not-eligible' });
      expect(stub.copy).not.toHaveBeenCalled();
    });

    it('counts the block as unchecked, so refuses, when whom the guest was linked to cannot be read', async () => {
      const stub = accountGuestStub({ readErrors: { profiles: { message: 'profiles unavailable' } } });

      const result = await importSharedGenerationInputMedia({
        source: GUEST_SIGNED_SOURCE,
        viewerUserId: VIEWER,
        dependencies: createDependencies(stub),
      });

      expect(result).toEqual({ outcome: 'not-eligible' });
      expect(stub.copy).not.toHaveBeenCalled();
    });
  });

  it('authorizes through a purchased recipe when free sharing is off', async () => {
    const stub = createAdminStub({
      generationRow: { ...SHARING_GENERATION, share_input_media_for_remix: false },
      postRows: [{ ...EXPOSED_POST, id: 'post-7' }],
    });
    const dependencies = createDependencies(stub, { recipeItems: [{ storagePath: SOURCE_PATH }] });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies,
    });

    expect(dependencies.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith({
      postId: 'post-7',
      generationId: 'gen-9',
      viewerUserId: VIEWER,
      adminSupabase: stub.client,
    });
    expect(result.outcome).toBe('imported');
    // Only free sharing asks who the caller is.
    expect(stub.getUserById).not.toHaveBeenCalled();
  });

  it('stays ineligible when the recipe grant covers different media', async () => {
    const stub = createAdminStub({
      generationRow: { ...SHARING_GENERATION, share_input_media_for_remix: false },
      postRows: [{ ...EXPOSED_POST, id: 'post-7' }],
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, {
        recipeItems: [{ storagePath: `generation_inputs/${CREATOR}/gen-9/01-reference_image.jpg` }],
      }),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
  });

  it('treats an already-existing destination copy as success', async () => {
    const stub = createAdminStub({
      copyError: { statusCode: '409', message: 'The resource already exists', error: 'Duplicate' },
    });
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result.outcome).toBe('imported');
  });

  it('fails retryably when the copy or signing fails after authorization', async () => {
    const copyFailed = createAdminStub({ copyError: { message: 'service unavailable' } });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(copyFailed),
    })).resolves.toEqual({ outcome: 'failed' });

    const signFailed = createAdminStub({ signError: { message: 'signing unavailable' } });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(signFailed),
    })).resolves.toEqual({ outcome: 'failed' });
  });

  it('fails closed on inconsistent ownership between path, row, and generation', async () => {
    const rowMismatch = createAdminStub({
      mediaRows: [{ id: 'media-1', generation_id: 'gen-9', user_id: 'someone-else', storage_path: SOURCE_PATH, metadata: {} }],
    });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(rowMismatch),
    })).resolves.toEqual({ outcome: 'not-eligible' });

    // A recipe grant naming the path, so only the generation's owner refuses it.
    const generationMismatch = createAdminStub({
      generationRow: { ...SHARING_GENERATION, user_id: 'someone-else' },
    });
    await expect(importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(generationMismatch, { recipeItems: [{ storagePath: SOURCE_PATH }] }),
    })).resolves.toEqual({ outcome: 'not-eligible' });
  });

  it('imports a private, unshared input made under a guest identity linked to the viewer', async () => {
    const stub = createLinkedGuestStub();
    const dependencies = createDependencies(stub);
    const result = await importSharedGenerationInputMedia({
      source: GUEST_SIGNED_SOURCE,
      viewerUserId: VIEWER,
      dependencies,
    });

    expect(result).toEqual({
      outcome: 'imported',
      storagePath: `generation_inputs/${GUEST_DEST_PATH}`,
      signedUrl: expect.stringContaining(GUEST_DEST_PATH),
    });
    expect(stub.copy).toHaveBeenCalledWith(`${GUEST}/gen-4/00-reference_image.png`, GUEST_DEST_PATH);
    // The block gate and the sharing checks exist for other people's media.
    expect(dependencies.isUserRelationshipBlocked).not.toHaveBeenCalled();
    expect(stub.from).not.toHaveBeenCalledWith('posts');
    expect(stub.getUserById).not.toHaveBeenCalled();
  });

  it('stays ineligible for a guest identity linked to a different account', async () => {
    const stub = createLinkedGuestStub({
      profileRows: [{ id: GUEST, merged_into_user_id: 'account-2' }],
    });
    const result = await importSharedGenerationInputMedia({
      source: GUEST_SIGNED_SOURCE,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('still requires a durable input row for a linked guest', async () => {
    const stub = createLinkedGuestStub({ mediaRows: [] });
    const result = await importSharedGenerationInputMedia({
      source: GUEST_SIGNED_SOURCE,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });
});

// A remix offers its original's result as a reference ("Use as reference" in the
// creators, web and app). The remix source hands out the post's showcase copy, or
// the private output of a creation that has none, and neither is under the
// remixer's prefix, so every start refused both. The start now gets a link to the
// original itself, built from the checked location; the run's own snapshot is the
// only copy made.
describe('resolveRemixResultMedia', () => {
  const SHOWCASE_ASSET = 'showcase/gen-9/result.mp4';
  const OUTPUT_PATH = `generated_videos/${CREATOR}/restored_gen-9_a1.mp4`;
  const SHOWCASE_RESULT = `https://project.supabase.co/storage/v1/object/public/showcase_media/${SHOWCASE_ASSET}`;
  // The token is never read: what the file is, and who may have it, comes from its path.
  const OUTPUT_RESULT = `https://project.supabase.co/storage/v1/object/sign/${OUTPUT_PATH}?token=expired`;

  // A creator who keeps their inputs to themselves: the result is the post's own media.
  const RESULT_GENERATION = {
    ...SHARING_GENERATION,
    share_input_media_for_remix: false,
    showcase_asset_path: SHOWCASE_ASSET,
    output_url: OUTPUT_PATH,
  };
  const VIDEO_POST = { ...EXPOSED_POST, category: 'video' };

  function resultStub(overrides: AdminStubOptions = {}) {
    return createAdminStub({ mediaRows: [], generationRow: RESULT_GENERATION, postRows: [VIDEO_POST], ...overrides });
  }

  async function resolveResult(stub: ReturnType<typeof createAdminStub>, source = SHOWCASE_RESULT, overrides: Parameters<typeof createDependencies>[1] = {}) {
    return resolveRemixResultMedia({ source, viewerUserId: VIEWER, dependencies: createDependencies(stub, overrides) });
  }

  it("answers the showcase copy's public link, built from the checked path, and copies nothing", async () => {
    const stub = resultStub();

    await expect(resolveResult(stub, `${SHOWCASE_RESULT}?download=forged`)).resolves.toEqual({
      outcome: 'resolved',
      url: `https://project.supabase.co/storage/v1/object/public/showcase_media/${SHOWCASE_ASSET}`,
    });
    expect(stub.storageFrom).toHaveBeenCalledWith('showcase_media');
    expect(stub.getPublicUrl).toHaveBeenCalledWith(SHOWCASE_ASSET);
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('signs the private output of a creation with no showcase copy, in its own bucket', async () => {
    const stub = resultStub({ generationRow: { ...RESULT_GENERATION, showcase_asset_path: null } });

    await expect(resolveResult(stub, OUTPUT_RESULT)).resolves.toEqual({
      outcome: 'resolved',
      url: expect.stringContaining('token=copy'),
    });
    expect(stub.storageFrom).toHaveBeenCalledWith('generated_videos');
    expect(stub.createSignedUrl).toHaveBeenCalledWith(`${CREATOR}/restored_gen-9_a1.mp4`, 3600);
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses any file but the one the remix source hands out', async () => {
    // Another file in the creation's showcase folder.
    const poster = resultStub();
    await expect(resolveResult(poster, 'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/gen-9/poster.jpg'))
      .resolves.toEqual({ outcome: 'not-eligible' });
    // The private output, while the post shows its showcase copy.
    const output = resultStub();
    await expect(resolveResult(output, OUTPUT_RESULT)).resolves.toEqual({ outcome: 'not-eligible' });
    // Another of the creator's files, which no creation has as its output.
    const other = resultStub({ generationRow: { ...RESULT_GENERATION, showcase_asset_path: null } });
    await expect(resolveResult(other, `generated_videos/${CREATOR}/restored_gen-3_b2.mp4`))
      .resolves.toEqual({ outcome: 'not-eligible' });
    for (const stub of [poster, output, other]) {
      expect(stub.getPublicUrl).not.toHaveBeenCalled();
      expect(stub.createSignedUrl).not.toHaveBeenCalled();
    }
  });

  // The owner's outputs are indexed by owner alone, so the file's name narrows the read to the
  // creation it names, by a unique-indexed column. The narrowing never decides: a name its writer
  // did not give from its creation's id, or one a list filter cannot carry, is read in full.
  it("reads a private output's creation by the id its file name gives, and in full otherwise", async () => {
    const generationId = '7d0f0b0e-5a2b-4c4b-9a43-0f8e2a1b3c4d';
    const generationReads = (stub: ReturnType<typeof resultStub>) => (
      stub.from.mock.calls.filter(([table]) => table === 'generations').length
    );
    const cases: Array<{ file: string; row: Record<string, string>; reads: number }> = [
      // Named by the row's own ids: one narrowed read.
      { file: 'generated_task-77.mp4', row: { prediction_id: 'task-77' }, reads: 1 },
      // One of several outputs, and a prediction id that itself ends in "_<digits>".
      { file: 'generated_task-77_0.mp4', row: { prediction_id: 'task-77' }, reads: 1 },
      { file: 'generated_task_7.mp4', row: { prediction_id: 'task_7' }, reads: 1 },
      { file: `restored_${generationId}_a1.mp4`, row: { id: generationId }, reads: 1 },
      // A stem that is not the row's prediction id, as a writer naming it otherwise would leave.
      { file: 'generated_task-77-v2.mp4', row: { prediction_id: 'task-77' }, reads: 2 },
      // No known shape, or characters a PostgREST list cannot carry (`"`): read in full at once.
      { file: 'legacy-output.mp4', row: {}, reads: 1 },
      { file: 'generated_x",y).mp4', row: {}, reads: 1 },
    ];
    for (const { file, row, reads } of cases) {
      const output = `generated_videos/${CREATOR}/${file}`;
      const generation = { ...RESULT_GENERATION, showcase_asset_path: null, output_url: output, prediction_id: 'task-0', ...row };
      const stub = resultStub({ generationRow: generation, postRows: [{ ...VIDEO_POST, generation_id: generation.id }] });
      await expect(resolveResult(stub, output), file).resolves.toMatchObject({ outcome: 'resolved' });
      expect(generationReads(stub), file).toBe(reads);
    }
    // The same name in another owner's folder is still not this creation's output.
    const output = `generated_videos/${CREATOR}/generated_task-77.mp4`;
    const elsewhere = resultStub({
      generationRow: { ...RESULT_GENERATION, showcase_asset_path: null, output_url: output, prediction_id: 'task-77', user_id: 'creator-2' },
    });
    await expect(resolveResult(elsewhere, output)).resolves.toEqual({ outcome: 'not-eligible' });
  });

  it('rejects sources outside the result buckets without touching the database', async () => {
    const stub = resultStub();
    for (const source of [
      `uploads/${CREATOR}/reference.jpg`,
      SOURCE_PATH,
      'https://project.supabase.co/storage/v1/object/public/showcase_media/previews/gen-9/result.webp',
      'https://example.com/result.mp4',
    ]) {
      await expect(resolveResult(stub, source)).resolves.toEqual({ outcome: 'not-eligible' });
    }
    expect(stub.from).not.toHaveBeenCalled();
  });

  // Ids are uuids: a path that names none is refused as before, not failed as a read that could be retried.
  it('refuses a path whose creation or owner segment is no uuid', async () => {
    const stub = resultStub({ readErrors: { generations: { message: 'invalid input syntax for type uuid: "abc"', code: '22P02' } } });
    await expect(resolveResult(stub, 'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/abc/x.png'))
      .resolves.toEqual({ outcome: 'not-eligible' });
    await expect(resolveResult(stub, 'generated_images/abc/x.png')).resolves.toEqual({ outcome: 'not-eligible' });
  });

  it('refuses a creation its post no longer shows', async () => {
    for (const overrides of [
      { postRows: [{ ...VIDEO_POST, archived_at: '2026-11-01T00:00:00Z' }] },
      { postRows: [{ ...VIDEO_POST, visibility: 'private' }] },
      { postRows: [] },
      { generationRow: { ...RESULT_GENERATION, is_public: false } },
    ] satisfies AdminStubOptions[]) {
      const stub = resultStub(overrides);
      await expect(resolveResult(stub)).resolves.toEqual({ outcome: 'not-eligible' });
      expect(stub.getPublicUrl).not.toHaveBeenCalled();
    }
  });

  it('refuses a guest caller, and fails when the caller cannot be read', async () => {
    const guest = resultStub({ viewer: { id: VIEWER, is_anonymous: true } });
    await expect(resolveResult(guest)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(postsReads(guest)).toBe(0);

    const unread = resultStub({ viewerError: { message: 'auth unavailable' } });
    await expect(resolveResult(unread)).resolves.toEqual({ outcome: 'failed' });
    expect(unread.getPublicUrl).not.toHaveBeenCalled();
  });

  it('refuses while a recipe on the post is locked to the viewer, and answers once they unlocked it', async () => {
    const locked = resultStub({ bundleRows: [PAID_REMIX_RECIPE] });
    await expect(resolveResult(locked)).resolves.toEqual({ outcome: 'not-eligible' });

    const unlocked = resultStub({
      bundleRows: [PAID_REMIX_RECIPE],
      purchaseRows: [{ id: 'purchase-1', bundle_id: 'bundle-9', buyer_user_id: VIEWER }],
    });
    await expect(resolveResult(unlocked)).resolves.toMatchObject({ outcome: 'resolved' });
  });

  // The review of phase 2, finding 1, and the owner's word on blocks (2026-11-06): a run's use of the
  // result a remix handed the viewer is a reuse, no new remix, so neither the post's "Allow remixes"
  // off nor a block since stops it, and no block is asked.
  // The owner, 2026-11-06: "no more post of A can be visible ... to B, but already bought posts won't be
  // affected". A result is never held, so a block refuses it to a viewer who bought nothing (the
  // re-review), and a post whose Allow remixes went off still serves it.
  it('refuses the result to a viewer blocked since who bought nothing, and answers one with remixes off', async () => {
    const blocked = resultStub();
    const blockedDependencies = createDependencies(blocked, { blocked: true });
    await expect(resolveRemixResultMedia({ source: SHOWCASE_RESULT, viewerUserId: VIEWER, dependencies: blockedDependencies }))
      .resolves.toEqual({ outcome: 'not-eligible' });
    expect(blockedDependencies.isUserRelationshipBlocked).toHaveBeenCalled();

    const closed = resultStub({ postRows: [{ ...VIDEO_POST, remixes_allowed: false }] });
    await expect(resolveResult(closed)).resolves.toMatchObject({ outcome: 'resolved' });
  });

  it('answers the result to a viewer blocked since who bought its recipe, without asking about the block', async () => {
    const bought = resultStub({
      bundleRows: [PAID_REMIX_RECIPE],
      purchaseRows: [{ id: 'purchase-1', bundle_id: 'bundle-9', buyer_user_id: VIEWER }],
    });
    const boughtDependencies = createDependencies(bought, { blocked: true });
    await expect(resolveRemixResultMedia({ source: SHOWCASE_RESULT, viewerUserId: VIEWER, dependencies: boughtDependencies }))
      .resolves.toMatchObject({ outcome: 'resolved' });
    expect(boughtDependencies.isUserRelationshipBlocked).not.toHaveBeenCalled();
  });

  it('refuses a template result', async () => {
    const templateResult = resultStub({ generationRow: { ...RESULT_GENERATION, template_run_id: 'run-1' } });
    await expect(resolveResult(templateResult)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(templateResult.getPublicUrl).not.toHaveBeenCalled();
  });

  it("answers the viewer's own result, made under their id or a guest's linked to them, without the checks for other people's", async () => {
    const own = resultStub({ generationRow: { ...RESULT_GENERATION, user_id: VIEWER }, postRows: [{ ...VIDEO_POST, user_id: VIEWER }] });
    const ownDependencies = createDependencies(own);
    await expect(resolveRemixResultMedia({ source: SHOWCASE_RESULT, viewerUserId: VIEWER, dependencies: ownDependencies }))
      .resolves.toMatchObject({ outcome: 'resolved' });
    expect(own.getUserById).not.toHaveBeenCalled();
    expect(postsReads(own)).toBe(0);
    expect(ownDependencies.isUserRelationshipBlocked).not.toHaveBeenCalled();

    const linkedGuest = resultStub({
      generationRow: { ...RESULT_GENERATION, user_id: GUEST, is_public: false },
      profileRows: [{ id: GUEST, merged_into_user_id: VIEWER }],
    });
    await expect(resolveResult(linkedGuest)).resolves.toMatchObject({ outcome: 'resolved' });
  });

  it('fails retryably when a read or the signing fails', async () => {
    for (const overrides of [
      { generationRow: { ...RESULT_GENERATION, showcase_asset_path: null }, signError: { message: 'signing unavailable' } },
      { readErrors: { generations: { message: 'timeout' } } },
      { readErrors: { posts: { message: 'timeout' } } },
    ] satisfies AdminStubOptions[]) {
      const source = overrides.generationRow ? OUTPUT_RESULT : SHOWCASE_RESULT;
      await expect(resolveResult(resultStub(overrides), source)).resolves.toEqual({ outcome: 'failed' });
    }
  });
});
