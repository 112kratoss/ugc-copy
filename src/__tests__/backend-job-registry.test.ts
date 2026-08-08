import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKEND_JOB_DAILY_INVOCATION_BUDGET,
  BACKEND_JOB_DEDICATED_CRONS,
  BACKEND_JOB_REGISTRY,
  BACKEND_JOB_SCHEDULER,
  BACKEND_JOB_VERCEL_CRONS,
  getBackendJobVercelDailyInvocations,
  getDueBackendJobs,
  getCronScheduleCadenceMinutes,
  getCronScheduleDailyInvocations,
  isCronScheduleDueAt,
} from '@/lib/backend-jobs';

type VercelConfig = {
  $schema?: string;
  fluid?: boolean;
  regions?: string[];
  crons?: Array<{ path: string; schedule: string }>;
};

const vercelConfig = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'),
) as VercelConfig;
const operationsRunbook = fs.readFileSync(
  path.resolve(process.cwd(), 'docs/production-deployment-runbook.md'),
  'utf8',
);

describe('backend job registry', () => {
  it('keeps server compute colocated with the Supabase Mumbai region', () => {
    expect(vercelConfig.$schema).toBe('https://openapi.vercel.sh/vercel.json');
    expect(vercelConfig.fluid).toBe(true);
    expect(vercelConfig.regions).toEqual(['bom1']);
  });

  it('keeps vercel.json crons exactly in step with the registry', () => {
    // F14 split the memory-heavy jobs onto their own cron entries, so this is
    // no longer a single-entry assertion. Drift either way is a real outage
    // shape: an entry without a registry job 401s forever, and a dedicated job
    // without an entry never runs at all, because the scheduler deliberately
    // stops dispatching it.
    expect(vercelConfig.crons).toEqual([...BACKEND_JOB_VERCEL_CRONS]);
    expect(BACKEND_JOB_SCHEDULER.cadenceMinutes).toBe(
      getCronScheduleCadenceMinutes(BACKEND_JOB_SCHEDULER.schedule),
    );
    expect(BACKEND_JOB_SCHEDULER.dailyInvocations).toBe(
      getCronScheduleDailyInvocations(BACKEND_JOB_SCHEDULER.schedule),
    );
  });

  it('isolates exactly the jobs that can take an invocation down', () => {
    // Isolation costs a cron entry, so the default is shared and a job has to
    // earn dedicated dispatch by being able to OOM or hard-crash the instance.
    // Both of these stage videos up to 250MB and shell out to ffmpeg.
    expect(BACKEND_JOB_DEDICATED_CRONS.map((job) => job.name)).toEqual([
      'generation-completions',
      'media-preview-repair',
    ]);

    for (const job of BACKEND_JOB_REGISTRY) {
      expect(['scheduler', 'dedicated']).toContain(job.dispatch);
    }
  });

  it('never dispatches a dedicated job through the shared scheduler', () => {
    // Running it in both places would put the memory-heavy work straight back
    // into the shared invocation, which is the whole thing F14 removes. The job
    // lock makes the duplicate harmless, not pointless-free.
    for (const timestamp of [
      '2026-06-22T10:00:00.000Z',
      '2026-06-22T10:10:00.000Z',
      '2026-06-22T10:20:00.000Z',
      '2026-06-22T10:40:00.000Z',
    ]) {
      const dueNames = getDueBackendJobs(Date.parse(timestamp)).map((job) => job.name);
      expect(dueNames).not.toContain('generation-completions');
      expect(dueNames).not.toContain('media-preview-repair');
    }
  });

  it('keeps every logical backend job represented in backend health metadata', () => {
    expect(BACKEND_JOB_REGISTRY.map((job) => job.name).sort()).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'feed-maintenance',
      'generation-completions',
      'generation-model-verification',
      'media-preview-repair',
      'media-upload-reclaim',
      'mobile-push-receipts',
      'operational-data-retention',
      'referral-reward-reconciliation',
      'workflow-run-steps',
    ]);
  });

  it('keeps logical job cadences and health windows in one shared contract', () => {
    for (const job of BACKEND_JOB_REGISTRY) {
      expect(job.cadenceMinutes).toBe(getCronScheduleCadenceMinutes(job.schedule));
      expect(job.dailyInvocations).toBe(getCronScheduleDailyInvocations(job.schedule));
      expect(job.healthExpectedMaxAgeMinutes).toBe(
        job.cadenceMinutes * job.maxMissedRunsBeforeDegraded,
      );
      expect(job.cadenceMinutes % BACKEND_JOB_SCHEDULER.cadenceMinutes).toBe(0);
      expect(job.maxDurationSeconds).toBe(300);
      expect(job.lockTtlSeconds).toBeGreaterThan(0);
      expect(job.lockTtlSeconds).toBeGreaterThanOrEqual(job.maxDurationSeconds);
      expect(job.noWorkSkipReason).toMatch(/\S/);
    }
  });

  it('keeps the background job schedule within the production invocation budget', () => {
    const logicalDailyRuns = BACKEND_JOB_REGISTRY.reduce(
      (total, job) => total + job.dailyInvocations,
      0,
    );

    expect(getCronScheduleDailyInvocations('*/10 * * * *')).toBe(144);
    expect(getCronScheduleDailyInvocations('0 * * * *')).toBe(24);
    // 505 from the seven original jobs, one daily retention sweep, one daily
    // staged-upload reclaim sweep, the ten-minute durable account-deletion
    // cleanup worker, and the ten-minute workflow run step worker added by F12
    // (+144) -- before it, no registry entry watched workflow runs at all.
    expect(logicalDailyRuns).toBe(795);
    expect(BACKEND_JOB_SCHEDULER.dailyInvocations).toBe(144);
    // The budget bounds real Vercel cron invocations, not logical job runs, so
    // it has to be measured across every entry now that F14 added two. Checking
    // only the scheduler would have let dedicated crons grow unbounded.
    expect(getBackendJobVercelDailyInvocations()).toBe(144 + 144 + 24);
    expect(getBackendJobVercelDailyInvocations())
      .toBeLessThanOrEqual(BACKEND_JOB_DAILY_INVOCATION_BUDGET);
    expect(
      Math.min(...BACKEND_JOB_REGISTRY.map((job) => job.cadenceMinutes)),
    ).toBeGreaterThanOrEqual(10);
  });

  it('selects due logical jobs on each orchestrator tick', () => {
    expect(isCronScheduleDueAt('0 * * * *', Date.parse('2026-06-22T10:09:00.000Z'), {
      windowMinutes: BACKEND_JOB_SCHEDULER.cadenceMinutes,
    })).toBe(true);
    expect(isCronScheduleDueAt('0 * * * *', Date.parse('2026-06-22T10:10:00.000Z'), {
      windowMinutes: BACKEND_JOB_SCHEDULER.cadenceMinutes,
    })).toBe(false);
    // generation-completions and media-preview-repair are absent throughout:
    // Vercel cron calls their own routes now, so the scheduler must not also
    // pull them into the shared invocation.
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:00:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'mobile-push-receipts',
      'workflow-run-steps',
    ]);
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:10:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'mobile-push-receipts',
      'workflow-run-steps',
    ]);
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:20:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'feed-maintenance',
      'mobile-push-receipts',
      'workflow-run-steps',
    ]);
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:40:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'mobile-push-receipts',
      'referral-reward-reconciliation',
      'workflow-run-steps',
    ]);
  });

  it('keeps literal Next.js maxDuration exports aligned with the registry', () => {
    const schedulerSource = fs.readFileSync(
      path.resolve(process.cwd(), `src/app${BACKEND_JOB_SCHEDULER.route}/route.ts`),
      'utf8',
    );

    expect(schedulerSource).toContain(`export const maxDuration = ${BACKEND_JOB_SCHEDULER.maxDurationSeconds};`);

    for (const job of BACKEND_JOB_REGISTRY) {
      const routeSource = fs.readFileSync(
        path.resolve(process.cwd(), `src/app${job.route}/route.ts`),
        'utf8',
      );

      expect(routeSource).toContain(`export const maxDuration = ${job.maxDurationSeconds};`);
    }
  });

  it('documents when cron-polled backend jobs should graduate to a durable queue', () => {
    expect(operationsRunbook).toContain('## Durable Queue Graduation Decision');
    expect(operationsRunbook).toContain('Current decision: keep the Vercel cron orchestrator');
    expect(operationsRunbook).toContain('sub-five-minute');
    expect(operationsRunbook).toContain('70% of `maxDuration`');
    expect(operationsRunbook).toContain('older than two health windows');

    for (const job of BACKEND_JOB_REGISTRY) {
      expect(operationsRunbook).toContain(`\`${job.name}\``);
    }
  });
});
