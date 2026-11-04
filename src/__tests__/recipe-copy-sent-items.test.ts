import { describe, expect, it, vi } from 'vitest';

import { prepareCreationRecipeBundle } from '@/lib/post-resource-bundles-server';
import { heldItemsForReferenceCopies, referenceCopiesToMake, sendsUnheldCreationCopies } from '@/lib/recipe-copy-sent-items';
import { recordRecipeImportUse } from '@/lib/recipe-import-use';

const OWNER = 'user-1';
const CREATION = 'gen-1';
const COPY_PATH = `${OWNER}/generation-references/${CREATION}/00-reference-ref-1.png`;

const copyItem = {
  id: 'reference-ref-1',
  scope: { kind: 'all' as const },
  type: 'reference_image' as const,
  role: 'style_reference' as const,
  sectionId: null,
  title: 'Product',
  description: null,
  textContent: null,
  externalUrl: null,
  storagePath: COPY_PATH,
  contentType: 'image/png',
  sizeBytes: null,
  workflowSnapshot: null,
  sortOrder: 0,
  isPrimary: true,
  remixUse: 'reference_only' as const,
};
const plannedInput = { item: copyItem, source: { bucket: 'generation_inputs', filePath: `${OWNER}/${CREATION}/hero.png` } };
const creatorsOwnFile = { ...copyItem, storagePath: `${OWNER}/upload-7-hero.png` };

// 2026-11-04 review of the recipe copy sweep: a composer's draft sends the copies the server put into a
// recipe back on every save. A sent copy counted as held, so no copy was made for it, and a recipe turned
// off (deleted with its revisions), swept, and saved again from the draft named files that were gone.
describe('a sent copy of a saved input is made again unless the recipe holds it', () => {
  it('holds the stored items and the creator’s own files, and a sent copy only where it is stored', () => {
    expect(heldItemsForReferenceCopies({
      sentItems: [copyItem, creatorsOwnFile],
      storedItems: [],
      ownerUserId: OWNER,
      generationId: CREATION,
    })).toEqual([creatorsOwnFile]);

    expect(heldItemsForReferenceCopies({
      sentItems: [copyItem],
      storedItems: [copyItem],
      ownerUserId: OWNER,
      generationId: CREATION,
    })).toEqual([copyItem, copyItem]);

    // Another creation's copy is no copy of this one's inputs: held as sent.
    const otherCreation = { ...copyItem, storagePath: `${OWNER}/generation-references/gen-2/00-reference-ref-1.png` };
    expect(heldItemsForReferenceCopies({
      sentItems: [otherCreation],
      storedItems: null,
      ownerUserId: OWNER,
      generationId: CREATION,
    })).toEqual([otherCreation]);
  });

  it('copies what the save adds and what was only sent, never one held or with no source', () => {
    const sentOnly = plannedInput;
    const added = { ...plannedInput, item: { ...copyItem, id: 'reference-ref-2', storagePath: `${OWNER}/generation-references/${CREATION}/01-reference-ref-2.png` } };
    const held = { ...plannedInput, item: { ...copyItem, id: 'reference-ref-3' }, source: null };
    const unsent = { ...plannedInput, item: { ...copyItem, id: 'reference-ref-4', storagePath: `${OWNER}/generation-references/${CREATION}/03-reference-ref-4.png` } };

    expect(referenceCopiesToMake({
      references: [sentOnly, added, held, unsent],
      added: [added],
      sentItems: [copyItem],
    })).toEqual([sentOnly, added]);
  });

  it('says whether a sent copy of this creation is missing from the stored recipe', () => {
    const params = { ownerUserId: OWNER, generationId: CREATION };
    expect(sendsUnheldCreationCopies({ ...params, sentItems: [copyItem], storedItems: [] })).toBe(true);
    expect(sendsUnheldCreationCopies({ ...params, sentItems: [copyItem], storedItems: [copyItem] })).toBe(false);
    expect(sendsUnheldCreationCopies({ ...params, sentItems: [creatorsOwnFile], storedItems: null })).toBe(false);
  });

  it('plans a sent copy the stored recipe lacks as one to make again', async () => {
    const planGenerationReferenceCopies = vi.fn(async () => ({ ok: true as const, references: [plannedInput] }));

    const prepared = await prepareCreationRecipeBundle({
      supabase: {} as never,
      ownerUserId: OWNER,
      bundle: {
        accessMode: 'free',
        previewText: 'The product reference behind this still.',
        resources: { promptText: null, notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: false, sections: [], items: [copyItem] },
      },
      creation: { id: CREATION, prompt: null },
      includeReferences: true,
      mayShareCreation: true,
      addsCreationPrompt: false,
      storedItems: [],
      mediaKeys: ['media-1'],
      dependencies: { planGenerationReferenceCopies, validatePostResourceBundleInput: () => null },
    });

    expect(planGenerationReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({ heldItems: [] }));
    expect(prepared).toMatchObject({ ok: true, addedItemIds: [], pendingCopies: [plannedInput] });
  });

  it('makes no second copy of one the stored recipe holds', async () => {
    const heldInput = { ...plannedInput, source: null };
    const planGenerationReferenceCopies = vi.fn(async () => ({ ok: true as const, references: [heldInput] }));

    const prepared = await prepareCreationRecipeBundle({
      supabase: {} as never,
      ownerUserId: OWNER,
      bundle: {
        accessMode: 'free',
        previewText: 'The product reference behind this still.',
        resources: { promptText: null, notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: false, sections: [], items: [copyItem] },
      },
      creation: { id: CREATION, prompt: null },
      includeReferences: true,
      mayShareCreation: true,
      addsCreationPrompt: false,
      storedItems: [copyItem],
      mediaKeys: ['media-1'],
      dependencies: { planGenerationReferenceCopies, validatePostResourceBundleInput: () => null },
    });

    expect(planGenerationReferenceCopies).toHaveBeenCalledWith(expect.objectContaining({ heldItems: [copyItem, copyItem] }));
    expect(prepared).toMatchObject({ ok: true, pendingCopies: [] });
  });
});

// 2026-11-04 fix check: both composers turn "Include creation references" off once a save has the inputs,
// and send the copies back from their drafts with the switch off, so the check above never ran on a re-save.
describe('a re-save with the switch off', () => {
  const bundle = {
    accessMode: 'free' as const,
    previewText: 'The product reference behind this still.',
    resources: { promptText: null, notesMarkdown: null, workflowShareUrl: null, attachments: [], allowRemix: false, sections: [], items: [copyItem] },
  };

  it('copies again a sent copy the stored recipe no longer names, and adds nothing new', async () => {
    const otherInput = { ...plannedInput, item: { ...copyItem, id: 'reference-ref-2', storagePath: `${OWNER}/generation-references/${CREATION}/01-reference-ref-2.png` } };
    const planGenerationReferenceCopies = vi.fn(async () => ({ ok: true as const, references: [plannedInput, otherInput] }));

    const prepared = await prepareCreationRecipeBundle({
      supabase: {} as never,
      ownerUserId: OWNER,
      bundle,
      creation: { id: CREATION, prompt: null },
      includeReferences: false,
      mayShareCreation: true,
      addsCreationPrompt: false,
      // The recipe was turned off and on again: deleted, so nothing is stored.
      storedItems: [],
      mediaKeys: ['media-1'],
      dependencies: { planGenerationReferenceCopies, validatePostResourceBundleInput: () => null },
    });

    expect(planGenerationReferenceCopies).toHaveBeenCalledTimes(1);
    expect(prepared).toMatchObject({ ok: true, addedItemIds: [], pendingCopies: [plannedInput] });
    expect(prepared.ok && prepared.bundle?.resources?.items?.map((item) => item.id)).toEqual(['reference-ref-1']);
  });

  it('reads no saved inputs when every sent copy is stored, or none is sent', async () => {
    const planGenerationReferenceCopies = vi.fn(async () => ({ ok: true as const, references: [plannedInput] }));
    const cases: Array<[typeof bundle, Array<typeof copyItem>]> = [
      [bundle, [copyItem]],
      [{ ...bundle, resources: { ...bundle.resources, items: [creatorsOwnFile] } }, []],
    ];
    for (const [sent, stored] of cases) {
      const prepared = await prepareCreationRecipeBundle({
        supabase: {} as never,
        ownerUserId: OWNER,
        bundle: sent,
        creation: { id: CREATION, prompt: null },
        includeReferences: false,
        mayShareCreation: true,
        addsCreationPrompt: false,
        storedItems: stored,
        mediaKeys: ['media-1'],
        dependencies: { planGenerationReferenceCopies, validatePostResourceBundleInput: () => null },
      });
      expect(prepared).toMatchObject({ ok: true, pendingCopies: [] });
    }
    expect(planGenerationReferenceCopies).not.toHaveBeenCalled();
  });
});

describe('a run start records its use of a recipe import', () => {
  const IMPORT = 'buyer-1/recipe-imports/seller-1/gen-1/00-reference-row-1.png';

  it('records it through the database, by its clock', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await expect(recordRecipeImportUse({ rpc } as never, 'buyer-1', IMPORT)).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('record_recipe_import_use', { p_buyer_user_id: 'buyer-1', p_object_name: IMPORT });
  });

  it('answers false when the record cannot be written, so the start does not use the import', async () => {
    const failing = vi.fn(async () => ({ data: null, error: { message: 'statement timeout' } }));
    await expect(recordRecipeImportUse({ rpc: failing } as never, 'buyer-1', IMPORT)).resolves.toBe(false);
    const throwing = vi.fn(async () => { throw new Error('network'); });
    await expect(recordRecipeImportUse({ rpc: throwing } as never, 'buyer-1', IMPORT)).resolves.toBe(false);
  });
});
