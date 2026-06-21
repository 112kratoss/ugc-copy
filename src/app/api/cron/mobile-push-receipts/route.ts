import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { withBackendJobLock } from '@/lib/backend-job-lock';
import {
  finishBackendJobRun,
  pruneBackendJobRuns,
  startBackendJobRun,
  type BackendJobRunHandle,
} from '@/lib/backend-job-runs';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import { processPendingMobilePushReceipts } from '@/lib/mobile-notifications';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';

const JOB_NAME = 'mobile-push-receipts';
const LOCK_TTL_SECONDS = 14 * 60;
const ROUTE = '/api/cron/mobile-push-receipts';

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
  let serviceClient: ReturnType<typeof createServiceClient> | null = null;
  let jobRun: BackendJobRunHandle | null = null;

  try {
    logCron('info', 'mobile_push_receipts_started', { requestId });

    const currentServiceClient = createServiceClient();
    serviceClient = currentServiceClient;
    jobRun = await startBackendJobRun(currentServiceClient, {
      name: JOB_NAME,
      route: ROUTE,
      requestId,
      lockOwner,
      startedAtMs: startedAt,
    });

    const lockResult = await withBackendJobLock(currentServiceClient, {
      name: JOB_NAME,
      ttlSeconds: LOCK_TTL_SECONDS,
      owner: lockOwner,
    }, () => processPendingMobilePushReceipts(currentServiceClient));

    if (!lockResult.acquired) {
      const finishedAt = Date.now();
      await finishBackendJobRun(currentServiceClient, jobRun, {
        status: 'skipped',
        finishedAtMs: finishedAt,
        skipReason: lockResult.reason,
      });
      const prunedJobRuns = await pruneBackendJobRuns(currentServiceClient);
      logCron('info', 'mobile_push_receipts_skipped', {
        requestId,
        reason: lockResult.reason,
        ms: finishedAt - startedAt,
        prunedJobRuns,
      });
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: lockResult.reason,
      }, { status: 202 });
    }

    const finishedAt = Date.now();
    await finishBackendJobRun(currentServiceClient, jobRun, {
      status: 'succeeded',
      finishedAtMs: finishedAt,
      summary: lockResult.value,
    });
    const prunedJobRuns = await pruneBackendJobRuns(currentServiceClient);
    logCron('info', 'mobile_push_receipts_completed', {
      requestId,
      ms: finishedAt - startedAt,
      summary: lockResult.value,
      prunedJobRuns,
    });
    return NextResponse.json({ success: true, summary: lockResult.value });
  } catch (error) {
    const finishedAt = Date.now();
    if (serviceClient) {
      await finishBackendJobRun(serviceClient, jobRun, {
        status: 'failed',
        finishedAtMs: finishedAt,
        errorMessage: errorMessage(error),
      });
      await pruneBackendJobRuns(serviceClient);
    }
    logCron('error', 'mobile_push_receipts_failed', {
      requestId,
      ms: finishedAt - startedAt,
      error: errorMessage(error),
    });
    return NextResponse.json({ error: 'Failed to process mobile push receipts.' }, { status: 500 });
  }
}
