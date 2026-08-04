import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import { listProtectedUploadPaths } from '@/lib/generation-input-media-repair';
import { MEDIA_UPLOAD_INTENTS_TABLE } from '@/lib/media-upload-intents';
import {
  RECLAIM_AFTER_HOURS,
  resolveUploadIntentReclaim,
  type UnclearedUploadIntent,
  type UploadIntentConsumer,
} from '@/lib/media-upload-reclaim';
import { getMediaUploadReclaimPolicy } from '@/lib/media-upload-reclaim-policy';

const UPLOADS_BUCKET = 'uploads';

/**
 * Bounded like the other retention sweeps: a backlog drains over subsequent
 * daily runs rather than needing one long pass. Storage deletes are batched, so
 * this is a handful of requests even at the cap.
 */
export const RECLAIM_BATCH_SIZE = 500;

/**
 * Never-consumed intents are withheld until this is explicitly enabled.
 *
 * Those rows are the abandoned-composer case, and mobile builds that predate
 * the verify-on-resume fix restore a draft without checking whether its staged
 * objects still exist -- so reclaiming one makes that draft fail at publish with
 * no recovery path. No upload-age TTL avoids this: those builds refresh a
 * draft's expiry every time the composer is opened, so a draft can outlive its
 * media indefinitely.
 *
 * Generation-consumed intents have no such coupling -- the bytes were already
 * copied into generation_inputs -- so they are collected from day one, which is
 * the larger of the two leaks anyway.
 *
 * Set the flag once the mobile fix has reached the installed base. The policy
 * helper also requires the code-controlled minimum app version to prove old
 * clients are excluded before this can become effective.
 */
export function isAbandonedIntentReclaimEnabled(
  environment: Record<string, string | undefined> = process.env,
  minimumAppVersion?: string,
): boolean {
  return getMediaUploadReclaimPolicy({ environment, minimumAppVersion }).effectiveEnabled;
}

type IntentRow = {
  id: string;
  storage_path: string;
  kind: UnclearedUploadIntent['kind'];
  declared_bytes: number | null;
  created_at: string;
  consumed_by: UploadIntentConsumer | null;
};

export type ReclaimSummary = {
  abandonedReclaimEnabled: boolean;
  scanned: number;
  reclaimed: number;
  rowsDropped: number;
  kept: number;
  bytesReclaimed: number;
  /**
   * Staged objects withheld because a generation with no durable input media
   * still reads them. Expected to fall toward zero as repair drains the backlog;
   * a number that stops falling means repair is stuck on something.
   */
  protectedLegacyReferences: number;
};

function toUnclearedIntent(row: IntentRow, objectExists: boolean): UnclearedUploadIntent {
  return {
    storagePath: row.storage_path,
    kind: row.kind,
    declaredBytes: row.declared_bytes,
    createdAt: row.created_at,
    consumedBy: row.consumed_by,
    objectExists,
  };
}

/**
 * Load the intents this run is allowed to consider.
 *
 * The rollout gate lives here rather than in the policy so the policy stays a
 * pure function of one intent, and so an operator flipping the flag changes
 * which rows are offered rather than what "abandoned" means.
 */
export async function selectReclaimableIntents(
  client: SupabaseClient,
  options: { now?: Date; includeAbandoned?: boolean; limit?: number } = {},
): Promise<IntentRow[]> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - RECLAIM_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const includeAbandoned = options.includeAbandoned ?? isAbandonedIntentReclaimEnabled();

  let query = client
    .from(MEDIA_UPLOAD_INTENTS_TABLE)
    .select('id, storage_path, kind, declared_bytes, created_at, consumed_by')
    .is('storage_cleared_at', null)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(options.limit ?? RECLAIM_BATCH_SIZE);

  if (!includeAbandoned) {
    query = query.not('consumed_by', 'is', null);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message ?? 'Failed to load reclaimable media upload intents.');
  }

  return (data ?? []) as IntentRow[];
}

export async function hasReclaimableMediaUploads(
  client: SupabaseClient,
  options: { includeAbandoned?: boolean } = {},
): Promise<boolean> {
  const rows = await selectReclaimableIntents(client, { ...options, limit: 1 });
  return rows.length > 0;
}

/**
 * Delete staged objects nothing needs any more, and close out their rows.
 *
 * Storage is deleted before the row is marked, never after: a delete that
 * succeeds without its row update is retried harmlessly next run, while a row
 * marked before a failed delete would strand the bytes permanently.
 *
 * Generations whose durable input media never persisted still read their staged
 * files, so those paths are withheld. The protection is path-based rather than
 * consumption-based on purpose: a repair that persists and then rolls back
 * leaves an intent marked consumed while its generation is legacy-only again,
 * and the consumed half of this sweep runs from day one.
 */
export async function reclaimAbandonedMediaUploads(
  client: SupabaseClient,
  options: {
    now?: Date;
    includeAbandoned?: boolean;
    protectedPaths?: Set<string> | null;
  } = {},
): Promise<ReclaimSummary> {
  const now = options.now ?? new Date();
  // Caller intent may narrow the destructive scope, but it must never widen
  // it past the code-controlled rollout interlock. Keeping this check at the
  // delete boundary prevents a future route, script, or refactor from turning
  // `includeAbandoned: true` into a bypass while old mobile builds are allowed.
  const abandonedReclaimEnabled = isAbandonedIntentReclaimEnabled()
    && options.includeAbandoned !== false;
  const rows = await selectReclaimableIntents(client, {
    ...options,
    includeAbandoned: abandonedReclaimEnabled,
  });
  const summary: ReclaimSummary = {
    abandonedReclaimEnabled,
    scanned: rows.length,
    reclaimed: 0,
    rowsDropped: 0,
    kept: 0,
    bytesReclaimed: 0,
    protectedLegacyReferences: 0,
  };

  if (rows.length === 0) {
    return summary;
  }

  const protectedPaths = options.protectedPaths !== undefined
    ? options.protectedPaths
    : await listProtectedUploadPaths(client, { now });

  if (protectedPaths === null) {
    // The protected set could not be proven. Deleting on an unproven answer is
    // the one outcome with no recovery, so this run reclaims nothing.
    logBackendWarning('media_upload_reclaim_skipped_unverifiable_legacy_refs', {
      scanned: rows.length,
    });
    summary.kept = rows.length;
    return summary;
  }

  const existingPaths = await listExistingObjectPaths(client, rows);
  const toReclaim: IntentRow[] = [];
  const toDropRow: IntentRow[] = [];

  for (const row of rows) {
    const intent = toUnclearedIntent(row, existingPaths.has(row.storage_path));
    const decision = resolveUploadIntentReclaim(intent, now);

    if (decision.action === 'reclaim') {
      if (protectedPaths.has(row.storage_path)) {
        summary.protectedLegacyReferences += 1;
        continue;
      }

      toReclaim.push(row);
      summary.bytesReclaimed += row.declared_bytes ?? 0;
    } else if (decision.action === 'drop-row') {
      // No object was ever written, so there is nothing to protect -- the row is
      // garbage whether or not a generation names the path.
      toDropRow.push(row);
    } else {
      summary.kept += 1;
    }
  }

  if (toReclaim.length > 0) {
    const { data, error } = await client.storage
      .from(UPLOADS_BUCKET)
      .remove(toReclaim.map((row) => row.storage_path));

    if (error) {
      // Leave the rows uncleared so the next run retries them.
      logBackendWarning('failed_to_remove_reclaimed_media_uploads', {
        error,
        count: toReclaim.length,
      });
      summary.bytesReclaimed = 0;
    } else {
      // Storage reports per-path outcomes in `data`, not `error`: a batch can
      // partially fail with error null. Clearing every row on that would orphan
      // the survivors, since nothing else ever looks at this bucket.
      const removedPaths = new Set(
        ((data ?? []) as Array<{ name?: string }>)
          .map((object) => object?.name)
          .filter((name): name is string => Boolean(name)),
      );
      const confirmed = removedPaths.size > 0
        ? toReclaim.filter((row) => removedPaths.has(row.storage_path))
        : toReclaim;

      if (confirmed.length < toReclaim.length) {
        logBackendWarning('partially_removed_reclaimed_media_uploads', {
          requested: toReclaim.length,
          removed: confirmed.length,
        });
      }

      await markCleared(client, confirmed.map((row) => row.id));
      summary.reclaimed = confirmed.length;
      summary.bytesReclaimed = confirmed.reduce((total, row) => total + (row.declared_bytes ?? 0), 0);
    }
  }

  if (toDropRow.length > 0) {
    // Nothing was ever written, so there is no object to delete -- the row is
    // all that is left of an upload the client never performed.
    await markCleared(client, toDropRow.map((row) => row.id));
    summary.rowsDropped = toDropRow.length;
  }

  return summary;
}

async function markCleared(client: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  const { error } = await client
    .from(MEDIA_UPLOAD_INTENTS_TABLE)
    .update({ storage_cleared_at: new Date().toISOString() })
    .in('id', ids);

  if (error) {
    logBackendWarning('failed_to_mark_reclaimed_media_upload_intents', { error, count: ids.length });
  }
}

/**
 * Ask storage which of these objects still exist.
 *
 * An intent whose signed URL lapsed unused has no object behind it, and issuing
 * a delete for it would be a wasted request on every run until something else
 * cleared the row. Listing is per-user-prefix because that is the only grouping
 * the uploads bucket has.
 */
async function listExistingObjectPaths(
  client: SupabaseClient,
  rows: IntentRow[],
): Promise<Set<string>> {
  const prefixes = new Map<string, Set<string>>();
  for (const row of rows) {
    const separatorIndex = row.storage_path.indexOf('/');
    if (separatorIndex <= 0) continue;
    const prefix = row.storage_path.slice(0, separatorIndex);
    const name = row.storage_path.slice(separatorIndex + 1);
    const names = prefixes.get(prefix) ?? new Set<string>();
    names.add(name);
    prefixes.set(prefix, names);
  }

  const existing = new Set<string>();
  const pageSize = 1000;

  for (const [prefix, names] of prefixes) {
    let failed = false;

    // Paginated: a single page would report every object past the first 1000 as
    // missing, and "missing" means the row is dropped and the object becomes
    // permanently untracked -- disabling the sweep for exactly the heaviest
    // accounts.
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client.storage
        .from(UPLOADS_BUCKET)
        .list(prefix, { limit: pageSize, offset });

      if (error) {
        logBackendWarning('failed_to_list_uploads_prefix_during_reclaim', { error, prefix });
        failed = true;
        break;
      }

      const page = data ?? [];
      for (const object of page) {
        if (object?.name) {
          existing.add(`${prefix}/${object.name}`);
        }
      }

      if (page.length < pageSize) break;
    }

    if (failed) {
      // Treating an unreadable prefix as "everything exists" keeps the sweep
      // from deleting rows for objects it simply could not see.
      for (const name of names) {
        existing.add(`${prefix}/${name}`);
      }
    }
  }

  return existing;
}
