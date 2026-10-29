import { describe, expect, it, vi } from 'vitest';

import { createStoredRows } from '@/__tests__/fixtures/stored-rows';
import { importSharedGenerationInputMedia } from '@/lib/generation-input-media-import';

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
  access_mode: 'paid',
  price_usd_cents: 499,
  status: 'published',
  allow_remix: true,
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
  readErrors?: Partial<Record<string, { message: string }>>;
  copyError?: { statusCode?: string; message: string; error?: string } | null;
  signError?: { message: string } | null;
};

/** A table whose every read fails, as a timed-out query does. */
function failingTable(error: { message: string }) {
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
    mediaRows = [{ id: 'media-1', generation_id: 'gen-9', user_id: CREATOR, storage_path: SOURCE_PATH }],
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

  const client = {
    from,
    auth: { admin: { getUserById } },
    storage: { from: vi.fn(() => ({ copy, createSignedUrl })) },
  };

  return { client, from, copy, createSignedUrl, getUserById };
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
    mediaRows: [{ id: 'media-4', generation_id: 'gen-4', user_id: GUEST, storage_path: GUEST_SOURCE_PATH }],
    generationRow: { ...SHARING_GENERATION, id: 'gen-4', user_id: GUEST, is_public: false, share_input_media_for_remix: false },
    profileRows: [{ id: GUEST, merged_into_user_id: VIEWER }],
    ...overrides,
  });
}

describe('importSharedGenerationInputMedia', () => {
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

  // The import's own block check is the only one a bought recipe's input meets,
  // and the free path hands its answer to the remix gate, so each path pins it.
  const BLOCK_PATHS: Array<[string, AdminStubOptions, Array<{ storagePath: string }>]> = [
    ['a freely shared input', {}, []],
    [
      "a bought recipe's input",
      { generationRow: { ...SHARING_GENERATION, share_input_media_for_remix: false } },
      [{ storagePath: SOURCE_PATH }],
    ],
  ];

  it.each(BLOCK_PATHS)('refuses %s when the viewer and creator block each other', async (_path, stubOptions, recipeItems) => {
    const stub = createAdminStub(stubOptions);
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, { blocked: true, recipeItems }),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it.each(BLOCK_PATHS)('treats a failing block check as blocked for %s', async (_path, stubOptions, recipeItems) => {
    const stub = createAdminStub(stubOptions);
    const result = await importSharedGenerationInputMedia({
      source: SOURCE_PATH,
      viewerUserId: VIEWER,
      dependencies: createDependencies(stub, {
        blocked: async () => {
          throw new Error('moderation outage');
        },
        recipeItems,
      }),
    });

    expect(result).toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
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
  // names no account they were linked to. The block cases above answer
  // "blocked" whoever is asked, so they cannot tell.
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
      mediaRows: [{ id: 'media-1', generation_id: 'gen-9', user_id: 'someone-else', storage_path: SOURCE_PATH }],
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
