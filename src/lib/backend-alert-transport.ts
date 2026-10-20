import 'server-only';

import {
  EXTERNAL_API_REQUEST_TIMEOUT_MS,
  fetchWithProviderTimeout,
} from '@/lib/provider-fetch';

/**
 * The one way an operator alert leaves the backend: a JSON POST of the
 * `backend_alerts` envelope to `BACKEND_ALERT_DELIVERY_URL`, with the status and
 * dedupe key repeated as headers so a receiver can route and group without
 * parsing the body (docs/production-deployment-runbook.md, "Production Alert
 * Delivery Wiring").
 *
 * Split out of `backend-alert-delivery.ts` so a sender that is not the
 * ten-minute summary (the Kie balance alert, which also runs behind a
 * generation request) can post the same envelope without importing the
 * health, cost and moderation collectors.
 */

export type BackendAlertEventSeverity = 'ok' | 'warning' | 'degraded';

export type BackendAlertEventDelivery = {
  severity: BackendAlertEventSeverity;
  title: string;
  summary: string;
  dedupeKey: string;
  runbookPath: string;
  monitorEndpoints: string[];
};

export type BackendAlertEventBody = {
  event: 'backend_alerts';
  source: 'magicbooklet-backend';
  status: BackendAlertEventSeverity;
  checkedAt: string;
  delivery: BackendAlertEventDelivery;
  signals: Record<string, unknown>;
  counts: { total: number; degraded: number; warning: number };
  monitorEndpoints: string[];
  alerts: Array<{
    source: string;
    severity: Exclude<BackendAlertEventSeverity, 'ok'>;
    code: string;
    message: string;
  }>;
};

export type BackendAlertEventReceipt = {
  destinationHost: string;
  responseStatus: number;
};

const ALERT_DELIVERY_SERVICE_NAME = 'Backend alert delivery';

function configuredValue(environment: NodeJS.ProcessEnv, key: string): string | null {
  const value = environment[key]?.trim();
  return value ? value : null;
}

export function getBackendAlertDeliveryUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  return configuredValue(environment, 'BACKEND_ALERT_DELIVERY_URL');
}

export function hasConfiguredBackendAlertDelivery(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(getBackendAlertDeliveryUrl(environment));
}

/** Whether the receiver has asked for `ok` events, the alert system's resolution signal. */
export function shouldNotifyBackendAlertOk(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return configuredValue(environment, 'BACKEND_ALERT_DELIVERY_NOTIFY_OK') === 'true';
}

export function getBackendAlertDestinationHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

function buildDeliveryHeaders(
  body: BackendAlertEventBody,
  environment: NodeJS.ProcessEnv,
): Headers {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'User-Agent': 'MagicBookletBackendAlerts/1.0',
    'x-magicbooklet-alert-status': body.status,
    'x-magicbooklet-alert-dedupe-key': body.delivery.dedupeKey,
  });
  const authHeader = configuredValue(environment, 'BACKEND_ALERT_DELIVERY_AUTH_HEADER');
  if (authHeader) {
    headers.set('Authorization', authHeader);
  }
  return headers;
}

/**
 * Posts one envelope. Throws when delivery is not configured, when the
 * receiver answers outside 2xx, and on a network failure or the five-second
 * timeout, so the caller can keep what it was telling for a later attempt.
 */
export async function postBackendAlertEvent(
  body: BackendAlertEventBody,
  options: { environment?: NodeJS.ProcessEnv; fetcher?: typeof fetch } = {},
): Promise<BackendAlertEventReceipt> {
  const environment = options.environment ?? process.env;
  const destinationUrl = getBackendAlertDeliveryUrl(environment);
  if (!destinationUrl) {
    throw new Error('Backend alert delivery is not configured.');
  }

  const response = await fetchWithProviderTimeout(
    destinationUrl,
    {
      method: 'POST',
      headers: buildDeliveryHeaders(body, environment),
      body: JSON.stringify(body),
    },
    EXTERNAL_API_REQUEST_TIMEOUT_MS,
    options.fetcher ?? fetch,
    ALERT_DELIVERY_SERVICE_NAME,
  );

  if (!response.ok) {
    throw new Error(`Backend alert delivery failed with status ${response.status}.`);
  }

  return {
    destinationHost: getBackendAlertDestinationHost(destinationUrl),
    responseStatus: response.status,
  };
}
