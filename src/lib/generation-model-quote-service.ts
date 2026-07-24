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

type CreateGenerationModelQuoteInput = {
  body: Partial<GenerationModelQuoteInput>;
  rateLimitKey: string;
  rateLimitClient: GenerationModelQuoteRateLimitClient;
  platform?: CatalogPlatform;
};

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

export async function createGenerationModelQuote({
  body,
  rateLimitKey,
  rateLimitClient,
  platform = 'web',
}: CreateGenerationModelQuoteInput): Promise<GenerationModelQuoteServiceResult> {
  if (!isGenerationModelKind(body.kind) || typeof body.modelId !== 'string' || !body.modelId) {
    return {
      ok: false,
      status: 422,
      code: 'INVALID_MODEL_SETTINGS',
      error: 'A valid kind and modelId are required.',
      fieldErrors: {},
    };
  }

  try {
    await enforceBackendRateLimit(rateLimitClient, {
      ...GENERATION_MODEL_QUOTE_RATE_LIMIT,
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

  try {
    return {
      ok: true,
      quote: await quotePublishedGenerationModel({
        kind: body.kind,
        modelId: body.modelId,
        schemaVersion: body.schemaVersion,
        settings: body.settings,
        inputCounts: body.inputCounts,
        inputMetadata: body.inputMetadata,
        catalogRevision: body.catalogRevision,
      }, { platform }),
    };
  } catch (error) {
    if (error instanceof CatalogError) {
      return {
        ok: false,
        status: error.status,
        code: error.code,
        error: error.message,
        fieldErrors: error.fieldErrors,
      };
    }

    console.error('Authoritative generation model catalog quote failed:', error);
    return {
      ok: false,
      status: 503,
      code: 'CATALOG_UNAVAILABLE',
      error: 'Generation pricing is temporarily unavailable. Refresh the model catalog and try again.',
      fieldErrors: {},
    };
  }
}
