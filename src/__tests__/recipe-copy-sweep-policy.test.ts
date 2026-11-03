import { describe, expect, it } from 'vitest';

import {
  isRecipeCopySweepDeletionEnabled,
  planRecipeFileSweep,
  RECIPE_COPY_SWEEP_BATCH_LIMIT,
  RECIPE_COPY_SWEEP_GRACE_MS,
  recipeFileKind,
  recipeImportSourceCopy,
} from '@/lib/recipe-copy-sweep-policy';

const PUBLISHER = '11111111-1111-4111-8111-111111111111';
const BUYER = '22222222-2222-4222-8222-222222222222';
const CREATION = '33333333-3333-4333-8333-333333333333';
const ROW = '44444444-4444-4444-8444-444444444444';
const NOW = Date.parse('2026-11-04T06:50:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const copyName = (file = `00-reference-${ROW}.png`) => `${PUBLISHER}/generation-references/${CREATION}/${file}`;
const importName = (file = `00-reference-${ROW}.png`) => `${BUYER}/recipe-imports/${PUBLISHER}/${CREATION}/${file}`;
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

describe('the recipe copy sweep rule', () => {
  it('knows a copy and an import only in their own bucket and exact folder', () => {
    expect(recipeFileKind('post_resource_files', copyName())).toBe('copy');
    expect(recipeFileKind('generation_inputs', importName())).toBe('import');

    // The creator's own uploads, beside the copies.
    expect(recipeFileKind('post_resource_files', `${PUBLISHER}/upload-1-photo.png`)).toBeNull();
    // A file deeper in the folder, or the folder itself.
    expect(recipeFileKind('post_resource_files', `${copyName()}/extra.png`)).toBeNull();
    expect(recipeFileKind('post_resource_files', `${PUBLISHER}/generation-references/${CREATION}`)).toBeNull();
    // The right folder in the wrong bucket, either way round.
    expect(recipeFileKind('generation_inputs', copyName())).toBeNull();
    expect(recipeFileKind('post_resource_files', importName())).toBeNull();
    // A kept input and the shared import's folder are never touched.
    expect(recipeFileKind('generation_inputs', `${BUYER}/${CREATION}/00-reference.png`)).toBeNull();
    expect(recipeFileKind('generation_inputs', `${BUYER}/remix-imports/${PUBLISHER}/${CREATION}/a.png`)).toBeNull();
    // Storage's folder placeholders.
    expect(recipeFileKind('post_resource_files', copyName('.emptyFolderPlaceholder'))).toBeNull();
    expect(recipeFileKind('showcase_media', copyName())).toBeNull();
  });

  it('maps an import back to the copy it was made from', () => {
    expect(recipeImportSourceCopy(importName())).toBe(copyName());
    expect(recipeImportSourceCopy(copyName())).toBeNull();
  });

  it('removes only what is older than the seven-day grace period', () => {
    const plan = planRecipeFileSweep([
      { bucketId: 'post_resource_files', name: copyName('00-a.png'), createdAt: at(8 * DAY) },
      { bucketId: 'post_resource_files', name: copyName('01-b.png'), createdAt: at(7 * DAY + 1) },
      // Exactly at the boundary, and inside it: kept.
      { bucketId: 'post_resource_files', name: copyName('02-c.png'), createdAt: at(7 * DAY) },
      { bucketId: 'post_resource_files', name: copyName('03-d.png'), createdAt: at(DAY) },
      { bucketId: 'generation_inputs', name: importName(), createdAt: at(30 * DAY) },
    ], { nowMs: NOW });

    expect(RECIPE_COPY_SWEEP_GRACE_MS).toBe(7 * DAY);
    expect(plan.deletions).toEqual([
      { bucketId: 'post_resource_files', name: copyName('00-a.png'), kind: 'copy' },
      { bucketId: 'post_resource_files', name: copyName('01-b.png'), kind: 'copy' },
      { bucketId: 'generation_inputs', name: importName(), kind: 'import' },
    ]);
    expect(plan.refused).toBe(2);
  });

  it('never takes a shorter grace period than seven days, whatever it is asked', () => {
    const plan = planRecipeFileSweep(
      [{ bucketId: 'post_resource_files', name: copyName(), createdAt: at(2 * DAY) }],
      { nowMs: NOW, graceMs: DAY },
    );

    expect(plan.deletions).toEqual([]);
    expect(plan.refused).toBe(1);
  });

  it('refuses whatever a read hands back outside the rule', () => {
    const plan = planRecipeFileSweep([
      { bucketId: 'post_resource_files', name: `${PUBLISHER}/upload-1.png`, createdAt: at(30 * DAY) },
      { bucketId: 'post_resource_files', name: copyName(), createdAt: null },
      { bucketId: 'post_resource_files', name: copyName(), createdAt: 'not a date' },
      { bucketId: 'post_resource_files', createdAt: at(30 * DAY) },
      { name: copyName(), createdAt: at(30 * DAY) },
      null,
      'post_resource_files/x',
      { bucketId: 'post_resource_files', name: copyName(), createdAt: at(30 * DAY) },
      // The same object twice is removed once.
      { bucketId: 'post_resource_files', name: copyName(), createdAt: at(30 * DAY) },
    ], { nowMs: NOW });

    expect(plan.deletions).toEqual([{ bucketId: 'post_resource_files', name: copyName(), kind: 'copy' }]);
    expect(plan.refused).toBe(8);
    expect(planRecipeFileSweep(null, { nowMs: NOW })).toEqual({ deletions: [], refused: 0, deferred: 0 });
    expect(planRecipeFileSweep({ candidates: [] }, { nowMs: NOW })).toEqual({ deletions: [], refused: 0, deferred: 0 });
  });

  it('bounds a run to its batch, oldest first as read, and leaves the rest for later', () => {
    const candidates = Array.from({ length: RECIPE_COPY_SWEEP_BATCH_LIMIT + 25 }, (_, index) => ({
      bucketId: 'post_resource_files',
      name: copyName(`${String(index).padStart(3, '0')}-reference.png`),
      createdAt: at(30 * DAY - index),
    }));

    const plan = planRecipeFileSweep(candidates, { nowMs: NOW });
    expect(plan.deletions).toHaveLength(RECIPE_COPY_SWEEP_BATCH_LIMIT);
    expect(plan.deletions[0]?.name).toBe(copyName('000-reference.png'));
    expect(plan.deferred).toBe(25);

    // A smaller limit is kept to; a larger one is held to the batch.
    expect(planRecipeFileSweep(candidates, { nowMs: NOW, limit: 3 }).deletions).toHaveLength(3);
    expect(planRecipeFileSweep(candidates, { nowMs: NOW, limit: 10_000 }).deletions).toHaveLength(RECIPE_COPY_SWEEP_BATCH_LIMIT);
  });

  it('removes nothing unless the operator turned removal on with the one accepted value', () => {
    expect(isRecipeCopySweepDeletionEnabled({})).toBe(false);
    expect(isRecipeCopySweepDeletionEnabled({ RECIPE_COPY_SWEEP_DELETE: '1' })).toBe(false);
    expect(isRecipeCopySweepDeletionEnabled({ RECIPE_COPY_SWEEP_DELETE: 'TRUE' })).toBe(false);
    expect(isRecipeCopySweepDeletionEnabled({ RECIPE_COPY_SWEEP_DELETE: 'true' })).toBe(true);
  });
});
