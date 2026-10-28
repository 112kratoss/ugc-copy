import {
  BackendRateLimitError,
  GENERATION_MODEL_QUOTE_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import {
  CatalogError,
  type CatalogPlatform,
  type GenerationModelKind,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { quotePublishedGenerationModel } from '@/lib/generation-model-catalog-store';
import { logBackendError } from '@/lib/backend-logger';

export type GenerationModelQuoteRateLimitClient = Parameters<typeof enforceBackendRateLimit>[0];

export type GenerationModelQuoteServiceResult =
  | {
    ok: true;
    quote: GenerationModelQuote;
  }
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

/**
 * A quote refused, as the single quote and the batch (`generation-model-quote-batch-service.ts`)
 * both answer it: the batch answers a run's refusal in the run's place, and its whole
 * request's (the limit) as the single quote does.
 */
export type GenerationModelQuoteRefusal = Extract<GenerationModelQuoteServiceResult, { ok: false }>;

type CreateGenerationModelQuoteInput = {
  body: Partial<GenerationModelQuoteInput>;
  rateLimitKey: string;
  rateLimitClient: GenerationModelQuoteRateLimitClient;
  platform?: CatalogPlatform;
};

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

/** Whether a body names a run the catalog can price: a known kind and a model id. */
export function isQuotableRun(value: unknown): value is GenerationModelQuoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<GenerationModelQuoteInput>;
  return isGenerationModelKind(run.kind) && typeof run.modelId === 'string' && run.modelId.length > 0;
}

export const INVALID_QUOTE_RUN: GenerationModelQuoteRefusal = {
  ok: false,
  status: 422,
  code: 'INVALID_MODEL_SETTINGS',
  error: 'A valid kind and modelId are required.',
  fieldErrors: {},
};

/** What of a run the catalog prices, and nothing else of the body it came in. */
export function quoteInputOf(run: GenerationModelQuoteInput): GenerationModelQuoteInput {
  return {
    kind: run.kind,
    modelId: run.modelId,
    schemaVersion: run.schemaVersion,
    settings: run.settings,
    inputCounts: run.inputCounts,
    inputMetadata: run.inputMetadata,
    catalogRevision: run.catalogRevision,
  };
}

/** The refusal of a request past its limit, or null when it may be priced. */
export async function refuseQuoteOverLimit(
  rateLimitClient: GenerationModelQuoteRateLimitClient,
  limit: Omit<Parameters<typeof enforceBackendRateLimit>[1], 'key'>,
  rateLimitKey: string,
): Promise<GenerationModelQuoteRefusal | null> {
  try {
    await enforceBackendRateLimit(rateLimitClient, { ...limit, key: rateLimitKey });
    return null;
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
}

/** A run the catalog did not price: its own refusal, or pricing not to be had now (the caller logs that). */
export function quoteRefusal(error: unknown): GenerationModelQuoteRefusal {
  if (error instanceof CatalogError) {
    return {
      ok: false,
      status: error.status,
      code: error.code,
      error: error.message,
      fieldErrors: error.fieldErrors,
    };
  }

  return {
    ok: false,
    status: 503,
    code: 'CATALOG_UNAVAILABLE',
    error: 'Generation pricing is temporarily unavailable. Refresh the model catalog and try again.',
    fieldErrors: {},
  };
}

export async function createGenerationModelQuote({
  body,
  rateLimitKey,
  rateLimitClient,
  platform = 'web',
}: CreateGenerationModelQuoteInput): Promise<GenerationModelQuoteServiceResult> {
  if (!isQuotableRun(body)) return INVALID_QUOTE_RUN;

  const overLimit = await refuseQuoteOverLimit(rateLimitClient, GENERATION_MODEL_QUOTE_RATE_LIMIT, rateLimitKey);
  if (overLimit) return overLimit;

  try {
    return { ok: true, quote: await quotePublishedGenerationModel(quoteInputOf(body), { platform }) };
  } catch (error) {
    if (!(error instanceof CatalogError)) {
      logBackendError('authoritative_generation_model_catalog_quote_failed', { error: error });
    }
    return quoteRefusal(error);
  }
}
