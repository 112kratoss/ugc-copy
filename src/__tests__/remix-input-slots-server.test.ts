import { describe, expect, it, vi } from 'vitest';

import { createStoredRows, databaseError } from '@/__tests__/fixtures/stored-rows';
import type { GenerationInputMediaItem } from '@/lib/generation-input-media';
import {
  buildGenerationReferenceCopyPath,
  copyPlannedGenerationReferences,
  findGenerationReferenceCopies,
  loadGenerationRecipeReferenceCopies,
  parseGenerationReferenceCopyPath,
  planGenerationReferenceCopies,
  type GenerationReferenceCopyRecipe,
} from '@/lib/post-resource-bundles-server';
import { holdBackFromRemix, remixSlotWords, splitRemixInputsByCopy } from '@/lib/remix-input-slots-server';

// Owner, 2026-11-03: a remix that is given none of the run's inputs gets an
// empty slot for each, and someone who unlocked the recipe gets back the inputs
// whose copies "Include creation references" put in it.

const SELLER = 'creator-1';
const GENERATION = 'gen-1';
const ROW_A = '6f1c2d3e-4a5b-4c6d-8e7f-00000000000a';
const ROW_B = '6f1c2d3e-4a5b-4c6d-8e7f-00000000000b';
const FOLDER = `${SELLER}/generation-references/${GENERATION}`;
/** The copy of row A as buildGenerationReferenceCopyPath names it. */
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

// One writer files the copies; a remix and a run start read them back. Each of their fixtures
// once typed the layout by hand, so a writer that changed left them green while buyers got empty boxes.
describe('the copy layout, from its writer to its readers', () => {
  const SELLER_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
  const GENERATION_ID = 'b1b2c3d4-0000-4000-8000-000000000001';
  const rows = [
    { id: 'c1b2c3d4-0000-4000-8000-0000000000a1', role: 'reference_image', sort_order: 0, media_type: 'image' as const, storage_path: `generation_inputs/${SELLER_ID}/${GENERATION_ID}/00-reference_image.png` },
    { id: 'c1b2c3d4-0000-4000-8000-0000000000b2', role: 'subject_image', sort_order: 11, media_type: 'image' as const, storage_path: `generation_inputs/${SELLER_ID}/${GENERATION_ID}/11-subject_image.webp` },
    { id: 'c1b2c3d4-0000-4000-8000-0000000000c3', role: 'motion_reference_video', sort_order: 2, media_type: 'video' as const, storage_path: `generation_inputs/${SELLER_ID}/${GENERATION_ID}/02-motion_reference_video.mov` },
  ];

  it('reads back every copy the writer files, by its row, and the start’s parser reads its folder', async () => {
    const stored: string[] = [];
    const client = {
      from: () => {
        const query = { select: () => query, eq: () => query, order: async () => ({ data: rows.map((row) => ({ ...row, generation_id: GENERATION_ID, user_id: SELLER_ID, label: null, source_generation_id: null, metadata: {} })), error: null }) };
        return query;
      },
      storage: {
        from: () => ({
          info: async () => ({ data: { contentType: 'image/png', size: 5 }, error: null }),
          copy: async (_from: string, to: string) => {
            stored.push(to);
            return { error: null };
          },
        }),
      },
    };

    // The writer plans each copy's path, then files it (#677's review: no byte moves before every check).
    const plan = await planGenerationReferenceCopies({ supabase: client as never, ownerUserId: SELLER_ID, generationId: GENERATION_ID });
    if (!plan.ok) throw new Error('the plan read no inputs');
    const copied = await copyPlannedGenerationReferences({ supabase: client as never, references: plan.references });
    const items = plan.references.map((planned) => planned.item);

    expect(copied.failedItemIds.size).toBe(0);
    expect(items.map((item) => item.storagePath)).toEqual(stored);
    expect(items.map((item) => item.storagePath)).toEqual(rows.map((row) => buildGenerationReferenceCopyPath(SELLER_ID, GENERATION_ID, row)));
    expect(findGenerationReferenceCopies({ items, ownerUserId: SELLER_ID, generationId: GENERATION_ID, inputRowIds: rows.map((row) => row.id) }))
      .toEqual(new Map(rows.map((row, index) => [row.id, items[index]!.storagePath!])));
    for (const item of items) {
      expect(parseGenerationReferenceCopyPath(item.storagePath!)).toEqual({
        ownerUserId: SELLER_ID,
        generationId: GENERATION_ID,
        fileName: item.storagePath!.split('/').pop(),
      });
    }
  });

  it.each([
    ['another folder of the recipe files', `${SELLER_ID}/resources/${GENERATION_ID}/guide.pdf`],
    ['a file below a creation’s folder', `${SELLER_ID}/generation-references/${GENERATION_ID}/nested/00-reference-image-row.png`],
    ['the folder itself', `${SELLER_ID}/generation-references/${GENERATION_ID}`],
    ['no account', `/generation-references/${GENERATION_ID}/00.png`],
  ])('reads %s as no copy', (_, filePath) => {
    expect(parseGenerationReferenceCopyPath(filePath)).toBeNull();
  });
});

describe('reading the copies from the recipe the viewer bought', () => {
  const recipeItem = (rowId: string, storagePath: string) => ({ id: `reference-${rowId}`, type: 'reference_image', title: 'Reference', storagePath });
  const RECIPE: GenerationReferenceCopyRecipe = { id: 'bundle-1', ownerUserId: SELLER, viewerHasPurchased: true };

  type SignedUrlAnswer = { data: { signedUrl: string } | null; error: { message: string } | null };

  function recipeClient(options: {
    currentItems?: unknown[];
    purchasedItems?: unknown[] | null;
    revisionError?: boolean;
    purchases?: Array<Record<string, unknown>> | ReturnType<typeof databaseError>;
    failing?: string[];
    creation?: { archived_at?: string | null; moderation_removed_at?: string | null };
  } = {}) {
    const stored = createStoredRows({
      post_resource_bundles: [{ id: 'bundle-1', resource_items: options.currentItems ?? [], resource_sections: [] }],
      generations: [{ id: GENERATION, archived_at: null, moderation_removed_at: null, ...options.creation }],
      post_resource_bundle_purchases: options.purchases ?? [{ id: 'purchase-1', bundle_id: 'bundle-1', buyer_user_id: 'buyer-1' }],
    }, {
      get_purchased_post_resource_bundle_revision: () => (options.revisionError
        ? databaseError('57014', 'canceling statement due to statement timeout')
        : options.purchasedItems
          ? [{ is_latest: false, resource_items: options.purchasedItems, resource_sections: [] }]
          : []),
    });
    const createSignedUrl = vi.fn<(filePath: string, expiresIn: number) => Promise<SignedUrlAnswer>>(async (filePath) => (
      (options.failing ?? []).includes(filePath)
        ? { data: null, error: { message: 'storage outage' } }
        : { data: { signedUrl: `https://signed.example/post_resource_files/${filePath}?token=short` }, error: null }
    ));
    const storageFrom = vi.fn(() => ({ createSignedUrl }));
    const from = vi.fn((table: string) => stored.client.from(table));
    return { client: { from, rpc: stored.client.rpc, storage: { from: storageFrom } } as never, from, storageFrom, createSignedUrl };
  }

  async function load(client: ReturnType<typeof recipeClient>, options: { recipe?: Partial<GenerationReferenceCopyRecipe>; inputRowIds?: string[]; signUrls?: boolean } = {}) {
    return loadGenerationRecipeReferenceCopies({
      adminSupabase: client.client,
      recipe: { ...RECIPE, ...options.recipe },
      generationId: GENERATION,
      viewerUserId: 'buyer-1',
      inputRowIds: options.inputRowIds ?? [ROW_A, ROW_B],
      ...(options.signUrls === undefined ? {} : { signUrls: options.signUrls }),
    });
  }

  it('reads the recipe the gate found its buyer bought, and signs each copy briefly in the recipe files', async () => {
    const client = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)] });

    const copies = await load(client);

    expect(client.storageFrom).toHaveBeenCalledWith('post_resource_files');
    expect(client.createSignedUrl).toHaveBeenCalledWith(COPY_A, 3600);
    expect(copies).toEqual(new Map([[ROW_A, {
      storagePath: `post_resource_files/${COPY_A}`,
      url: `https://signed.example/post_resource_files/${COPY_A}?token=short`,
    }]]));
    // What the gate read is not read again: no purchase, no post, no profile. Whether each copy is
    // withheld is asked now, of the database (owner, 2026-11-04; remix plan, phase 1b).
    expect(client.from.mock.calls.map(([table]) => table)).toEqual(['post_resource_bundles']);
  });

  // Owner, 2026-11-04: a creation its creator archived or an operator removed lends its copies to no
  // remix and no start, read now so that un-archiving restores them.
  it.each([
    ['archived by its creator', { archived_at: '2026-11-04T00:00:00.000Z' }],
    ['removed by an operator', { moderation_removed_at: '2026-11-04T00:00:00.000Z' }],
  ])('restores no copy of a creation %s, and signs none', async (_, creation) => {
    const client = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)], creation });

    expect(await load(client)).toEqual(new Map());
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  // A creator who edits a sold recipe cannot take back what it held when it was
  // bought: the file route signs a file of either version for its buyer.
  it('finds a copy that is only in the version the viewer bought', async () => {
    const copies = await load(recipeClient({
      currentItems: [recipeItem(ROW_B, COPY_B)],
      purchasedItems: [recipeItem(ROW_A, COPY_A)],
    }));

    expect([...copies.keys()].sort()).toEqual([ROW_A, ROW_B]);
  });

  // A recipe its seller retired gates no Remix, so the gate asked no purchase: it is read here.
  it('reads the purchase of a recipe the gate did not ask about, and finds its copies for its buyer alone', async () => {
    const buyer = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)] });
    expect([...(await load(buyer, { recipe: { viewerHasPurchased: null } })).keys()]).toEqual([ROW_A]);

    const stranger = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)], purchases: [{ id: 'p', bundle_id: 'bundle-1', buyer_user_id: 'someone-else' }] });
    expect(await load(stranger, { recipe: { viewerHasPurchased: null } })).toEqual(new Map());
    expect(stranger.createSignedUrl).not.toHaveBeenCalled();
  });

  // The version a buyer bought can hold a copy the recipe no longer does: unread, that copy turned into
  // a slot for good, or a start's refusal that is not retryable (2026-11-03 re-review).
  it('throws when the version the buyer bought cannot be read, rather than reading the recipe without it', async () => {
    const client = recipeClient({ currentItems: [recipeItem(ROW_B, COPY_B)], revisionError: true });

    await expect(load(client)).rejects.toBeTruthy();
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  it('throws when the purchase cannot be read, rather than taking it for none', async () => {
    const client = recipeClient({ purchases: databaseError('57014', 'canceling statement due to statement timeout') });

    await expect(load(client, { recipe: { viewerHasPurchased: null } })).rejects.toBeTruthy();
  });

  it.each([
    ['a viewer who never bought it', { viewerHasPurchased: false }],
    ['its seller, whose copies are their own files', { ownerUserId: 'buyer-1' }],
    ['a recipe with no seller', { ownerUserId: null }],
  ])('reads and signs nothing for %s', async (_, recipe) => {
    const client = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)] });

    expect(await load(client, { recipe: recipe as never })).toEqual(new Map());
    expect(client.from).not.toHaveBeenCalled();
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  it('keeps a copy whose signing failed, without a link, and signs nothing for a start', async () => {
    const failing = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)], failing: [COPY_A] });
    expect((await load(failing)).get(ROW_A)).toEqual({ storagePath: `post_resource_files/${COPY_A}`, url: null });

    const unsigned = recipeClient({ currentItems: [recipeItem(ROW_A, COPY_A)] });
    expect((await load(unsigned, { signUrls: false })).get(ROW_A)).toEqual({ storagePath: `post_resource_files/${COPY_A}`, url: null });
    expect(unsigned.createSignedUrl).not.toHaveBeenCalled();
  });

  it('reads nothing for a run with no rows', async () => {
    const client = recipeClient();

    expect(await load(client, { inputRowIds: [] })).toEqual(new Map());
    expect(client.from).not.toHaveBeenCalled();
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
      input('lead-3', 'image', 'subject_image', 2, { handle: '@lead', subjectIndex: 0 }),
      input('bottle-1', 'image', 'subject_image', 3, { handle: '@bottle', subjectIndex: 1 }),
      input('bottle-2', 'image', 'subject_image', 4, { handle: '@bottle', subjectIndex: 1 }),
      // Names no subject, so it cannot be restored as one, copy or not.
      input('unnamed', 'image', 'subject_image', 5, { subjectIndex: 2 }),
    ], new Set(['lead-2', 'lead-3', 'unnamed']), 'video');

    // @lead comes back with its two copied pictures, and no slot asks for @lead beside it.
    expect(ids(restored)).toEqual(['lead-2', 'lead-3']);
    expect(ids(withheld)).toEqual(['bottle-1', 'bottle-2', 'unnamed']);
  });

  // A subject takes two to four pictures (`SUBJECT_IMAGES_PER_NAME`): one restored alone opened below
  // the minimum, with no word of it (2026-11-03 review). It is the remixer's to fill instead.
  it('gives a subject with fewer copied pictures than a subject takes its slot, rather than part of it', () => {
    const { restored, withheld } = splitRemixInputsByCopy([
      input('lead-1', 'image', 'subject_image', 0, { handle: '@lead', subjectIndex: 0 }),
      input('lead-2', 'image', 'subject_image', 1, { handle: '@lead', subjectIndex: 0 }),
    ], new Set(['lead-2']), 'video');

    expect(ids(restored)).toEqual([]);
    expect(ids(withheld)).toEqual(['lead-1', 'lead-2']);
  });

  // A subject handed over with one of its pictures held back (a recipe file) was left with one picture,
  // below what a subject takes, and its box hid as answered (2026-11-03 re-review). Held back whole
  // below the minimum, it is a slot; at the minimum or above, it is handed over without the file.
  it('holds back a subject whole where what a held-back picture leaves of it is no subject', () => {
    const isRecipeFile = (item: GenerationInputMediaItem) => item.metadata?.sourceKind === 'recipe-file';
    const bought = { sourceKind: 'recipe-file' };
    const pairs = holdBackFromRemix([
      input('lead-1', 'image', 'subject_image', 0, { handle: '@lead', subjectIndex: 0 }),
      input('lead-2', 'image', 'subject_image', 1, { handle: '@lead', subjectIndex: 0, ...bought }),
      input('maya-1', 'image', 'subject_image', 2, { handle: '@maya', subjectIndex: 1 }),
      input('maya-2', 'image', 'subject_image', 3, { handle: '@maya', subjectIndex: 1 }),
      input('maya-3', 'image', 'subject_image', 4, { handle: '@maya', subjectIndex: 1, ...bought }),
      input('ref-own', 'image', 'reference_image', 5),
      input('ref-bought', 'image', 'reference_image', 6, bought),
    ], isRecipeFile, 'video');

    expect(ids(pairs.handedOn)).toEqual(['maya-1', 'maya-2', 'ref-own']);
    expect(ids(pairs.heldBack)).toEqual(['lead-1', 'lead-2', 'maya-3', 'ref-bought']);
    // Nothing held back, nothing moves.
    expect(holdBackFromRemix([input('lead-1', 'image', 'subject_image', 0, { handle: '@lead' })], isRecipeFile, 'video').heldBack).toEqual([]);
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

// A story keeps only its first shot as the creation's prompt; every shot reaches the remixer.
describe('the words a run’s handles are read in', () => {
  it('reads the prompt and each of a story’s shots', () => {
    expect(remixSlotWords('@hero walks in', { multiPrompts: [{ prompt: '@hero walks in' }, { prompt: '@villain waits' }, { duration: 3 }, null] }))
      .toEqual(['@hero walks in', '@hero walks in', '@villain waits', null, null]);
    expect(remixSlotWords(null, { multiPrompts: 'not shots' })).toEqual([null]);
    expect(remixSlotWords('@hero', {})).toEqual(['@hero']);
  });
});
