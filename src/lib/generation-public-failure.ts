export type GenerationStartFailureCode =
  | 'insufficient_credits'
  | 'invalid_input_media'
  | 'service_misconfigured'
  | 'provider_busy'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'submission_pending'
  | 'prompt_blocked';

/** Shown when `generation-prompt-safety` refuses a prompt; kept here so client
 * code can reuse the copy without bundling the rules. */
export const GENERATION_PROMPT_BLOCKED_MESSAGE =
  'Magicbooklet can’t create this. We don’t make nude, undressed or see-through images of people, '
  + 'or anything sexual involving minors. Edit your prompt and try again. No credits were used.';

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
  'prompt_blocked',
]);

/**
 * Marks an error whose generation was *held* rather than refunded (F14).
 *
 * The copy follows confirmed state, not the error shape. Both standalone and
 * template starts retain ambiguous reservations. If the marker write cannot
 * be confirmed, carry recovery metadata with cautious status-only copy rather
 * than promising reserved credits from an unconfirmed database response.
 *
 * Non-enumerable so the flag never leaks into a serialized error payload.
 */
const HELD_SUBMISSION_FLAG = '__magicbookletHeldSubmission';
const HELD_SUBMISSION_GENERATION_ID = '__magicbookletHeldGenerationId';
const UNCONFIRMED_SUBMISSION_FLAG = '__magicbookletUnconfirmedSubmission';

export function markHeldProviderSubmission(
  error: unknown,
  generationId?: string | null,
  options: { confirmed?: boolean } = {},
): void {
  if (!error || typeof error !== 'object') return;
  Object.defineProperty(error, UNCONFIRMED_SUBMISSION_FLAG, {
    value: options.confirmed === false, enumerable: false, configurable: true, writable: true,
  });
  Object.defineProperty(error, HELD_SUBMISSION_FLAG, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  if (generationId?.trim()) {
    Object.defineProperty(error, HELD_SUBMISSION_GENERATION_ID, {
      value: generationId.trim(),
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
}

/** Server-only workflow recovery metadata. Non-enumerable on the originating
 * error so API serializers never expose internal generation identifiers. */
export function getHeldProviderSubmissionGenerationId(error: unknown): string | null {
  if (!isHeldProviderSubmission(error) || !error || typeof error !== 'object') return null;
  const value = (error as Record<string, unknown>)[HELD_SUBMISSION_GENERATION_ID];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isHeldProviderSubmission(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as Record<string, unknown>)[HELD_SUBMISSION_FLAG] === true,
  );
}

const REFUNDED_START_GENERATION_ID = '__magicbookletRefundedStartGenerationId';

/**
 * Marks an error whose generation was failed and refunded at start: the
 * opposite outcome to a held submission, and never set together with it.
 *
 * The start services set it only when their settlement released the hold
 * itself. A request that started the generation answers with the error and
 * has no use for the mark. A run worker has nobody to answer, and reads it to
 * announce the failure if the step ends there.
 *
 * Non-enumerable for the same reason as the held-submission metadata.
 */
export function markRefundedGenerationStart(error: unknown, generationId: string): void {
  if (!error || typeof error !== 'object') return;
  Object.defineProperty(error, REFUNDED_START_GENERATION_ID, {
    value: generationId,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/** The generation a refused start failed and refunded, when the error carries one. */
export function getRefundedStartGenerationId(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const value = (error as Record<string, unknown>)[REFUNDED_START_GENERATION_ID];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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
    if (recordValue(error, [UNCONFIRMED_SUBMISSION_FLAG]) === true) {
      return {
        code: 'submission_pending',
        message: 'We could not confirm the current status of this request. It may still be running. Check Studio in a few minutes before starting it again.',
      };
    }
    return {
      code: 'submission_pending',
      message: 'We could not confirm this request with the generation provider in time. It may still be running — check Studio in a few minutes. Your credits stay reserved until it resolves, and are returned automatically if it does not.',
    };
  }

  const status = errorStatus(error);
  const message = normalizedSignal(errorMessage(error));
  const code = normalizedSignal(errorCode(error));
  const signal = `${code} ${message}`.trim();

  if (code === 'prompt blocked') {
    return { code: 'prompt_blocked', message: GENERATION_PROMPT_BLOCKED_MESSAGE };
  }

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
