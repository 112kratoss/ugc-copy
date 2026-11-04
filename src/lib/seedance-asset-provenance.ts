import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';
import {
  checkRecipeCopyReuse,
  findHeldRecipeCopy,
  type RecipeCopyReads,
} from '@/lib/generation-reference-copy-import';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * Who prepared each Seedance asset, and from what (owner, 2026-11-04;
 * `public.seedance_prepared_assets`, 20261103232019). An asset id is a bearer handle at the provider:
 * whoever sends it runs the file it was prepared from, and the server keeps no other record of that
 * file. So the asset route records every asset it prepares, and a Seedance start asks here of every
 * asset id it sends, bare or in a file's place:
 *
 * - prepared from a file of the preparer's own: usable by anyone, as before (a creator's shared
 *   inputs hand their asset ids to remixers, owner 2026-10-29);
 * - prepared from a recipe file: only by its preparer, and only while the copy is theirs to reuse
 *   now (`checkRecipeCopyReuse`: the remix gate, the version they bought holding it, its creation
 *   neither removed nor archived). A refund, a block or an archive ends it; nobody else ever runs it;
 * - prepared before the table existed: the migration recorded every id a run had used, under the first
 *   account that ran it. An id still on no record (prepared and kept in a draft or a workflow, never
 *   run) is recorded by the first start that sends it beside its file, as that file reads for the
 *   caller then. The file is the caller's word, so such a record (`recorded_from: 'start'`) lends the
 *   asset to its recorder alone, whatever it says of the file, and every use of it is still logged
 *   (`seedance_asset_unrecorded`). One sent bare, with no file beside it, is let through and logged
 *   until `UNRECORDED_SEEDANCE_ASSETS_ACCEPTED_UNTIL`, and refused after: refusing those at once would
 *   break every draft and saved workflow holding an asset prepared before this shipped, for the narrow
 *   case of a recipe file prepared then and never run since (2026-11-04 review).
 */

/**
 * The last moment a start lets through a Seedance asset id the server has no record of, sent bare.
 * A month after the records began (20261103232019): long enough for a draft or a workflow holding one
 * to be run, and so recorded, or prepared again. After it, such an id is refused.
 */
export const UNRECORDED_SEEDANCE_ASSETS_ACCEPTED_UNTIL = new Date('2026-12-04T00:00:00.000Z');

export const SEEDANCE_ASSET_UNRECORDED_MESSAGE =
  'A prepared file in this run needs preparing again. Remove it, add it again and try again.';

export type SeedanceAssetRecordSource = 'prepare' | 'start';

type PreparedAssetRow = {
  asset_id: string;
  owner_user_id: string;
  recipe_file: string | null;
  recorded_from: string;
};

export type SeedanceAssetUse =
  | { ok: true }
  | { ok: false; status: 400 | 500; message: string };

export const SEEDANCE_ASSET_NOT_YOURS_MESSAGE =
  'A prepared file in this run comes from a recipe you can no longer use. Remove it and try again.';
const SEEDANCE_ASSET_CHECK_FAILED_MESSAGE = 'We could not check the prepared files in this run. Please try again.';

export interface SeedanceAssetProvenanceDependencies {
  createServiceClient?: typeof createServiceClient;
  checkRecipeCopyReuse?: typeof checkRecipeCopyReuse;
  findHeldRecipeCopy?: typeof findHeldRecipeCopy;
  now?: () => Date;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === '23505');
}

/**
 * Records an asset prepared from `source` by `ownerUserId`: `recipeFile` is the recipe copy the file
 * stands for (`post_resource_files/…`), `''` for a recipe file whose copy is on no record, null for the
 * owner's own file. True when the record exists afterwards, a second record of the same id included.
 */
export async function recordPreparedSeedanceAsset(params: {
  adminSupabase: SupabaseClient;
  assetId: string;
  ownerUserId: string;
  source: string;
  recipeFile: string | null;
  recordedFrom: SeedanceAssetRecordSource;
}): Promise<boolean> {
  const { error } = await params.adminSupabase
    .from('seedance_prepared_assets')
    .insert({
      asset_id: params.assetId,
      owner_user_id: params.ownerUserId,
      source: params.source,
      recipe_file: params.recipeFile,
      recorded_from: params.recordedFrom,
    });
  if (!error || isUniqueViolation(error)) return true;
  logBackendError('seedance_asset_record_failed', { error });
  return false;
}

/**
 * The recipe file a source the caller holds stands for, as a start records it: the copy
 * (`findHeldRecipeCopy`), `''` for a recipe file whose copy is on no record, null for one of the
 * caller's own. `failed` when a run's kept input cannot be read: never recorded as their own.
 */
export async function recipeFileOfPreparedSource(params: {
  source: string;
  viewerUserId: string;
  dependencies?: SeedanceAssetProvenanceDependencies;
}): Promise<{ recipeFile: string | null } | 'failed'> {
  const held = await (params.dependencies?.findHeldRecipeCopy ?? findHeldRecipeCopy)({
    source: params.source,
    viewerUserId: params.viewerUserId,
  });
  if (!held) return { recipeFile: null };
  if (held.outcome === 'failed') return 'failed';
  return { recipeFile: held.outcome === 'copy' ? held.copySource : '' };
}

/**
 * Whether the caller may send these Seedance asset ids in a run now. `pairedSources` names the file
 * each id was sent in place of, where the start was given one (`seedanceAssets`).
 */
export async function checkSeedanceAssetsUsable(params: {
  viewerUserId: string;
  assetIds: Iterable<string>;
  pairedSources?: ReadonlyMap<string, string>;
  reads?: RecipeCopyReads;
  dependencies?: SeedanceAssetProvenanceDependencies;
}): Promise<SeedanceAssetUse> {
  const assetIds = [...new Set([...params.assetIds].filter(Boolean))];
  if (assetIds.length === 0) return { ok: true };
  const adminSupabase = (params.dependencies?.createServiceClient ?? createServiceClient)();

  const { data, error } = await adminSupabase
    .from('seedance_prepared_assets')
    .select('asset_id, owner_user_id, recipe_file, recorded_from')
    .in('asset_id', assetIds);
  if (error) {
    logBackendError('seedance_asset_records_read_failed', { error });
    return { ok: false, status: 500, message: SEEDANCE_ASSET_CHECK_FAILED_MESSAGE };
  }
  const records = new Map(((data ?? []) as PreparedAssetRow[]).map((row) => [row.asset_id, row]));

  for (const assetId of assetIds) {
    let record = records.get(assetId) ?? null;
    if (!record) {
      const source = params.pairedSources?.get(assetId);
      if (!source) {
        logBackendWarning('seedance_asset_unrecorded', { assetId, bare: true });
        if ((params.dependencies?.now ?? (() => new Date()))() > UNRECORDED_SEEDANCE_ASSETS_ACCEPTED_UNTIL) {
          return { ok: false, status: 400, message: SEEDANCE_ASSET_UNRECORDED_MESSAGE };
        }
        continue;
      }
      // Prepared before the table: recorded as the file it was sent beside reads for the caller now.
      const held = await recipeFileOfPreparedSource({
        source,
        viewerUserId: params.viewerUserId,
        dependencies: params.dependencies,
      });
      if (held === 'failed') {
        return { ok: false, status: 500, message: SEEDANCE_ASSET_CHECK_FAILED_MESSAGE };
      }
      await recordPreparedSeedanceAsset({
        adminSupabase,
        assetId,
        ownerUserId: params.viewerUserId,
        source,
        recipeFile: held.recipeFile,
        recordedFrom: 'start',
      });
      record = { asset_id: assetId, owner_user_id: params.viewerUserId, recipe_file: held.recipeFile, recorded_from: 'start' };
    }

    // A start's record rests on the file its caller paired the id with: it lends the asset to that
    // caller alone, and stays measured.
    if (record.recorded_from === 'start') {
      logBackendWarning('seedance_asset_unrecorded', { assetId, recordedAtStart: true });
      if (record.owner_user_id !== params.viewerUserId) {
        return { ok: false, status: 400, message: SEEDANCE_ASSET_NOT_YOURS_MESSAGE };
      }
    }
    if (record.recipe_file === null) continue;
    if (record.owner_user_id !== params.viewerUserId || record.recipe_file === '') {
      return { ok: false, status: 400, message: SEEDANCE_ASSET_NOT_YOURS_MESSAGE };
    }
    const reuse = await (params.dependencies?.checkRecipeCopyReuse ?? checkRecipeCopyReuse)({
      source: record.recipe_file,
      viewerUserId: params.viewerUserId,
      reads: params.reads,
    });
    if (reuse.outcome === 'failed') {
      return { ok: false, status: 500, message: SEEDANCE_ASSET_CHECK_FAILED_MESSAGE };
    }
    if (reuse.outcome !== 'entitled') {
      return { ok: false, status: 400, message: SEEDANCE_ASSET_NOT_YOURS_MESSAGE };
    }
  }
  return { ok: true };
}
