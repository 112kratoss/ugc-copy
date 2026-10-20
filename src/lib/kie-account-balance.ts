import 'server-only';

import {
  PROVIDER_STATUS_POLL_TIMEOUT_MS,
  fetchWithProviderTimeout,
  isExternalServiceTimeoutError,
  withExternalServiceTimeout,
} from '@/lib/provider-fetch';

/**
 * Reads the Kie.ai account's prepaid credit balance.
 *
 * Every generation Magicbooklet starts is paid from this one balance. When it
 * runs out Kie refuses each start, the creator is refunded and told the
 * provider is unavailable, and nothing else in the backend can tell that apart
 * from an outage, so the `kie-account-balance` job reads it (see
 * `kie-account-balance-alert.ts`).
 *
 * The key travels only in the Authorization header. Nothing here puts it in an
 * error, a log line or a return value: errors are built from fixed text, the
 * HTTP status and Kie's numeric code, and Kie's own message is redacted of the
 * key before it is quoted.
 */

export const KIE_ACCOUNT_BALANCE_ENDPOINT = 'https://api.kie.ai/api/v1/chat/credit';
/** A read, so the status-poll budget. The job runs every ten minutes; a slow read waits for the next one. */
export const KIE_ACCOUNT_BALANCE_TIMEOUT_MS = PROVIDER_STATUS_POLL_TIMEOUT_MS;
export const KIE_ACCOUNT_BALANCE_SERVICE_NAME = 'KIE account balance';

/** Where src/lib reads the Kie key from, the same variable every generation call uses. */
const KIE_API_KEY_ENV = 'KIE_AI_API_KEY';
const MAX_QUOTED_PROVIDER_MESSAGE_LENGTH = 120;

export type KieAccountBalanceErrorReason =
  | 'not_configured'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'malformed_body'
  | 'provider_error';

export class KieAccountBalanceError extends Error {
  readonly reason: KieAccountBalanceErrorReason;
  readonly httpStatus: number | null;
  readonly providerCode: number | null;

  constructor(
    reason: KieAccountBalanceErrorReason,
    message: string,
    details: { httpStatus?: number; providerCode?: number } = {},
  ) {
    super(message);
    this.name = 'KieAccountBalanceError';
    this.reason = reason;
    this.httpStatus = details.httpStatus ?? null;
    this.providerCode = details.providerCode ?? null;
  }
}

export type KieAccountBalance = {
  credits: number;
  checkedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Kie's words for a refusal, short, on one line, and never with the key in them. */
function quoteProviderMessage(message: unknown, apiKey: string | null): string | null {
  if (typeof message !== 'string') return null;
  let text = message.replace(/\s+/g, ' ').trim();
  if (apiKey) text = text.split(apiKey).join('[redacted]');
  if (!text) return null;
  return text.length > MAX_QUOTED_PROVIDER_MESSAGE_LENGTH
    ? `${text.slice(0, MAX_QUOTED_PROVIDER_MESSAGE_LENGTH)}…`
    : text;
}

/**
 * The balance in a `{ code, msg, data }` answer. Strict: only code 200 with a
 * finite number in `data` is a balance; any other code is Kie refusing the
 * read, and anything else is malformed.
 */
export function parseKieAccountBalanceResponse(
  body: unknown,
  options: { apiKey?: string | null } = {},
): number {
  if (!isRecord(body) || typeof body.code !== 'number' || !Number.isFinite(body.code)) {
    throw new KieAccountBalanceError(
      'malformed_body',
      'Kie account balance answer was not a {code, msg, data} object.',
    );
  }

  if (body.code !== 200) {
    const quoted = quoteProviderMessage(body.msg, options.apiKey ?? null);
    throw new KieAccountBalanceError(
      'provider_error',
      `Kie refused the account balance read with code ${body.code}${quoted ? `: ${quoted}` : ''}.`,
      { providerCode: body.code },
    );
  }

  if (typeof body.data !== 'number' || !Number.isFinite(body.data)) {
    throw new KieAccountBalanceError(
      'malformed_body',
      'Kie account balance answer carried no numeric balance.',
    );
  }

  return body.data;
}

function getKieApiKey(environment: NodeJS.ProcessEnv): string | null {
  const value = environment[KIE_API_KEY_ENV]?.trim();
  return value ? value : null;
}

export function hasConfiguredKieAccountBalanceCheck(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(getKieApiKey(environment));
}

function errorName(error: unknown): string | null {
  return error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
    ? error.name
    : null;
}

export async function readKieAccountBalance(options: {
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
} = {}): Promise<KieAccountBalance> {
  const environment = options.environment ?? process.env;
  const apiKey = getKieApiKey(environment);
  if (!apiKey) {
    throw new KieAccountBalanceError('not_configured', `${KIE_API_KEY_ENV} is not configured.`);
  }

  const timeoutMs = options.timeoutMs ?? KIE_ACCOUNT_BALANCE_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  let body: unknown;
  try {
    // The request carries its own abort signal; the outer bound also covers a
    // fetcher that ignores it and a body that never finishes arriving.
    body = await withExternalServiceTimeout((async () => {
      const response = await fetchWithProviderTimeout(
        KIE_ACCOUNT_BALANCE_ENDPOINT,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            Accept: 'application/json',
          },
          cache: 'no-store',
        },
        timeoutMs,
        fetcher,
        KIE_ACCOUNT_BALANCE_SERVICE_NAME,
      );

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new KieAccountBalanceError(
          'http_error',
          `Kie account balance read answered HTTP ${response.status}.`,
          { httpStatus: response.status },
        );
      }

      try {
        return await response.json();
      } catch {
        throw new KieAccountBalanceError('malformed_body', 'Kie account balance answer was not JSON.');
      }
    })(), timeoutMs, KIE_ACCOUNT_BALANCE_SERVICE_NAME);
  } catch (error) {
    if (error instanceof KieAccountBalanceError) throw error;
    if (isExternalServiceTimeoutError(error)) {
      throw new KieAccountBalanceError('timeout', `Kie account balance read timed out after ${timeoutMs}ms.`);
    }
    const name = errorName(error);
    throw new KieAccountBalanceError(
      'network_error',
      `Kie account balance read could not reach Kie${name ? ` (${name})` : ''}.`,
    );
  }

  return {
    credits: parseKieAccountBalanceResponse(body, { apiKey }),
    checkedAt: (options.now?.() ?? new Date()).toISOString(),
  };
}
