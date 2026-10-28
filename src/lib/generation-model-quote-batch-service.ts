import { GENERATION_MODEL_QUOTE_BATCH_RATE_LIMIT } from '@/lib/backend-rate-limit';
import {
  CatalogError,
  type CatalogPlatform,
  type GenerationModelQuote,
} from '@/lib/generation-model-catalog';
import { quotePublishedGenerationModels } from '@/lib/generation-model-catalog-store';
import { logBackendError } from '@/lib/backend-logger';
import {
  INVALID_QUOTE_RUN,
  isQuotableRun,
  quoteInputOf,
  quoteRefusal,
  refuseQuoteOverLimit,
  type GenerationModelQuoteRateLimitClient,
  type GenerationModelQuoteRefusal,
} from '@/lib/generation-model-quote-service';
import { GENERATION_MODEL_QUOTE_BATCH_MAX } from '../../ugc-mobile/lib/model-catalog/protocol';

// The most runs one request prices (a whole settings panel, or the whole video model
// list), shared with the clients that split a longer list.
export { GENERATION_MODEL_QUOTE_BATCH_MAX };

/** One run's answer, in the place its request had: its quote, or why it was not priced, as the single quote says it. */
export type GenerationModelQuoteBatchEntry =
  | { ok: true; quote: GenerationModelQuote }
  | GenerationModelQuoteRefusal;

export type GenerationModelQuoteBatchServiceResult =
  | { ok: true; quotes: GenerationModelQuoteBatchEntry[] }
  | GenerationModelQuoteRefusal;

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

  const overLimit = await refuseQuoteOverLimit(rateLimitClient, GENERATION_MODEL_QUOTE_BATCH_RATE_LIMIT, rateLimitKey);
  if (overLimit) return overLimit;

  const quotable = runs.flatMap((run, index) => (isQuotableRun(run) ? [{ index, run }] : []));
  const settled = await quotePublishedGenerationModels(quotable.map(({ run }) => quoteInputOf(run)), { platform });
  const quotes: GenerationModelQuoteBatchEntry[] = runs.map(() => INVALID_QUOTE_RUN);
  let unavailable: unknown = null;
  settled.forEach((result, position) => {
    const { index } = quotable[position];
    if (result.status === 'fulfilled') {
      quotes[index] = { ok: true, quote: result.value };
      return;
    }
    if (!(result.reason instanceof CatalogError)) unavailable ??= result.reason;
    quotes[index] = quoteRefusal(result.reason);
  });
  // One line for a catalog that failed every run, not one per run.
  if (unavailable) logBackendError('authoritative_generation_model_catalog_quote_batch_failed', { error: unavailable });
  return { ok: true, quotes };
}
