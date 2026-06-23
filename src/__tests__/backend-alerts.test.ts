import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { buildBackendAlertSummary, collectBackendAlerts } from '@/lib/backend-alerts';
import type { BackendCostReport } from '@/lib/backend-cost-report';
import type { BackendHealth } from '@/lib/backend-health';

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
      },
      counts: {
        total: 2,
        degraded: 1,
        warning: 1,
      },
      delivery: {
        severity: 'degraded',
        title: 'Backend alerts degraded: 1 degraded, 1 warning',
        dedupeKey: 'backend-alerts:degraded:GENERATION_STALLED_ACTIVE,FAILED_PAID_GENERATIONS',
        summary: 'GENERATION_STALLED_ACTIVE: 1 active generation is stalled. | FAILED_PAID_GENERATIONS: 1 paid generation failed.',
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
      ],
    });
  });

  it('collects health and cost reports with one Supabase service client', async () => {
    const client = { service: 'supabase' };
    const collectHealth = vi.fn(async () => healthyBackend);
    const collectCosts = vi.fn(async () => quietCosts);
    const now = new Date('2026-06-22T10:00:00.000Z');

    const summary = await collectBackendAlerts(client as never, {
      now,
      collectHealth,
      collectCosts,
    });

    expect(summary.status).toBe('ok');
    expect(summary.alerts).toEqual([]);
    expect(summary.delivery).toMatchObject({
      severity: 'ok',
      title: 'Backend alerts ok',
      dedupeKey: 'backend-alerts:ok',
      summary: 'No backend health or cost alerts.',
    });
    expect(collectHealth).toHaveBeenCalledWith(client, now);
    expect(collectCosts).toHaveBeenCalledWith(client, now);
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
