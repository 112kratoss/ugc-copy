import { describe, expect, it, vi } from 'vitest';

import { heldRecipeFileOf } from '@/lib/generation-input-origin';
import {
  loadWithheldCopyCreations,
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
  function client(rows: Array<{ id: string; archived_at: string | null; moderation_removed_at: string | null }> | Error) {
    const inFilter = vi.fn(async (_column: string, ids: string[]) => (
      rows instanceof Error ? { data: null, error: rows } : { data: rows.filter((row) => ids.includes(row.id)), error: null }
    ));
    return { inFilter, supabase: { from: vi.fn(() => ({ select: () => ({ in: inFilter }) })) } as never };
  }

  it('names a copy’s creation from its path, with or without the bucket', () => {
    expect(recipeCopyCreationId(COPY)).toBe(CREATION);
    expect(recipeCopyCreationId(COPY_PATH)).toBe(CREATION);
    expect(recipeCopyCreationId(`${SELLER}/notes/guide.png`)).toBeNull();
  });

  it('finds the removed or archived creations, never one deleted outright', async () => {
    const { supabase } = client([
      { id: CREATION, archived_at: '2026-11-04T00:00:00.000Z', moderation_removed_at: null },
      { id: OTHER_CREATION, archived_at: null, moderation_removed_at: null },
    ]);
    const deleted = '44444444-4444-4444-8444-444444444444';

    expect(await loadWithheldCopyCreations(supabase, [COPY, `${SELLER}/generation-references/${OTHER_CREATION}/a.png`, `${SELLER}/generation-references/${deleted}/a.png`]))
      .toEqual(new Set([CREATION]));
  });

  it('takes those copies out of a recipe and the version bought, leaving every other item', async () => {
    const { supabase } = client([{ id: CREATION, archived_at: null, moderation_removed_at: '2026-11-04T00:00:00.000Z' }]);
    const current = { items: [{ storagePath: COPY_PATH }, { storagePath: `${SELLER}/notes/guide.png` }, { storagePath: null }] };
    const bought = { items: [{ storagePath: COPY_PATH }] };

    await withholdCopiesOfCreationsOffView(supabase, [current, bought, null]);

    expect(current.items).toEqual([{ storagePath: `${SELLER}/notes/guide.png` }, { storagePath: null }]);
    expect(bought.items).toEqual([]);
  });

  it('withholds every copy when the creations cannot be read, and reads nothing for a recipe without copies', async () => {
    const failing = client(new Error('statement timeout'));
    const current = { items: [{ storagePath: COPY_PATH }, { storagePath: `${SELLER}/notes/guide.png` }] };
    await withholdCopiesOfCreationsOffView(failing.supabase, [current]);
    expect(current.items).toEqual([{ storagePath: `${SELLER}/notes/guide.png` }]);

    const none = client([]);
    await withholdCopiesOfCreationsOffView(none.supabase, [{ items: [{ storagePath: `${SELLER}/notes/guide.png` }] }]);
    expect(none.inFilter).not.toHaveBeenCalled();
  });
});
