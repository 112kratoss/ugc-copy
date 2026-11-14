import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';
import { GenerationServiceError } from '@/lib/generation-service-core';
import { KIE_PROVIDER_SERVICE, PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';
import { createServiceClient } from '@/lib/server-helpers';

/**
 * The queue of generation starts waiting to be sent to the provider: its rows.
 *
 * A creator's start that the gate has no place for is not failed and does not
 * wait in its request. Its prepared provider request is stored
 * (`generation_queued_submissions`) and the start answers as queued. Whatever
 * sends the run later takes the request back out with a claim, an atomic
 * delete: the caller that gets the request is the only one that may send,
 * cancel or expire the run, so a queued run is sent once or refunded once.
 *
 * This file is the rows alone, so the start services can queue without
 * loading what drives the queue (generation-submission-queue.ts), which loads
 * them.
 */

/** A provider request as a start prepared it. */
export type QueuedProviderTask = {
  endpoint: string;
  body: Record<string, unknown>;
  callbackUrl: string;
  modelId: string | null;
};

/** A queued run's request, taken out of the queue by the one caller that may act on it. */
export type ClaimedProviderSubmission = {
  generationId: string;
  userId: string;
  task: QueuedProviderTask;
  queuedAtMs: number;
};

/** A run still in the queue, without its request. */
export type QueuedProviderSubmission = {
  generationId: string;
  userId: string;
  model: string | null;
  queuedAtMs: number;
};

type RpcClient = Pick<SupabaseClient, 'rpc'>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const QUEUE_FULL_MESSAGE =
  'Too many generations are waiting to start right now. No credits were charged. Please retry shortly.';
const USER_QUEUE_FULL_MESSAGE =
  'You already have several generations waiting to start. No credits were charged. Please retry once one has started.';

/**
 * Stores a start's provider request and puts the run in the queue.
 *
 * Throws the same 429 `provider_busy` an over-limit start always answered when
 * the queue will not take it: it is full, the creator's share of it is, or the
 * queue could not be reached. That refusal is refunded by the start's own
 * catch, which is right because nothing was sent and nothing is stored.
 *
 * Unlike the gate, this cannot fail open. Failing open on the gate sends the
 * run; here it would answer "queued" for a run nothing holds a request for.
 */
export async function enqueueProviderSubmission(params: {
  generationId: string;
  task: QueuedProviderTask;
  client?: RpcClient;
}): Promise<{ queuedAtMs: number; ahead: number | null }> {
  let status: string | null = null;
  let data: unknown = null;

  try {
    const client = params.client ?? createServiceClient();
    const answer = await client.rpc('enqueue_provider_submission', {
      p_generation_id: params.generationId,
      p_service: KIE_PROVIDER_SERVICE,
      p_model: params.task.modelId,
      p_endpoint: params.task.endpoint,
      // The callback address travels with the body, as it is sent.
      p_request: { ...params.task.body, callBackUrl: params.task.callbackUrl },
      p_queue_max: PROVIDER_ADMISSION_POLICY.queueMax,
      p_user_queue_max: PROVIDER_ADMISSION_POLICY.queueUserMax,
    });
    if (answer.error) throw answer.error;
    data = answer.data;
    status = isRecord(data) && typeof data.status === 'string' ? data.status : null;
  } catch (error) {
    logBackendWarning('generation_submission_queue_unavailable', {
      generationId: params.generationId,
      error: error instanceof Error ? error.message : String(isRecord(error) ? error.message : error),
    });
  }

  if (status === 'queued' && isRecord(data)) {
    const queuedAtMs = Date.parse(String(data.queuedAt));
    return {
      queuedAtMs: Number.isFinite(queuedAtMs) ? queuedAtMs : Date.now(),
      ahead: typeof data.ahead === 'number' ? data.ahead : null,
    };
  }

  logBackendWarning('generation_submission_queue_refused', {
    generationId: params.generationId,
    status,
  });
  throw new GenerationServiceError(
    status === 'user_queue_full' ? USER_QUEUE_FULL_MESSAGE : QUEUE_FULL_MESSAGE,
    429,
    'provider_busy',
  );
}

/**
 * Takes a queued run's request out of the queue. Null when there is none to
 * take: it was never queued, or something else claimed it first.
 */
export async function claimQueuedProviderSubmission(
  client: RpcClient,
  generationId: string,
): Promise<ClaimedProviderSubmission | null> {
  const { data, error } = await client.rpc('claim_queued_provider_submission', {
    p_generation_id: generationId,
  });
  if (error) throw error;
  if (!isRecord(data) || !isRecord(data.request) || typeof data.endpoint !== 'string') return null;

  const { callBackUrl, ...body } = data.request;
  const queuedAtMs = Date.parse(String(data.queuedAt));
  return {
    generationId,
    userId: String(data.userId),
    task: {
      endpoint: data.endpoint,
      body,
      callbackUrl: typeof callBackUrl === 'string' ? callBackUrl : '',
      modelId: typeof data.model === 'string' ? data.model : null,
    },
    queuedAtMs: Number.isFinite(queuedAtMs) ? queuedAtMs : Date.now(),
  };
}

type QueueRow = { generation_id: string; user_id: string; model: string | null; queued_at: string };

function toQueued(row: QueueRow): QueuedProviderSubmission {
  return {
    generationId: row.generation_id,
    userId: row.user_id,
    model: row.model,
    queuedAtMs: Date.parse(row.queued_at),
  };
}

/** The queued run of a generation, if it is queued. Never its request. */
export async function readQueuedProviderSubmission(
  client: SupabaseClient,
  generationId: string,
): Promise<QueuedProviderSubmission | null> {
  const { data, error } = await client
    .from('generation_queued_submissions')
    .select('generation_id, user_id, model, queued_at')
    .eq('generation_id', generationId)
    .maybeSingle();
  if (error) throw error;
  return data ? toQueued(data as QueueRow) : null;
}

/** The runs that have waited longest, oldest first. */
export async function listOldestQueuedProviderSubmissions(
  client: SupabaseClient,
  limit: number,
): Promise<QueuedProviderSubmission[]> {
  const { data, error } = await client
    .from('generation_queued_submissions')
    .select('generation_id, user_id, model, queued_at')
    .eq('service', KIE_PROVIDER_SERVICE)
    .order('queued_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as QueueRow[]).map(toQueued);
}

/** How many runs were queued before this one and are still waiting. */
export async function countQueuedProviderSubmissionsAhead(
  client: SupabaseClient,
  queued: QueuedProviderSubmission,
): Promise<number> {
  const { count, error } = await client
    .from('generation_queued_submissions')
    .select('generation_id', { count: 'exact', head: true })
    .eq('service', KIE_PROVIDER_SERVICE)
    .lt('queued_at', new Date(queued.queuedAtMs).toISOString());
  if (error) throw error;
  return count ?? 0;
}

/** Whether any run is queued. A read that fails says no: the cron that asks has other work to do. */
export async function hasQueuedProviderSubmissions(client: SupabaseClient): Promise<boolean> {
  try {
    return (await listOldestQueuedProviderSubmissions(client, 1)).length > 0;
  } catch (error) {
    logBackendWarning('generation_submission_queue_unavailable', {
      error: error instanceof Error ? error.message : String(isRecord(error) ? error.message : error),
    });
    return false;
  }
}
