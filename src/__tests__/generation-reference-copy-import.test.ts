import { describe, expect, it, vi } from 'vitest';

import { createStoredRows, databaseError } from '@/__tests__/fixtures/stored-rows';
import { createRecipeCopyReads, importGenerationReferenceCopy, reuseRecipeFile } from '@/lib/generation-reference-copy-import';
import { buildGenerationReferenceCopyPath } from '@/lib/post-resource-bundles-server';

// Owner, 2026-11-03: a remix of an unlocked recipe restores the inputs the
// recipe holds copies of. Those copies are the seller's files, so a run start
// refused them as someone else's media until it could import one the caller's
// purchase covers, once their right to reuse it is read again: the remix
// source's own gate (`resolveRemixAccess`), then the recipe they bought.

const SELLER = 'a1b2c3d4-0000-4000-8000-000000000001';
const VIEWER = 'a1b2c3d4-0000-4000-8000-000000000002';
const GENERATION = 'b1b2c3d4-0000-4000-8000-000000000001';
const OTHER_GENERATION = 'b1b2c3d4-0000-4000-8000-000000000002';
const ROW = 'c1b2c3d4-0000-4000-8000-000000000001';
const OTHER_ROW = 'c1b2c3d4-0000-4000-8000-000000000002';
const OTHER_GENERATION_ROW = 'c1b2c3d4-0000-4000-8000-000000000003';

/** The copy of each row as "Include creation references" files it: its one writer. */
const copyOf = (rowId: string, sortOrder: number, generationId = GENERATION) => buildGenerationReferenceCopyPath(SELLER, generationId, {
  id: rowId,
  role: 'reference_image',
  sort_order: sortOrder,
  storage_path: `generation_inputs/${SELLER}/${generationId}/0${sortOrder}-reference_image.png`,
  media_type: 'image',
});
const COPY = copyOf(ROW, 0);
const OTHER_COPY = copyOf(OTHER_ROW, 1);
const SOURCE = `post_resource_files/${COPY}`;
/** The caller's import, which names the copy it was made from: its seller, its creation, its file. */
const DESTINATION = `${VIEWER}/recipe-imports/${SELLER}/${GENERATION}/${COPY.split('/').pop()}`;

/** A recipe item as the recipe stores it (`planGenerationReferenceCopies`). */
const copyItem = (rowId: string, storagePath: string) => ({ id: `reference-${rowId}`, type: 'reference_image', title: 'Reference', storagePath });

const PUBLIC_GENERATION = {
  id: GENERATION,
  user_id: SELLER,
  is_public: true,
  share_input_media_for_remix: false,
  template_run_id: null,
  template_run_step_id: null,
  archived_at: null,
  moderation_removed_at: null,
};
/** The creation's post as the feed shows it: public, live and visible. */
const EXPOSED_POST = {
  id: 'post-1',
  user_id: SELLER,
  generation_id: GENERATION,
  category: 'image',
  post_format: 'media',
  source_kind: 'magicbooklet',
  visibility: 'public',
  archived_at: null,
  review_status: 'visible',
};
const RECIPE = {
  id: 'bundle-1',
  post_id: 'post-1',
  owner_user_id: SELLER,
  status: 'published',
  allow_remix: false,
  resource_items: [copyItem(ROW, COPY)],
  resource_sections: [],
};

type Tables = Parameters<typeof createStoredRows>[0];
type StorageError = { statusCode?: string; message: string; error?: string };
type CopyAnswer = { data: { path: string } | null; error: StorageError | null };
type SignAnswer = { data: { signedUrl: string } | null; error: { message: string } | null };

function setUp(options: {
  tables?: Tables;
  /** The version the viewer bought, where it is no longer the recipe's latest. */
  purchasedRevision?: { resource_items: unknown[] } | null;
  revisionError?: boolean;
  blocked?: boolean;
  viewer?: { id: string; is_anonymous: boolean } | null;
  copyError?: StorageError | null;
  signError?: { message: string } | null;
  recordUseError?: boolean;
} = {}) {
  const stored = createStoredRows({
    generations: [PUBLIC_GENERATION, { ...PUBLIC_GENERATION, id: OTHER_GENERATION }],
    posts: [EXPOSED_POST, { ...EXPOSED_POST, id: 'post-2', generation_id: OTHER_GENERATION }],
    post_resource_bundles: [RECIPE],
    post_resource_bundle_purchases: [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: VIEWER }],
    generation_input_media: [
      { id: ROW, generation_id: GENERATION },
      { id: OTHER_ROW, generation_id: GENERATION },
      { id: OTHER_GENERATION_ROW, generation_id: OTHER_GENERATION },
    ],
    profiles: [{ id: 'nobody', merged_into_user_id: null }],
    ...options.tables,
  }, {
    get_purchased_post_resource_bundle_revision: () => (options.revisionError
      ? databaseError('57014', 'canceling statement due to statement timeout')
      : options.purchasedRevision
        ? [{ ...options.purchasedRevision, is_latest: false, resource_sections: [] }]
        : []),
    // The recipe-copy-sweep job's record of the import's use (`recordRecipeImportUse`).
    record_recipe_import_use: () => (options.recordUseError ? databaseError('57014', 'canceling statement due to statement timeout') : null),
  });
  const copy = vi.fn<(from: string, to: string, options?: { destinationBucket?: string }) => Promise<CopyAnswer>>(
    async (_from, to) => (options.copyError ? { data: null, error: options.copyError } : { data: { path: to }, error: null }),
  );
  const createSignedUrl = vi.fn<(path: string, expiresIn: number) => Promise<SignAnswer>>(async (path) => (
    options.signError
      ? { data: null, error: options.signError }
      : { data: { signedUrl: `https://project.supabase.co/storage/v1/object/sign/generation_inputs/${path}?token=copy` }, error: null }
  ));
  const storageFrom = vi.fn((bucket: string) => ({ bucket, copy, createSignedUrl }));
  const from = vi.fn((table: string) => stored.client.from(table));
  const viewer = options.viewer === undefined ? { id: VIEWER, is_anonymous: false } : options.viewer;
  const getUserById = vi.fn(async () => ({ data: { user: viewer }, error: null }));
  const client = { from, rpc: stored.client.rpc, storage: { from: storageFrom }, auth: { admin: { getUserById } } };
  const isUserRelationshipBlocked = vi.fn(async () => options.blocked === true);

  return {
    dependencies: {
      createServiceClient: (() => client) as never,
      isUserRelationshipBlocked: isUserRelationshipBlocked as never,
    },
    from,
    storageFrom,
    copy,
    createSignedUrl,
    getUserById,
    isUserRelationshipBlocked,
    called: stored.called,
  };
}

function importAs(viewerUserId: string, source: string, stub: ReturnType<typeof setUp>, reads?: ReturnType<typeof createRecipeCopyReads>) {
  return importGenerationReferenceCopy({ source, viewerUserId, reads, dependencies: stub.dependencies });
}

const readsOf = (stub: ReturnType<typeof setUp>, table: string) => stub.from.mock.calls.filter(([name]) => name === table).length;

describe('importing a recipe’s copy of a creation’s input into a run', () => {
  it.each([
    ['its stored path', SOURCE],
    ['a signed link to it, expired or not', `https://project.supabase.co/storage/v1/object/sign/${SOURCE}?token=expired`],
  ])('imports a copy the viewer bought, from %s, into a folder of their own kept for recipe files', async (_, source) => {
    const stub = setUp();

    const result = await importAs(VIEWER, source, stub);

    expect(result).toEqual({
      outcome: 'imported',
      storagePath: `generation_inputs/${DESTINATION}`,
      signedUrl: `https://project.supabase.co/storage/v1/object/sign/generation_inputs/${DESTINATION}?token=copy`,
    });
    // The remix gate, asked again: the post read, the block asked about its creator.
    expect(stub.isUserRelationshipBlocked).toHaveBeenCalledWith(expect.objectContaining({ firstUserId: VIEWER, secondUserId: SELLER }));
    // Copied, not read through: from the recipe files into the caller's generation inputs.
    expect(stub.storageFrom).toHaveBeenCalledWith('post_resource_files');
    expect(stub.copy).toHaveBeenCalledTimes(1);
    expect(stub.copy).toHaveBeenCalledWith(COPY, DESTINATION, { destinationBucket: 'generation_inputs' });
    expect(stub.createSignedUrl).toHaveBeenCalledWith(DESTINATION, 3600);
  });

  // Owner, 2026-11-04: a creation its creator archived or an operator removed lends its copies to no
  // start, read at every start: un-archiving it restores them. The generation's own two marks decide,
  // whatever the post says.
  it.each([
    ['archived by its creator', { archived_at: '2026-11-04T00:00:00.000Z' }],
    ['removed by an operator', { moderation_removed_at: '2026-11-04T00:00:00.000Z' }],
  ])('imports no copy of a creation %s, and copies nothing', async (_, marks) => {
    const offView = setUp({ tables: { generations: [{ ...PUBLIC_GENERATION, ...marks }] } });

    await expect(importAs(VIEWER, SOURCE, offView)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(offView.copy).not.toHaveBeenCalled();
    await expect(importAs(VIEWER, SOURCE, setUp({ tables: { generations: [{ ...PUBLIC_GENERATION, archived_at: null }] } })))
      .resolves.toMatchObject({ outcome: 'imported' });
  });

  // A seller who edits a sold recipe takes back nothing its buyers paid for.
  it('imports a copy that is only in the version the viewer bought', async () => {
    const stub = setUp({
      tables: { post_resource_bundles: [{ ...RECIPE, resource_items: [copyItem(OTHER_ROW, OTHER_COPY)] }] },
      purchasedRevision: { resource_items: [copyItem(ROW, COPY)] },
    });

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toMatchObject({ outcome: 'imported' });
  });

  // A recipe its seller retired gates no Remix, and stays its buyers', as their files do.
  it('imports a copy of a retired recipe for its buyer, and for no one else', async () => {
    const retired = { post_resource_bundles: [{ ...RECIPE, status: 'retired' }] };

    await expect(importAs(VIEWER, SOURCE, setUp({ tables: retired }))).resolves.toMatchObject({ outcome: 'imported' });
    const neverBought = setUp({ tables: { ...retired, post_resource_bundle_purchases: [{ id: 'p', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }] } });
    await expect(importAs(VIEWER, SOURCE, neverBought)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(neverBought.copy).not.toHaveBeenCalled();
  });

  // A purchase is the entitlement: no reveal is asked of an NSFW post's buyer, as the buyer library asks none.
  it('imports a copy for the buyer of an NSFW post’s recipe', async () => {
    const stub = setUp({ tables: { posts: [{ ...EXPOSED_POST, is_nsfw: true }] } });

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toMatchObject({ outcome: 'imported' });
  });

  it.each([
    ['a viewer who never bought the recipe', { post_resource_bundle_purchases: [{ id: 'p', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }] }],
    ['a copy that is not in the version they have', { post_resource_bundles: [{ ...RECIPE, resource_items: [copyItem(OTHER_ROW, OTHER_COPY)] }] }],
    ['a copy their version holds under another input’s name', { post_resource_bundles: [{ ...RECIPE, resource_items: [copyItem(OTHER_ROW, COPY)] }] }],
    ['a post with no recipe', { post_resource_bundles: [{ ...RECIPE, post_id: 'post-elsewhere' }] }],
  ])('refuses %s', async (_, tables) => {
    const stub = setUp({ tables });

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
    expect(stub.createSignedUrl).not.toHaveBeenCalled();
  });

  // Entitlement to read is not entitlement to reuse (2026-11-03 review): a saved remix, or a request
  // made by hand, imported the copy at Generate after any of these, which `/api/remix-source` refuses.
  it.each([
    ['the seller blocked the buyer, or the buyer the seller', { blocked: true }],
    ['the post is archived', { tables: { posts: [{ ...EXPOSED_POST, archived_at: '2026-11-03T00:00:00Z' }] } }],
    ['the post is private', { tables: { posts: [{ ...EXPOSED_POST, visibility: 'private' }] } }],
    ['the post is taken down', { tables: { posts: [{ ...EXPOSED_POST, review_status: 'hidden' }] } }],
    ['the post is deleted, its tombstone taking the creation private', { tables: { generations: [{ ...PUBLIC_GENERATION, is_public: false }] } }],
    ['the creation is a template’s result', { tables: { generations: [{ ...PUBLIC_GENERATION, template_run_id: 'run-1' }] } }],
    ['the viewer is a guest', { viewer: { id: VIEWER, is_anonymous: true } }],
  ])('refuses the buyer once %s', async (_, options) => {
    const stub = setUp(options as Parameters<typeof setUp>[0]);

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses a copy kept in another creation’s folder, even where the viewer bought both recipes', async () => {
    // Named after ROW, an input of GENERATION, but filed in OTHER_GENERATION's folder.
    const misfiled = copyOf(ROW, 0, OTHER_GENERATION);
    const stub = setUp({
      tables: {
        post_resource_bundles: [
          { ...RECIPE, resource_items: [copyItem(ROW, misfiled)] },
          { ...RECIPE, id: 'bundle-2', post_id: 'post-2', resource_items: [copyItem(ROW, misfiled)] },
        ],
        post_resource_bundle_purchases: [
          { id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: VIEWER },
          { id: 'purchase-2', bundle_id: 'bundle-2', buyer_user_id: VIEWER },
        ],
      },
    });

    // Its folder names OTHER_GENERATION: that creation's recipe is read, and ROW is none of its inputs.
    await expect(importAs(VIEWER, `post_resource_files/${misfiled}`, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses a file of the seller’s recipe folder that is no copy, even one the recipe lists', async () => {
    const notes = `${SELLER}/generation-references/${GENERATION}/notes.txt`;
    const stub = setUp({ tables: { post_resource_bundles: [{ ...RECIPE, resource_items: [copyItem(ROW, COPY), { id: 'item-3', type: 'file', title: 'Notes', storagePath: notes }] }] } });

    await expect(importAs(VIEWER, `post_resource_files/${notes}`, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it.each([
    ['another of the seller’s recipe files', `post_resource_files/${SELLER}/resources/${GENERATION}/guide.pdf`],
    ['a file below a copy’s folder', `post_resource_files/${SELLER}/generation-references/${GENERATION}/nested/${COPY.split('/').pop()}`],
    ['a creation segment that is no id', `post_resource_files/${SELLER}/generation-references/gen-1/${COPY.split('/').pop()}`],
    ['a creator’s own kept input, which the shared import answers', `generation_inputs/${SELLER}/${GENERATION}/00-reference_image.png`],
    ['an upload', `uploads/${SELLER}/hero.png`],
  ])('refuses %s without reading anything', async (_, source) => {
    const stub = setUp();

    await expect(importAs(VIEWER, source, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.from).not.toHaveBeenCalled();
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses the seller their own copy, which their run reads as their own file', async () => {
    const stub = setUp();

    await expect(importAs(SELLER, SOURCE, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.from).not.toHaveBeenCalled();
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses a creation with no saved inputs', async () => {
    const stub = setUp({ tables: { generation_input_media: [{ id: OTHER_GENERATION_ROW, generation_id: OTHER_GENERATION }] } });

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  // As the shared import answers: a read, the copy or its signing that fails is retryable, and
  // nothing is copied before the unlock is settled. A purchase read that fails is no "never bought".
  it.each([
    ['the creation', { tables: { generations: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['the post', { tables: { posts: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['the recipe', { tables: { post_resource_bundles: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['the purchase', { tables: { post_resource_bundle_purchases: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['a retired recipe’s purchase', { tables: {
      post_resource_bundles: [{ ...RECIPE, status: 'retired' }],
      post_resource_bundle_purchases: databaseError('57014', 'canceling statement due to statement timeout'),
    } }],
    ['the saved inputs', { tables: { generation_input_media: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['the version they bought', { revisionError: true }],
  ])('fails retryably, copying nothing, when the read of %s fails', async (_, options) => {
    const stub = setUp(options as Parameters<typeof setUp>[0]);

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toEqual({ outcome: 'failed' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('fails retryably when the copy or its signing fails, and reuses a copy already made', async () => {
    await expect(importAs(VIEWER, SOURCE, setUp({ copyError: { message: 'service unavailable' } })))
      .resolves.toEqual({ outcome: 'failed' });
    await expect(importAs(VIEWER, SOURCE, setUp({ signError: { message: 'signing unavailable' } })))
      .resolves.toEqual({ outcome: 'failed' });

    const again = setUp({ copyError: { statusCode: '409', message: 'The resource already exists', error: 'Duplicate' } });
    await expect(importAs(VIEWER, SOURCE, again)).resolves.toMatchObject({
      outcome: 'imported',
      storagePath: `generation_inputs/${DESTINATION}`,
    });
  });

  it('records the use of the import before it touches the file, and fails retryably when it cannot', async () => {
    const recorded = setUp();
    await expect(importAs(VIEWER, SOURCE, recorded)).resolves.toMatchObject({ outcome: 'imported' });
    expect(recorded.called).toContain('record_recipe_import_use');

    const unrecorded = setUp({ recordUseError: true });
    await expect(importAs(VIEWER, SOURCE, unrecorded)).resolves.toEqual({ outcome: 'failed' });
    expect(unrecorded.copy).not.toHaveBeenCalled();
    expect(unrecorded.createSignedUrl).not.toHaveBeenCalled();
  });

  // Each reference of a start used to read the gate, the recipe and the rows again (2026-11-03 review).
  it('reads one creation’s unlock once for all of a start’s references, and again at the next start', async () => {
    const stub = setUp({ tables: { post_resource_bundles: [{ ...RECIPE, resource_items: [copyItem(ROW, COPY), copyItem(OTHER_ROW, OTHER_COPY)] }] } });
    const reads = createRecipeCopyReads();

    const results = await Promise.all([
      importAs(VIEWER, SOURCE, stub, reads),
      importAs(VIEWER, `post_resource_files/${OTHER_COPY}`, stub, reads),
    ]);

    expect(results.map((result) => result.outcome)).toEqual(['imported', 'imported']);
    expect(readsOf(stub, 'posts')).toBe(1);
    expect(readsOf(stub, 'post_resource_bundles')).toBe(2); // the gate's, and the recipe's items
    expect(readsOf(stub, 'generation_input_media')).toBe(1);
    expect(stub.getUserById).toHaveBeenCalledTimes(1);
    expect(stub.copy).toHaveBeenCalledTimes(2);

    await importAs(VIEWER, SOURCE, stub, createRecipeCopyReads());
    expect(readsOf(stub, 'posts')).toBe(2);
  });
});

// 2026-11-03 re-review: a file the caller already holds that is a recipe file (the start's import of a
// copy, or a kept input of theirs marked as one) was signed as their own, with no unlock read, so a
// refund or a block ended nothing. Each is checked as the copy it stands for is, and imported again.
describe('reusing a recipe file the caller already holds', () => {
  const KEPT = `generation_inputs/${VIEWER}/d1b2c3d4-0000-4000-8000-000000000009/00-reference_image.png`;

  function reuse(source: string, stub: ReturnType<typeof setUp>) {
    return reuseRecipeFile({ source, viewerUserId: VIEWER, dependencies: stub.dependencies });
  }

  it('checks the start’s import of a copy as the copy itself, and imports it again', async () => {
    const stub = setUp();

    await expect(reuse(`generation_inputs/${DESTINATION}`, stub)).resolves.toMatchObject({ outcome: 'imported', storagePath: `generation_inputs/${DESTINATION}` });
    expect(stub.copy).toHaveBeenCalledWith(COPY, DESTINATION, { destinationBucket: 'generation_inputs' });
    // Read again now: the gate, the recipe and the creation's rows.
    expect(readsOf(stub, 'posts')).toBe(1);
  });

  it.each([
    ['a refund', { post_resource_bundle_purchases: [{ id: 'p', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }] }],
    ['a deleted post', { generations: [{ ...PUBLIC_GENERATION, is_public: false }] }],
  ])('refuses the start’s import of a copy after %s', async (_, tables) => {
    const stub = setUp({ tables });

    await expect(reuse(`https://project.supabase.co/storage/v1/object/sign/generation_inputs/${DESTINATION}?token=old`, stub))
      .resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses another account’s import of a copy unless the caller bought the recipe themselves', async () => {
    const theirs = `generation_inputs/a1b2c3d4-0000-4000-8000-000000000003/recipe-imports/${SELLER}/${GENERATION}/${COPY.split('/').pop()}`;

    await expect(reuse(theirs, setUp())).resolves.toMatchObject({ outcome: 'imported', storagePath: `generation_inputs/${DESTINATION}` });
    await expect(reuse(theirs, setUp({ tables: { post_resource_bundle_purchases: [] } }))).resolves.toEqual({ outcome: 'not-eligible' });
  });

  // The first round's imports (`<buyer>/recipe-imports/<generation>/<file>`) named no seller, so no copy
  // can be read off one: refused, never signed as the caller's own file, rows readable or not.
  it('refuses an import kept in the first round’s layout, which names no copy', async () => {
    const firstRound = `generation_inputs/${VIEWER}/recipe-imports/${GENERATION}/${COPY.split('/').pop()}`;

    for (const stub of [setUp(), setUp({ tables: { generation_input_media: databaseError('57014', 'canceling statement due to statement timeout') } })]) {
      await expect(reuse(firstRound, stub)).resolves.toEqual({ outcome: 'not-eligible' });
      await expect(reuse(`https://project.supabase.co/storage/v1/object/sign/${firstRound}?token=old`, stub)).resolves.toEqual({ outcome: 'not-eligible' });
      expect(stub.copy).not.toHaveBeenCalled();
    }
  });

  it('checks a kept input of the caller’s own marked as a recipe file as the copy it came from', async () => {
    const marked = setUp({ tables: { generation_input_media: [
      { id: ROW, generation_id: GENERATION, user_id: SELLER, storage_path: `generation_inputs/${SELLER}/${GENERATION}/00.png`, metadata: {} },
      { id: OTHER_ROW, generation_id: GENERATION, user_id: SELLER, storage_path: `generation_inputs/${SELLER}/${GENERATION}/01.png`, metadata: {} },
      { id: 'kept-1', generation_id: 'gen-mine', user_id: VIEWER, storage_path: KEPT, metadata: { sourceKind: 'recipe-file', recipeFile: SOURCE } },
    ] } });

    await expect(reuse(KEPT, marked)).resolves.toMatchObject({ outcome: 'imported', storagePath: `generation_inputs/${DESTINATION}` });

    const refunded = setUp({ tables: {
      generation_input_media: [{ id: 'kept-1', generation_id: 'gen-mine', user_id: VIEWER, storage_path: KEPT, metadata: { sourceKind: 'recipe-file', recipeFile: SOURCE } }],
      post_resource_bundle_purchases: [],
    } });
    await expect(reuse(KEPT, refunded)).resolves.toEqual({ outcome: 'not-eligible' });
  });

  it('refuses a kept input marked as a recipe file whose copy is not on record', async () => {
    const unknownCopy = setUp({ tables: { generation_input_media: [{ id: 'kept-1', generation_id: 'gen-mine', user_id: VIEWER, storage_path: KEPT, metadata: { sourceKind: 'recipe-file' } }] } });
    await expect(reuse(KEPT, unknownCopy)).resolves.toEqual({ outcome: 'not-eligible' });
  });

  // 2026-11-04 review: since 20261103232019 storage refuses a buyer a kept recipe file they no longer
  // hold, so a kept input whose row cannot be read is no longer theirs by its path. Left to the start,
  // it was signed with the service role, and a Seedance asset made of it recorded as their own file for
  // good. It fails retryably instead; any other own file whose row read fails is left to the start.
  it('fails a run’s kept input whose row cannot be read retryably, never taking it for the caller’s own', async () => {
    const unreadable = setUp({ tables: { generation_input_media: databaseError('57014', 'canceling statement due to statement timeout') } });

    await expect(reuse(KEPT, unreadable)).resolves.toEqual({ outcome: 'failed' });
    expect(unreadable.copy).not.toHaveBeenCalled();
    await expect(reuse(`generation_inputs/${VIEWER}/uploads/face.png`, unreadable)).resolves.toBeNull();
    // A start's import is a recipe file by its path all the same: checked as its copy, whose own read
    // of the creation's rows fails retryably here, never left to the start as the caller's own.
    await expect(reuse(`generation_inputs/${DESTINATION}`, unreadable)).resolves.toEqual({ outcome: 'failed' });
    expect(unreadable.copy).not.toHaveBeenCalled();
  });

  it.each([
    ['an unmarked kept input of the caller’s own', KEPT, [{ id: 'kept-1', generation_id: 'gen-mine', user_id: VIEWER, storage_path: KEPT, metadata: { sourceStoragePath: `uploads/${VIEWER}/face.png` } }]],
    ['a shared input the caller imported', `generation_inputs/${VIEWER}/remix-imports/gen-9/00-reference_image.png`, []],
    ['an upload of the caller’s own', `uploads/${VIEWER}/face.png`, []],
    ['the caller’s own recipe file', `post_resource_files/${VIEWER}/resources/guide.png`, []],
  ])('leaves %s to the start, as before', async (_, source, rows) => {
    const stub = setUp({ tables: { generation_input_media: rows } });

    await expect(reuse(source, stub)).resolves.toBeNull();
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('answers the seller’s copy itself as the start’s import does', async () => {
    await expect(reuse(SOURCE, setUp())).resolves.toMatchObject({ outcome: 'imported' });
  });
});
