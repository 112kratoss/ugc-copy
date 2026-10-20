import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  collectBackendAlerts,
  type BackendAlertStatus,
  type BackendAlertSummary,
} from '@/lib/backend-alerts';
import {
  getBackendAlertDeliveryUrl,
  getBackendAlertDestinationHost,
  hasConfiguredBackendAlertDelivery,
  postBackendAlertEvent,
  shouldNotifyBackendAlertOk,
} from '@/lib/backend-alert-transport';

export { hasConfiguredBackendAlertDelivery };

export type BackendAlertDeliveryResult = {
  configured: boolean;
  delivered: boolean;
  reason?: 'not_configured' | 'no_alerts';
  alertStatus?: BackendAlertStatus;
  alertCount?: number;
  destinationHost?: string;
  responseStatus?: number;
  dedupeKey?: string;
  checkedAt?: string;
};

type BackendAlertDeliveryOptions = {
  collectAlerts?: typeof collectBackendAlerts;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: Date;
};

/** The `backend_alerts` envelope, typed by the summary it carries. */
type BackendAlertDeliveryPayload = {
  event: 'backend_alerts';
  source: 'magicbooklet-backend';
  status: BackendAlertSummary['status'];
  checkedAt: string;
  delivery: BackendAlertSummary['delivery'];
  signals: BackendAlertSummary['signals'];
  counts: BackendAlertSummary['counts'];
  monitorEndpoints: BackendAlertSummary['monitorEndpoints'];
  alerts: BackendAlertSummary['alerts'];
};

function buildDeliveryPayload(summary: BackendAlertSummary): BackendAlertDeliveryPayload {
  return {
    event: 'backend_alerts',
    source: 'magicbooklet-backend',
    status: summary.status,
    checkedAt: summary.checkedAt,
    delivery: summary.delivery,
    signals: summary.signals,
    counts: summary.counts,
    monitorEndpoints: summary.monitorEndpoints,
    alerts: summary.alerts,
  };
}

export function getBackendAlertDeliveryNotConfiguredSummary(): BackendAlertDeliveryResult {
  return {
    configured: false,
    delivered: false,
    reason: 'not_configured',
  };
}

export async function deliverBackendAlerts(
  client: SupabaseClient,
  options: BackendAlertDeliveryOptions = {},
): Promise<BackendAlertDeliveryResult> {
  const environment = options.environment ?? process.env;
  const destinationUrl = getBackendAlertDeliveryUrl(environment);
  if (!destinationUrl) {
    return getBackendAlertDeliveryNotConfiguredSummary();
  }

  const collectAlerts = options.collectAlerts ?? collectBackendAlerts;
  // The Kie balance job posts its own alert once per episode; leaving it out
  // here keeps this ten-minute push from re-sending it on every tick.
  const summary = await collectAlerts(client, {
    ...(options.now ? { now: options.now } : {}),
    includeKieBalance: false,
  });
  const baseResult = {
    configured: true,
    alertStatus: summary.status,
    alertCount: summary.counts.total,
    destinationHost: getBackendAlertDestinationHost(destinationUrl),
    dedupeKey: summary.delivery.dedupeKey,
    checkedAt: summary.checkedAt,
  };

  if (summary.status === 'ok' && !shouldNotifyBackendAlertOk(environment)) {
    return {
      ...baseResult,
      delivered: false,
      reason: 'no_alerts',
    };
  }

  const receipt = await postBackendAlertEvent(buildDeliveryPayload(summary), {
    environment,
    fetcher: options.fetcher,
  });

  return {
    ...baseResult,
    delivered: true,
    responseStatus: receipt.responseStatus,
  };
}
