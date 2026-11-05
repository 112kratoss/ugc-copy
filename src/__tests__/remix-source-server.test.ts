import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generation: null as Record<string, unknown> | null,
  selectedColumns: [] as string[],
  // The post media rows a read of `post_media` answers, and the filters each read sent.
  postMedia: { data: [], error: null } as { data: Array<Record<string, unknown>> | null; error: { message: string } | null },
  postMediaReads: [] as unknown[][][],
  resolveRemixAccess: vi.fn(),
  loadGenerationInputMediaMap: vi.fn(),
  buildLegacyGenerationInputMedia: vi.fn(),
  loadGenerationRecipeRemixInputMediaByPostId: vi.fn(),
  // The inputs a bought recipe holds back from a remix: files of someone else's recipe its run used.
  recipeFiles: [] as Array<Record<string, unknown>>,
  loadGenerationRecipeReferenceCopies: vi.fn(),
}));

const adminClient = {
  from: vi.fn((table: string) => {
    const filters: unknown[][] = [];
    const builder = {
      select: (columns: string) => {
        mocks.selectedColumns.push(columns);
        return builder;
      },
      eq: (...filter: unknown[]) => {
        filters.push(['eq', ...filter]);
        return builder;
      },
      is: (...filter: unknown[]) => {
        filters.push(['is', ...filter]);
        return builder;
      },
      not: (...filter: unknown[]) => {
        filters.push(['not', ...filter]);
        return builder;
      },
      maybeSingle: async () => ({ data: mocks.generation, error: null }),
      limit: async () => {
        if (table !== 'post_media') throw new Error(`Unexpected list read of ${table}`);
        mocks.postMediaReads.push(filters);
        return mocks.postMedia;
      },
    };
    return builder;
  }),
  storage: {
    from: () => ({
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://public.example/${path}` } }),
      createSignedUrl: async () => ({ data: { signedUrl: 'https://signed.example/upload' }, error: null }),
    }),
  },
};

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: vi.fn(() => ({})),
  createServiceClient: vi.fn(() => adminClient),
  resolveOwnedStoredMediaUrl: vi.fn(async () => null),
}));
vi.mock('@/lib/server-auth-user', () => ({
  getVerifiedAuthUserResult: vi.fn(async () => ({ data: { user: { id: 'viewer-1' } }, error: null })),
}));
vi.mock('@/lib/backend-rate-limit', () => ({
  REMIX_SOURCE_RATE_LIMIT: { scope: 'remix-source' },
  enforceBackendRateLimit: vi.fn(async () => undefined),
}));
vi.mock('@/lib/remix-access', () => ({
  REMIX_UNLOCK_REQUIRED_CODE: 'REMIX_UNLOCK_REQUIRED',
  REMIX_UNLOCK_REQUIRED_MESSAGE: 'Unlock this post to remix it.',
  TEMPLATE_RESULT_REMIX_CODE: 'TEMPLATE_RESULT_NOT_REMIXABLE',
  TEMPLATE_RESULT_REMIX_MESSAGE: 'Template results cannot be remixed. Use the template again to make another.',
  resolveRemixAccess: mocks.resolveRemixAccess,
}));
vi.mock('@/lib/generation-input-media', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/generation-input-media')>(),
  loadGenerationInputMediaMap: mocks.loadGenerationInputMediaMap,
  buildLegacyGenerationInputMedia: mocks.buildLegacyGenerationInputMedia,
}));
vi.mock('@/lib/post-resource-bundles-server', () => ({
  loadGenerationRecipeRemixInputsByPostId: async (params: unknown) => ({
    inputMedia: await mocks.loadGenerationRecipeRemixInputMediaByPostId(params),
    recipeFiles: mocks.recipeFiles,
  }),
  loadGenerationRecipeReferenceCopies: mocks.loadGenerationRecipeReferenceCopies,
}));

import { buildCatalogInputMediaCandidates } from '@/lib/catalog-input-media-candidates';
import {
  collectImageInputCandidates,
  collectReferenceMediaCandidates,
  collectSubjectImageCandidates,
} from '@/lib/generation-input-media';
import { loadRemixSourceBundle, RemixSourceError } from '@/lib/remix-source-server';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';
import { USER_SCOPED_STORAGE_BUCKETS } from '@/lib/storage-ownership';
import mobileApiContract from '../../contracts/mobile-api-v1.json';

const LOCKED_PROMPT = 'The prompt a buyer pays for';

const EXPOSED_POST = {
  id: 'post-verified',
  user_id: 'creator-1',
  generation_id: 'gen-1',
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};

function request(postId?: string) {
  const query = postId ? `?id=gen-1&postId=${postId}` : '?id=gen-1';
  return new NextRequest(`http://localhost/api/remix-source${query}`);
}

beforeEach(() => {
  mocks.generation = {
    id: 'gen-1',
    user_id: 'creator-1',
    is_public: true,
    share_input_media_for_remix: true,
    output_url: null,
    showcase_asset_path: null,
    category: 'image',
    model: 'nano-banana-2',
    prompt: LOCKED_PROMPT,
    title: 'Recipe',
    workflow_settings: {
      model: 'nano-banana-2',
      referenceImageUrls: ['https://cdn.example/private-face.png'],
    },
  };
  mocks.selectedColumns.length = 0;
  mocks.postMedia = { data: [], error: null };
  mocks.postMediaReads.length = 0;
  mocks.resolveRemixAccess.mockReset();
  mocks.loadGenerationInputMediaMap.mockReset().mockResolvedValue(new Map());
  mocks.buildLegacyGenerationInputMedia.mockReset().mockResolvedValue([]);
  mocks.loadGenerationRecipeRemixInputMediaByPostId.mockReset().mockResolvedValue([]);
  mocks.recipeFiles = [];
  mocks.loadGenerationRecipeReferenceCopies.mockReset().mockResolvedValue(new Map());
});

describe('loadRemixSourceBundle access', () => {
  it('asks the shared remix gate with the caller’s post id and refuses a locked recipe without its prompt', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ allowed: false, reason: 'unlock_required' });

    const outcome = await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' })
      .then((bundle) => bundle, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(RemixSourceError);
    expect(outcome).toMatchObject({
      status: 403,
      code: 'REMIX_UNLOCK_REQUIRED',
      message: 'Unlock this post to remix it.',
    });
    expect(JSON.stringify(outcome)).not.toContain(LOCKED_PROMPT);
    expect(mocks.resolveRemixAccess).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: 'viewer-1',
      requestedPostId: 'post-client',
      generation: {
        id: 'gen-1',
        user_id: 'creator-1',
        is_public: true,
        share_input_media_for_remix: true,
        template_run_id: null,
        template_run_step_id: null,
        remix_recipe_mode: null,
      },
    }));
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
  });

  // A template's recipe and model are its author's (Studio shows the result's
  // model as `template-workflow`), and this read handed the model to a remix.
  it("refuses a template result in the gate's words, never with its model, having asked the gate with its run", async () => {
    mocks.generation = {
      ...mocks.generation,
      model: 'nano-banana-pro',
      prompt: null,
      workflow_settings: {},
      template_run_id: 'run-1',
      template_run_step_id: 'step-1',
    };
    mocks.resolveRemixAccess.mockResolvedValue({ allowed: false, reason: 'template_result' });

    const outcome = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' })
      .then((bundle) => bundle, (error: unknown) => error);

    // /api/showcase/remix's refusal, word for word: the gate's one answer.
    const refusal = mobileApiContract.endpoints.remixShowcasePost.errors.templateResult;
    expect(outcome).toBeInstanceOf(RemixSourceError);
    expect(outcome).toMatchObject({
      status: refusal.status,
      message: refusal.response.error,
      code: refusal.response.code,
    });
    expect(`${(outcome as Error).message} ${JSON.stringify(outcome)}`).not.toContain('nano-banana-pro');
    expect(mocks.selectedColumns[0]).toContain('template_run_id, template_run_step_id');
    expect(mocks.resolveRemixAccess).toHaveBeenCalledWith(expect.objectContaining({
      generation: expect.objectContaining({ template_run_id: 'run-1', template_run_step_id: 'step-1' }),
    }));
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
  });

  it('answers not found when the gate refuses, before any media is signed', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ allowed: false, reason: 'not_found' });

    await expect(loadRemixSourceBundle(request(), 'gen-1')).rejects.toMatchObject({
      status: 404,
      message: 'Remix source not found',
    });
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
  });

  it('restores the creator’s shared input files for a public remix', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'public',
      post: EXPOSED_POST,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.generation.prompt).toBe(LOCKED_PROMPT);
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledWith(expect.objectContaining({
      generationIds: ['gen-1'],
      urlMode: 'signed',
    }));
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
  });

  it('keeps unshared input files out of a public remix', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'public',
      post: EXPOSED_POST,
      includeSharedInputMedia: false,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.workflowSettings).toEqual({ model: 'nano-banana-2' });
    expect(bundle.inputs).toEqual({});
    expect(bundle).not.toHaveProperty('inputMedia');
    // The run's inputs are read only to name their slots (owner, 2026-11-03):
    // nothing is signed, and nothing of them is handed over.
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledTimes(1);
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledWith(expect.objectContaining({ urlMode: 'none' }));
    expect(mocks.buildLegacyGenerationInputMedia).toHaveBeenCalledWith(expect.objectContaining({ urlMode: 'none' }));
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeReferenceCopies).not.toHaveBeenCalled();
  });

  it('restores bought recipe media from the post the gate verified, not the one the caller named', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'unlocked',
      post: EXPOSED_POST,
      includeSharedInputMedia: false,
      recipeEntitled: true,
    });

    await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' });

    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-verified',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    }));
  });

  it('lets the owner restore their own input files', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'owner',
      post: null,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.workflowSettings).toMatchObject({
      referenceImageUrls: ['https://cdn.example/private-face.png'],
    });
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalled();
  });
});

// Owner, 2026-11-03: a remix is given a creation's prompt, model and settings,
// and its saved inputs only where the creator shares them. Each input it is not
// given becomes an empty slot named as its role and, where the prompt mentions
// it, by its handle, so the remixer adds their own and the prompt still runs.
// Someone who unlocked the recipe gets back the inputs the creator put copies of
// in it ("Include creation references"), and slots for the rest.
describe('input slots for a remix given none of the run’s inputs', () => {
  const PUBLIC_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: false, recipeEntitled: false, recipe: null };
  /** The recipe on the post as the gate read it, which the copies are read on from. */
  const BOUGHT_RECIPE = { id: 'bundle-verified', ownerUserId: 'creator-1', published: true, viewerHasPurchased: true };
  const UNLOCKED_ACCESS = { ...PUBLIC_ACCESS, basis: 'unlocked', recipe: BOUGHT_RECIPE };
  /** A kept row as a read without signing answers it: no link. */
  const row = (
    id: string,
    mediaType: string,
    role: string,
    sortOrder: number,
    label: string,
    metadata: Record<string, unknown>,
    sourceGenerationId: string | null = null,
  ) => ({
    id,
    generationId: 'gen-1',
    mediaType,
    role,
    label,
    url: null,
    storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-${role}.png`,
    sourceGenerationId,
    sortOrder,
    metadata,
  });
  const PRODUCT = row('row-product', 'image', 'reference_image', 0, 'Product', {
    handle: '@product',
    displayName: 'Product',
    sourceStoragePath: 'uploads/creator-1/1730000000000-product.png',
  });
  // Its handle was made from an upload's file name, and the prompt does not mention it.
  const BACKDROP = row('row-backdrop', 'image', 'reference_image', 1, 'my-passport.jpg', {
    handle: '@my_passport',
    displayName: 'my-passport.jpg',
    sourceStoragePath: 'uploads/creator-1/1730000000001-my-passport.jpg',
  }, 'gen-private-7');
  const BOTH_SLOTS = [
    { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@product', name: 'Reference image 1' },
    { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' },
  ];
  // Nothing of the input but what goes there: no clip's length, no subject's picture count.
  const SLOT_KEYS = new Set(['id', 'kind', 'role', 'handle', 'name']);

  /** Nothing that names or reaches the creator's files: no row, path, link, source, label or stored name. */
  function expectNothingOfTheInputs(value: unknown) {
    expect(JSON.stringify(value)).not.toMatch(
      /row-product|row-backdrop|gen-private-7|generation_inputs|uploads\/|Product|my-passport|my_passport|displayName|sourceStoragePath|"label"|https?:\/\//,
    );
  }

  beforeEach(() => {
    mocks.generation = {
      ...mocks.generation,
      share_input_media_for_remix: false,
      prompt: 'Place @product on a marble counter, soft light',
      workflow_settings: { model: 'nano-banana-2', aspectRatio: '3:4' },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [PRODUCT, BACKDROP]]]));
  });

  it('gives anyone else a slot for each kept input, with a handle only where the prompt mentions it', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputSlots).toEqual(BOTH_SLOTS);
    for (const slot of bundle.inputSlots ?? []) {
      expect(Object.keys(slot).filter((key) => !SLOT_KEYS.has(key))).toEqual([]);
    }
    // Read once, without signing: the rows were enough, so the settings were not read for inputs.
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledTimes(1);
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledWith(expect.objectContaining({
      generationIds: ['gen-1'],
      urlMode: 'none',
      throwOnError: true,
    }));
    expect(mocks.buildLegacyGenerationInputMedia).not.toHaveBeenCalled();
    // Not someone who unlocked a recipe: no copy is looked for.
    expect(mocks.loadGenerationRecipeReferenceCopies).not.toHaveBeenCalled();
    expect(bundle.inputs).toEqual({});
    expect(bundle).not.toHaveProperty('inputMedia');
    // A slot is no restore failure: the fixture's missing result is the only one.
    expect(bundle.restoreIssues).toEqual(['result']);
    expectNothingOfTheInputs(bundle);
  });

  it('gives a run that kept no rows a slot for each input its settings name, read without signing', async () => {
    const actual = await vi.importActual<typeof import('@/lib/generation-input-media')>('@/lib/generation-input-media');
    mocks.buildLegacyGenerationInputMedia.mockImplementation(actual.buildLegacyGenerationInputMedia);
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map());
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      prompt: '@me in a linen suit.',
      workflow_settings: {
        model: 'nano-banana-2',
        elements: [
          { id: 'el-1', displayName: 'passport-scan.jpg', handle: '@me', storagePath: 'uploads/creator-1/1730000000000-passport-scan.jpg' },
          { id: 'el-2', displayName: 'Reference result', handle: '@reference_result', sourceGenerationId: 'gen-private-7' },
        ],
      },
    };
    const storageFrom = vi.spyOn(adminClient.storage, 'from');

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputSlots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@me', name: 'Reference image 1' },
      { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' },
    ]);
    expect(mocks.buildLegacyGenerationInputMedia).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'gen-1', urlMode: 'none' }));
    expect(storageFrom).not.toHaveBeenCalled();
    expect(bundle.inputs).toEqual({});
    expect(JSON.stringify(bundle)).not.toMatch(/passport-scan|gen-private-7|Reference result|el-\d|uploads\//);
    storageFrom.mockRestore();
  });

  it('names a motion run’s slots as its character and its clip', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-2.6',
      prompt: 'Dance like the clip',
      workflow_settings: { model: 'kling-2.6' },
    };
    // The plain reference roles the catalog path kept motion inputs under.
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [
      row('row-hero', 'image', 'reference_image', 0, 'hero.png', { slot: 'characterImage' }),
      row('row-moves', 'video', 'reference_video', 1, 'moves.mp4', { slot: 'referenceVideo', durationSeconds: 8 }),
    ]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputSlots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'character_image', handle: null, name: 'Character image' },
      { id: 'slot-2', kind: 'video', role: 'motion_reference_video', handle: null, name: 'Motion video' },
    ]);
    expect(bundle.inputs).toEqual({});
  });

  // A failed read is retried, never turned into slots for good (2026-11-03 review): the clients read a
  // restore issue as a failed restore and read the source again.
  it('names no slot and raises a restore issue when the rows cannot be read, rather than failing the remix or reading the settings', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(UNLOCKED_ACCESS);
    mocks.loadGenerationInputMediaMap.mockImplementation(async (params: { throwOnError?: boolean }) => {
      if (params.throwOnError) throw new Error('canceling statement due to statement timeout');
      return new Map([['gen-1', [PRODUCT, BACKDROP]]]);
    });

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.generation.prompt).toBe('Place @product on a marble counter, soft light');
    expect(bundle).not.toHaveProperty('inputSlots');
    expect(bundle.restoreIssues).toContain('withheld-inputs');
    expect(bundle.inputs).toEqual({});
    expect(mocks.buildLegacyGenerationInputMedia).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeReferenceCopies).not.toHaveBeenCalled();
  });

  it('looks for copies in the recipe the gate read, and gives slots alone when it holds none', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(UNLOCKED_ACCESS);

    const bundle = await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' });

    expect(mocks.loadGenerationRecipeReferenceCopies).toHaveBeenCalledTimes(1);
    // Read on from what the gate read (2026-11-03 review): no unlock read is made twice.
    expect(mocks.loadGenerationRecipeReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({
      recipe: BOUGHT_RECIPE,
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
      inputRowIds: ['row-product', 'row-backdrop'],
    }));
    // The creator's switch is off: the inputs themselves are not read for this buyer.
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalledWith(expect.objectContaining({ urlMode: 'signed' }));
    expect(bundle.inputSlots).toEqual(BOTH_SLOTS);
    expect(bundle.inputs).toEqual({});
    expect(bundle.workflowSettings).toEqual({ model: 'nano-banana-2', aspectRatio: '3:4' });
    expectNothingOfTheInputs(bundle);
  });

  it('restores the inputs an unlocked recipe holds copies of from the copies’ links, and gives slots for the rest', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(UNLOCKED_ACCESS);
    const COPY = 'post_resource_files/creator-1/generation-references/gen-1/00-reference-image-row-product.png';
    mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([['row-product', {
      storagePath: COPY,
      url: 'https://signed.example/recipe-copy-of-product.png?token=short',
    }]]));

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    // Under the row's own id, as any remixer's restore is, with the copy in place of the creator's file.
    expect(bundle.inputs.image?.elements).toEqual([{
      id: 'row-product',
      displayName: 'Product',
      handle: '@product',
      storagePath: COPY,
      sourceGenerationId: null,
      url: 'https://signed.example/recipe-copy-of-product.png?token=short',
    }]);
    expect(bundle.inputSlots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 1' },
    ]);
    expectNothingOfTheInputs(bundle.inputSlots);
    // Neither the creator's own copy, where their upload was staged, nor the withheld input reaches the remix.
    expect(JSON.stringify(bundle)).not.toMatch(/generation_inputs|uploads\/|sourceStoragePath|row-backdrop|my-passport|my_passport|gen-private-7/);
    expect(bundle).not.toHaveProperty('inputMedia');
    expect(bundle.restoreIssues).toEqual(['result']);
  });

  it('counts a copy whose link could not be signed as a failed restore, not a slot', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(UNLOCKED_ACCESS);
    mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([['row-product', {
      storagePath: 'post_resource_files/creator-1/generation-references/gen-1/00-reference-image-row-product.png',
      url: null,
    }]]));

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.inputs.image?.elements).toEqual([expect.objectContaining({ id: 'row-product', url: null })]);
    expect(bundle.restoreIssues).toContain('image-element:Product');
    expect(bundle.inputSlots?.map((slot) => slot.handle)).toEqual([null]);
  });

  // An input with a copy read as one the creator kept to themselves, for good: the app's recovery never
  // read the source again once its mentions had boxes (2026-11-03 review).
  it('names no slot in place of a copy when the recipe cannot be read, and raises a restore issue to read it again', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(UNLOCKED_ACCESS);
    mocks.loadGenerationRecipeReferenceCopies.mockRejectedValue(new Error('post_resource_bundles unavailable'));

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle).not.toHaveProperty('inputSlots');
    expect(bundle.restoreIssues).toEqual(['withheld-inputs', 'result']);
    expect(bundle.inputs).toEqual({});
  });

  // A recipe its seller retired gates no Remix, so the gate reads its buyer as anyone: they still own
  // what they bought, as the file route and the run start's import hold (2026-11-03 review).
  it('restores a retired recipe’s copies for its buyer from the recipe the gate read', async () => {
    const RETIRED = { id: 'bundle-verified', ownerUserId: 'creator-1', published: false, viewerHasPurchased: null };
    mocks.resolveRemixAccess.mockResolvedValue({ ...PUBLIC_ACCESS, recipe: RETIRED });
    mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([['row-product', {
      storagePath: 'post_resource_files/creator-1/generation-references/gen-1/00-reference-image-row-product.png',
      url: 'https://signed.example/recipe-copy-of-product.png?token=short',
    }]]));

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(mocks.loadGenerationRecipeReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({ recipe: RETIRED, viewerUserId: 'viewer-1' }));
    expect(bundle.inputs.image?.elements?.map((element) => element.id)).toEqual(['row-product']);
    expect(bundle.inputSlots).toEqual([{ id: 'slot-1', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 1' }]);
  });

  // A story keeps only its first shot as the creation's prompt, and a handle only a later shot names
  // read as "Unknown element mention", its box as "Subject 2" (2026-11-03 review).
  it('names a slot by the handle any shot of a story mentions', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'kling-o3',
      prompt: '@hero walks in.',
      workflow_settings: { model: 'kling-o3', multiPrompts: [{ prompt: '@hero walks in.', duration: 3 }, { prompt: '@villain waits.', duration: 3 }] },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [
      row('row-hero', 'image', 'subject_image', 0, 'Hero', { handle: '@hero', subjectIndex: 0 }),
      row('row-villain', 'image', 'subject_image', 1, 'Villain', { handle: '@villain', subjectIndex: 1 }),
    ]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputSlots?.map((slot) => slot.handle)).toEqual(['@hero', '@villain']);
  });

  it.each([
    ['the owner', { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false, recipe: null }],
    ['a remix of shared inputs', { ...PUBLIC_ACCESS, includeSharedInputMedia: true }],
    ['someone the unlocked recipe hands the inputs to', { ...UNLOCKED_ACCESS, recipeEntitled: true }],
  ])('gives %s no slots', async (_, access) => {
    mocks.resolveRemixAccess.mockResolvedValue(access);
    mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([PRODUCT, BACKDROP]);

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle).not.toHaveProperty('inputSlots');
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalledWith(expect.objectContaining({ urlMode: 'none' }));
    expect(mocks.loadGenerationRecipeReferenceCopies).not.toHaveBeenCalled();
  });

  // Owner, 2026-11-03: a buyer's run that used a seller's recipe file keeps it as an input of its own.
  // A remix of the buyer's creation is never handed it, whatever the buyer shares: an empty slot instead.
  describe('a creation whose run used a file of someone else’s recipe', () => {
    const SIGNED = (path: string) => `https://signed.example/${path}?token=short`;
    const signed = (item: ReturnType<typeof row>) => ({ ...item, url: SIGNED(item.storagePath) });
    const BOUGHT = signed(row('row-bought', 'image', 'reference_image', 2, 'Bought', {
      handle: '@backdrop',
      sourceKind: 'recipe-file',
      sourceStoragePath: 'post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row-9.png',
    }));
    // Unmarked: known by the start's import of the seller's copy alone.
    const IMPORTED = signed(row('row-imported', 'image', 'reference_image', 3, 'Imported', {
      sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/generation_inputs/creator-1/recipe-imports/gen-0/01-reference-image-row-8.png?token=x',
    }));

    beforeEach(() => {
      mocks.generation = {
        ...mocks.generation,
        prompt: 'Place @product on @backdrop',
        workflow_settings: {
          model: 'nano-banana-2',
          // Each prepared from its input's own upload, which the input's row names as its source.
          seedanceAssets: { images: [
            { assetId: 'asset-product', assetType: 'Image', status: 'active', sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/1730000000000-product.png?token=prep' },
            { assetId: 'asset-backdrop', assetType: 'Image', status: 'active', sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/1730000000001-my-passport.jpg?token=prep' },
            { assetId: 'asset-bought', assetType: 'Image', status: 'active', sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row-9.png?token=prep' },
          ] },
        },
      };
      mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [signed(PRODUCT), signed(BACKDROP), BOUGHT, IMPORTED]]]));
    });

    it('gives a remix the creator shares their inputs with an empty slot in its place, and nothing of the file', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...PUBLIC_ACCESS, includeSharedInputMedia: true });

      const bundle = await loadRemixSourceBundle(request(), 'gen-1');

      expect(bundle.inputs.image?.elements?.map((element) => element.id)).toEqual(['row-product', 'row-backdrop']);
      expect(bundle.inputSlots).toEqual([
        { id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@backdrop', name: 'Reference image 1' },
        { id: 'slot-2', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 2' },
      ]);
      expect(JSON.stringify(bundle)).not.toMatch(/row-bought|row-imported|recipe-imports|post_resource_files|seller-9|asset-bought|asset-imported/);
      // The prepared assets of what is handed over, in their places among it.
      expect(bundle.workflowSettings.seedanceAssets).toEqual({
        images: [
          expect.objectContaining({ assetId: 'asset-product' }),
          expect.objectContaining({ assetId: 'asset-backdrop' }),
        ],
        videos: [],
        audios: [],
      });
      expect(bundle.restoreIssues).toEqual(['result']);
    });

    it('gives a buyer of a recipe that hands its inputs over an empty slot in its place', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...UNLOCKED_ACCESS, recipeEntitled: true });
      // The loader hands over the rest, and holds the recipe file back for its slot (post-resource-bundles-server).
      mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([signed(PRODUCT), signed(BACKDROP)]);
      mocks.recipeFiles = [{ ...BOUGHT, url: null }];

      const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

      expect(bundle.inputs.image?.elements?.map((element) => element.id)).toEqual(['row-product', 'row-backdrop']);
      expect(bundle.inputSlots).toEqual([{ id: 'slot-1', kind: 'image', role: 'reference_image', handle: '@backdrop', name: 'Reference image 1' }]);
      expect(JSON.stringify(bundle)).not.toMatch(/row-bought|post_resource_files|seller-9|asset-bought/);
    });

    // Remix plan, phase 1b: the file came through the recipe the creator's run remixed, and their
    // recipe passed it on, so a buyer of that recipe gets it from the recipe's copy instead of a slot.
    it('gives a buyer of a recipe that hands its inputs over a passed-on file from the recipe’s copy', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...UNLOCKED_ACCESS, recipeEntitled: true });
      mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([signed(PRODUCT), signed(BACKDROP)]);
      mocks.recipeFiles = [{ ...BOUGHT, url: null }];
      const COPY = 'post_resource_files/creator-1/generation-references/gen-1/02-reference-image-row-bought.png';
      mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([['row-bought', { storagePath: COPY, url: SIGNED(COPY) }]]));

      const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

      expect(mocks.loadGenerationRecipeReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({
        recipe: BOUGHT_RECIPE,
        generationId: 'gen-1',
        inputRowIds: ['row-bought'],
      }));
      expect(bundle.inputs.image?.elements?.map((element) => [element.id, element.storagePath ?? null])).toEqual([
        ['row-product', expect.anything()],
        ['row-backdrop', expect.anything()],
        ['row-bought', COPY],
      ]);
      expect(bundle).not.toHaveProperty('inputSlots');
      // Never the creator's kept file, the seller's copy it came from, or the asset prepared from it.
      expect(JSON.stringify(bundle)).not.toMatch(/generation_inputs\/creator-1\/gen-1\/02|seller-9|asset-bought/);
    });

    // Phase 1b's review: the creator's own asset of a passed-on file was prepared from their kept file,
    // theirs alone; handed over, the remix's Generate was refused. It prepares its own from the copy.
    it('hands a remix no asset of the creator’s for a passed-on file', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...UNLOCKED_ACCESS, recipeEntitled: true });
      const kept = { ...BOUGHT, url: null, metadata: { ...BOUGHT.metadata, seedanceAsset: { assetId: 'asset-kept-bought', assetType: 'Image', status: 'active' } } };
      mocks.generation = {
        ...mocks.generation!,
        workflow_settings: {
          ...(mocks.generation!.workflow_settings as Record<string, unknown>),
          seedanceAssets: { images: [
            { assetId: 'asset-product', assetType: 'Image', status: 'active', sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/1730000000000-product.png?token=prep' },
            { assetId: 'asset-kept-bought', assetType: 'Image', status: 'active', sourceUrl: kept.storagePath },
          ] },
        },
      };
      mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([signed(PRODUCT)]);
      mocks.recipeFiles = [kept];
      const COPY = 'post_resource_files/creator-1/generation-references/gen-1/02-reference-image-row-bought.png';
      mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([['row-bought', { storagePath: COPY, url: SIGNED(COPY) }]]));

      const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

      expect(bundle.inputs.image?.elements?.map((element) => element.id)).toEqual(['row-product', 'row-bought']);
      expect(JSON.stringify(bundle.workflowSettings.seedanceAssets ?? null)).not.toContain('asset-kept-bought');
    });

    // Phase 1b's review: a creator who shares their run's inputs and sells its recipe; a buyer of the
    // recipe gets the passed-on file from its copy, where the shared inputs alone would give a slot.
    it('gives a buyer of a recipe whose creator shares the inputs a passed-on file from the recipe’s copy', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...UNLOCKED_ACCESS, includeSharedInputMedia: true });
      const COPY = 'post_resource_files/creator-1/generation-references/gen-1/02-reference-image-row-bought.png';
      mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([['row-bought', { storagePath: COPY, url: SIGNED(COPY) }]]));

      const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

      expect(mocks.loadGenerationRecipeReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({
        recipe: BOUGHT_RECIPE,
        inputRowIds: ['row-bought', 'row-imported'],
      }));
      expect(bundle.inputs.image?.elements?.map((element) => [element.id, element.storagePath ?? null])).toEqual([
        ['row-product', expect.anything()],
        ['row-backdrop', expect.anything()],
        ['row-bought', COPY],
      ]);
      // The import with no copy in the recipe keeps its slot.
      expect(bundle.inputSlots).toEqual([{ id: 'slot-1', kind: 'image', role: 'reference_image', handle: null, name: 'Reference image 1' }]);
    });

    it('fails a remix whose passed-on copies cannot be read, rather than giving the file a slot', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...UNLOCKED_ACCESS, recipeEntitled: true });
      mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([signed(PRODUCT)]);
      mocks.recipeFiles = [{ ...BOUGHT, url: null }];
      mocks.loadGenerationRecipeReferenceCopies.mockRejectedValue(new Error('statement timeout'));

      await expect(loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' })).rejects.toThrow();
    });

    // A subject whose held-back picture leaves it one picture is no subject (2026-11-03 re-review): it
    // was restored with one picture, and its box hid as answered by it.
    it('gives a subject left below what a subject takes by a held-back picture its slot, not the rest of it', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ ...PUBLIC_ACCESS, includeSharedInputMedia: true });
      mocks.generation = {
        ...mocks.generation,
        category: 'video',
        model: 'kling-o3',
        prompt: '@lead lifts the bottle.',
        workflow_settings: { model: 'kling-o3', referenceMode: 'elements' },
      };
      mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [
        signed(row('row-lead-1', 'image', 'subject_image', 0, 'Lead', { handle: '@lead', displayName: 'Lead', subjectIndex: 0 })),
        signed(row('row-lead-2', 'image', 'subject_image', 1, 'Lead', { handle: '@lead', displayName: 'Lead', subjectIndex: 0, sourceKind: 'recipe-file' })),
      ]]]));

      const bundle = await loadRemixSourceBundle(request(), 'gen-1');

      expect(bundle.inputs.video?.subjects ?? []).toEqual([]);
      expect(bundle.inputSlots).toEqual([{ id: 'slot-1', kind: 'image', role: 'subject', handle: '@lead', name: 'Subject 1' }]);
      expect(JSON.stringify(bundle)).not.toMatch(/row-lead|generation_inputs/);
    });

    it('still hands the owner every input of their own run', async () => {
      mocks.resolveRemixAccess.mockResolvedValue({ allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false, recipe: null });

      const bundle = await loadRemixSourceBundle(request(), 'gen-1');

      expect(bundle.inputMedia?.map((item) => item.id)).toEqual(['row-product', 'row-backdrop', 'row-bought', 'row-imported']);
      expect(bundle).not.toHaveProperty('inputSlots');
    });
  });

  it.each([
    ['a recipe it has not unlocked', { allowed: false, reason: 'unlock_required' }, 403],
    ['a template result', { allowed: false, reason: 'template_result' }, 400],
    ['a source it may not see', { allowed: false, reason: 'not_found' }, 404],
  ])('reads no input and names no slot for %s', async (_, access, status) => {
    mocks.resolveRemixAccess.mockResolvedValue(access);

    const outcome = await loadRemixSourceBundle(request(), 'gen-1').then((bundle) => bundle, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(RemixSourceError);
    expect(outcome).toMatchObject({ status });
    expect(JSON.stringify(outcome)).not.toMatch(/inputSlots|slot-1/);
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
    expect(mocks.buildLegacyGenerationInputMedia).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeReferenceCopies).not.toHaveBeenCalled();
  });
});

// Product decision D4 (2026-10-15): the route admits an app guest, for its
// own creations only. Whatever else the shared gate would grant (a public
// post's recipe, a bought one) is remixing, which takes an account, so a
// guest's request is decided before that gate is asked anything.
describe('loadRemixSourceBundle for an app guest', () => {
  function asGuest() {
    vi.mocked(getVerifiedAuthUserResult).mockResolvedValueOnce({
      data: { user: { id: 'guest-1', is_anonymous: true } },
      error: null,
    } as never);
  }

  it("refuses another creator's generation in the proxy's words, before the gate is asked or anything signed", async () => {
    asGuest();

    const outcome = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' })
      .then((bundle) => bundle, (error: unknown) => error);

    expect(outcome).toBeInstanceOf(RemixSourceError);
    expect(outcome).toMatchObject({
      status: 403,
      code: 'REGISTRATION_REQUIRED',
      message: 'Create an account to use this feature.',
    });
    expect(JSON.stringify(outcome)).not.toContain(LOCKED_PROMPT);
    expect(mocks.resolveRemixAccess).not.toHaveBeenCalled();
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).not.toHaveBeenCalled();
  });

  it('gives a generation that does not exist the same answer, so nothing is confirmed', async () => {
    asGuest();
    mocks.generation = null;

    await expect(loadRemixSourceBundle(request(), 'gen-1')).rejects.toMatchObject({
      status: 403,
      code: 'REGISTRATION_REQUIRED',
    });
    expect(mocks.resolveRemixAccess).not.toHaveBeenCalled();
  });

  it('hands its own generation to the shared gate, which restores it as the owner', async () => {
    asGuest();
    mocks.generation = { ...mocks.generation, user_id: 'guest-1', is_public: false };
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'owner',
      post: null,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.generation.prompt).toBe(LOCKED_PROMPT);
    expect(mocks.resolveRemixAccess).toHaveBeenCalledWith(expect.objectContaining({
      viewerUserId: 'guest-1',
      generation: expect.objectContaining({ id: 'gen-1', user_id: 'guest-1' }),
    }));
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalled();
  });
});

// Audit, additional risk: a motion model onboarded through the generic catalog
// path is stored the catalog's way. The record is a 'video' generation marked
// by creation_mode, its inputs are slots, and its durable rows took the plain
// reference roles. Remix only knew the legacy motion shape, so it restored the
// character image as a video reference and the motion creator got nothing.
describe('remixing a motion generation made through the catalog', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const CATALOG_INPUTS = [
    { slot: 'characterImage', kind: 'image', label: 'Character image', storagePath: 'uploads/creator-1/hero.png' },
    { slot: 'referenceVideo', kind: 'video', label: 'Reference video', storagePath: 'uploads/creator-1/moves.mp4', durationSeconds: 8 },
  ] as const;

  function catalogMotionGeneration() {
    return {
      id: 'gen-1',
      user_id: 'creator-1',
      is_public: true,
      share_input_media_for_remix: true,
      output_url: null,
      showcase_asset_path: null,
      category: 'video',
      creation_mode: 'motion',
      model: 'kling-2.6',
      prompt: 'Dance like the clip',
      title: 'Dance',
      // What startCatalogGeneration writes: settings at the top level and the
      // inputs as slots, with no legacy characterImage or referenceVideo keys.
      workflow_settings: {
        model: 'kling-2.6',
        catalogRevision: 'rev-1',
        resolution: '720p',
        characterOrientation: 'video',
        duration: 8,
        inputs: CATALOG_INPUTS,
      },
    };
  }

  /** Durable rows as the catalog path persisted them before motion slots had motion roles. */
  const ROWS_WITH_REFERENCE_ROLES = [
    {
      id: 'row-0',
      generationId: 'gen-1',
      mediaType: 'image',
      role: 'reference_image',
      label: 'Character image',
      url: 'https://signed.example/hero.png',
      storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
      sourceGenerationId: null,
      sortOrder: 0,
      metadata: { slot: 'characterImage', displayName: 'Character image', sourceStoragePath: 'uploads/creator-1/hero.png' },
    },
    {
      id: 'row-1',
      generationId: 'gen-1',
      mediaType: 'video',
      role: 'reference_video',
      label: 'Reference video',
      url: 'https://signed.example/moves.mp4',
      storagePath: 'generation_inputs/creator-1/gen-1/01-reference_video.mp4',
      sourceGenerationId: null,
      sortOrder: 1,
      metadata: { slot: 'referenceVideo', durationSeconds: 8, sourceStoragePath: 'uploads/creator-1/moves.mp4' },
    },
  ];

  beforeEach(() => {
    mocks.generation = catalogMotionGeneration();
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
  });

  it('restores its durable inputs into the motion creator, reading the slot where the role is generic', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', ROWS_WITH_REFERENCE_ROLES]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(mocks.selectedColumns.join(' ')).toContain('creation_mode');
    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.inputs.motion).toEqual({
      characterImage: expect.objectContaining({ kind: 'image', url: 'https://signed.example/hero.png' }),
      referenceVideo: expect.objectContaining({ kind: 'video', url: 'https://signed.example/moves.mp4' }),
    });
    // The fixture has no output, which is its own issue; neither input is one.
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('motion-') || issue.startsWith('video-'))).toEqual([]);
  });

  // The round trip for a generation started now: the rows the catalog start
  // keeps, read back the way loadGenerationInputMediaMap returns them, restore
  // into the motion creator.
  it('restores what a new catalog motion start keeps', async () => {
    const candidates = buildCatalogInputMediaCandidates(
      'motion',
      CATALOG_INPUTS.map((input) => ({ ...input, url: `https://provider.example/${input.slot}` })),
    );
    expect(candidates.map((candidate) => candidate.role)).toEqual(['character_image', 'motion_reference_video']);
    const rows = candidates.map((candidate, index) => ({
      id: `row-${index}`,
      generationId: 'gen-1',
      mediaType: candidate.mediaType,
      role: candidate.role,
      label: candidate.label ?? '',
      url: `https://signed.example/durable-${index}`,
      storagePath: `generation_inputs/creator-1/gen-1/0${index}-${candidate.role}`,
      sourceGenerationId: candidate.sourceGenerationId ?? null,
      sortOrder: candidate.sortOrder ?? index,
      metadata: { ...candidate.metadata, sourceStoragePath: candidate.sourceStoragePath ?? null },
    }));
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', rows]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.inputs.motion).toEqual({
      characterImage: expect.objectContaining({ kind: 'image', label: 'Character image', url: 'https://signed.example/durable-0' }),
      referenceVideo: expect.objectContaining({ kind: 'video', label: 'Reference video', url: 'https://signed.example/durable-1' }),
    });
  });

  it('restores from its own input slots when no durable copy was made', async () => {
    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.inputs.motion).toEqual({
      characterImage: expect.objectContaining({ kind: 'image', storagePath: 'uploads/creator-1/hero.png', url: 'https://signed.example/upload' }),
      referenceVideo: expect.objectContaining({ kind: 'video', storagePath: 'uploads/creator-1/moves.mp4', url: 'https://signed.example/upload' }),
    });
  });

  // A catalog motion run sends its picture and clip in the slots its model declares
  // (catalogMotionInputSlots): production published Kling 3.0 with imageReferences and
  // videoReferences until release kling-3-motion-inputs-20261101. A motion run holds one picture
  // and one clip, so they are kept under the motion roles by kind: kept by the motion-inputs
  // names, they came back as nothing.
  describe('in the slots its model declares', () => {
    const DECLARED_INPUTS = [
      { slot: 'imageReferences', kind: 'image', label: 'Character image', storagePath: 'uploads/creator-1/hero.png' },
      { slot: 'videoReferences', kind: 'video', label: 'Reference video', storagePath: 'uploads/creator-1/moves.mp4', durationSeconds: 8 },
    ] as const;

    beforeEach(() => {
      const generation = catalogMotionGeneration();
      mocks.generation = { ...generation, model: 'kling-3.0', workflow_settings: { ...generation.workflow_settings, model: 'kling-3.0', inputs: DECLARED_INPUTS } };
    });

    it('keeps them under the motion roles, and restores the durable copies into the motion creator', async () => {
      const candidates = buildCatalogInputMediaCandidates(
        'motion',
        DECLARED_INPUTS.map((input) => ({ ...input, url: `https://provider.example/${input.slot}` })),
      );
      expect(candidates.map((candidate) => candidate.role)).toEqual(['character_image', 'motion_reference_video']);
      mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', candidates.map((candidate, index) => ({
        id: `row-${index}`,
        generationId: 'gen-1',
        mediaType: candidate.mediaType,
        role: candidate.role,
        label: candidate.label ?? '',
        url: `https://signed.example/durable-${index}`,
        storagePath: `generation_inputs/creator-1/gen-1/0${index}-${candidate.role}`,
        sourceGenerationId: candidate.sourceGenerationId ?? null,
        sortOrder: candidate.sortOrder ?? index,
        metadata: { ...candidate.metadata, sourceStoragePath: candidate.sourceStoragePath ?? null },
      }))]]));

      const bundle = await loadRemixSourceBundle(request(), 'gen-1');

      expect(bundle.inputs.video).toBeUndefined();
      expect(bundle.inputs.motion).toEqual({
        characterImage: expect.objectContaining({ kind: 'image', label: 'Character image', url: 'https://signed.example/durable-0' }),
        referenceVideo: expect.objectContaining({ kind: 'video', label: 'Reference video', url: 'https://signed.example/durable-1' }),
      });
    });

    // Runs kept before the roles went by kind: the plain reference roles, under the slots
    // the model declares. Read by the motion-inputs slot names only, both came back as
    // nothing, with no restore issue, and the motion creator opened empty.
    it('restores runs kept under the plain reference roles in those slots, by kind', async () => {
      mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', ROWS_WITH_REFERENCE_ROLES.map((row, index) => ({
        ...row,
        metadata: { ...row.metadata, slot: DECLARED_INPUTS[index].slot },
      }))]]));

      const bundle = await loadRemixSourceBundle(request(), 'gen-1');

      expect(bundle.inputs.video).toBeUndefined();
      expect(bundle.inputs.motion).toEqual({
        characterImage: expect.objectContaining({ kind: 'image', url: 'https://signed.example/hero.png' }),
        referenceVideo: expect.objectContaining({ kind: 'video', url: 'https://signed.example/moves.mp4' }),
      });
      expect(bundle.restoreIssues.filter((issue) => issue.startsWith('motion-') || issue.startsWith('video-'))).toEqual([]);
    });
  });
});

// Audit, additional risk: keeping a generation's inputs fails one item at a
// time, and each failure is only logged. A generation that kept some of its
// inputs restored as though it had kept them all, so a remix showed half a
// recipe with nothing to say the rest was missing.
describe('a recipe whose inputs were only partly kept', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const KEPT_IMAGE = {
    id: 'row-0',
    generationId: 'gen-1',
    mediaType: 'image',
    role: 'reference_image',
    label: 'Girl',
    url: 'https://signed.example/girl.png',
    storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
    sourceGenerationId: null,
    sortOrder: 0,
    metadata: { handle: '@girl', displayName: 'Girl', sourceStoragePath: 'uploads/creator-1/girl.png' },
  };
  /** What the recipe itself says it used, read without signing anything. */
  const DECLARED_IMAGE = { ...KEPT_IMAGE, id: 'legacy-0', url: null, storagePath: 'uploads/creator-1/girl.png', metadata: { legacy: true } };
  const DECLARED_CLIP = {
    id: 'legacy-1',
    generationId: 'gen-1',
    mediaType: 'video',
    role: 'reference_video',
    label: 'Clip',
    url: null,
    storagePath: null,
    sourceGenerationId: null,
    sortOrder: 1,
    metadata: { legacy: true, sourceUrl: 'https://cdn.example/clip.mp4' },
  };

  beforeEach(() => {
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'seedance-2',
      workflow_settings: { model: 'seedance-2', referenceMode: 'elements' },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [KEPT_IMAGE]]]));
  });

  it('says some media could not be restored when the recipe used more than was kept', async () => {
    mocks.buildLegacyGenerationInputMedia.mockResolvedValue([DECLARED_IMAGE, DECLARED_CLIP]);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.elements).toEqual([expect.objectContaining({ handle: '@girl', url: 'https://signed.example/girl.png' })]);
    expect(bundle.restoreIssues).toContain('input-media-not-kept:video');
    expect(mocks.buildLegacyGenerationInputMedia).toHaveBeenCalledWith(expect.objectContaining({ generationId: 'gen-1', urlMode: 'none' }));
  });

  it('adds nothing when everything the recipe used was kept', async () => {
    mocks.buildLegacyGenerationInputMedia.mockResolvedValue([DECLARED_IMAGE]);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept'))).toEqual([]);
  });
});

// A Seedance run sends its reference clip to the provider as a plain URL, and
// that URL is all the recipe records of it. Reported from a live post: the
// remix opened with the three reference images and no sign that a clip existed.
describe('a recipe with a reference clip sent as a plain URL', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const KEPT_IMAGE = {
    id: 'row-0',
    generationId: 'gen-1',
    mediaType: 'image',
    role: 'reference_image',
    label: 'Ali',
    url: 'https://signed.example/ali.png',
    storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
    sourceGenerationId: null,
    sortOrder: 0,
    metadata: { id: 'imageReferences-1', handle: '@ali', displayName: 'Ali', sourceStoragePath: 'uploads/creator-1/ali.png' },
  };

  beforeEach(async () => {
    // The recipe is read by the real builder here: what it declares is the point.
    const actual = await vi.importActual<typeof import('@/lib/generation-input-media')>('@/lib/generation-input-media');
    mocks.buildLegacyGenerationInputMedia.mockImplementation(actual.buildLegacyGenerationInputMedia);
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'seedance-2',
      prompt: 'Change the first person in the reference video to @ali',
      workflow_settings: {
        model: 'seedance-2',
        referenceMode: 'references',
        elements: [{ id: 'imageReferences-1', displayName: 'Ali', handle: '@ali', storagePath: 'uploads/creator-1/ali.png', sourceGenerationId: null }],
        referenceVideoUrls: [
          'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/dance.mp4?token=expired',
        ],
      },
    };
  });

  it('says a clip is missing when only the images were kept', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [KEPT_IMAGE]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.referenceVideos).toEqual([]);
    expect(bundle.restoreIssues).toContain('input-media-not-kept:video');
  });

  // The round trip for a run started now: the row the video start keeps for the
  // clip, read back the way loadGenerationInputMediaMap returns it.
  it('restores the clip beside the images once the run keeps it', async () => {
    const [clip] = collectReferenceMediaCandidates({
      mediaType: 'video',
      sources: ['https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/dance.mp4?token=read'],
      resolvedUrls: ['https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/dance.mp4?token=provider'],
      descriptors: [{ kind: 'video', label: 'Dance clip', storagePath: 'uploads/creator-1/dance.mp4', sourceGenerationId: null, durationSeconds: 9.4 }],
    });
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [KEPT_IMAGE, {
      id: 'row-1',
      generationId: 'gen-1',
      mediaType: clip.mediaType,
      role: clip.role,
      label: clip.label ?? '',
      url: 'https://signed.example/dance.mp4',
      storagePath: 'generation_inputs/creator-1/gen-1/01-reference_video.mp4',
      sourceGenerationId: clip.sourceGenerationId ?? null,
      sortOrder: 1,
      metadata: { ...clip.metadata, sourceStoragePath: clip.sourceStoragePath ?? null },
    }]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.elements).toEqual([expect.objectContaining({ handle: '@ali', url: 'https://signed.example/ali.png' })]);
    // With its length: a Seedance remix cannot be quoted without it.
    expect(bundle.inputs.video?.referenceVideos).toEqual([{
      kind: 'video',
      label: 'Dance clip',
      storagePath: 'generation_inputs/creator-1/gen-1/01-reference_video.mp4',
      sourceGenerationId: null,
      url: 'https://signed.example/dance.mp4',
      durationSeconds: 9.4,
    }]);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept'))).toEqual([]);
  });
});

// A Kling O3 run takes named subjects: two to four pictures of one person or
// product, under an @handle the prompt mentions. A run kept nothing of them, so
// a remix of it restored the prompt and no subject (2026-10-03).
describe('a Kling O3 run with named subjects', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const PUBLIC_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: false, recipeEntitled: false };
  // Neither handle is the one its subject's name would give.
  const DECLARED_SUBJECTS = [
    {
      handle: '@lead',
      displayName: 'Hero creator',
      images: [{ storagePath: 'uploads/creator-1/hero-front.png' }, { storagePath: 'uploads/creator-1/hero-side.png' }],
    },
    {
      handle: '@bottle',
      displayName: 'Serum bottle',
      images: [{ storagePath: 'uploads/creator-1/bottle-front.png' }, { storagePath: 'uploads/creator-1/bottle-side.png' }],
    },
  ];

  // The round trip for a run started now: the rows the video start keeps for
  // its subjects, read back the way loadGenerationInputMediaMap returns them.
  const KEPT_PICTURES = collectSubjectImageCandidates({
    subjects: DECLARED_SUBJECTS.map((subject) => ({
      ...subject,
      images: subject.images.map((image) => ({ url: image.storagePath, storagePath: image.storagePath })),
      imageUrls: subject.images.map((image) => `https://provider.example/${image.storagePath}`),
    })),
  }).map((candidate, sortOrder) => ({
    id: `row-${sortOrder}`,
    generationId: 'gen-1',
    mediaType: candidate.mediaType,
    role: candidate.role,
    label: candidate.label ?? '',
    url: `https://signed.example/kept-${sortOrder}.png`,
    storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-${candidate.role}.png`,
    sourceGenerationId: candidate.sourceGenerationId ?? null,
    sortOrder,
    metadata: { ...candidate.metadata, sourceStoragePath: candidate.sourceStoragePath ?? null },
  }));
  const RESTORED_SUBJECTS = [
    {
      handle: '@lead',
      displayName: 'Hero creator',
      images: [0, 1].map((sortOrder) => ({
        kind: 'image',
        label: 'Hero creator',
        storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-subject_image.png`,
        sourceGenerationId: null,
        url: `https://signed.example/kept-${sortOrder}.png`,
      })),
    },
    {
      handle: '@bottle',
      displayName: 'Serum bottle',
      images: [2, 3].map((sortOrder) => ({
        kind: 'image',
        label: 'Serum bottle',
        storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-subject_image.png`,
        sourceGenerationId: null,
        url: `https://signed.example/kept-${sortOrder}.png`,
      })),
    },
  ];

  beforeEach(async () => {
    // The recipe is read by the real builder here: what it declares is the point.
    const actual = await vi.importActual<typeof import('@/lib/generation-input-media')>('@/lib/generation-input-media');
    mocks.buildLegacyGenerationInputMedia.mockImplementation(actual.buildLegacyGenerationInputMedia);
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'kling-o3',
      prompt: '@lead lifts @bottle and smiles at the camera.',
      workflow_settings: { model: 'kling-o3', referenceMode: 'elements', klingSubjects: DECLARED_SUBJECTS },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', KEPT_PICTURES]]));
  });

  it('restores each subject with its handle, its name and its pictures, in the order the run used them', async () => {
    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects).toEqual(RESTORED_SUBJECTS);
    // A subject's pictures are one identity, not four references: they are not
    // handed to a creator that would attach them as plain reference images.
    expect(bundle.inputs.video?.elements).toEqual([]);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept') || issue.startsWith('video-subject'))).toEqual([]);
  });

  it('says some media is missing when the run kept fewer pictures than its subjects had', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', KEPT_PICTURES.slice(0, 3)]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects?.map((subject) => [subject.handle, subject.images.length])).toEqual([
      ['@lead', 2],
      ['@bottle', 1],
    ]);
    expect(bundle.restoreIssues).toContain('input-media-not-kept:image');
  });

  it('names the subject whose picture has no link to hand over', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [
      ...KEPT_PICTURES.slice(0, 3),
      { ...KEPT_PICTURES[3], url: null },
    ]]]));

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects?.[1].images.map((image) => image.url)).toEqual(['https://signed.example/kept-2.png', null]);
    expect(bundle.restoreIssues).toContain('video-subject:Serum bottle');
    expect(bundle.restoreIssues).not.toContain('video-subject:Hero creator');
  });

  // No copy of the pictures was made (keeping them failed outright): the owner's
  // remix reads them from where the run's settings say they were staged.
  it('restores the subjects from the run’s settings when no copy of their pictures was kept', async () => {
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map());

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.inputs.video?.subjects).toEqual(DECLARED_SUBJECTS.map((subject) => ({
      handle: subject.handle,
      displayName: subject.displayName,
      images: subject.images.map((image) => ({
        kind: 'image',
        label: subject.displayName,
        storagePath: image.storagePath,
        sourceGenerationId: null,
        url: 'https://signed.example/upload',
      })),
    })));
  });

  it('restores no subject for a run that recorded none', async () => {
    // A run made before subjects were kept: its prompt mentions them and nothing else does.
    mocks.generation = { ...mocks.generation, workflow_settings: { model: 'kling-o3', referenceMode: 'elements' } };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map());

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.generation.prompt).toBe('@lead lifts @bottle and smiles at the camera.');
    expect(bundle.inputs.video?.subjects).toEqual([]);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('input-media-not-kept') || issue.startsWith('video-subject'))).toEqual([]);
  });

  it('keeps the subjects out of a remix the creator did not share the run’s inputs with', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.generation.prompt).toBe('@lead lifts @bottle and smiles at the camera.');
    expect(bundle.inputs.video).toBeUndefined();
    expect(bundle.workflowSettings).toEqual({ model: 'kling-o3', referenceMode: 'elements' });
    // Even the links this fake read hands back stay out: a slot is named, never filled.
    expect(JSON.stringify(bundle)).not.toMatch(/hero-front|subject_image|Hero creator|kept-\d|generation_inputs/);
    // Read without signing, for an empty slot per subject (owner, 2026-11-03).
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledTimes(1);
    expect(mocks.loadGenerationInputMediaMap).toHaveBeenCalledWith(expect.objectContaining({ urlMode: 'none' }));
    expect(bundle.inputSlots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'subject', handle: '@lead', name: 'Subject 1' },
      { id: 'slot-2', kind: 'image', role: 'subject', handle: '@bottle', name: 'Subject 2' },
    ]);
  });

  it('restores the subjects an unlocked recipe holds copies of, and gives the others a slot each', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      ...PUBLIC_ACCESS,
      basis: 'unlocked',
      recipe: { id: 'bundle-verified', ownerUserId: 'creator-1', published: true, viewerHasPurchased: true },
    });
    const copyPath = (sortOrder: number) => (
      `post_resource_files/creator-1/generation-references/gen-1/0${sortOrder}-subject-image-row-${sortOrder}.png`
    );
    mocks.loadGenerationRecipeReferenceCopies.mockResolvedValue(new Map([0, 1].map((sortOrder) => [
      `row-${sortOrder}`,
      { storagePath: copyPath(sortOrder), url: `https://signed.example/copy-${sortOrder}.png` },
    ])));

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.inputs.video?.subjects).toEqual([{
      handle: '@lead',
      displayName: 'Hero creator',
      images: [0, 1].map((sortOrder) => ({
        kind: 'image',
        label: 'Hero creator',
        storagePath: copyPath(sortOrder),
        sourceGenerationId: null,
        url: `https://signed.example/copy-${sortOrder}.png`,
      })),
    }]);
    expect(bundle.inputSlots).toEqual([
      { id: 'slot-1', kind: 'image', role: 'subject', handle: '@bottle', name: 'Subject 1' },
    ]);
    // The creator's own copies and their links never reach the remix: only the recipe's.
    expect(JSON.stringify(bundle)).not.toMatch(/kept-\d|generation_inputs/);
    expect(bundle.restoreIssues.filter((issue) => issue.startsWith('video-subject'))).toEqual([]);
  });

  it('restores the subjects of a bought recipe from the post the gate verified, with the settings still stripped', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ ...PUBLIC_ACCESS, basis: 'unlocked', recipeEntitled: true });
    mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue(KEPT_PICTURES);

    const bundle = await loadRemixSourceBundle(request('post-client'), 'gen-1', { postId: 'post-client' });

    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-verified',
      generationId: 'gen-1',
      viewerUserId: 'viewer-1',
    }));
    expect(bundle.inputs.video?.subjects).toEqual(RESTORED_SUBJECTS);
    expect(bundle.workflowSettings).toEqual({ model: 'kling-o3', referenceMode: 'elements' });
    expect(mocks.loadGenerationInputMediaMap).not.toHaveBeenCalled();
  });
});

// A picture run started through the catalog records each input as a slot with
// the path it was staged under in its creator's folder, and settling a run
// that made several pictures lists where each was kept. Neither is a setting
// an editor restores, and both name the creator's account and their files.
describe("a catalog picture run's own media in its settings", () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const PUBLIC_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: false, recipeEntitled: false };
  const CREATOR_FOLDER = new RegExp(`(?:${[...USER_SCOPED_STORAGE_BUCKETS].join('|')})/creator-1/`);
  // What startCatalogGeneration writes, in three parts: what an editor restores,
  // what is kept of the inputs, then where settling two pictures kept them.
  const RESTORED = {
    aspectRatio: '3:4',
    resolution: '2K',
    model: 'nano-banana-2',
    catalogRevision: 'rev-1',
    settings: { aspectRatio: '3:4', resolution: '2K' },
  };
  const OF_THE_INPUTS = {
    compiledPrompt: '@me in a linen suit. @me is the first attached image.',
    elements: [{ displayName: 'me', handle: '@me', storagePath: 'uploads/creator-1/1730000000000-passport-scan.jpg', sourceGenerationId: null }],
    inputs: [
      { slot: 'imageReferences', kind: 'image', label: 'me', handle: '@me', storagePath: 'uploads/creator-1/1730000000000-passport-scan.jpg' },
      { slot: 'imageReferences', kind: 'image', sourceGenerationId: 'gen-private-7' },
    ],
  };
  const OF_THE_PICTURES = {
    outputs: [
      { index: 0, storagePath: 'generated_images/creator-1/generated_task-1_0.png' },
      { index: 1, storagePath: 'generated_images/creator-1/generated_task-1_1.png' },
    ],
    primaryOutputIndex: 0,
  };

  beforeEach(() => {
    mocks.generation = {
      ...mocks.generation,
      share_input_media_for_remix: false,
      // A public post's result is its showcase copy, outside the creator's folders.
      showcase_asset_path: 'showcase/gen-1/result.png',
      prompt: '@me in a linen suit.',
      workflow_settings: structuredClone({ ...RESTORED, ...OF_THE_INPUTS, ...OF_THE_PICTURES }),
    };
  });

  it("hands someone else's remix the settings without a path to the creator's uploads or pictures", async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.result?.url).toBe('https://public.example/showcase/gen-1/result.png');
    expect(bundle.workflowSettings).toEqual(RESTORED);
    expect(JSON.stringify(bundle)).not.toMatch(CREATOR_FOLDER);
    expect(JSON.stringify(bundle)).not.toMatch(/passport-scan|gen-private-7/);
  });

  it('gives the owner the inputs but not where the pictures were kept', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.workflowSettings).toEqual({ ...RESTORED, ...OF_THE_INPUTS });
  });

  // Owner, 2026-10-29: a remix the inputs are handed to restores them from
  // `inputs`, and is not told where they were staged either.
  it.each([
    ['a remix of shared inputs', { ...PUBLIC_ACCESS, includeSharedInputMedia: true }],
    ["a bought recipe's remix", { ...PUBLIC_ACCESS, basis: 'unlocked', recipeEntitled: true }],
  ])('gives %s the settings without the inputs', async (_, access) => {
    mocks.resolveRemixAccess.mockResolvedValue(access);

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.workflowSettings).toEqual(RESTORED);
  });

  describe('once the run kept a copy of its input', () => {
    // Where the creator's upload was staged and the link the run read it from,
    // as the start passed them on to be kept.
    const UPLOAD_LINK = 'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/1730000000000-passport-scan.jpg?token=original-run';
    // The id older app builds gave a picked file, made from where it was staged.
    const APP_ELEMENT_ID = 'image-uploads-creator-1-1730000000000-passport-scan-jpg-m2k9x1';
    // The row keeping writes: the copy in the run's own folder, with the
    // element's id and both of those beside it (persistGenerationInputMedia).
    // Built afresh for each test, so no answer is the fixture compared with itself.
    const keptInput = () => collectImageInputCandidates({
      resolvedImageUrls: [UPLOAD_LINK],
      elements: [{ id: APP_ELEMENT_ID, ...OF_THE_INPUTS.elements[0] }],
    }).map((candidate, sortOrder) => ({
      id: `row-${sortOrder}`,
      generationId: 'gen-1',
      mediaType: candidate.mediaType,
      role: candidate.role,
      label: candidate.label ?? '',
      url: `https://signed.example/kept-${sortOrder}.jpg`,
      storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-${candidate.role}.jpg`,
      sourceGenerationId: candidate.sourceGenerationId ?? null,
      sortOrder,
      metadata: {
        ...candidate.metadata,
        sourceStoragePath: candidate.sourceStoragePath ?? null,
        sourceUrl: candidate.sourceUrl ?? null,
      },
    }));
    // The copy is what a remixer's run imports, reading the creator from its
    // path, so it is the one folder of the creator's a remix may name.
    const STAGED_IN_CREATOR_FOLDER = new RegExp(`(?:${[...USER_SCOPED_STORAGE_BUCKETS]
      .filter((bucket) => bucket !== 'generation_inputs')
      .join('|')})/creator-1/`);
    const RESTORED_ELEMENT = {
      id: APP_ELEMENT_ID,
      displayName: 'me',
      handle: '@me',
      storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.jpg',
      sourceGenerationId: null,
      url: 'https://signed.example/kept-0.jpg',
    };

    it.each([
      ['a remix of shared inputs', { ...PUBLIC_ACCESS, includeSharedInputMedia: true }],
      ["a bought recipe's remix", { ...PUBLIC_ACCESS, basis: 'unlocked', recipeEntitled: true }],
    ])("hands %s the copy, never the creator's upload, its file name or the link it was read from", async (_, access) => {
      mocks.resolveRemixAccess.mockResolvedValue(access);
      mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', keptInput()]]));
      mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue(keptInput());

      const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

      // Under the row's own id: the one the creator's app gave it names the file.
      expect(bundle.inputs.image?.elements).toEqual([{ ...RESTORED_ELEMENT, id: 'row-0' }]);
      expect(JSON.stringify(bundle)).not.toMatch(STAGED_IN_CREATOR_FOLDER);
      expect(JSON.stringify(bundle)).not.toMatch(/passport-scan|original-run/);
      expect(bundle).not.toHaveProperty('inputMedia');
    });

    it('still gives the owner the rows themselves', async () => {
      mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);
      mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', keptInput()]]));

      const bundle = await loadRemixSourceBundle(request(), 'gen-1');

      expect(bundle.inputs.image?.elements).toEqual([RESTORED_ELEMENT]);
      expect(bundle.inputMedia).toEqual(keptInput());
      expect(bundle.inputMedia?.[0].metadata).toMatchObject({
        id: APP_ELEMENT_ID,
        sourceStoragePath: 'uploads/creator-1/1730000000000-passport-scan.jpg',
        sourceUrl: UPLOAD_LINK,
      });
    });
  });
});

// A read of what a run kept can fail (a timeout, a busy database). Read as
// "nothing kept", it handed a remix the uploads the run's settings name, and
// the owner's choice to hand those over (2026-10-29) is for a run that kept
// nothing, not for one whose rows could not be read.
describe('a failed read of what a run kept', () => {
  const OWNER_ACCESS = { allowed: true, basis: 'owner', post: null, includeSharedInputMedia: true, recipeEntitled: false };
  const SHARED_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: true, recipeEntitled: false };
  const failure = new Error('canceling statement due to statement timeout');

  beforeEach(() => {
    mocks.generation = {
      ...mocks.generation,
      workflow_settings: {
        model: 'nano-banana-2',
        elements: [{ id: 'el-1', displayName: 'me', handle: '@me', storagePath: 'uploads/creator-1/1730000000000-passport-scan.jpg' }],
      },
    };
    // The loader as it stands: a failed read is logged and answered as nothing
    // kept, unless its caller asks to hear of it.
    mocks.loadGenerationInputMediaMap.mockImplementation(async (params: { throwOnError?: boolean }) => {
      if (params.throwOnError) throw failure;
      return new Map();
    });
  });

  it('fails a remix of shared inputs rather than reading the uploads from the settings', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(SHARED_ACCESS);

    await expect(loadRemixSourceBundle(request(), 'gen-1')).rejects.toBe(failure);
    expect(mocks.buildLegacyGenerationInputMedia).not.toHaveBeenCalled();
  });

  it("asks a bought recipe's inputs to be read the same way", async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ ...SHARED_ACCESS, includeSharedInputMedia: false, basis: 'unlocked', recipeEntitled: true });

    await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(mocks.loadGenerationRecipeRemixInputMediaByPostId).toHaveBeenCalledWith(expect.objectContaining({ throwOnError: true }));
  });

  it("still restores the owner's own run from its settings", async () => {
    mocks.resolveRemixAccess.mockResolvedValue(OWNER_ACCESS);

    await loadRemixSourceBundle(request(), 'gen-1');

    expect(mocks.buildLegacyGenerationInputMedia).toHaveBeenCalled();
  });
});

// A Seedance 2 run keeps what it prepared from each reference. The prepared
// asset is what a run sends for a real person, and a remixer cannot prepare one
// from the creator's copy, so it goes with the inputs (owner, 2026-10-29) but
// without the link it was prepared from.
describe("a Seedance 2 run's prepared assets", () => {
  const PUBLIC_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: false, recipeEntitled: false };
  const PREPARED = {
    images: [{
      assetId: 'asset-face',
      assetType: 'Image',
      status: 'active',
      sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/1730000000000-passport-scan.jpg?token=read',
      error: null,
      lastCheckedAt: '2026-10-29T10:00:00.000Z',
    }],
  };
  // The picture the asset was prepared from, kept as a start keeps it: with the link it was read from.
  const FACE = {
    id: 'row-face',
    generationId: 'gen-1',
    mediaType: 'image',
    role: 'reference_image',
    label: 'Face',
    url: 'https://signed.example/face.png',
    storagePath: 'generation_inputs/creator-1/gen-1/00-reference_image.png',
    sourceGenerationId: null,
    sortOrder: 0,
    metadata: { sourceUrl: PREPARED.images[0].sourceUrl },
  };
  const HANDED_ON = [
    ['a remix of shared inputs', { ...PUBLIC_ACCESS, includeSharedInputMedia: true }],
    ["a bought recipe's remix", { ...PUBLIC_ACCESS, basis: 'unlocked', recipeEntitled: true }],
  ] as const;

  beforeEach(() => {
    mocks.generation = {
      ...mocks.generation,
      share_input_media_for_remix: false,
      category: 'video',
      model: 'seedance-2',
      workflow_settings: { model: 'seedance-2', referenceMode: 'elements', seedanceAssets: structuredClone(PREPARED) },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [FACE]]]));
    mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([FACE]);
  });

  it.each(HANDED_ON)('go to %s by id, without the links they were prepared from', async (_, access) => {
    mocks.resolveRemixAccess.mockResolvedValue(access);

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.workflowSettings).toEqual({
      model: 'seedance-2',
      referenceMode: 'elements',
      seedanceAssets: {
        images: [{ assetId: 'asset-face', assetType: 'Image', status: 'active', sourceUrl: null, error: null, lastCheckedAt: null }],
        videos: [],
        audios: [],
      },
    });
    expect(JSON.stringify(bundle)).not.toMatch(/passport-scan/);
  });

  // 2026-11-04 re-review: with nothing held back, every asset the run recorded went to the remix by its
  // place: one prepared from a recipe file among them, which the run records under the copy's link the
  // buyer's client sent (no import's), and one prepared from an input that was never kept. An asset id
  // runs the file it was prepared from, so each now goes with an input the remix is handed, or nowhere.
  it.each(HANDED_ON)('go to %s only with an input it is handed', async (_, access) => {
    mocks.resolveRemixAccess.mockResolvedValue(access);
    const [face] = PREPARED.images;
    mocks.generation = {
      ...mocks.generation,
      workflow_settings: { model: 'seedance-2', referenceMode: 'elements', seedanceAssets: { images: [
        face,
        { ...face, assetId: 'asset-bought', sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/post_resource_files/seller-9/generation-references/gen-0/00-reference-image-row-9.png?token=read' },
        { ...face, assetId: 'asset-unkept', sourceUrl: 'https://project.supabase.co/storage/v1/object/sign/uploads/creator-1/1730000000002-hand.jpg?token=read' },
      ] } },
    };

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.workflowSettings.seedanceAssets).toEqual({
      images: [{ assetId: 'asset-face', assetType: 'Image', status: 'active', sourceUrl: null, error: null, lastCheckedAt: null }],
      videos: [],
      audios: [],
    });
    expect(JSON.stringify(bundle)).not.toMatch(/asset-bought|asset-unkept|seller-9|1730000000002-hand/);
  });

  it('go nowhere with a recipe that hands its buyer none of the inputs', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({ ...PUBLIC_ACCESS, basis: 'unlocked', recipeEntitled: true });
    // The creator's switch is off: the unlock hands over no input (`loadGenerationRecipeRemixInputsByPostId`).
    mocks.loadGenerationRecipeRemixInputMediaByPostId.mockResolvedValue([]);

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.workflowSettings).toEqual({ model: 'seedance-2', referenceMode: 'elements' });
  });

  it('stay out of a remix the inputs are not handed to', async () => {
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.workflowSettings).toEqual({ model: 'seedance-2', referenceMode: 'elements' });
  });
});

// Kling 3.0 takes clips under handles its prompt mentions them by. In the app
// every clip is named "Reference Video", and taking one away leaves the others
// their handles, so the handle cannot be rebuilt from the name.
describe('a Kling 3.0 run with clips under handles', () => {
  const clipRow = (sortOrder: number, handle: string) => ({
    id: `row-${sortOrder}`,
    generationId: 'gen-1',
    mediaType: 'video',
    role: 'reference_video',
    label: 'Reference Video',
    url: `https://signed.example/kept-${sortOrder}.mp4`,
    storagePath: `generation_inputs/creator-1/gen-1/0${sortOrder}-reference_video.mp4`,
    sourceGenerationId: null,
    sortOrder,
    metadata: {
      id: `clip-${sortOrder}`,
      displayName: 'Reference Video',
      handle,
      sourceStoragePath: `uploads/creator-1/173000000000${sortOrder}-holiday-${sortOrder}.mp4`,
    },
  });

  beforeEach(() => {
    mocks.generation = {
      ...mocks.generation,
      share_input_media_for_remix: true,
      category: 'video',
      model: 'kling-3.0-video',
      prompt: '@reference_video_2 walks in and @reference_video_3 waves.',
      workflow_settings: { model: 'kling-3.0-video', referenceMode: 'elements' },
    };
    mocks.loadGenerationInputMediaMap.mockResolvedValue(new Map([['gen-1', [
      clipRow(0, '@reference_video_2'),
      clipRow(1, '@reference_video_3'),
    ]]]));
  });

  it('hands each clip on under the handle the prompt mentions it by', async () => {
    mocks.resolveRemixAccess.mockResolvedValue({
      allowed: true,
      basis: 'public',
      post: EXPOSED_POST,
      includeSharedInputMedia: true,
      recipeEntitled: false,
    });

    const bundle = await loadRemixSourceBundle(request('post-verified'), 'gen-1', { postId: 'post-verified' });

    expect(bundle.inputs.video?.referenceVideos?.map((clip) => clip.handle)).toEqual(['@reference_video_2', '@reference_video_3']);
    expect(JSON.stringify(bundle)).not.toMatch(/holiday/);
  });
});

// "Use as reference" is told the original clip's length rather than reading the clip: the post's
// media row measured the showcase copy the remix source hands out. Once the feed's rendition is
// built the row holds the rendition's length, a re-timed encode, so such a row is not read.
describe("the original clip's length", () => {
  const SHOWCASE_CLIP = 'showcase/gen-1/result.4f2a9c1b7e3d.mp4';
  const PUBLIC_ACCESS = { allowed: true, basis: 'public', post: EXPOSED_POST, includeSharedInputMedia: false, recipeEntitled: false };

  beforeEach(() => {
    mocks.generation = {
      ...mocks.generation,
      category: 'video',
      model: 'kling-3.0-video',
      showcase_asset_path: SHOWCASE_CLIP,
      workflow_settings: { model: 'kling-3.0-video' },
    };
    mocks.resolveRemixAccess.mockResolvedValue(PUBLIC_ACCESS);
  });

  it('comes with the result, as the media row measured the showcase copy itself', async () => {
    mocks.postMedia = { data: [{ duration_seconds: '7.48' }], error: null };

    const bundle = await loadRemixSourceBundle(request(), 'gen-1');

    expect(bundle.result).toEqual({
      mediaType: 'video',
      url: `https://public.example/${SHOWCASE_CLIP}`,
      durationSeconds: 7.48,
    });
    expect(mocks.postMediaReads).toEqual([[
      ['eq', 'posts.generation_id', 'gen-1'],
      ['eq', 'storage_path', SHOWCASE_CLIP],
      // Not a row whose length is the feed rendition's.
      ['is', 'rendition_storage_path', null],
      ['not', 'duration_seconds', 'is', null],
    ]]);
  });

  it('is left out where no row has measured it, or the read fails', async () => {
    const unmeasured = await loadRemixSourceBundle(request(), 'gen-1');
    expect(unmeasured.result).toEqual({ mediaType: 'video', url: `https://public.example/${SHOWCASE_CLIP}` });

    mocks.postMedia = { data: null, error: { message: 'post_media unavailable' } };
    const failed = await loadRemixSourceBundle(request(), 'gen-1');
    expect(failed.result).toEqual({ mediaType: 'video', url: `https://public.example/${SHOWCASE_CLIP}` });
  });

  it('is not read for a picture, or for a result with no showcase copy', async () => {
    mocks.generation = { ...mocks.generation, showcase_asset_path: null };
    await loadRemixSourceBundle(request(), 'gen-1');

    mocks.generation = { ...mocks.generation, category: 'image', model: 'nano-banana-2', showcase_asset_path: 'showcase/gen-1/result.png' };
    await loadRemixSourceBundle(request(), 'gen-1');

    expect(mocks.postMediaReads).toEqual([]);
  });
});
