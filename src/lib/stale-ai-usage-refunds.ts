import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendInfo } from '@/lib/backend-logger';

/**
 * Refunds AI usage charges no request is going to settle.
 *
 * The prompt enhancer and the workflow assistant and blueprint charge first
 * (`start_ai_usage_event`) and settle after the model answers
 * (`settle_ai_usage_event`). A function that dies in between leaves the event
 * `pending` with the credits taken. Until 2026-11-27 backend health reported
 * it as AI_USAGE_STALE_PENDING and nothing cleared it; health now speaks of one
 * only after 30 minutes, once this refund has had two ticks at it.
 *
 * Those routes run for at most Vercel's 300 s, so a charge still pending after
 * ten minutes has no request left to settle it, and it is refunded through the
 * same idempotent settlement the services call. Should a request somehow
 * settle it later, `succeeded` meets `transition_conflict` and the service
 * refunds (`already_refunded`), so the creator is never charged twice nor
 * refunded twice. Run from the generation-completions job, the ten-minute
 * credit-settlement safety net, rather than a job of its own.
 */

export const AI_USAGE_PENDING_REFUND_AFTER_MINUTES = 10;
export const AI_USAGE_PENDING_REFUND_BATCH_LIMIT = 25;
export const AI_USAGE_STALE_PENDING_REFUND_MESSAGE =
  'The request did not finish, so its charge was refunded automatically.';

type PendingAiUsageRow = { id: string; feature: string | null; created_at: string | null };

export type StaleAiUsageRefundSummary = {
  eligible: number;
  refunded: number;
  skipped: number;
  failed: number;
  deferred: number;
};

function cutoffIso(nowMs: number): string {
  return new Date(nowMs - AI_USAGE_PENDING_REFUND_AFTER_MINUTES * 60 * 1000).toISOString();
}

export async function hasStaleAiUsageCharges(
  client: Pick<SupabaseClient, 'from'>,
  options: { nowMs?: number } = {},
): Promise<boolean> {
  const { data, error } = await client
    .from('ai_usage_events')
    .select('id')
    .eq('status', 'pending')
    .lt('created_at', cutoffIso(options.nowMs ?? Date.now()))
    .limit(1);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function refundStaleAiUsageCharges(params: {
  client: Pick<SupabaseClient, 'from' | 'rpc'>;
  nowMs?: number;
  limit?: number;
  deadlineMs?: number;
}): Promise<StaleAiUsageRefundSummary> {
  const nowMs = params.nowMs ?? Date.now();
  const summary: StaleAiUsageRefundSummary = { eligible: 0, refunded: 0, skipped: 0, failed: 0, deferred: 0 };

  // ai_usage_events_pending_created_at_idx serves this read.
  const { data, error } = await params.client
    .from('ai_usage_events')
    .select('id, feature, created_at')
    .eq('status', 'pending')
    .lt('created_at', cutoffIso(nowMs))
    .order('created_at', { ascending: true })
    .limit(params.limit ?? AI_USAGE_PENDING_REFUND_BATCH_LIMIT);
  if (error) throw error;

  const rows = (Array.isArray(data) ? data : []) as PendingAiUsageRow[];
  summary.eligible = rows.length;

  for (const row of rows) {
    if (params.deadlineMs !== undefined && Date.now() >= params.deadlineMs) {
      summary.deferred += 1;
      continue;
    }
    try {
      const result = await params.client.rpc('settle_ai_usage_event', {
        p_event_id: row.id,
        p_outcome: 'refunded',
        p_output_text: null,
        p_response_payload: null,
        p_error_message: AI_USAGE_STALE_PENDING_REFUND_MESSAGE,
      });
      if (result.error) throw result.error;
      const status = result.data && typeof result.data === 'object' && 'status' in result.data
        ? (result.data as { status?: unknown }).status
        : null;
      if (status === 'refunded') {
        summary.refunded += 1;
        logBackendInfo('ai_usage_stale_pending_refunded', {
          eventId: row.id,
          feature: row.feature,
          createdAt: row.created_at,
        });
      } else {
        // already_refunded, a request that settled it first (transition_conflict),
        // or an event that is gone: nothing is owed.
        summary.skipped += 1;
      }
    } catch (rowError) {
      summary.failed += 1;
      logBackendError('ai_usage_stale_pending_refund_failed', { eventId: row.id, error: rowError });
    }
  }

  return summary;
}
