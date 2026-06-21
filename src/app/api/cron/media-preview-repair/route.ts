import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { withBackendJobLock } from '@/lib/backend-job-lock';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { repairMediaPreviews } from '@/lib/media-preview-repair';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';
export const maxDuration = 300;

const JOB_NAME = 'media-preview-repair';
const LOCK_TTL_SECONDS = 14 * 60;
const ROUTE = '/api/cron/media-preview-repair';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCron(level: 'info' | 'error', msg: string, fields: Record<string, unknown>) {
  const payload = JSON.stringify({
    level,
    msg,
    route: ROUTE,
    job: JOB_NAME,
    ...fields,
  });

  if (level === 'error') {
    console.error(payload);
  } else {
    console.log(payload);
  }
}

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const requestId = request.headers.get('x-vercel-id') ?? randomUUID();
  const lockOwner = `${requestId}:${startedAt}`;

  try {
    logCron('info', 'media_preview_repair_started', { requestId });

    const serviceClient = createServiceClient();
    const lockResult = await withBackendJobLock(serviceClient, {
      name: JOB_NAME,
      ttlSeconds: LOCK_TTL_SECONDS,
      owner: lockOwner,
    }, () => repairMediaPreviews(serviceClient));

    if (!lockResult.acquired) {
      logCron('info', 'media_preview_repair_skipped', {
        requestId,
        reason: lockResult.reason,
        ms: Date.now() - startedAt,
      });
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: lockResult.reason,
      }, { status: 202 });
    }

    logCron('info', 'media_preview_repair_completed', {
      requestId,
      ms: Date.now() - startedAt,
      summary: lockResult.value,
    });
    return NextResponse.json({ success: true, summary: lockResult.value });
  } catch (error) {
    logCron('error', 'media_preview_repair_failed', {
      requestId,
      ms: Date.now() - startedAt,
      error: errorMessage(error),
    });
    return NextResponse.json({ error: 'Failed to repair media previews.' }, { status: 500 });
  }
}
