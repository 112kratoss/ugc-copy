import { describe, expect, it, vi } from 'vitest';

import type { BackendAlertSummary } from '@/lib/backend-alerts';
import type { BackendCostReport } from '@/lib/backend-cost-report';
import type { BackendHealth } from '@/lib/backend-health';
import type { BackendModerationHealth } from '@/lib/backend-moderation-health';
import {
  buildBackendOpsDashboard,
  collectBackendOpsDashboard,
} from '@/lib/backend-ops-dashboard';
import type { KieBalanceStatus } from '@/lib/kie-account-balance-alert';

const backendHealth = {
  status: 'degraded',
  checkedAt: '2026-06-23T10:00:00.000Z',
  buildId: 'build-123',
  environment: { status: 'ok', missing: [] },
  scheduler: { status: 'ok', dailyInvocations: 144, coveredJobCount: 4 },
  jobs: [
    { name: 'generation-completions', status: 'ok' },
    { name: 'backend-alert-delivery', status: 'warning' },
  ],
  issues: [
    {
      severity: 'degraded',
      code: 'GENERATION_STALLED_ACTIVE',
      message: '1 active generation is stalled.',
    },
  ],
} as unknown as BackendHealth;

const backendCosts = {
  status: 'warning',
  checkedAt: '2026-06-23T10:00:00.000Z',
  window: { recentHours: 24, since: '2026-06-22T10:00:00.000Z' },
  generationSpend: { recentRuns: 8, recentCreditCost: 96, failedPaidCreditCost: 12 },
  aiUsageSpend: { recentEvents: 4, recentCreditCost: 18 },
  providerDependencies: { recentEvents: 7, failedCount: 2, slowCount: 1 },
  rateLimitPressure: { quoteRequests: 20, mediaReadRequests: 40 },
  storageGrowth: { recentObjectCount: 5, recentBytes: 1024 },
  issues: [
    {
      severity: 'warning',
      code: 'PROVIDER_DEPENDENCY_FAILURES',
      message: 'Provider failures exceeded warning threshold.',
    },
  ],
} as unknown as BackendCostReport;

const backendModeration = {
  status: 'warning',
  checkedAt: '2026-06-23T10:00:00.000Z',
  queue: {
    postReportCount: 7,
    subjectReportCount: 3,
    totalOpenCount: 10,
    oldestCreatedAt: '2026-06-23T04:00:00.000Z',
    oldestAgeMinutes: 360,
  },
  issues: [
    {
      severity: 'warning',
      code: 'MODERATION_QUEUE_AGE_WARNING',
      message: 'The moderation queue is ageing.',
    },
  ],
} as unknown as BackendModerationHealth;

const backendAlerts = {
  status: 'degraded',
  checkedAt: '2026-06-23T10:00:00.000Z',
  buildId: 'build-123',
  signals: {
    healthStatus: 'degraded',
    costStatus: 'warning',
    costWindowHours: 24,
    moderationStatus: 'warning',
    moderationOpenCount: 10,
    moderationOldestAgeMinutes: 360,
  },
  counts: { total: 2, degraded: 1, warning: 1 },
  delivery: {
    severity: 'degraded',
    title: 'Backend alerts degraded',
    summary: 'GENERATION_STALLED_ACTIVE: 1 active generation is stalled.',
    dedupeKey: 'backend-alerts:degraded:GENERATION_STALLED_ACTIVE',
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
  alerts: [],
} as unknown as BackendAlertSummary;

describe('backend ops dashboard', () => {
  it('builds dashboard panels from health, costs, and alerts', () => {
    const dashboard = buildBackendOpsDashboard({
      health: backendHealth,
      costs: backendCosts,
      alerts: backendAlerts,
      checkedAt: '2026-06-23T10:01:00.000Z',
    });

    expect(dashboard).toMatchObject({
      status: 'degraded',
      checkedAt: '2026-06-23T10:01:00.000Z',
      buildId: 'build-123',
      sources: {
        health: '/api/ops/backend-health',
        costs: '/api/ops/backend-costs',
        alerts: '/api/ops/backend-alerts',
      },
      panels: [
        {
          id: 'health',
          title: 'Backend health',
          status: 'degraded',
          href: '/api/ops/backend-health',
          issueCount: 1,
        },
        {
          id: 'costs',
          title: 'Backend costs',
          status: 'warning',
          href: '/api/ops/backend-costs',
          issueCount: 1,
        },
        {
          id: 'alerts',
          title: 'Backend alerts',
          status: 'degraded',
          href: '/api/ops/backend-alerts',
          issueCount: 2,
        },
      ],
      alertDelivery: {
        severity: 'degraded',
        dedupeKey: 'backend-alerts:degraded:GENERATION_STALLED_ACTIVE',
      },
    });
  });

  it('collects health, costs, and moderation once and derives the alert summary from them', async () => {
    const collectHealth = vi.fn(async () => backendHealth);
    const collectCosts = vi.fn(async () => backendCosts);
    const collectModeration = vi.fn(async () => backendModeration);
    const client = { service: 'supabase' };
    const now = new Date('2026-06-23T10:02:00.000Z');

    const dashboard = await collectBackendOpsDashboard(client as never, {
      now,
      collectHealth,
      collectCosts,
      collectModeration,
    });

    expect(dashboard.status).toBe('degraded');
    expect(dashboard.alertDelivery.severity).toBe('degraded');
    expect(collectHealth).toHaveBeenCalledWith(client, now);
    expect(collectCosts).toHaveBeenCalledWith(client, now);
    expect(collectModeration).toHaveBeenCalledWith(client, now);
  });

  const lowKieBalance: KieBalanceStatus = {
    available: true,
    error: null,
    thresholdCredits: 2000,
    recoveryCredits: 2200,
    episodeLevel: 'low',
    credits: 845.32,
    observedAt: '2026-10-20T06:00:00.000Z',
    lastCheckedAt: '2026-10-20T06:10:00.000Z',
    lastCheckError: null,
    consecutiveFailures: 0,
    episodeStartedAt: '2026-10-20T06:00:00.000Z',
  };

  it('shows the last observed Kie balance as its own panel, without ever degrading the dashboard', () => {
    const quietHealth = { ...backendHealth, status: 'ok', issues: [] } as unknown as BackendHealth;
    const quietCosts = { ...backendCosts, status: 'ok', issues: [] } as unknown as BackendCostReport;
    const quietAlerts = {
      ...backendAlerts,
      status: 'ok',
      counts: { total: 0, degraded: 0, warning: 0 },
    } as unknown as BackendAlertSummary;

    const low = buildBackendOpsDashboard({
      health: quietHealth,
      costs: quietCosts,
      alerts: quietAlerts,
      kieBalance: lowKieBalance,
      checkedAt: '2026-10-20T06:11:00.000Z',
    });

    expect(low.status).toBe('warning');
    expect(low.panels.map((panel) => panel.id)).toEqual(['health', 'costs', 'alerts', 'kie-balance']);
    expect(low.panels[3]).toMatchObject({
      id: 'kie-balance',
      title: 'Kie credit balance',
      status: 'warning',
      issueCount: 1,
      metrics: {
        balanceCredits: 845.32,
        thresholdCredits: 2000,
        episodeLevel: 'low',
        observedAt: '2026-10-20T06:00:00.000Z',
        lastCheckedAt: '2026-10-20T06:10:00.000Z',
        lastCheckError: null,
      },
    });
    expect(low.panels[3].summary).toContain('845.32');

    // Generations failing for want of Kie credits is still a warning here: the
    // dashboard answers 503 only for backend degradation, and a top-up is an
    // owner action, not a fault the backend can clear.
    const exhausted = buildBackendOpsDashboard({
      health: quietHealth,
      costs: quietCosts,
      alerts: quietAlerts,
      kieBalance: { ...lowKieBalance, episodeLevel: 'exhausted', credits: 3 },
    });
    expect(exhausted.status).toBe('warning');

    const healthy = buildBackendOpsDashboard({
      health: quietHealth,
      costs: quietCosts,
      alerts: quietAlerts,
      kieBalance: { ...lowKieBalance, episodeLevel: 'ok', credits: 25_000, episodeStartedAt: null },
    });
    expect(healthy.status).toBe('ok');
    expect(healthy.panels[3]).toMatchObject({ status: 'ok', issueCount: 0 });
  });

  it('collects the Kie balance panel alongside the other collectors, and survives it failing', async () => {
    const now = new Date('2026-10-20T06:12:00.000Z');
    const collectKieBalance = vi.fn(async () => lowKieBalance);

    const dashboard = await collectBackendOpsDashboard({ service: 'supabase' } as never, {
      now,
      collectHealth: vi.fn(async () => backendHealth),
      collectCosts: vi.fn(async () => backendCosts),
      collectModeration: vi.fn(async () => backendModeration),
      collectKieBalance,
    });

    expect(collectKieBalance).toHaveBeenCalledTimes(1);
    expect(dashboard.panels.find((panel) => panel.id === 'kie-balance')).toMatchObject({
      status: 'warning',
      metrics: { balanceCredits: 845.32 },
    });

    // The default collector reads the job's own run rows; a client that cannot
    // read them leaves the panel unavailable rather than failing the dashboard.
    const unreadable = await collectBackendOpsDashboard({ service: 'supabase' } as never, {
      now,
      collectHealth: vi.fn(async () => backendHealth),
      collectCosts: vi.fn(async () => backendCosts),
      collectModeration: vi.fn(async () => backendModeration),
    });
    expect(unreadable.panels.find((panel) => panel.id === 'kie-balance')).toMatchObject({
      status: 'warning',
      metrics: { balanceCredits: null },
    });
  });
});
