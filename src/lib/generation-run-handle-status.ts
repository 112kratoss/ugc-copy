import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveLinkedAccountIds } from '@/lib/account-identity';
import { logBackendError } from '@/lib/backend-logger';
import type { RunAfterResponse } from '@/lib/deferrable-notification';
import { isRunHandle } from '@/lib/generation-run-handle';
import {
  buildFailedGenerationStatusPayload,
  buildLockedGenerationStatusPayload,
} from '@/lib/generation-status-lock';
import { driveQueuedSubmissions } from '@/lib/generation-submission-queue';
import {
  countQueuedProviderSubmissionsAhead,
  readQueuedProviderSubmission,
} from '@/lib/generation-submission-queue-store';

/**
 * A status check made with a run's handle in place of a provider task id.
 *
 * A queued run's start answers the generation's own id as the id to follow it
 * by (generation-run-handle.ts), because the provider task it would otherwise
 * give does not exist yet. The three status services look a run up by its task
 * id and know nothing of this: each asks here first, and goes on as it always
 * has with whatever task id comes back.
 *
 * While the run is queued the check answers by itself: `waiting`, with
 * `queued`, the run's place and a short `retryAfterMs`. A client that knows
 * nothing of the queue reads that as the `waiting` it has always shown. The
 * check also makes one pass over the head of the queue, behind its answer, so
 * a creator who is watching a queued run is moving the queue along.
 */

/** How soon a client should ask again about a queued run: places open by the second. */
export const QUEUED_RUN_STATUS_RETRY_AFTER_MS = 3_000;

type RunHandleRow = {
  id: string;
  user_id: string;
  prediction_id: string | null;
  status: string | null;
  category: string | null;
  model: string | null;
  created_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

export type RunHandleStatus =
  /** Not a handle of this creator's: a provider task id, to look up as before. */
  | { kind: 'task'; predictionId: string }
  /** The handle of a run that has its provider task: follow that. */
  | { kind: 'attached'; predictionId: string }
  /** The handle's own answer: queued, about to be sent, or ended before it was. */
  | { kind: 'answered'; body: Record<string, unknown> };

/** What a queued run's wait is called, for the clients that show the server's words. */
export function queuedRunPhaseLabel(ahead: number): string {
  if (ahead <= 0) return 'Queued · starting soon';
  return `Queued · ${ahead} ahead of you`;
}

export async function resolveRunHandleStatus(params: {
  id: string;
  userId: string;
  createAdminSupabase: () => SupabaseClient;
  runAfterResponse?: RunAfterResponse;
}): Promise<RunHandleStatus> {
  if (!isRunHandle(params.id)) return { kind: 'task', predictionId: params.id };

  const admin = params.createAdminSupabase();
  const ownerUserIds = await resolveLinkedAccountIds(admin, params.userId);
  const { data, error } = await admin
    .from('generations')
    .select('id, user_id, prediction_id, status, category, model, created_at, completed_at, error_message')
    .eq('id', params.id.trim())
    .in('user_id', ownerUserIds)
    .maybeSingle();
  if (error) {
    // Not "no such run": the creator's poll stops on a 404, and the run is there.
    logBackendError('generation_run_handle_lookup_failed', { error });
    throw error;
  }
  const row = data as RunHandleRow | null;
  // No generation of this creator's has this id. It is then looked up as a
  // provider task id, as every id was before there were handles: a provider
  // whose task ids are shaped like ours is followed all the same, and an id
  // that is neither answers that lookup's own "not found".
  if (!row || !ownerUserIds.includes(row.user_id)) return { kind: 'task', predictionId: params.id };

  // Sent: from here on the run is its provider task's, as any run is.
  if (row.prediction_id) return { kind: 'attached', predictionId: row.prediction_id };

  // Ended before it was sent: refused by the provider, or queued too long.
  if (row.status === 'failed') return { kind: 'answered', body: buildFailedGenerationStatusPayload(row) };

  const queued = row.status === 'pending' ? await readQueuedProviderSubmission(admin, row.id) : null;
  if (!queued) {
    // Between the queue and the provider: claimed, and being sent right now.
    return {
      kind: 'answered',
      body: buildLockedGenerationStatusPayload(
        { ...row, status: 'processing' },
        null,
        QUEUED_RUN_STATUS_RETRY_AFTER_MS,
      ),
    };
  }

  const ahead = await countQueuedProviderSubmissionsAhead(admin, queued);
  const waiting = buildLockedGenerationStatusPayload(
    { ...row, status: 'waiting' },
    null,
    QUEUED_RUN_STATUS_RETRY_AFTER_MS,
  );

  // Whoever is watching a queued run serves the queue: one pass over its head,
  // behind this answer, which sends the watcher's own run when it is its turn
  // and the runs ahead of it when it is theirs.
  if (params.runAfterResponse) {
    try {
      params.runAfterResponse(() => driveQueuedSubmissions());
    } catch (scheduleError) {
      logBackendError('generation_queued_submission_drive_unscheduled', { generationId: row.id, error: scheduleError });
    }
  }

  return {
    kind: 'answered',
    body: {
      ...waiting,
      timing: { ...waiting.timing, phaseLabel: queuedRunPhaseLabel(ahead) },
      queued: true,
      queuePosition: ahead + 1,
    },
  };
}
