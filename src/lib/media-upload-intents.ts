import 'server-only';
import { logBackendWarning } from '@/lib/backend-logger';

import type { UploadIntentConsumer, UploadIntentKind } from '@/lib/media-upload-reclaim';
import { releaseUploadBytes } from '@/lib/upload-byte-admission';

// Re-exported so the request path keeps a single import for intent work; the
// definitions live in a dependency-free module the ops backfill can also load.
export {
  MEDIA_UPLOAD_INTENTS_TABLE,
  normalizeUploadIntentPath,
} from '@/lib/media-upload-staging-paths';

import {
  MEDIA_UPLOAD_INTENTS_TABLE,
  normalizeUploadIntentPath,
} from '@/lib/media-upload-staging-paths';

/**
 * Split a storage remove() batch into what was actually deleted and what was
 * not.
 *
 * `remove()` reports per-path outcomes in `data`, not `error`: a batch can
 * partially fail while `error` stays null. Marking every requested path cleared
 * on that basis makes the sweep permanently ignore objects that still exist --
 * the exact leak the intents table was built to end.
 *
 * When `error` is null and `data` reports nothing, the whole batch is treated
 * as removed: older client versions and test doubles omit per-path outcomes,
 * and `error` is then the only signal there is.
 */
export function getConfirmedRemovedPaths(
  requestedPaths: string[],
  result: {
    data?: Array<{ name?: string }> | null;
    error: { message?: string } | null;
  },
): { confirmed: string[]; unconfirmed: string[] } {
  if (result.error) {
    return { confirmed: [], unconfirmed: [...requestedPaths] };
  }

  const removed = new Set(
    (result.data ?? [])
      .map((object) => object?.name)
      .filter((name): name is string => Boolean(name)),
  );

  if (removed.size === 0) {
    return { confirmed: [...requestedPaths], unconfirmed: [] };
  }

  return {
    confirmed: requestedPaths.filter((storagePath) => removed.has(storagePath)),
    unconfirmed: requestedPaths.filter((storagePath) => !removed.has(storagePath)),
  };
}

type IntentInsertClient = {
  from: (table: string) => {
    insert: (values: Record<string, unknown>) => PromiseLike<{ error: { message?: string } | null }>;
  };
};

type IntentUpdateFilter = {
  in: (column: string, values: string[]) => IntentUpdateFilter
    & PromiseLike<{ error: { message?: string } | null }>;
  is: (column: string, value: null) => IntentUpdateFilter
    & PromiseLike<{ error: { message?: string } | null }>;
};

type IntentUpdateClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
  from: (table: string) => {
    update: (values: Record<string, unknown>) => IntentUpdateFilter;
  };
};

/**
 * Record a signed upload so the sweep can find it later.
 *
 * Fails loudly rather than silently: an intent that is never written is an
 * object nothing will ever collect, which is the exact failure this table
 * exists to prevent. The sign route already fails closed on its rate-limit RPC,
 * so this does not widen the availability profile of that endpoint.
 */
export async function recordMediaUploadIntent(
  client: IntentInsertClient,
  intent: {
    userId: string;
    storagePath: string;
    kind: UploadIntentKind;
    contentType: string | null;
    declaredBytes: number | null;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await client.from(MEDIA_UPLOAD_INTENTS_TABLE).insert({
    user_id: intent.userId,
    storage_path: normalizeUploadIntentPath(intent.storagePath),
    kind: intent.kind,
    content_type: intent.contentType,
    declared_bytes: intent.declaredBytes,
  });

  if (error) {
    return { ok: false, error: error.message ?? 'Failed to record media upload intent.' };
  }

  return { ok: true };
}

/**
 * Mark staged objects as claimed.
 *
 * `storageCleared` says whether the caller already deleted the staging object.
 * The post paths copy and delete in the same request, so they pass true. The
 * generation path passes false: an unchanged picker selection can be submitted
 * twice, and the second run still needs those bytes, so the sweep clears them
 * once they are past the reclaim window.
 *
 * Bookkeeping must never fail the work it is describing -- by the time this
 * runs, the post is published or the generation has started. A failure here
 * costs a delayed reclaim, so it warns and returns.
 */
export async function markMediaUploadIntentsConsumed(
  client: IntentUpdateClient,
  params: {
    storagePaths: string[];
    consumedBy: UploadIntentConsumer;
    storageCleared: boolean;
  },
): Promise<void> {
  const storagePaths = Array.from(
    new Set(params.storagePaths.map(normalizeUploadIntentPath).filter(Boolean)),
  );
  if (storagePaths.length === 0) {
    return;
  }

  const consumedAt = new Date().toISOString();
  const { error } = await client
    .from(MEDIA_UPLOAD_INTENTS_TABLE)
    .update({
      consumed_at: consumedAt,
      consumed_by: params.consumedBy,
      ...(params.storageCleared ? { storage_cleared_at: consumedAt } : {}),
    })
    .in('storage_path', storagePaths)
    // Never overwrite an earlier claim. A staged object reused by a second
    // generation keeps the first consumer, which is the one that tells the
    // truth about when these bytes were first copied out.
    .is('consumed_at', null);

  if (error) {
    logBackendWarning('failed_to_mark_media_upload_intents_consumed', {
      error,
      consumedBy: params.consumedBy,
      count: storagePaths.length,
    });
  }

  // Once a staged object has a durable consumer it is no longer an outstanding
  // upload, even when the generation-input path deliberately leaves staging in
  // place for short-term reuse. The reclaim intent remains the storage-lifecycle
  // record; byte admission should not keep charging the user for two hours.
  await Promise.all(storagePaths.map((storagePath) => releaseUploadBytes(client, {
    bucket: 'uploads',
    storagePath,
  })));
}

/**
 * Record that staged objects were deleted without ever being claimed.
 *
 * This is the publish-failure path: the bytes were rolled back, so nothing
 * consumed them, but they are gone and the sweep should not go looking. Leaving
 * consumed_at/consumed_by null is what the table's pair constraint expects and
 * keeps "how many uploads were abandoned" honest.
 */
export async function markMediaUploadIntentsCleared(
  client: IntentUpdateClient,
  storagePaths: string[],
): Promise<void> {
  const normalized = Array.from(
    new Set(storagePaths.map(normalizeUploadIntentPath).filter(Boolean)),
  );
  if (normalized.length === 0) {
    return;
  }

  const { error } = await client
    .from(MEDIA_UPLOAD_INTENTS_TABLE)
    .update({ storage_cleared_at: new Date().toISOString() })
    .in('storage_path', normalized)
    .is('storage_cleared_at', null);

  if (error) {
    logBackendWarning('failed_to_mark_media_upload_intents_cleared', {
      error,
      count: normalized.length,
    });
  }


  await Promise.all(normalized.map((storagePath) => releaseUploadBytes(client, {
    bucket: 'uploads',
    storagePath,
  })));
}
