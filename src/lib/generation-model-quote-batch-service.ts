import {
  BackendRateLimitError,
  GENERATION_MODEL_QUOTE_BATCH_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  CatalogError,
  type CatalogPlatform,
  type GenerationModelKind,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { quotePublishedGenerationModels } from '@/lib/generation-model-catalog-store';
import { logBackendError } from '@/lib/backend-logger';
import type { GenerationModelQuoteRateLimitClient } from '@/lib/generation-model-quote-service';
import { GENERATION_MODEL_QUOTE_BATCH_MAX } from '../../ugc-mobile/lib/model-catalog/protocol';

// The most runs one request prices (a whole settings panel, or the whole video model
// list), shared with the clients that split a longer list.
export { GENERATION_MODEL_QUOTE_BATCH_MAX };

/** One run's answer, in the place its request had: its quote, or why the catalog refused it. */
export type GenerationModelQuoteBatchEntry =
  | { ok: true; quote: GenerationModelQuote }
  | { ok: false; status: number; code: string; error: string; fieldErrors: Record<string, string> };

export type GenerationModelQuoteBatchServiceResult =
  | { ok: true; quotes: GenerationModelQuoteBatchEntry[] }
  | {
    ok: false;
    status: number;
    code: string;
    error: string;
    fieldErrors: Record<string, string>;
    retryAfterSeconds?: number;
    limit?: number;
    remaining?: number;
    resetAt?: string;
  };

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

function isQuotableRun(value: unknown): value is GenerationModelQuoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<GenerationModelQuoteInput>;
  return isGenerationModelKind(run.kind) && typeof run.modelId === 'string' && run.modelId.length > 0;
}

const INVALID_RUN: GenerationModelQuoteBatchEntry = {
  ok: false,
  status: 422,
  code: 'INVALID_MODEL_SETTINGS',
  error: 'A valid kind and modelId are required.',
  fieldErrors: {},
};

function refusal(error: unknown): GenerationModelQuoteBatchEntry {
  if (error instanceof CatalogError) {
    return { ok: false, status: error.status, code: error.code, error: error.message, fieldErrors: error.fieldErrors };
  }
  return {
    ok: false,
    status: 503,
    code: 'CATALOG_UNAVAILABLE',
    error: 'Generation pricing is temporarily unavailable. Refresh the model catalog and try again.',
    fieldErrors: {},
  };
}

/**
 * Prices many runs in one request (`POST /api/generation-models/quotes`), each as the
 * single quote prices it: the creators price their model list and their settings with
 * it, every model and every option at once. Like the single quote it reads no identity
 * and is counted by network, but a request counts once whatever it carries, against a
 * limit of its own. Each run's answer comes back in its request's place, a refusal
 * beside the prices; only a list that is not one, or is empty or too long, is refused
 * whole.
 */
export async function createGenerationModelQuoteBatch({
  body,
  rateLimitKey,
  rateLimitClient,
  platform = 'web',
}: {
  body: unknown;
  rateLimitKey: string;
  rateLimitClient: GenerationModelQuoteRateLimitClient;
  platform?: CatalogPlatform;
}): Promise<GenerationModelQuoteBatchServiceResult> {
  const runs = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { quotes?: unknown }).quotes
    : undefined;
  if (!Array.isArray(runs) || runs.length === 0 || runs.length > GENERATION_MODEL_QUOTE_BATCH_MAX) {
    return {
      ok: false,
      status: 422,
      code: 'INVALID_QUOTE_BATCH',
      error: `Send between 1 and ${GENERATION_MODEL_QUOTE_BATCH_MAX} runs to price.`,
      fieldErrors: {},
    };
  }

  try {
    await enforceBackendRateLimit(rateLimitClient, {
      ...GENERATION_MODEL_QUOTE_BATCH_RATE_LIMIT,
      key: rateLimitKey,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return {
        ok: false,
        status: error.status,
        code: 'RATE_LIMITED',
        error: error.message,
        fieldErrors: {},
        retryAfterSeconds: error.retryAfterSeconds,
        limit: error.state.limit,
        remaining: error.state.remaining,
        resetAt: error.state.resetAt,
      };
    }
    return {
      ok: false,
      status: 500,
      code: 'RATE_LIMIT_CHECK_FAILED',
      error: 'Failed to check quote limits.',
      fieldErrors: {},
    };
  }

  const quotable = runs.flatMap((run, index) => (isQuotableRun(run) ? [{ index, run }] : []));
  const settled = await quotePublishedGenerationModels(quotable.map(({ run }) => ({
    kind: run.kind,
    modelId: run.modelId,
    schemaVersion: run.schemaVersion,
    settings: run.settings,
    inputCounts: run.inputCounts,
    inputMetadata: run.inputMetadata,
    catalogRevision: run.catalogRevision,
  })), { platform });
  const quotes: GenerationModelQuoteBatchEntry[] = runs.map(() => INVALID_RUN);
  let unavailable: unknown = null;
  settled.forEach((result, position) => {
    const { index } = quotable[position];
    if (result.status === 'fulfilled') {
      quotes[index] = { ok: true, quote: result.value };
      return;
    }
    if (!(result.reason instanceof CatalogError)) unavailable ??= result.reason;
    quotes[index] = refusal(result.reason);
  });
  // One line for a catalog that failed every run, not one per run.
  if (unavailable) logBackendError('authoritative_generation_model_catalog_quote_batch_failed', { error: unavailable });
  return { ok: true, quotes };
}
