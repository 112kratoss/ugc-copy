import { describe, expect, it, vi } from 'vitest';

import { heldRecipeFileOf } from '@/lib/generation-input-origin';
import { recipeCopiesWithheldOver } from './fixtures/recipe-copies-withheld';
import {
  loadWithheldCopies,
  recipeCopyCreationId,
  withholdCopiesOfCreationsOffView,
  withholdUnreadableRecipeFileInputs,
} from '@/lib/recipe-copy-access';

// Owner, 2026-11-04: a buyer's use of a recipe's files ends with their unlock, and the copies of a
// creation's inputs stop being served once that creation is removed or archived.

const SELLER = '11111111-1111-4111-8111-111111111111';
const CREATION = '22222222-2222-4222-8222-222222222222';
const OTHER_CREATION = '33333333-3333-4333-8333-333333333333';
const COPY_PATH = `${SELLER}/generation-references/${CREATION}/00-reference-image-row-1.png`;
const COPY = `post_resource_files/${COPY_PATH}`;
const IMPORT = `generation_inputs/buyer-1/recipe-imports/${SELLER}/${CREATION}/00-reference-image-row-1.png`;
const holder = new Set(['buyer-1']);

describe('the recipe file a held input stands for', () => {
  it('reads the copy its row recorded, or the one its import names', () => {
    expect(heldRecipeFileOf({ metadata: { sourceKind: 'recipe-file', recipeFile: COPY } }, holder)).toBe(COPY);
    expect(heldRecipeFileOf({ metadata: { sourceStoragePath: IMPORT } }, holder)).toBe(COPY);
    expect(heldRecipeFileOf({ metadata: { legacy: true }, storagePath: IMPORT }, holder)).toBe(COPY);
  });

  it('reads a seller’s own recipe upload a run used', () => {
    expect(heldRecipeFileOf({ metadata: { sourceStoragePath: `post_resource_files/${SELLER}/notes/guide.png` } }, holder))
      .toBe(`post_resource_files/${SELLER}/notes/guide.png`);
  });

  it('answers an unknown file for a marked input with none on record, and none for the holder’s own', () => {
    expect(heldRecipeFileOf({ metadata: { sourceKind: 'recipe-file' } }, holder)).toBe('');
    expect(heldRecipeFileOf({ metadata: { sourceStoragePath: 'uploads/buyer-1/mine.png' } }, holder)).toBeNull();
  });
});

describe('withholding the held inputs a holder may no longer read', () => {
  const item = (id: string, metadata: Record<string, unknown>) => ({ id, url: `https://signed.example/${id}`, metadata });

  it('asks only of the recipe files, for the holder, and keeps what they may read', async () => {
    const rpc = vi.fn(async () => ({ data: [COPY], error: null }));
    const items = [item('copy', { recipeFile: COPY, sourceKind: 'recipe-file' }), item('own', {})];

    const result = await withholdUnreadableRecipeFileInputs({ adminSupabase: { rpc } as never, holderUserId: 'buyer-1', items });

    expect(result.map((entry) => entry.url)).toEqual(['https://signed.example/copy', 'https://signed.example/own']);
    expect(rpc).toHaveBeenCalledWith('recipe_files_readable_by', { p_viewer_user_id: 'buyer-1', p_paths: [COPY] });
  });

  it('withholds a marked input whose file is on no record without asking', async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const result = await withholdUnreadableRecipeFileInputs({
      adminSupabase: { rpc } as never,
      holderUserId: 'buyer-1',
      items: [item('unknown', { sourceKind: 'recipe-file' })],
    });

    expect(result[0]?.url).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks nothing for a holder with no recipe file', async () => {
    const rpc = vi.fn();
    const items = [item('own', {})];

    expect(await withholdUnreadableRecipeFileInputs({ adminSupabase: { rpc } as never, holderUserId: 'buyer-1', items })).toEqual(items);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('the copies of a creation now off public view', () => {
  function client(rows: Array<{ id: string; archived_at: string | null; moderation_removed_at: string | null }> | Error, passedOnWithheld: string[] = []) {
    const rpc = vi.fn(async (name: string, args: { p_paths: string[] }) => {
      if (name !== 'recipe_copies_withheld') throw new Error(`Unexpected rpc: ${name}`);
      return rows instanceof Error
        ? { data: null, error: rows }
        : { data: recipeCopiesWithheldOver(rows, passedOnWithheld)(args.p_paths), error: null };
    });
    return { rpc, supabase: { rpc } as never };
  }

  it('names a copy’s creation from its path, with or without the bucket', () => {
    expect(recipeCopyCreationId(COPY)).toBe(CREATION);
    expect(recipeCopyCreationId(COPY_PATH)).toBe(CREATION);
    expect(recipeCopyCreationId(`${SELLER}/notes/guide.png`)).toBeNull();
  });

  it('asks the database which copies are withheld, as given, and only of copies', async () => {
    const { supabase, rpc } = client([
      { id: CREATION, archived_at: '2026-11-04T00:00:00.000Z', moderation_removed_at: null },
      { id: OTHER_CREATION, archived_at: null, moderation_removed_at: null },
    ]);
    const deleted = '44444444-4444-4444-8444-444444444444';
    const other = `${SELLER}/generation-references/${OTHER_CREATION}/a.png`;
    const ofDeleted = `${SELLER}/generation-references/${deleted}/a.png`;

    expect(await loadWithheldCopies(supabase, [COPY, other, ofDeleted, `${SELLER}/notes/guide.png`, null]))
      .toEqual(new Set([COPY]));
    expect(rpc).toHaveBeenCalledWith('recipe_copies_withheld', { p_paths: [COPY, other, ofDeleted] });
  });

  // Remix plan, phase 1b: a copy a remix's recipe passed on is withheld with what it came from, which
  // only the database knows; its creation may be on view.
  it('withholds a passed-on copy the database closes, and no other copy of its creation', async () => {
    const passedOn = `${SELLER}/generation-references/${OTHER_CREATION}/00-reference-image-row-2.png`;
    const own = `${SELLER}/generation-references/${OTHER_CREATION}/01-reference-image-row-3.png`;
    const { supabase } = client([{ id: OTHER_CREATION, archived_at: null, moderation_removed_at: null }], [passedOn]);
    const current = { items: [{ storagePath: passedOn }, { storagePath: own }] };

    await withholdCopiesOfCreationsOffView(supabase, [current]);

    expect(current.items).toEqual([{ storagePath: own }]);
  });

  it('throws when the database cannot answer, so no caller takes it for leave to serve', async () => {
    await expect(loadWithheldCopies(client(new Error('statement timeout')).supabase, [COPY])).rejects.toThrow('statement timeout');
  });

  it('takes those copies out of a recipe and the version bought, leaving every other item', async () => {
    const { supabase } = client([{ id: CREATION, archived_at: null, moderation_removed_at: '2026-11-04T00:00:00.000Z' }]);
    const current = { items: [{ storagePath: COPY_PATH }, { storagePath: `${SELLER}/notes/guide.png` }, { storagePath: null }] };
    const bought = { items: [{ storagePath: COPY_PATH }] };

    await withholdCopiesOfCreationsOffView(supabase, [current, bought, null]);

    expect(current.items).toEqual([{ storagePath: `${SELLER}/notes/guide.png` }, { storagePath: null }]);
    expect(bought.items).toEqual([]);
  });

  // 2026-11-04 review: both file routes sign a recipe's attachments as well as its items.
  it('takes them out of a recipe’s attachments too', async () => {
    const { supabase } = client([{ id: CREATION, archived_at: '2026-11-04T00:00:00.000Z', moderation_removed_at: null }]);
    const legacy = { items: [], attachments: [{ storagePath: COPY_PATH }, { storagePath: `${SELLER}/notes/guide.png` }] };

    await withholdCopiesOfCreationsOffView(supabase, [legacy]);

    expect(legacy.attachments).toEqual([{ storagePath: `${SELLER}/notes/guide.png` }]);
  });

  it('withholds every copy when the creations cannot be read, and reads nothing for a recipe without copies', async () => {
    const failing = client(new Error('statement timeout'));
    const current = { items: [{ storagePath: COPY_PATH }, { storagePath: `${SELLER}/notes/guide.png` }] };
    await withholdCopiesOfCreationsOffView(failing.supabase, [current]);
    expect(current.items).toEqual([{ storagePath: `${SELLER}/notes/guide.png` }]);

    const none = client([]);
    await withholdCopiesOfCreationsOffView(none.supabase, [{ items: [{ storagePath: `${SELLER}/notes/guide.png` }] }]);
    expect(none.rpc).not.toHaveBeenCalled();
  });
});
