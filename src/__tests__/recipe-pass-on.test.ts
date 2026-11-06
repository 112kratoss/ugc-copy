import { describe, expect, it, vi } from 'vitest';

import { createStoredRows, databaseError } from '@/__tests__/fixtures/stored-rows';
import { passesOnRecipeFile } from '@/lib/generation-input-origin';
import { isRecipeCopyableInputRow } from '@/lib/generation-input-media';
import {
  loadRecipePassOnFolder,
  loadRecipePassOnFolders,
  recipePassOnFolder,
  recordRecipeCopySource,
} from '@/lib/recipe-pass-on';

// Remix plan, phase 1b (owner, 2026-11-05: a remix's recipe holds what its run used): B's recipe
// takes the files that came through the recipe B's run remixed, matched by that recipe's copies'
// folder, and no file of any other recipe.

const A = '11111111-1111-4111-8111-111111111111';
const B = 'b0000000-0000-4000-8000-000000000001';
const A_CREATION = '22222222-2222-4222-8222-222222222222';
const Z_CREATION = '33333333-3333-4333-8333-333333333333';
const FOLDER = `post_resource_files/${A}/generation-references/${A_CREATION}/`;
const FROM_A = `${FOLDER}00-reference-image-row-a.png`;
const FROM_Z = `post_resource_files/${A}/generation-references/${Z_CREATION}/00-reference-image-row-z.png`;
const IMPORT_OF_A = `generation_inputs/${B}/recipe-imports/${A}/${A_CREATION}/01-reference-image-row-c.png`;
const own = new Set([B]);

describe('which of a run’s recipe files pass on', () => {
  it('names a recipe’s copies’ folder in the recipe files, with its trailing slash', () => {
    expect(recipePassOnFolder(A, A_CREATION)).toBe(FOLDER);
  });

  it('passes on a file recorded from the remixed recipe’s folder, or named by its import', () => {
    expect(passesOnRecipeFile({ metadata: { sourceKind: 'recipe-file', recipeFile: FROM_A } }, own, FOLDER)).toBe(true);
    expect(passesOnRecipeFile({ metadata: { sourceStoragePath: IMPORT_OF_A } }, own, FOLDER)).toBe(true);
  });

  it('passes on no file of another recipe, the same seller’s included, and none without a folder', () => {
    expect(passesOnRecipeFile({ metadata: { sourceKind: 'recipe-file', recipeFile: FROM_Z } }, own, FOLDER)).toBe(false);
    expect(passesOnRecipeFile({ metadata: { sourceKind: 'recipe-file', recipeFile: FROM_A } }, own, null)).toBe(false);
    // A file marked as a recipe file whose file is on no record.
    expect(passesOnRecipeFile({ metadata: { sourceKind: 'recipe-file' } }, own, FOLDER)).toBe(false);
    // A seller's upload in that recipe is no copy of its creation's inputs.
    expect(passesOnRecipeFile({ metadata: { sourceStoragePath: `post_resource_files/${A}/notes/guide.png` } }, own, FOLDER)).toBe(false);
  });

  it('is asked of recipe files only: an input of the creator’s own is no file passed on', () => {
    expect(passesOnRecipeFile({ metadata: { sourceStoragePath: `uploads/${B}/mine.png` } }, own, FOLDER)).toBe(false);
  });

  it('lets the copyable rule take a passed-on file, and nothing else it refused before', () => {
    const row = (metadata: Record<string, unknown>) => ({
      user_id: B,
      storage_path: `generation_inputs/${B}/gen-b/00-reference-image.png`,
      metadata,
    });
    expect(isRecipeCopyableInputRow(row({ sourceKind: 'recipe-file', recipeFile: FROM_A }), [B], FOLDER)).toBe(true);
    expect(isRecipeCopyableInputRow(row({ sourceKind: 'recipe-file', recipeFile: FROM_A }), [B])).toBe(false);
    expect(isRecipeCopyableInputRow(row({ sourceKind: 'recipe-file', recipeFile: FROM_Z }), [B], FOLDER)).toBe(false);
    expect(isRecipeCopyableInputRow(row({}), [B], FOLDER)).toBe(true);
    // Still only a row of the publisher's set, in its own folder.
    expect(isRecipeCopyableInputRow({ ...row({ sourceKind: 'recipe-file', recipeFile: FROM_A }), user_id: 'stranger' }, [B], FOLDER)).toBe(false);
  });
});

describe('the folder a run passes on from', () => {
  const tables = (overrides: Record<string, unknown> = {}) => ({
    generations: [
      { id: 'gen-b', remix_recipe_bundle_id: 'bundle-a' },
      { id: 'gen-plain', remix_recipe_bundle_id: null },
    ],
    post_resource_bundles: [{ id: 'bundle-a', owner_user_id: A, post_id: 'post-a' }],
    posts: [{ id: 'post-a', generation_id: A_CREATION, deleted_generation_id: null }],
    ...overrides,
  });

  it('reads the remixed recipe’s owner and its post’s creation, for each run that remixed one', async () => {
    const stored = createStoredRows(tables() as never);
    const folders = await loadRecipePassOnFolders(stored.client, [
      { id: 'gen-b', remixRecipeBundleId: 'bundle-a' },
      { id: 'gen-b2', remixRecipeBundleId: 'bundle-a' },
      { id: 'gen-plain', remixRecipeBundleId: null },
    ]);

    expect(folders).toEqual(new Map([['gen-b', FOLDER], ['gen-b2', FOLDER]]));
    expect(stored.reads.map((read) => read.table)).toEqual(['post_resource_bundles', 'posts']);
  });

  it('keeps the folder of a post whose creation was deleted, whose copies keep it', async () => {
    const stored = createStoredRows(tables({ posts: [{ id: 'post-a', generation_id: null, deleted_generation_id: A_CREATION }] }) as never);
    expect(await loadRecipePassOnFolder(stored.client, 'gen-b')).toBe(FOLDER);
  });

  it('answers none for a run that remixed no recipe, or one whose recipe is gone, reading nothing more', async () => {
    const stored = createStoredRows(tables({ post_resource_bundles: [{ id: 'other', owner_user_id: A, post_id: 'post-a' }] }) as never);
    expect(await loadRecipePassOnFolder(stored.client, 'gen-plain')).toBeNull();
    expect(stored.reads.map((read) => read.table)).toEqual(['generations']);
    expect(await loadRecipePassOnFolder(stored.client, 'gen-b')).toBeNull();
  });

  it('throws when a read fails, never taking it for “nothing to pass on”', async () => {
    const stored = createStoredRows(tables({ post_resource_bundles: databaseError('57014', 'canceling statement due to statement timeout') }) as never);
    await expect(loadRecipePassOnFolder(stored.client, 'gen-b')).rejects.toMatchObject({ code: '57014' });
  });
});

describe('recording where a passed-on copy came from', () => {
  function client(error: { message: string } | null) {
    const upsert = vi.fn(async () => ({ error }));
    return { upsert, supabase: { from: vi.fn(() => ({ upsert })) } as never };
  }

  it('writes the copy bucket-qualified, once, beside the file it stands for and its holder', async () => {
    const { upsert, supabase } = client(null);
    expect(await recordRecipeCopySource(supabase, {
      copyPath: `${B}/generation-references/gen-b/00-reference-image-row-1.png`,
      sourceFile: FROM_A,
      holderUserId: B,
    })).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      { copy_path: `post_resource_files/${B}/generation-references/gen-b/00-reference-image-row-1.png`, source_file: FROM_A, holder_user_id: B },
      { onConflict: 'copy_path', ignoreDuplicates: true },
    );
  });

  it('answers false when the write fails, so the copy is not made', async () => {
    expect(await recordRecipeCopySource(client({ message: 'permission denied' }).supabase, {
      copyPath: `post_resource_files/${B}/generation-references/gen-b/00-reference-image-row-1.png`,
      sourceFile: FROM_A,
      holderUserId: B,
    })).toBe(false);
  });
});
