import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError, logBackendWarning } from '@/lib/backend-logger';

import {
  enqueueGenerationCompletionJob,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import { attachGenerationProviderTask } from '@/lib/generation-services';
import {
  extractKieWebhookTaskId,
  verifyKieWebhookAuthorization,
} from '@/lib/kie-webhook';
import { readBoundedWebhookBody } from '@/lib/webhook-request';

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
      await processGenerationCompletionJobs({
        supabase: serviceClient,
        creditSupabase: serviceClient,
        lockedBy,
        limit: 5,
        predictionId,
      });
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
