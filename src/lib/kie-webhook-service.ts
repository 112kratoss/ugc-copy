import type { SupabaseClient } from '@supabase/supabase-js';

import {
  enqueueGenerationCompletionJob,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import { attachGenerationProviderTask } from '@/lib/generation-services';
import {
  extractKieWebhookTaskId,
  verifyKieWebhookAuthorization,
} from '@/lib/kie-webhook';
import { isWebhookPayloadTooLarge } from '@/lib/webhook-request';

type RouteBody = Record<string, unknown>;

export type KieWebhookRouteResult = {
  body: RouteBody;
  status: number;
};

export type KieWebhookRouteRequest = Pick<Request, 'headers' | 'json' | 'url'>;

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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
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

  console.error(JSON.stringify({
    level: 'warn',
    msg: 'kie_webhook_provider_task_attach_skipped',
    generationId,
    predictionId: params.predictionId,
    status,
  }));
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
  if (isWebhookPayloadTooLarge(request)) {
    return {
      body: { error: 'Webhook payload is too large.' },
      status: 413,
    };
  }

  let payload: unknown;
  try {
    payload = await request.json();
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
  const env = input.env ?? process.env;
  const authorized = verifyKieWebhookAuthorization({
    taskId: predictionId,
    timestamp: request.headers.get('x-webhook-timestamp'),
    signature: request.headers.get('x-webhook-signature'),
    hmacKey: configuredValue(env, 'KIE_WEBHOOK_HMAC_KEY'),
    legacySecret: configuredValue(env, 'WEBHOOK_SECRET'),
    requestSecret: url.searchParams.get('secret'),
    nowSeconds: resolveNowSeconds(input),
  });

  if (!authorized) {
    return {
      body: { error: 'Unauthorized' },
      status: 401,
    };
  }

  const serviceClient = input.createServiceClient() as SupabaseClient;
  const callbackGenerationId = url.searchParams.get('generationId');
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
      console.error(JSON.stringify({
        level: 'error',
        msg: 'kie_webhook_completion_processing_failed',
        predictionId,
        error: errorMessage(error),
      }));
    }
  });

  return {
    body: { received: true, predictionId },
    status: 200,
  };
}
