import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildBackendAlertSummary,
  type BackendAlertSummary,
  type BackendAlertStatus,
} from '@/lib/backend-alerts';
import {
  collectBackendCostReport,
  type BackendCostReport,
  type BackendCostReportStatus,
} from '@/lib/backend-cost-report';
import {
  collectBackendHealth,
  type BackendHealth,
  type BackendHealthStatus,
} from '@/lib/backend-health';
import {
  collectBackendModerationHealth,
  type BackendModerationHealth,
} from '@/lib/backend-moderation-health';

export type BackendOpsDashboardStatus = 'ok' | 'warning' | 'degraded';

export type BackendOpsDashboardPanel = {
  id: 'health' | 'costs' | 'alerts';
  title: string;
  status: BackendOpsDashboardStatus;
  href: string;
  issueCount: number;
  summary: string;
  metrics: Record<string, number | string | null>;
};

export type BackendOpsDashboard = {
  status: BackendOpsDashboardStatus;
  checkedAt: string;
  buildId: string;
  sources: {
    health: string;
    costs: string;
    alerts: string;
  };
  panels: BackendOpsDashboardPanel[];
  alertDelivery: BackendAlertSummary['delivery'];
  monitorEndpoints: string[];
};

type BuildBackendOpsDashboardInput = {
  health: BackendHealth;
  costs: BackendCostReport;
  alerts: BackendAlertSummary;
  checkedAt?: string;
};

type CollectBackendOpsDashboardOptions = {
  now?: Date;
  environment?: NodeJS.ProcessEnv;
  collectHealth?: (client: SupabaseClient, now: Date) => Promise<BackendHealth>;
  collectCosts?: (client: SupabaseClient, now: Date) => Promise<BackendCostReport>;
  collectModeration?: (
    client: SupabaseClient,
    now: Date,
  ) => Promise<BackendModerationHealth>;
};

const SOURCES = {
  health: '/api/ops/backend-health',
  costs: '/api/ops/backend-costs',
  alerts: '/api/ops/backend-alerts',
} as const;

const DASHBOARD_ENDPOINT = '/api/ops/backend-dashboard';

function maxStatus(
  statuses: Array<BackendHealthStatus | BackendCostReportStatus | BackendAlertStatus>,
): BackendOpsDashboardStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function panelSummary(status: BackendOpsDashboardStatus, issueCount: number): string {
  if (status === 'ok') return 'No active issues.';
  return `${issueCount} active ${issueCount === 1 ? 'issue' : 'issues'}.`;
}

export function buildBackendOpsDashboard({
  health,
  costs,
  alerts,
  checkedAt = new Date().toISOString(),
}: BuildBackendOpsDashboardInput): BackendOpsDashboard {
  const status = maxStatus([health.status, costs.status, alerts.status]);
  const panels: BackendOpsDashboardPanel[] = [
    {
      id: 'health',
      title: 'Backend health',
      status: health.status,
      href: SOURCES.health,
      issueCount: health.issues.length,
      summary: panelSummary(health.status, health.issues.length),
      metrics: {
        jobs: health.jobs.length,
        schedulerDailyInvocations: health.scheduler.dailyInvocations,
        missingEnvironmentCapabilities: health.environment?.missing.length ?? null,
      },
    },
    {
      id: 'costs',
      title: 'Backend costs',
      status: costs.status,
      href: SOURCES.costs,
      issueCount: costs.issues.length,
      summary: panelSummary(costs.status, costs.issues.length),
      metrics: {
        generationCreditCost: costs.generationSpend.recentCreditCost,
        aiUsageCreditCost: costs.aiUsageSpend.recentCreditCost,
        quoteRequests: costs.rateLimitPressure.quoteRequests,
        mediaReadRequests: costs.rateLimitPressure.mediaReadRequests,
        storageBytes: costs.storageGrowth.recentBytes,
      },
    },
    {
      id: 'alerts',
      title: 'Backend alerts',
      status: alerts.status,
      href: SOURCES.alerts,
      issueCount: alerts.counts.total,
      summary: alerts.delivery.summary,
      metrics: {
        total: alerts.counts.total,
        degraded: alerts.counts.degraded,
        warning: alerts.counts.warning,
        moderationOpenReports: alerts.signals.moderationOpenCount,
        moderationOldestAgeMinutes: alerts.signals.moderationOldestAgeMinutes,
      },
    },
  ];

  return {
    status,
    checkedAt,
    buildId: health.buildId,
    sources: SOURCES,
    panels,
    alertDelivery: alerts.delivery,
    monitorEndpoints: [DASHBOARD_ENDPOINT, ...alerts.monitorEndpoints],
  };
}

export async function collectBackendOpsDashboard(
  client: SupabaseClient,
  options: CollectBackendOpsDashboardOptions = {},
): Promise<BackendOpsDashboard> {
  const now = options.now ?? new Date();
  const environment = options.environment ?? process.env;
  const collectHealth = options.collectHealth
    ?? ((healthClient: SupabaseClient, healthNow: Date) => (
      collectBackendHealth(healthClient, healthNow, environment)
    ));
  const collectCosts = options.collectCosts
    ?? ((costClient: SupabaseClient, costNow: Date) => (
      collectBackendCostReport(costClient, costNow, { environment })
    ));
  const collectModeration = options.collectModeration ?? collectBackendModerationHealth;
  const [health, costs, moderation] = await Promise.all([
    collectHealth(client, now),
    collectCosts(client, now),
    collectModeration(client, now),
  ]);
  const alerts = buildBackendAlertSummary({
    health,
    costs,
    moderation,
    checkedAt: now.toISOString(),
  });

  return buildBackendOpsDashboard({
    health,
    costs,
    alerts,
    checkedAt: now.toISOString(),
  });
}
