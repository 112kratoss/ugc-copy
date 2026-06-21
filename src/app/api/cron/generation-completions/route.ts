import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { withBackendJobLock } from '@/lib/backend-job-lock';
import {
  finishBackendJobRun,
  maybePruneBackendJobRuns,
  startBackendJobRun,
  type BackendJobRunHandle,
} from '@/lib/backend-job-runs';
import { isAuthorizedCronRequest } from '@/lib/cron-auth';
import {
  hasDueGenerationCompletionJobs,
  maybePruneGenerationCompletionJobs,
  processGenerationCompletionJobs,
} from '@/lib/generation-completion-jobs';
import { createServiceClient } from '@/lib/server-helpers';

export const runtime = 'nodejs';
export const maxDuration = 300;

const JOB_NAME = 'generation-completions';
const LOCK_TTL_SECONDS = 14 * 60;
const ROUTE = '/api/cron/generation-completions';
const BATCH_LIMIT = 25;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
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
  const lockOwner = `${JOB_NAME}:${requestId}:${startedAt}`;
  let serviceClient: ReturnType<typeof createServiceClient> | null = null;
  let jobRun: BackendJobRunHandle | null = null;

  try {
    logCron('info', 'generation_completions_started', { requestId });

    const currentServiceClient = createServiceClient();
    serviceClient = currentServiceClient;

    const hasDueJobs = await hasDueGenerationCompletionJobs(currentServiceClient, {
      nowMs: startedAt,
    });

    if (!hasDueJobs) {
      const finishedAt = Date.now();
      const pruned = await maybePruneGenerationCompletionJobs(currentServiceClient, { nowMs: startedAt });
      const prunedJobRuns = await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAt });
      logCron('info', 'generation_completions_skipped_no_due_jobs', {
        requestId,
        ms: finishedAt - startedAt,
        pruned,
        prunedJobRuns,
      });
      return NextResponse.json({
        success: true,
        skipped: true,
        reason: 'no_due_jobs',
        pruned,
      }, { status: 202 });
    }

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
    }, async () => {
      const completionSummary = await processGenerationCompletionJobs({
        supabase: currentServiceClient,
        creditSupabase: currentServiceClient,
        lockedBy: lockOwner,
        limit: BATCH_LIMIT,
      });
      const pruned = await maybePruneGenerationCompletionJobs(currentServiceClient, { nowMs: startedAt });
      return {
        ...completionSummary,
        pruned,
      };
    });

    if (!lockResult.acquired) {
      const finishedAt = Date.now();
      await finishBackendJobRun(currentServiceClient, jobRun, {
        status: 'skipped',
        finishedAtMs: finishedAt,
        skipReason: lockResult.reason,
      });
      const prunedJobRuns = await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAt });
      logCron('info', 'generation_completions_skipped', {
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
    const prunedJobRuns = await maybePruneBackendJobRuns(currentServiceClient, { nowMs: startedAt });
    logCron('info', 'generation_completions_completed', {
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
      await maybePruneBackendJobRuns(serviceClient, { nowMs: startedAt });
    }
    logCron('error', 'generation_completions_failed', {
      requestId,
      ms: finishedAt - startedAt,
      error: errorMessage(error),
    });
    return NextResponse.json({ error: 'Failed to process generation completions.' }, { status: 500 });
  }
}
