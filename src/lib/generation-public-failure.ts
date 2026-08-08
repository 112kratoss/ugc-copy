export type GenerationStartFailureCode =
  | 'insufficient_credits'
  | 'invalid_input_media'
  | 'service_misconfigured'
  | 'provider_busy'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'submission_pending';

export type PublicGenerationStartFailure = Readonly<{
  code: GenerationStartFailureCode;
  message: string;
}>;

const GENERATION_START_FAILURE_CODES = new Set<GenerationStartFailureCode>([
  'insufficient_credits',
  'invalid_input_media',
  'service_misconfigured',
  'provider_busy',
  'provider_unavailable',
  'provider_rejected',
  'submission_pending',
]);

/**
 * Marks an error whose generation was *held* rather than refunded (F14).
 *
 * The copy has to follow what actually happened to the money, not the shape of
 * the error. The same `ExternalServiceTimeoutError` is refunded on the template
 * path and held on every other one, so telling them apart by error type would
 * promise "your credits stay reserved" to a user who has already been refunded.
 * The start service tags the error only once the hold is recorded.
 *
 * Non-enumerable so the flag never leaks into a serialized error payload.
 */
const HELD_SUBMISSION_FLAG = '__magicbookletHeldSubmission';

export function markHeldProviderSubmission(error: unknown): void {
  if (!error || typeof error !== 'object') return;
  Object.defineProperty(error, HELD_SUBMISSION_FLAG, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

function isHeldProviderSubmission(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as Record<string, unknown>)[HELD_SUBMISSION_FLAG] === true,
  );
}

function recordValue(error: unknown, keys: string[]): unknown {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = recordValue(error, ['message', 'error', 'detail']);
  return typeof message === 'string' ? message : '';
}

function errorStatus(error: unknown): number | null {
  const status = recordValue(error, ['status', 'statusCode', 'status_code']);
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function errorCode(error: unknown): string {
  const code = recordValue(error, ['failureCode', 'failure_code', 'code', 'errorCode', 'error_code']);
  return typeof code === 'string' || typeof code === 'number' ? String(code) : '';
}

function normalizedSignal(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasInvalidInputMediaSignal(value: string): boolean {
  const signal = normalizedSignal(value);
  if (!signal) return false;

  return [
    /(?:invalid|unsupported|corrupt(?:ed)?|unreadable|malformed) (?:input )?(?:image|media|file|upload|reference)/,
    /(?:image|media|file|upload|reference).{0,48}(?:invalid|unsupported|corrupt(?:ed)?|unreadable|malformed|too small|too large)/,
    /(?:dimension|dimensions|resolution).{0,40}(?:invalid|unsupported|minimum|at least|too small|too low|low)/,
    /(?:minimum|invalid) (?:image )?(?:width|height|dimensions|resolution)/,
    /unsupported (?:image )?(?:format|file type|mime type)/,
    /(?:failed|unable) to decode (?:the )?(?:image|media|file|upload)/,
    /(?:image|media|file|upload) validation failed/,
    /(?:no|zero|0) valid (?:images?|media|files?|uploads?)/,
    /could not read one of the uploads/,
  ].some((pattern) => pattern.test(signal));
}

export function normalizeGenerationStartFailureCode(value: unknown): GenerationStartFailureCode | null {
  return typeof value === 'string' && GENERATION_START_FAILURE_CODES.has(value as GenerationStartFailureCode)
    ? value as GenerationStartFailureCode
    : null;
}

/** Returns true only for deterministic media failures that need a replacement
 * upload. A known structured code wins over message heuristics. */
export function requiresReplacementGenerationInput(input: {
  code?: unknown;
  message?: string | null;
}): boolean {
  const code = normalizeGenerationStartFailureCode(input.code);
  if (code) return code === 'invalid_input_media';
  return hasInvalidInputMediaSignal(input.message ?? '');
}

/** Consumer-safe provider failure copy. Never returns provider payloads, URLs,
 * private prompts, or model identifiers. */
export function getPublicGenerationStartFailure(error: unknown): PublicGenerationStartFailure {
  // First, because it is the only branch that describes what happened to the
  // user's credits rather than what the provider said. Deliberately never says
  // "retry": a retry here starts a second generation and places a second hold
  // while the first submission may still be accepted and billed.
  if (isHeldProviderSubmission(error)) {
    return {
      code: 'submission_pending',
      message: 'We could not confirm this request with the generation provider in time. It may still be running — check Studio in a few minutes. Your credits stay reserved until it resolves, and are returned automatically if it does not.',
    };
  }

  const status = errorStatus(error);
  const message = normalizedSignal(errorMessage(error));
  const code = normalizedSignal(errorCode(error));
  const signal = `${code} ${message}`.trim();

  if (code === 'service misconfigured') {
    return {
      code: 'service_misconfigured',
      message: 'Generation setup is incomplete. No credits were charged for this attempt. Ask an administrator to finish the service setup before retrying.',
    };
  }

  if (status === 402 || /insufficient (?:credits?|balance)|not enough credits?/.test(signal)) {
    return {
      code: 'insufficient_credits',
      message: 'Insufficient credits for this generation step.',
    };
  }

  // Transient provider failures take precedence over media words in messages
  // such as "image generation capacity is unavailable".
  if (status === 429 || /rate.?limit|too many requests|busy|capacity|overloaded/.test(signal)) {
    return {
      code: 'provider_busy',
      message: 'The generation provider is busy right now. Please retry this step shortly.',
    };
  }

  if (
    (status !== null && status >= 500)
    || /timeout|timed out|network|fetch failed|econn|enotfound|unavailable|maintenance|service outage/.test(signal)
  ) {
    return {
      code: 'provider_unavailable',
      message: 'The generation provider is temporarily unavailable. Please retry this step shortly.',
    };
  }

  if (hasInvalidInputMediaSignal(signal)) {
    return {
      code: 'invalid_input_media',
      message: 'The generation model could not read one of the uploads. Start a new run with a clear JPEG, PNG, or WebP image at least 256×256 px.',
    };
  }

  return {
    code: 'provider_rejected',
    message: 'The generation provider could not accept this request. Check the template inputs before retrying.',
  };
}
