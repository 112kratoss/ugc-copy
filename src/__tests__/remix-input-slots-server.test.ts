import { describe, expect, it, vi } from 'vitest';

import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import {
  findGenerationReferenceCopies,
  loadGenerationRecipeReferenceCopiesByPostId,
  type PostResourceBundleDetail,
} from '@/lib/post-resource-bundles-server';
import { splitRemixInputsByCopy } from '@/lib/remix-input-slots-server';

// Owner, 2026-11-03: a remix that is given none of the run's inputs gets an
// empty slot for each, and someone who unlocked the recipe gets back the inputs
// whose copies "Include creation references" put in it.

const SELLER = 'creator-1';
const GENERATION = 'gen-1';
const ROW_A = '6f1c2d3e-4a5b-4c6d-8e7f-00000000000a';
const ROW_B = '6f1c2d3e-4a5b-4c6d-8e7f-00000000000b';
const FOLDER = `${SELLER}/generation-references/${GENERATION}`;
/** The copy of row A as buildGenerationReferenceResourceItems names it. */
const COPY_A = `${FOLDER}/00-reference-image-${ROW_A}.png`;
const COPY_B = `${FOLDER}/01-reference-image-${ROW_B}.png`;

describe('finding the copies a recipe holds of its creation’s inputs', () => {
  const find = (items: Array<{ id?: string; storagePath: string | null }>, inputRowIds = [ROW_A]) => (
    findGenerationReferenceCopies({ items, ownerUserId: SELLER, generationId: GENERATION, inputRowIds })
  );

  it('matches a row to the item stored under its id, in the creation’s folder, named after it', () => {
    expect(find([
      { id: 'prompt', storagePath: null },
      { id: `reference-${ROW_B}`, storagePath: COPY_B },
      { id: `reference-${ROW_A}`, storagePath: COPY_A },
    ], [ROW_A, ROW_B])).toEqual(new Map([[ROW_A, COPY_A], [ROW_B, COPY_B]]));
  });

  it.each([
    ['another creation’s folder', `${SELLER}/generation-references/gen-2/00-reference-image-${ROW_A}.png`],
    ['another account’s folder', `creator-2/generation-references/${GENERATION}/00-reference-image-${ROW_A}.png`],
    ['a folder outside the creation references', `${SELLER}/uploads/00-reference-image-${ROW_A}.png`],
    ['a folder inside the creation’s', `${FOLDER}/nested/00-reference-image-${ROW_A}.png`],
    ['a file named after another row', `${FOLDER}/00-reference-image-${ROW_B}.png`],
    ['a file with no extension', `${FOLDER}/00-reference-image-${ROW_A}`],
    ['a name that decodes to something else', `${FOLDER}/%2e%2e-reference-image-${ROW_A}.png`],
    ['a bucket-prefixed path', `post_resource_files/${FOLDER}/00-reference-image-${ROW_A}.png`],
  ])('ignores an item of the row’s id kept in %s', (_, storagePath) => {
    expect(find([{ id: `reference-${ROW_A}`, storagePath }])).toEqual(new Map());
  });

  it('ignores the row’s copy stored under another id', () => {
    expect(find([{ id: 'item-3', storagePath: COPY_A }, { id: `reference-${ROW_B}`, storagePath: COPY_A }])).toEqual(new Map());
  });

  it('names no row with an id that sanitizes to nothing', () => {
    expect(find([{ id: 'reference-1', storagePath: `${FOLDER}/00-reference-image-1.png` }], ['___'])).toEqual(new Map());
  });
});

describe('reading the copies from the recipe the viewer has', () => {
  const recipeItem = (rowId: string, storagePath: string) => ({ id: `reference-${rowId}`, storagePath });

  function detail(overrides: Partial<{
    viewerCanAccess: boolean;
    currentItems: Array<{ id: string; storagePath: string }> | null;
    purchasedItems: Array<{ id: string; storagePath: string }> | null;
    generationId: string;
  }> = {}): PostResourceBundleDetail {
    const { viewerCanAccess = true, currentItems = [], purchasedItems = null, generationId = GENERATION } = overrides;
    return {
      viewerCanAccess,
      resources: currentItems ? { items: currentItems } : null,
      purchasedRevision: purchasedItems ? { resources: { items: purchasedItems } } : null,
      seller: { id: SELLER },
      post: { generationId },
    } as unknown as PostResourceBundleDetail;
  }

  type SignedUrlAnswer = { data: { signedUrl: string } | null; error: { message: string } | null };

  function storageClient({ failing = [] as string[] } = {}) {
    const createSignedUrl = vi.fn<(filePath: string, expiresIn: number) => Promise<SignedUrlAnswer>>(async (filePath) => (
      failing.includes(filePath)
        ? { data: null, error: { message: 'storage outage' } }
        : { data: { signedUrl: `https://signed.example/post_resource_files/${filePath}?token=short` }, error: null }
    ));
    const from = vi.fn<(bucket: string) => { createSignedUrl: typeof createSignedUrl }>(() => ({ createSignedUrl }));
    return { client: { storage: { from } } as never, from, createSignedUrl };
  }

  async function load(recipe: PostResourceBundleDetail | null, options: { inputRowIds?: string[]; failing?: string[] } = {}) {
    const storage = storageClient({ failing: options.failing });
    const getDetailByPostId = vi.fn(async () => recipe);
    const copies = await loadGenerationRecipeReferenceCopiesByPostId({
      postId: 'post-verified',
      generationId: GENERATION,
      viewerUserId: 'buyer-1',
      inputRowIds: options.inputRowIds ?? [ROW_A, ROW_B],
      adminSupabase: storage.client,
      getDetailByPostId: getDetailByPostId as never,
    });
    return { copies, getDetailByPostId, ...storage };
  }

  it('reads the unlock as the file route does, and signs each copy briefly in the recipe files', async () => {
    const { copies, getDetailByPostId, from, createSignedUrl, client } = await load(detail({ currentItems: [recipeItem(ROW_A, COPY_A)] }));

    expect(getDetailByPostId).toHaveBeenCalledWith('post-verified', {
      viewerUserId: 'buyer-1',
      adminSupabase: client,
      countLockedReferences: false,
    });
    expect(from).toHaveBeenCalledWith('post_resource_files');
    expect(createSignedUrl).toHaveBeenCalledWith(COPY_A, 3600);
    expect(copies).toEqual(new Map([[ROW_A, {
      storagePath: `post_resource_files/${COPY_A}`,
      url: `https://signed.example/post_resource_files/${COPY_A}?token=short`,
    }]]));
  });

  // A creator who edits a sold recipe cannot take back what it held when it was
  // unlocked: the file route signs a file of either version for its buyer.
  it('finds a copy that is only in the version the viewer unlocked', async () => {
    const { copies } = await load(detail({
      currentItems: [recipeItem(ROW_B, COPY_B)],
      purchasedItems: [recipeItem(ROW_A, COPY_A)],
    }));

    expect([...copies.keys()].sort()).toEqual([ROW_A, ROW_B]);
  });

  it.each([
    ['no recipe for this viewer', null],
    ['a viewer without access', detail({ viewerCanAccess: false, currentItems: [recipeItem(ROW_A, COPY_A)] })],
    ['a recipe whose resources are withheld', detail({ currentItems: null })],
    ['a recipe on another creation', detail({ currentItems: [recipeItem(ROW_A, COPY_A)], generationId: 'gen-2' })],
  ])('signs nothing for %s', async (_, recipe) => {
    const { copies, createSignedUrl } = await load(recipe);

    expect(copies).toEqual(new Map());
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it('keeps a copy whose signing failed, without a link', async () => {
    const { copies } = await load(detail({ currentItems: [recipeItem(ROW_A, COPY_A)] }), { failing: [COPY_A] });

    expect(copies.get(ROW_A)).toEqual({ storagePath: `post_resource_files/${COPY_A}`, url: null });
  });

  it('reads nothing for a run with no rows', async () => {
    const { copies, getDetailByPostId } = await load(detail(), { inputRowIds: [] });

    expect(copies).toEqual(new Map());
    expect(getDetailByPostId).not.toHaveBeenCalled();
  });
});

describe('splitting withheld inputs into restored copies and slots', () => {
  const input = (
    id: string,
    mediaType: GenerationInputMediaItem['mediaType'],
    role: string,
    sortOrder: number,
    metadata: Record<string, unknown> = {},
  ): GenerationInputMediaItem => ({
    id,
    generationId: GENERATION,
    mediaType,
    role,
    label: `label-${id}`,
    url: null,
    storagePath: `generation_inputs/${SELLER}/${GENERATION}/${sortOrder}`,
    sourceGenerationId: null,
    sortOrder,
    metadata,
  });
  const ids = (items: GenerationInputMediaItem[]) => items.map((item) => item.id);

  it('restores what has a copy and keeps the rest for slots, in the run’s order', () => {
    const { restored, withheld } = splitRemixInputsByCopy([
      input('ref-2', 'image', 'reference_image', 2),
      input('ref-1', 'image', 'reference_image', 1),
      input('clip', 'video', 'reference_video', 3),
      input('track', 'audio', 'reference_audio', 4),
    ], new Set(['ref-2', 'track']), 'video');

    expect(ids(restored)).toEqual(['ref-2', 'track']);
    expect(ids(withheld)).toEqual(['ref-1', 'clip']);
  });

  it('counts a named subject as one input, restored from the pictures it has copies of', () => {
    const { restored, withheld } = splitRemixInputsByCopy([
      input('lead-1', 'image', 'subject_image', 0, { handle: '@lead', subjectIndex: 0 }),
      input('lead-2', 'image', 'subject_image', 1, { handle: '@lead', subjectIndex: 0 }),
      input('bottle-1', 'image', 'subject_image', 2, { handle: '@bottle', subjectIndex: 1 }),
      input('bottle-2', 'image', 'subject_image', 3, { handle: '@bottle', subjectIndex: 1 }),
      // Names no subject, so it cannot be restored as one, copy or not.
      input('unnamed', 'image', 'subject_image', 4, { subjectIndex: 2 }),
    ], new Set(['lead-2', 'unnamed']), 'video');

    // @lead comes back with its one copied picture, and no slot asks for @lead beside it.
    expect(ids(restored)).toEqual(['lead-2']);
    expect(ids(withheld)).toEqual(['bottle-1', 'bottle-2', 'unnamed']);
  });

  it('reads a frame as the first of its role, as the slot builder and the restore both do', () => {
    const frames = [
      input('start-1', 'image', 'start_frame', 0),
      input('start-2', 'image', 'start_frame', 1),
      input('end', 'image', 'end_frame', 2),
    ];

    const firstCopied = splitRemixInputsByCopy(frames, new Set(['start-1', 'start-2']), 'video');
    expect(ids(firstCopied.restored)).toEqual(['start-1']);
    expect(ids(firstCopied.withheld)).toEqual(['end']);

    // Only a later start frame has a copy: the run's start frame is still the creator's.
    const laterCopied = splitRemixInputsByCopy(frames, new Set(['start-2']), 'video');
    expect(ids(laterCopied.restored)).toEqual([]);
    expect(ids(laterCopied.withheld)).toEqual(['start-1', 'start-2', 'end']);
  });

  it('reads a motion run as its character and its clip, whatever roles the catalog stored', () => {
    const { restored, withheld } = splitRemixInputsByCopy([
      input('character', 'image', 'reference_image', 0),
      input('clip', 'video', 'reference_video', 1),
    ], new Set(['clip']), 'motion');

    expect(ids(restored)).toEqual(['clip']);
    expect(ids(withheld)).toEqual(['character']);
  });

  it('leaves out what no creator of the tool restores, copy or not', () => {
    expect(splitRemixInputsByCopy([
      input('frame', 'image', 'start_frame', 0),
      input('picture', 'image', 'subject_image', 1, { handle: '@lead', subjectIndex: 0 }),
    ], new Set(['frame', 'picture']), 'image')).toEqual({ restored: [], withheld: [] });
  });
});
