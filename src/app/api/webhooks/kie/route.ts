import { after, NextResponse } from 'next/server';

import {
  enqueueGenerationCompletionJob,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import {
  extractKieWebhookTaskId,
  verifyKieWebhookAuthorization,
} from '@/lib/kie-webhook';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';
export const maxDuration = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function configuredValue(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload.' }, { status: 400 });
  }

  const predictionId = extractKieWebhookTaskId(payload);
  if (!predictionId) {
    return NextResponse.json({ error: 'Missing provider task id.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const authorized = verifyKieWebhookAuthorization({
    taskId: predictionId,
    timestamp: request.headers.get('x-webhook-timestamp'),
    signature: request.headers.get('x-webhook-signature'),
    hmacKey: configuredValue('KIE_WEBHOOK_HMAC_KEY'),
    legacySecret: configuredValue('WEBHOOK_SECRET'),
    requestSecret: url.searchParams.get('secret'),
    nowSeconds: Math.floor(Date.now() / 1000),
  });

  if (!authorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const serviceClient = createServiceClient();
  await enqueueGenerationCompletionJob(serviceClient, {
    predictionId,
    payload: isRecord(payload) ? payload : { payload },
  });

  const lockedBy = `kie-webhook:${predictionId}:${Date.now()}`;
  after(async () => {
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

  return NextResponse.json({ received: true, predictionId });
}
