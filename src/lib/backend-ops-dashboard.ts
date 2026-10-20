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
import {
  collectKieBalanceStatus,
  describeKieBalanceStatus,
  type KieBalanceStatus,
} from '@/lib/kie-account-balance-alert';

export type BackendOpsDashboardStatus = 'ok' | 'warning' | 'degraded';

export type BackendOpsDashboardPanel = {
  id: 'health' | 'costs' | 'alerts' | 'kie-balance';
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
  /** The Kie credit balance the `kie-account-balance` job last read; no panel without it. */
  kieBalance?: KieBalanceStatus | null;
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
  collectKieBalance?: (client: SupabaseClient) => Promise<KieBalanceStatus>;
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

/**
 * The last balance read, from the job's own run summary rather than a call to
 * Kie, so opening the dashboard costs no provider request. At most a warning:
 * the dashboard answers 503 for backend degradation, and a top-up is an owner
 * action, not a fault the backend can clear. The alert itself goes out
 * through alert delivery (kie-account-balance-alert.ts).
 */
function buildKieBalancePanel(balance: KieBalanceStatus): BackendOpsDashboardPanel {
  const status: BackendOpsDashboardStatus = (
    !balance.available || balance.episodeLevel !== 'ok' || balance.consecutiveFailures > 0
  ) ? 'warning' : 'ok';

  return {
    id: 'kie-balance',
    title: 'Kie credit balance',
    status,
    href: DASHBOARD_ENDPOINT,
    issueCount: status === 'ok' ? 0 : 1,
    summary: describeKieBalanceStatus(balance),
    metrics: {
      balanceCredits: balance.credits,
      thresholdCredits: balance.thresholdCredits,
      episodeLevel: balance.episodeLevel,
      observedAt: balance.observedAt,
      lastCheckedAt: balance.lastCheckedAt,
      lastCheckError: balance.lastCheckError,
      recoveryCredits: balance.recoveryCredits,
      consecutiveFailures: balance.consecutiveFailures,
    },
  };
}

export function buildBackendOpsDashboard({
  health,
  costs,
  alerts,
  kieBalance,
  checkedAt = new Date().toISOString(),
}: BuildBackendOpsDashboardInput): BackendOpsDashboard {
  const kieBalancePanel = kieBalance ? buildKieBalancePanel(kieBalance) : null;
  const status = maxStatus([
    health.status,
    costs.status,
    alerts.status,
    ...(kieBalancePanel ? [kieBalancePanel.status] : []),
  ]);
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
    ...(kieBalancePanel ? [kieBalancePanel] : []),
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
  const collectKieBalance = options.collectKieBalance
    ?? ((balanceClient: SupabaseClient) => collectKieBalanceStatus(balanceClient, { environment }));
  const [health, costs, moderation, kieBalance] = await Promise.all([
    collectHealth(client, now),
    collectCosts(client, now),
    collectModeration(client, now),
    collectKieBalance(client),
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
    kieBalance,
    checkedAt: now.toISOString(),
  });
}
