import { describe, expect, it, vi } from 'vitest';

import { createStoredRows, databaseError } from '@/__tests__/fixtures/stored-rows';
import { importGenerationReferenceCopy } from '@/lib/generation-reference-copy-import';
import {
  loadGenerationRecipeReferenceCopiesByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';

// Owner, 2026-11-03: a remix of an unlocked recipe restores the inputs the
// recipe holds copies of. Those copies are the seller's files, so a run start
// refused them as someone else's media until it could import one the caller's
// unlock covers, as it imports a creator's freely shared input.

const SELLER = 'a1b2c3d4-0000-4000-8000-000000000001';
const VIEWER = 'a1b2c3d4-0000-4000-8000-000000000002';
const GENERATION = 'b1b2c3d4-0000-4000-8000-000000000001';
const OTHER_GENERATION = 'b1b2c3d4-0000-4000-8000-000000000002';
const ROW = 'c1b2c3d4-0000-4000-8000-000000000001';
const OTHER_ROW = 'c1b2c3d4-0000-4000-8000-000000000002';
const OTHER_GENERATION_ROW = 'c1b2c3d4-0000-4000-8000-000000000003';

/** The copy of ROW as "Include creation references" files it (buildGenerationReferenceResourceItems). */
const COPY = `${SELLER}/generation-references/${GENERATION}/00-reference-image-${ROW}.png`;
const OTHER_COPY = `${SELLER}/generation-references/${GENERATION}/01-reference-image-${OTHER_ROW}.png`;
const SOURCE = `post_resource_files/${COPY}`;
const DESTINATION = `${VIEWER}/remix-imports/${GENERATION}/00-reference-image-${ROW}.png`;

const copyItem = (rowId: string, storagePath: string) => ({ id: `reference-${rowId}`, storagePath });

/** The recipe this viewer has, as the unlock's read answers it. */
function unlocked(
  items: Array<{ id: string; storagePath: string }>,
  overrides: { purchasedItems?: Array<{ id: string; storagePath: string }>; viewerCanAccess?: boolean; generationId?: string } = {},
): PostResourceBundleDetail {
  return {
    viewerCanAccess: overrides.viewerCanAccess ?? true,
    resources: { items },
    purchasedRevision: overrides.purchasedItems ? { resources: { items: overrides.purchasedItems } } : null,
    seller: { id: SELLER },
    post: { generationId: overrides.generationId ?? GENERATION },
  } as unknown as PostResourceBundleDetail;
}

type Tables = Parameters<typeof createStoredRows>[0];
type StorageError = { statusCode?: string; message: string; error?: string };
type CopyAnswer = { data: { path: string } | null; error: StorageError | null };
type SignAnswer = { data: { signedUrl: string } | null; error: { message: string } | null };

function setUp(options: {
  /** Each post's recipe as this viewer has it, by post id; none for a post they never unlocked. */
  recipes?: Record<string, PostResourceBundleDetail | null>;
  tables?: Tables;
  detailError?: Error;
  copyError?: StorageError | null;
  signError?: { message: string } | null;
} = {}) {
  const stored = createStoredRows({
    posts: [
      { id: 'post-1', user_id: SELLER, generation_id: GENERATION },
      { id: 'post-2', user_id: SELLER, generation_id: OTHER_GENERATION },
    ],
    generation_input_media: [
      { id: ROW, generation_id: GENERATION },
      { id: OTHER_ROW, generation_id: GENERATION },
      { id: OTHER_GENERATION_ROW, generation_id: OTHER_GENERATION },
    ],
    ...options.tables,
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
  const client = { from, storage: { from: storageFrom } };

  const recipes = options.recipes ?? { 'post-1': unlocked([copyItem(ROW, COPY)]) };
  const getDetailByPostId = vi.fn(async (postId: string) => {
    if (options.detailError) throw options.detailError;
    return recipes[postId] ?? null;
  });
  // The real reader and matcher, over the recipe this fake answers.
  const loadCopies = vi.fn((params: Parameters<typeof loadGenerationRecipeReferenceCopiesByPostId>[0]) => (
    loadGenerationRecipeReferenceCopiesByPostId({ ...params, getDetailByPostId: getDetailByPostId as never })
  ));

  return {
    dependencies: {
      createServiceClient: (() => client) as never,
      loadGenerationRecipeReferenceCopiesByPostId: loadCopies as never,
    },
    from,
    storageFrom,
    copy,
    createSignedUrl,
    getDetailByPostId,
    loadCopies,
  };
}

function importAs(viewerUserId: string, source: string, stub: ReturnType<typeof setUp>) {
  return importGenerationReferenceCopy({ source, viewerUserId, dependencies: stub.dependencies });
}

describe('importing a recipe’s copy of a creation’s input into a run', () => {
  it.each([
    ['its stored path', SOURCE],
    ['a signed link to it, expired or not', `https://project.supabase.co/storage/v1/object/sign/${SOURCE}?token=expired`],
  ])('imports a copy the viewer’s unlock covers, from %s, into their own folder', async (_, source) => {
    const stub = setUp();

    const result = await importAs(VIEWER, source, stub);

    expect(result).toEqual({
      outcome: 'imported',
      storagePath: `generation_inputs/${DESTINATION}`,
      signedUrl: `https://project.supabase.co/storage/v1/object/sign/generation_inputs/${DESTINATION}?token=copy`,
    });
    // Read again now, through the unlock's own read, for the seller's post of that creation.
    expect(stub.getDetailByPostId).toHaveBeenCalledWith('post-1', expect.objectContaining({
      viewerUserId: VIEWER,
      countLockedReferences: false,
    }));
    expect(stub.loadCopies).toHaveBeenCalledWith(expect.objectContaining({
      postId: 'post-1',
      generationId: GENERATION,
      viewerUserId: VIEWER,
      inputRowIds: [ROW, OTHER_ROW],
      signUrls: false,
    }));
    // Copied, not read through: from the recipe files into the caller's generation inputs.
    expect(stub.storageFrom).toHaveBeenCalledWith('post_resource_files');
    expect(stub.copy).toHaveBeenCalledTimes(1);
    expect(stub.copy).toHaveBeenCalledWith(COPY, DESTINATION, { destinationBucket: 'generation_inputs' });
    expect(stub.storageFrom).toHaveBeenCalledWith('generation_inputs');
    expect(stub.createSignedUrl).toHaveBeenCalledWith(DESTINATION, 3600);
  });

  // A seller who edits a sold recipe takes back nothing its buyers paid for.
  it('imports a copy that is only in the version the viewer unlocked', async () => {
    const stub = setUp({
      recipes: { 'post-1': unlocked([copyItem(OTHER_ROW, OTHER_COPY)], { purchasedItems: [copyItem(ROW, COPY)] }) },
    });

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toMatchObject({ outcome: 'imported' });
  });

  it.each([
    ['a viewer who never unlocked the recipe', { 'post-1': null }],
    ['a viewer whose unlock is gone, refunded since the remix', { 'post-1': unlocked([copyItem(ROW, COPY)], { viewerCanAccess: false }) }],
    ['a copy that is not in the version they have', { 'post-1': unlocked([copyItem(OTHER_ROW, OTHER_COPY)]) }],
    ['a copy their version holds under another input’s name', { 'post-1': unlocked([copyItem(OTHER_ROW, COPY)]) }],
  ])('refuses %s', async (_, recipes) => {
    const stub = setUp({ recipes });

    await expect(importAs(VIEWER, SOURCE, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
    expect(stub.createSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses a copy kept in another creation’s folder, even where the viewer unlocked both recipes', async () => {
    // Named after ROW, an input of GENERATION, but filed in OTHER_GENERATION's folder.
    const misfiled = `${SELLER}/generation-references/${OTHER_GENERATION}/00-reference-image-${ROW}.png`;
    const stub = setUp({
      recipes: {
        'post-1': unlocked([copyItem(ROW, misfiled)]),
        'post-2': unlocked([copyItem(ROW, misfiled)], { generationId: OTHER_GENERATION }),
      },
    });

    await expect(importAs(VIEWER, `post_resource_files/${misfiled}`, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    // Its folder names OTHER_GENERATION: that creation's post is read, and ROW is none of its inputs.
    expect(stub.getDetailByPostId).toHaveBeenCalledTimes(1);
    expect(stub.getDetailByPostId).toHaveBeenCalledWith('post-2', expect.anything());
    expect(stub.loadCopies).toHaveBeenCalledWith(expect.objectContaining({ inputRowIds: [OTHER_GENERATION_ROW] }));
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses a file of the seller’s recipe folder that is no copy, even one the recipe lists', async () => {
    const notes = `${SELLER}/generation-references/${GENERATION}/notes.txt`;
    const stub = setUp({ recipes: { 'post-1': unlocked([copyItem(ROW, COPY), { id: 'item-3', storagePath: notes }]) } });

    await expect(importAs(VIEWER, `post_resource_files/${notes}`, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it.each([
    ['another of the seller’s recipe files', `post_resource_files/${SELLER}/resources/${GENERATION}/guide.pdf`],
    ['a file below a copy’s folder', `post_resource_files/${SELLER}/generation-references/${GENERATION}/nested/00-reference-image-${ROW}.png`],
    ['a creation segment that is no id', `post_resource_files/${SELLER}/generation-references/gen-1/00-reference-image-${ROW}.png`],
    ['a creator’s own kept input, which the shared import answers', `generation_inputs/${SELLER}/${GENERATION}/00-reference_image.png`],
    ['an upload', `uploads/${SELLER}/hero.png`],
  ])('refuses %s without reading anything', async (_, source) => {
    const stub = setUp();

    await expect(importAs(VIEWER, source, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.from).not.toHaveBeenCalled();
    expect(stub.getDetailByPostId).not.toHaveBeenCalled();
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses the seller their own copy, which their run reads as their own file', async () => {
    const stub = setUp();

    await expect(importAs(SELLER, SOURCE, stub)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(stub.from).not.toHaveBeenCalled();
    expect(stub.copy).not.toHaveBeenCalled();
  });

  it('refuses a creation with no post of the seller’s, or no saved inputs', async () => {
    const noPost = setUp({ tables: { posts: [{ id: 'post-1', user_id: 'someone-else', generation_id: GENERATION }] } });
    await expect(importAs(VIEWER, SOURCE, noPost)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(noPost.getDetailByPostId).not.toHaveBeenCalled();

    const noInputs = setUp({ tables: { generation_input_media: [] } });
    await expect(importAs(VIEWER, SOURCE, noInputs)).resolves.toEqual({ outcome: 'not-eligible' });
    expect(noInputs.getDetailByPostId).not.toHaveBeenCalled();
  });

  // As the shared import answers: a read, the copy or its signing that fails
  // is retryable, and nothing is copied before the unlock is settled.
  it.each([
    ['the post', { tables: { posts: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['the saved inputs', { tables: { generation_input_media: databaseError('57014', 'canceling statement due to statement timeout') } }],
    ['the recipe', { detailError: new Error('post_resource_bundles unavailable') }],
  ])('fails retryably, copying nothing, when the read of %s fails', async (_, options) => {
    const stub = setUp(options);

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
});
