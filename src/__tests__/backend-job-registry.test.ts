import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKEND_JOB_DAILY_INVOCATION_BUDGET,
  BACKEND_JOB_REGISTRY,
  BACKEND_JOB_SCHEDULER,
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

  it('keeps Vercel cron scheduling consolidated on the backend job orchestrator', () => {
    expect(vercelConfig.crons).toEqual([{
      path: BACKEND_JOB_SCHEDULER.route,
      schedule: BACKEND_JOB_SCHEDULER.schedule,
    }]);
    expect(BACKEND_JOB_SCHEDULER.cadenceMinutes).toBe(
      getCronScheduleCadenceMinutes(BACKEND_JOB_SCHEDULER.schedule),
    );
    expect(BACKEND_JOB_SCHEDULER.dailyInvocations).toBe(
      getCronScheduleDailyInvocations(BACKEND_JOB_SCHEDULER.schedule),
    );
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
    expect(BACKEND_JOB_SCHEDULER.dailyInvocations).toBeLessThanOrEqual(BACKEND_JOB_DAILY_INVOCATION_BUDGET);
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
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:00:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'generation-completions',
      'media-preview-repair',
      'mobile-push-receipts',
      'workflow-run-steps',
    ]);
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:10:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'generation-completions',
      'mobile-push-receipts',
      'workflow-run-steps',
    ]);
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:20:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'feed-maintenance',
      'generation-completions',
      'mobile-push-receipts',
      'workflow-run-steps',
    ]);
    expect(getDueBackendJobs(Date.parse('2026-06-22T10:40:00.000Z')).map((job) => job.name)).toEqual([
      'account-deletion-resweeps',
      'backend-alert-delivery',
      'generation-completions',
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
