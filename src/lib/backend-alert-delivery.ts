import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  collectBackendAlerts,
  type BackendAlertStatus,
  type BackendAlertSummary,
} from '@/lib/backend-alerts';
import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';

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

const ALERT_DELIVERY_SERVICE_NAME = 'Backend alert delivery';

function configuredValue(environment: NodeJS.ProcessEnv, key: string): string | null {
  const value = environment[key]?.trim();
  return value ? value : null;
}

function getAlertDeliveryUrl(environment: NodeJS.ProcessEnv): string | null {
  return configuredValue(environment, 'BACKEND_ALERT_DELIVERY_URL');
}

function shouldNotifyOk(environment: NodeJS.ProcessEnv): boolean {
  return configuredValue(environment, 'BACKEND_ALERT_DELIVERY_NOTIFY_OK') === 'true';
}

function getAlertDeliveryAuthHeader(environment: NodeJS.ProcessEnv): string | null {
  return configuredValue(environment, 'BACKEND_ALERT_DELIVERY_AUTH_HEADER');
}

function getDestinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

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

function buildDeliveryHeaders(
  summary: BackendAlertSummary,
  environment: NodeJS.ProcessEnv,
): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'User-Agent': 'MagicBookletBackendAlerts/1.0',
    'x-magicbooklet-alert-status': summary.status,
    'x-magicbooklet-alert-dedupe-key': summary.delivery.dedupeKey,
  });
  const authHeader = getAlertDeliveryAuthHeader(environment);
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }
  return headers;
}

export function hasConfiguredBackendAlertDelivery(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(getAlertDeliveryUrl(environment));
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
  const destinationUrl = getAlertDeliveryUrl(environment);
  if (!destinationUrl) {
    return getBackendAlertDeliveryNotConfiguredSummary();
  }

  const collectAlerts = options.collectAlerts ?? collectBackendAlerts;
  const summary = await collectAlerts(client, options.now ? { now: options.now } : {});
  const baseResult = {
    configured: true,
    alertStatus: summary.status,
    alertCount: summary.counts.total,
    destinationHost: getDestinationHost(destinationUrl),
    dedupeKey: summary.delivery.dedupeKey,
    checkedAt: summary.checkedAt,
  };

  if (summary.status === 'ok' && !shouldNotifyOk(environment)) {
    return {
      ...baseResult,
      delivered: false,
      reason: 'no_alerts',
    };
  }

  const response = await fetchWithProviderTimeout(
    destinationUrl,
    {
      method: 'POST',
      headers: buildDeliveryHeaders(summary, environment),
      body: JSON.stringify(buildDeliveryPayload(summary)),
    },
    EXTERNAL_API_REQUEST_TIMEOUT_MS,
    options.fetcher ?? fetch,
    ALERT_DELIVERY_SERVICE_NAME,
  );

  if (!response.ok) {
    throw new Error(`Backend alert delivery failed with status ${response.status}.`);
  }

  return {
    ...baseResult,
    delivered: true,
    responseStatus: response.status,
  };
}
