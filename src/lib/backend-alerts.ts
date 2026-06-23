import type { SupabaseClient } from '@supabase/supabase-js';

import {
  collectBackendCostReport,
  type BackendCostReport,
  type BackendCostReportIssue,
  type BackendCostReportStatus,
} from '@/lib/backend-cost-report';
import {
  collectBackendHealth,
  type BackendHealth,
  type BackendHealthIssue,
  type BackendHealthStatus,
} from '@/lib/backend-health';

export type BackendAlertSeverity = 'warning' | 'degraded';
export type BackendAlertSource = 'health' | 'costs';
export type BackendAlertStatus = 'ok' | BackendAlertSeverity;

export type BackendAlert = {
  source: BackendAlertSource;
  severity: BackendAlertSeverity;
  code: string;
  message: string;
};

export type BackendAlertDeliveryPayload = {
  severity: BackendAlertStatus;
  title: string;
  summary: string;
  dedupeKey: string;
  runbookPath: string;
  monitorEndpoints: string[];
};

export type BackendAlertSummary = {
  status: BackendAlertStatus;
  checkedAt: string;
  buildId: string;
  signals: {
    healthStatus: BackendHealthStatus;
    costStatus: BackendCostReportStatus;
    costWindowHours: number;
  };
  counts: {
    total: number;
    degraded: number;
    warning: number;
  };
  delivery: BackendAlertDeliveryPayload;
  monitorEndpoints: string[];
  alerts: BackendAlert[];
};

type BuildBackendAlertSummaryInput = {
  health: BackendHealth;
  costs: BackendCostReport;
  checkedAt?: string;
};

type CollectBackendAlertsOptions = {
  now?: Date;
  collectHealth?: (client: SupabaseClient, now: Date) => Promise<BackendHealth>;
  collectCosts?: (client: SupabaseClient, now: Date) => Promise<BackendCostReport>;
};

const MONITOR_ENDPOINTS = [
  '/api/ops/backend-health',
  '/api/ops/backend-costs',
  '/api/ops/backend-alerts',
];

function maxStatus(statuses: BackendAlertStatus[]): BackendAlertStatus {
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

function toAlerts(
  source: BackendAlertSource,
  issues: Array<BackendHealthIssue | BackendCostReportIssue>,
): BackendAlert[] {
  return issues.map((issue) => ({
    source,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
  }));
}

function buildDeliveryPayload(
  status: BackendAlertStatus,
  counts: BackendAlertSummary['counts'],
  alerts: BackendAlert[],
): BackendAlertDeliveryPayload {
  if (status === 'ok') {
    return {
      severity: 'ok',
      title: 'Backend alerts ok',
      summary: 'No backend health or cost alerts.',
      dedupeKey: 'backend-alerts:ok',
      runbookPath: 'docs/production-deployment-runbook.md#alert-response-guide',
      monitorEndpoints: MONITOR_ENDPOINTS,
    };
  }

  const alertCodes = alerts.map((alert) => alert.code).join(',');
  const alertSummary = alerts
    .map((alert) => `${alert.code}: ${alert.message}`)
    .join(' | ');

  return {
    severity: status,
    title: `Backend alerts ${status}: ${counts.degraded} degraded, ${counts.warning} warning`,
    summary: alertSummary,
    dedupeKey: `backend-alerts:${status}:${alertCodes}`,
    runbookPath: 'docs/production-deployment-runbook.md#alert-response-guide',
    monitorEndpoints: MONITOR_ENDPOINTS,
  };
}

export function buildBackendAlertSummary({
  health,
  costs,
  checkedAt = new Date().toISOString(),
}: BuildBackendAlertSummaryInput): BackendAlertSummary {
  const alerts = [
    ...toAlerts('health', health.issues),
    ...toAlerts('costs', costs.issues),
  ];
  const degraded = alerts.filter((alert) => alert.severity === 'degraded').length;
  const warning = alerts.filter((alert) => alert.severity === 'warning').length;
  const status = maxStatus([health.status, costs.status, ...alerts.map((alert) => alert.severity)]);
  const counts = {
    total: alerts.length,
    degraded,
    warning,
  };

  return {
    status,
    checkedAt,
    buildId: health.buildId,
    signals: {
      healthStatus: health.status,
      costStatus: costs.status,
      costWindowHours: costs.window.recentHours,
    },
    counts,
    delivery: buildDeliveryPayload(status, counts, alerts),
    monitorEndpoints: MONITOR_ENDPOINTS,
    alerts,
  };
}

export async function collectBackendAlerts(
  client: SupabaseClient,
  options: CollectBackendAlertsOptions = {},
): Promise<BackendAlertSummary> {
  const now = options.now ?? new Date();
  const collectHealth = options.collectHealth ?? collectBackendHealth;
  const collectCosts = options.collectCosts ?? collectBackendCostReport;
  const [health, costs] = await Promise.all([
    collectHealth(client, now),
    collectCosts(client, now),
  ]);

  return buildBackendAlertSummary({
    health,
    costs,
    checkedAt: now.toISOString(),
  });
}
