import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildBackendAlertSummary, collectBackendAlerts } from '@/lib/backend-alerts';
import type { BackendCostReport } from '@/lib/backend-cost-report';
import type { BackendHealth } from '@/lib/backend-health';
import type { BackendModerationHealth } from '@/lib/backend-moderation-health';

const operationsRunbook = fs.readFileSync(
  path.resolve(process.cwd(), 'docs/production-deployment-runbook.md'),
  'utf8',
);

const healthyBackend = {
  status: 'ok',
  checkedAt: '2026-06-22T10:00:00.000Z',
  buildId: 'build-123',
  issues: [],
} as unknown as BackendHealth;

const quietCosts = {
  status: 'ok',
  checkedAt: '2026-06-22T10:00:00.000Z',
  window: { recentHours: 24, since: '2026-06-21T10:00:00.000Z' },
  issues: [],
} as unknown as BackendCostReport;

const quietModeration = {
  status: 'ok',
  checkedAt: '2026-06-22T10:00:00.000Z',
  queue: {
    postReportCount: 0,
    subjectReportCount: 0,
    totalOpenCount: 0,
    oldestCreatedAt: null,
    oldestAgeMinutes: null,
  },
  issues: [],
} as unknown as BackendModerationHealth;

describe('backend alerts', () => {
  it('combines backend health and cost report issues into source-labelled alerts', () => {
    const summary = buildBackendAlertSummary({
      health: {
        ...healthyBackend,
        status: 'degraded',
        issues: [
          {
            severity: 'degraded',
            code: 'GENERATION_STALLED_ACTIVE',
            message: '1 active generation is stalled.',
          },
        ],
      },
      costs: {
        ...quietCosts,
        status: 'warning',
        issues: [
          {
            severity: 'warning',
            code: 'FAILED_PAID_GENERATIONS',
            message: '1 paid generation failed.',
          },
        ],
      },
      moderation: {
        ...quietModeration,
        status: 'warning',
        queue: {
          ...quietModeration.queue,
          postReportCount: 10,
          totalOpenCount: 10,
          oldestCreatedAt: '2026-06-22T04:00:00.000Z',
          oldestAgeMinutes: 360,
        },
        issues: [
          {
            severity: 'warning',
            code: 'MODERATION_QUEUE_AGE_WARNING',
            message: 'The moderation queue is ageing.',
          },
        ],
      },
      checkedAt: '2026-06-22T10:01:00.000Z',
    });

    expect(summary).toMatchObject({
      status: 'degraded',
      checkedAt: '2026-06-22T10:01:00.000Z',
      buildId: 'build-123',
      signals: {
        healthStatus: 'degraded',
        costStatus: 'warning',
        costWindowHours: 24,
        moderationStatus: 'warning',
        moderationOpenCount: 10,
        moderationOldestAgeMinutes: 360,
      },
      counts: {
        total: 3,
        degraded: 1,
        warning: 2,
      },
      delivery: {
        severity: 'degraded',
        title: 'Backend alerts degraded: 1 degraded, 2 warning',
        dedupeKey: 'backend-alerts:degraded:GENERATION_STALLED_ACTIVE,FAILED_PAID_GENERATIONS,MODERATION_QUEUE_AGE_WARNING',
        summary: 'GENERATION_STALLED_ACTIVE: 1 active generation is stalled. | FAILED_PAID_GENERATIONS: 1 paid generation failed. | MODERATION_QUEUE_AGE_WARNING: The moderation queue is ageing.',
        runbookPath: 'docs/production-deployment-runbook.md#alert-response-guide',
        monitorEndpoints: [
          '/api/ops/backend-health',
          '/api/ops/backend-costs',
          '/api/ops/backend-alerts',
        ],
      },
      monitorEndpoints: [
        '/api/ops/backend-health',
        '/api/ops/backend-costs',
        '/api/ops/backend-alerts',
      ],
      alerts: [
        {
          source: 'health',
          severity: 'degraded',
          code: 'GENERATION_STALLED_ACTIVE',
          message: '1 active generation is stalled.',
        },
        {
          source: 'costs',
          severity: 'warning',
          code: 'FAILED_PAID_GENERATIONS',
          message: '1 paid generation failed.',
        },
        {
          source: 'moderation',
          severity: 'warning',
          code: 'MODERATION_QUEUE_AGE_WARNING',
          message: 'The moderation queue is ageing.',
        },
      ],
    });
  });

  it('collects health and cost reports with one Supabase service client', async () => {
    const client = { service: 'supabase' };
    const collectHealth = vi.fn(async () => healthyBackend);
    const collectCosts = vi.fn(async () => quietCosts);
    const collectModeration = vi.fn(async () => quietModeration);
    const now = new Date('2026-06-22T10:00:00.000Z');

    const summary = await collectBackendAlerts(client as never, {
      now,
      collectHealth,
      collectCosts,
      collectModeration,
    });

    expect(summary.status).toBe('ok');
    expect(summary.alerts).toEqual([]);
    expect(summary.delivery).toMatchObject({
      severity: 'ok',
      title: 'Backend alerts ok',
      dedupeKey: 'backend-alerts:ok',
      summary: 'No backend health, cost, or moderation alerts.',
    });
    expect(collectHealth).toHaveBeenCalledWith(client, now);
    expect(collectCosts).toHaveBeenCalledWith(client, now);
    expect(collectModeration).toHaveBeenCalledWith(client, now);
  });

  it('documents production alert delivery wiring against the normalized payload', () => {
    expect(operationsRunbook).toContain('## Production Alert Delivery Wiring');
    expect(operationsRunbook).toContain('/api/ops/backend-alerts');
    expect(operationsRunbook).toContain('delivery.severity');
    expect(operationsRunbook).toContain('delivery.dedupeKey');
    expect(operationsRunbook).toContain('delivery.runbookPath');
    expect(operationsRunbook).toContain('Cache-Control: private, no-store');
  });
});
