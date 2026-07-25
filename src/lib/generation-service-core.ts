import 'server-only';

import { logBackendError } from '@/lib/backend-logger';
import { buildKieWebhookCallbackUrl } from '@/lib/kie-webhook';
import type { GenerationStartFailureCode } from '@/lib/generation-public-failure';

/**
 * Primitives shared by every generation seam.
 *
 * These were extracted first because the settlement, provider-task,
 * output-persistence, and status-sync seams all depend on them, as do the
 * per-type start paths. Without a common home they would have had to be
 * duplicated into each new module or left behind in a file the new modules
 * import from — which would have made the split circular.
 */

export const KIE_API_KEY = process.env.KIE_AI_API_KEY;

export class GenerationServiceError extends Error {
  status: number;
  failureCode: GenerationStartFailureCode | null;

  constructor(message: string, status = 400, failureCode: GenerationStartFailureCode | null = null) {
    super(message);
    this.name = 'GenerationServiceError';
    this.status = status;
    this.failureCode = failureCode;
  }
}

export function supabaseErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function requireApiKey(): string {
  if (!KIE_API_KEY) {
    throw new Error('Server configuration error: API key missing');
  }
  return KIE_API_KEY;
}

function failKieGenerationConfiguration(
  component: 'provider_api_key' | 'callback_base_url' | 'callback_auth',
): never {
  logBackendError('generation_start_configuration_preflight_failed', { component });
  throw new GenerationServiceError(
    'Generation setup is incomplete. No credits were charged for this attempt. Ask an administrator to finish the service setup before retrying.',
    503,
    'service_misconfigured',
  );
}

/**
 * Validate every server-side dependency required to submit a durable KIE task.
 * Start services call this before storage resolution, credit RPCs, or provider
 * requests so an operator configuration error cannot reserve funds.
 */
export function requireKieGenerationConfiguration(): void {
  if (!KIE_API_KEY) {
    failKieGenerationConfiguration('provider_api_key');
  }
  if (!process.env.KIE_WEBHOOK_HMAC_KEY?.trim()) {
    failKieGenerationConfiguration('callback_auth');
  }

  try {
    buildKieWebhookCallbackUrl();
  } catch (error) {
    const component = error instanceof Error && error.message.includes('callback URL')
      ? 'callback_base_url'
      : 'callback_auth';
    failKieGenerationConfiguration(component);
  }
}

export function resolveQuotedGenerationCost(
  computedCost: number,
  quotedCostCredits?: number,
): number {
  if (quotedCostCredits === undefined) {
    return computedCost;
  }

  if (!Number.isInteger(quotedCostCredits) || quotedCostCredits < 0) {
    throw new GenerationServiceError('Invalid quoted generation cost.', 500);
  }

  return quotedCostCredits;
}
