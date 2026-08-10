import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

import {
  enqueueGenerationCompletionJob,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import {
  GENERATION_OUTPUT_IMPORT_BATCH_LIMIT,
  processGenerationOutputImportJobs,
} from '@/lib/generation-output-import-jobs-processor';
import { attachGenerationProviderTask } from '@/lib/generation-services';
import {
  extractKieWebhookTaskId,
  verifyKieWebhookAuthorization,
} from '@/lib/kie-webhook';
import { readBoundedWebhookBody } from '@/lib/webhook-request';
import {
  TEMPLATE_RUN_JOB_BATCH_LIMIT,
  processTemplateRunJobs,
} from '@/lib/template-run-jobs-processor';
import {
  WORKFLOW_RUN_STEP_BATCH_LIMIT,
  processWorkflowRunStepJobs,
} from '@/lib/workflow-run-jobs-processor';

type RouteBody = Record<string, unknown>;

export type KieWebhookRouteResult = {
  body: RouteBody;
  status: number;
};

export type KieWebhookRouteRequest = Pick<Request, 'body' | 'headers' | 'url'>;

export type KieWebhookRouteEnvironment = Record<string, string | undefined>;

export interface KieWebhookRouteInput {
  createServiceClient: () => unknown;
  env?: KieWebhookRouteEnvironment;
  nowSeconds?: number;
  nowMs?: number;
  request: KieWebhookRouteRequest;
  scheduleAfter: (callback: () => Promise<void> | void) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function configuredValue(env: KieWebhookRouteEnvironment | undefined, name: string): string | null {
  return env?.[name]?.trim() || null;
}


async function attachCallbackGenerationId(
  serviceClient: SupabaseClient,
  params: { generationId: string | null; predictionId: string },
): Promise<'attached' | 'already_attached' | 'skipped'> {
  const generationId = params.generationId?.trim();
  if (!generationId) return 'attached';

  const status = await attachGenerationProviderTask(serviceClient, {
    generationId,
    predictionId: params.predictionId,
  });

  if (status === 'attached' || status === 'already_attached') {
    return status;
  }

  logBackendWarning('kie_webhook_provider_task_attach_skipped', {
    generationId,
    predictionId: params.predictionId,
    status,
  });
  return 'skipped';
}

/**
 * Record the residual race the F14 grace window cannot close.
 *
 * A callback can always land after the window expired and the reaper refunded.
 * The provider did the work and will bill for it, so the discrepancy has to
 * outlive this request: the warning above is not queryable against money, and
 * log retention is finite while F15b's log drain is still open.
 *
 * The shape test lives in the RPC, not here. This same `already_settled` path
 * is reached by ordinary duplicate callbacks on generations that succeeded
 * normally, and a ledger full of benign duplicates is one nobody reads.
 */
async function recordLateCallbackAfterRefund(
  serviceClient: SupabaseClient,
  params: { generationId: string | null; predictionId: string },
): Promise<void> {
  const generationId = params.generationId?.trim();
  if (!generationId) return;

  try {
    const { data, error } = await serviceClient.rpc('record_provider_submission_reconciliation', {
      p_generation_id: generationId,
      p_prediction_id: params.predictionId,
    });
    if (error) throw error;

    const status = isRecord(data) && typeof data.status === 'string' ? data.status : null;
    if (status === 'recorded') {
      logBackendError('provider_submission_reconciliation_recorded', {
        generationId,
        predictionId: params.predictionId,
        refundedCredits: isRecord(data) ? data.refunded_credits : undefined,
      });
    }
  } catch (error) {
    // Never fail the webhook over bookkeeping: the provider retries on a
    // non-200 and the completion payload is already lost either way.
    logBackendWarning('provider_submission_reconciliation_record_failed', {
      generationId,
      predictionId: params.predictionId,
      error,
    });
  }
}

function buildCompletionJobPayload(
  payload: unknown,
  params: { generationId: string | null },
): Record<string, unknown> {
  const completionPayload = isRecord(payload) ? payload : { payload };
  const generationId = params.generationId?.trim();
  if (!generationId) return completionPayload;

  return {
    ...completionPayload,
    magicbooklet: {
      ...(isRecord(completionPayload.magicbooklet) ? completionPayload.magicbooklet : {}),
      callbackGenerationId: generationId,
    },
  };
}

function resolveNowSeconds(input: KieWebhookRouteInput) {
  return input.nowSeconds ?? Math.floor((input.nowMs ?? Date.now()) / 1000);
}

function resolveNowMs(input: KieWebhookRouteInput) {
  return input.nowMs ?? (input.nowSeconds !== undefined ? input.nowSeconds * 1000 : Date.now());
}

export async function handleKieWebhookForRoute(input: KieWebhookRouteInput): Promise<KieWebhookRouteResult> {
  const { request } = input;
  const body = await readBoundedWebhookBody(request);
  if (!body.ok) {
    return {
      body: { error: 'Webhook payload is too large.' },
      status: 413,
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.text);
  } catch {
    return {
      body: { error: 'Invalid JSON payload.' },
      status: 400,
    };
  }

  const predictionId = extractKieWebhookTaskId(payload);
  if (!predictionId) {
    return {
      body: { error: 'Missing provider task id.' },
      status: 400,
    };
  }

  const url = new URL(request.url);
  const callbackGenerationId = url.searchParams.get('generationId')?.trim() || null;
  const env = input.env ?? process.env;
  const authorized = verifyKieWebhookAuthorization({
    generationId: callbackGenerationId,
    taskId: predictionId,
    rawBody: body.text,
    timestamp: request.headers.get('x-webhook-timestamp'),
    signature: request.headers.get('x-webhook-payload-signature'),
    hmacKey: configuredValue(env, 'KIE_WEBHOOK_HMAC_KEY'),
    previousHmacKey: configuredValue(env, 'KIE_WEBHOOK_HMAC_KEY_PREVIOUS'),
    nowSeconds: resolveNowSeconds(input),
  });

  if (!authorized) {
    return {
      body: { error: 'Unauthorized' },
      status: 401,
    };
  }

  const serviceClient = input.createServiceClient() as SupabaseClient;
  const attachStatus = await attachCallbackGenerationId(serviceClient, {
    generationId: callbackGenerationId,
    predictionId,
  });

  if (attachStatus === 'skipped') {
    await recordLateCallbackAfterRefund(serviceClient, {
      generationId: callbackGenerationId,
      predictionId,
    });
    return {
      body: { received: true, predictionId },
      status: 200,
    };
  }

  await enqueueGenerationCompletionJob(serviceClient, {
    predictionId,
    payload: buildCompletionJobPayload(payload, { generationId: callbackGenerationId }),
  });

  const lockedBy = `kie-webhook:${predictionId}:${resolveNowMs(input)}`;
  input.scheduleAfter(async () => {
    try {
      const completion = await processGenerationCompletionJobs({
        supabase: serviceClient,
        creditSupabase: serviceClient,
        lockedBy,
        limit: 5,
        predictionId,
      });
      const outputImports = completion.completed > 0
        ? await processGenerationOutputImportJobs({
            client: serviceClient,
            lockedBy: `${lockedBy}:output-import`,
            limit: Math.min(GENERATION_OUTPUT_IMPORT_BATCH_LIMIT, completion.completed),
          })
        : { completed: 0 };
      if (completion.completed > 0 || outputImports.completed > 0) {
        // The generation terminal trigger made the exact workflow ticket due.
        // Drain it in the same after() window for low latency; the durable
        // ticket and cron remain the crash-safe fallback if this work is cut.
        await processWorkflowRunStepJobs({
          supabase: serviceClient,
          lockedBy: `${lockedBy}:workflow`,
          limit: Math.min(
            WORKFLOW_RUN_STEP_BATCH_LIMIT,
            Math.max(1, completion.completed + outputImports.completed),
          ),
        });
        await processTemplateRunJobs({
          client: serviceClient,
          lockedBy: `${lockedBy}:template`,
          limit: Math.min(
            TEMPLATE_RUN_JOB_BATCH_LIMIT,
            Math.max(1, completion.completed + outputImports.completed),
          ),
        });
      }
    } catch (error) {
      logBackendError('kie_webhook_completion_processing_failed', {
        predictionId,
        error,
      });
    }
  });

  return {
    body: { received: true, predictionId },
    status: 200,
  };
}
