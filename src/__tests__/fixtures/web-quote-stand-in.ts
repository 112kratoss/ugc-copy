import type { GenerationModelQuoteInput } from '@/lib/generation-model-catalog';

/**
 * The stand-in for the web creators' quote hook (`useWebGenerationModelQuote`) that the video,
 * image and motion page tests and the quote hook's own share. It answers at once, as the real
 * hook does once its request is answered: no request, no quote; a state says the request it
 * answers (`key`, as JSON). A test sets what it answers here and reads here what the page asked.
 *
 * A test file mocks the client module with it, handing over the module's own error class (the
 * stand-in cannot import the module it stands in for):
 *
 *   vi.mock('@/lib/generation-model-client', async () => {
 *     const actual = await vi.importActual<typeof import('@/lib/generation-model-client')>('@/lib/generation-model-client');
 *     const { quoteHookStandIn } = await import('./fixtures/web-quote-stand-in');
 *     return { ...actual, useWebGenerationModelQuote: quoteHookStandIn(actual.WebCatalogRequestError) };
 *   });
 */
export const quoteStandIn = {
  /** Each request the hook was given, a render at a time, and the attempt it was asked under. */
  requests: [] as Array<GenerationModelQuoteInput | null>,
  attempts: [] as number[],
  /** The answer at each attempt: a price, a quote not ready, or a failure; the last one stands after that. */
  answers: [8] as Array<number | 'pending' | 'error'>,
  /** Answers as for another request than the page asked. */
  forAnotherRequest: false,
  /** Every answer is this refusal, as for a catalog that changed under the page. */
  errorCode: null as string | null,
  /** The page's last quote request (a render without one counts). */
  lastRequest(): GenerationModelQuoteInput | null | undefined {
    return quoteStandIn.requests.at(-1);
  },
  /** The attempt the page's last quote request was asked under. */
  lastAttempt(): number | undefined {
    return quoteStandIn.attempts.at(-1);
  },
  /** Nothing asked yet, and `price` at every asking. */
  reset(price: number): void {
    quoteStandIn.requests = [];
    quoteStandIn.attempts = [];
    quoteStandIn.answers = [price];
    quoteStandIn.forAnotherRequest = false;
    quoteStandIn.errorCode = null;
  },
};

type RequestErrorClass = new (message: string, status: number, code?: string) => Error;

export function quoteHookStandIn(RequestError: RequestErrorClass) {
  return (request: GenerationModelQuoteInput | null, _accessToken?: string | null, attempt = 0) => {
    void _accessToken;
    quoteStandIn.requests.push(request);
    quoteStandIn.attempts.push(attempt);
    if (!request) return { status: 'idle' as const, quote: null, error: null, key: null };
    const key = JSON.stringify(quoteStandIn.forAnotherRequest ? { ...request, modelId: 'another-model' } : request);
    if (quoteStandIn.errorCode) {
      return { status: 'error' as const, quote: null, error: new RequestError('The model catalog changed.', 409, quoteStandIn.errorCode), key };
    }
    const answer = quoteStandIn.answers[Math.min(attempt, quoteStandIn.answers.length - 1)];
    if (answer === 'pending') return { status: 'pending' as const, quote: null, error: null, key };
    if (answer === 'error') {
      return { status: 'error' as const, quote: null, error: new RequestError('Could not calculate generation cost.', 503), key };
    }
    return {
      status: 'ready' as const,
      quote: {
        modelId: request.modelId,
        catalogRevision: request.catalogRevision ?? '',
        normalizedSettings: {},
        costCredits: answer,
      },
      error: null,
      key,
    };
  };
}
