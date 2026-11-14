import { AsyncLocalStorage } from 'node:async_hooks';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { logBackendWarning } from '@/lib/backend-logger';
import { createServiceClient } from '@/lib/server-helpers';
import { isExternalServiceTimeoutError } from '@/lib/provider-fetch';

/**
 * F14 part two — account-wide admission control in front of the provider.
 *
 * Per-user limiting (30 submissions per 10 minutes) never bounded the *account*:
 * a launch spike, a template fan-out, or fifty users acting at once all reach
 * Kie unthrottled. This module is the single gate every submission passes
 * through, and it lives in `createKieTask` rather than at the seven start call
 * sites for the reason the money-bug fix landed in the shared settle helper —
 * a new start path should inherit the gate rather than have to remember it.
 */

export const KIE_PROVIDER_SERVICE = 'kie';

/**
 * What Kie publishes about its own limits (kie.ai/getting-started, section 8,
 * read 2026-11-14; captured in `docs/model-api-references/kie-account-limits.md`).
 * Applied per account. A request over the rate is answered 429 and is not
 * queued. The concurrency figure is Kie's "typically", not a promise.
 */
export const KIE_PUBLISHED_ACCOUNT_LIMITS = {
  newRequestsPerWindow: 20,
  windowSeconds: 10,
  typicalConcurrentTasks: 100,
} as const;

/**
 * Our ceilings in front of the provider. The rate is a sliding window because
 * Kie's rule is one: at most `rateWindowMax` submissions in any
 * `rateWindowSeconds`. A window spends its whole count as a burst and again
 * every window after, where a token bucket has to split one budget between the
 * two: it admits capacity + refill x window, so the earlier 15 refilling at
 * 1.5/s let 30 through in ten seconds, ten more than Kie takes, and fitting it
 * under 20 would have meant a burst of 10 at 1/s or 5 at 1.5/s.
 *
 * With the margins below this is a burst of 18 (it was 15) and 1.5/s sustained
 * (unchanged), against Kie's 20 and 2/s. What is given up is the margin, and
 * what is gained is that no window of Kie's can be overrun.
 *
 * Both margins are deliberate, and `provider-admission.test.ts` holds them to
 * the published figures. The window is longer than Kie's because we stamp an
 * admission before the request leaves and Kie counts it on arrival: two bursts
 * exactly one window apart on our clock can land closer than that on Kie's, so
 * the two seconds are for transit. The count is two short of Kie's for the
 * requests this gate does not count: a replayed start reusing its reservation,
 * a start admitted while the gate's own database call failed, a model probe or
 * a script on the same account. Kie's page does not say whether its other
 * endpoints the app calls (chat completions for the prompt enhancer and the
 * workflow assistant, Seedance asset creation) draw on the same 20; if a 429
 * ever shows they do, lower `rateWindowMax` by their rate.
 */
export const PROVIDER_ADMISSION_POLICY = {
  rateWindowSeconds: 12,
  rateWindowMax: 18,
  /**
   * A single model cannot take the whole account window: a third of it stays
   * open to every other model. Ours, not Kie's, whose limit is per account.
   */
  modelRateWindowMax: 12,
  /**
   * Half of what Kie typically runs at once. This one protects our side: every
   * finished task comes back as a callback that imports media, and 48 at once
   * is what the certification run proved. Raise it with that run, not a hunch.
   */
  maxInFlight: 50,
  /**
   * Only recent work counts toward the concurrency cap. Counting every
   * non-terminal row would let a few permanently stuck generations wedge
   * submissions account-wide; the 45-minute reaper is what clears strays, so an
   * hour window comfortably covers live work without inheriting the backlog.
   */
  inFlightWindowSeconds: 3600,
  failureThreshold: 5,
  circuitOpenSeconds: 60,
  probeTimeoutSeconds: 60,
  /**
   * How long a run may stay queued before it is refunded and its creator told.
   * The limits it waits on clear in seconds, so this is a safety bound, not an
   * expected wait. It has to stay far inside the hour the signed input links
   * in a stored request last, and inside the reaper's 45 minutes, which would
   * otherwise settle the run from under the queue.
   */
  queueMaxAgeMs: 10 * 60 * 1000,
  /**
   * The most runs the queue holds, and the most of one creator's. Past either
   * a start is refused and refunded at once, as every over-limit start once
   * was: a queue that cannot drain inside `queueMaxAgeMs` only holds credits.
   */
  queueMax: 200,
  queueUserMax: 4,
  /**
   * How long the request that queued a run goes on asking for its place after
   * it has answered (Next's `after`). Under the 300 s the route is given, with
   * room to create the provider task once the place comes.
   */
  queueDriveBudgetMs: 240_000,
  /**
   * How often the request that queued a run looks at the head of the queue
   * again while it waits for its run's turn.
   */
  queuePollMs: 2_000,
  /**
   * How long one ask of the gate may take before it is given up as
   * unanswered: a start's own request is waiting on it.
   */
  askTimeoutMs: 10_000,
} as const;

/** The refusals a place clears by itself: worth queueing a run for. The breaker's are not. */
const WAITABLE_REASONS: ReadonlySet<string> = new Set(['rate_limited', 'model_rate_limited', 'max_in_flight']);

type AdmissionScope =
  /** A creator's start: over the limits it is queued, not refused. */
  | { kind: 'queue' }
  /** A run step: it is neither queued nor held, and its turn dates from when it was first turned away. */
  | { kind: 'turn'; sinceMs: number | null };

const admissionScope = new AsyncLocalStorage<AdmissionScope>();

/**
 * Runs a start that may be queued when the provider's limits are full.
 *
 * Queueing is something the caller asks for, never the default: it changes
 * what the start answers (a run that is not sent yet), so only a caller that
 * can say so to whoever is waiting opens this. A template or workflow step
 * has a durable retry of its own; it starts outside this scope, is refused at
 * once as before, and comes back later.
 */
export function withProviderSubmissionQueue<T>(run: () => T): T {
  return admissionScope.run({ kind: 'queue' }, run);
}

/** Whether the start running now may be queued: only inside `withProviderSubmissionQueue`. */
export function providerSubmissionMayQueue(): boolean {
  return admissionScope.getStore()?.kind === 'queue';
}

/**
 * Runs a run step's start, which keeps its place in the line by date rather
 * than by ticket.
 *
 * A step is not queued here: its worker's time is shared, and a busy step is
 * put back and retried for up to thirty minutes. With no ticket it would be
 * behind every queued creator, on every retry, for as long as creators keep
 * arriving. `firstRefusedAtMs` is when the provider first
 * turned the step away (null on its first try): the line puts it behind only
 * the tickets older than that. It holds no place while it is away, and when it
 * comes back it is the one that has waited longest.
 */
export function withProviderAdmissionTurn<T>(firstRefusedAtMs: number | null, run: () => T): T {
  const sinceMs = typeof firstRefusedAtMs === 'number' && Number.isFinite(firstRefusedAtMs)
    ? firstRefusedAtMs
    : null;
  return admissionScope.run({ kind: 'turn', sinceMs }, run);
}

/** When the run step starting now was first turned away, if it is one and it was. */
export function providerAdmissionTurnSinceMs(): number | null {
  const scope = admissionScope.getStore();
  return scope?.kind === 'turn' ? scope.sinceMs : null;
}

export type ProviderAdmissionReason =
  | 'admitted'
  | 'circuit_probe'
  | 'circuit_open'
  | 'circuit_probe_in_flight'
  | 'max_in_flight'
  | 'rate_limited'
  | 'model_rate_limited';

export type ProviderAdmissionVerdict = {
  allowed: boolean;
  reason: ProviderAdmissionReason;
  state: string;
  retryAfterSeconds: number;
  inFlight: number | null;
  /** Starts ahead of this one in the line when it asked. */
  waitersAhead: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeVerdict(value: unknown): ProviderAdmissionVerdict {
  if (!isRecord(value)) throw new Error('Provider admission response was invalid');
  const inFlight = Number(value.inFlight);
  const waitersAhead = Number(value.waitersAhead);
  return {
    allowed: value.allowed === true,
    reason: (typeof value.reason === 'string' ? value.reason : 'admitted') as ProviderAdmissionReason,
    state: typeof value.state === 'string' ? value.state : 'closed',
    retryAfterSeconds: Math.max(0, Number(value.retryAfterSeconds ?? 0)),
    inFlight: Number.isFinite(inFlight) ? inFlight : null,
    waitersAhead: value.waitersAhead != null && Number.isFinite(waitersAhead) ? waitersAhead : null,
  };
}

const REJECTION_MESSAGES: Record<string, string> = {
  circuit_open: 'The generation provider is not accepting requests right now. No credits were charged. Please retry shortly.',
  circuit_probe_in_flight: 'The generation provider is recovering. No credits were charged. Please retry shortly.',
  max_in_flight: 'Too many generations are already running. No credits were charged. Please retry once some finish.',
  rate_limited: 'The generation provider is busy right now. No credits were charged. Please retry shortly.',
  model_rate_limited: 'This model is busy right now. No credits were charged. Please retry shortly.',
};

type ProviderAdmissionAnswer = { data: unknown; error: unknown };

type ProviderAdmissionClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<ProviderAdmissionAnswer>;
};

/** One ask, given up after `askTimeoutMs` where the client can be told to (supabase-js can). */
function askWithTimeout(call: PromiseLike<ProviderAdmissionAnswer>): PromiseLike<ProviderAdmissionAnswer> {
  const abortable = call as PromiseLike<ProviderAdmissionAnswer> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<ProviderAdmissionAnswer>;
  };
  return typeof abortable.abortSignal === 'function'
    ? abortable.abortSignal(AbortSignal.timeout(PROVIDER_ADMISSION_POLICY.askTimeoutMs))
    : call;
}

/** An ask that ran into its time limit, as supabase-js reports the abort. */
const ASK_TIMED_OUT = /TimeoutError|AbortError|operation was aborted/i;

/**
 * Asks the gate for the submission's place, once, and throws when it has none
 * and may not be queued.
 *
 * Two answers to "the limits are full":
 *
 * - A start that may not be queued (a run step, or anything outside
 *   `withProviderSubmissionQueue`) is refused: a 429 its caller refunds.
 * - A creator's start (`mayQueue`), and whatever later asks for a queued run's
 *   turn, gets the refusal back as a verdict, `allowed: false`, for its caller
 *   to queue the run on or leave it queued.
 *
 * The line it is asked behind is the database's: the queue of starts waiting
 * to be sent, in the order they were queued (`reserve_provider_submission`). A
 * queued run's turn is read from its own row there. A run step keeps no place
 * in that queue; its turn is `turnSinceMs`, when it was first turned away.
 *
 * The refusal is deliberately a `GenerationServiceError` with status 429 rather
 * than a bespoke type: the route services already map `.status` onto the HTTP
 * response, and `getPublicGenerationStartFailure` already resolves a 429 to
 * `provider_busy`, whose copy ("busy right now, please retry shortly") is
 * exactly right here. Correct precisely because a rejected submission *is*
 * refunded — the request never left the box, so nothing will be billed and
 * retrying is safe. That is the opposite of the held-submission case, whose
 * copy must never say "retry".
 *
 * It must also never be an `ExternalServiceTimeoutError`, or the shared settle
 * helper would hold the credits for 45 minutes instead of refunding them.
 */
export async function admitProviderSubmission(params: {
  service?: string;
  model?: string | null;
  generationId?: string | null;
  client?: ProviderAdmissionClient;
  /** Answer a capacity refusal as a verdict instead of throwing; defaults to the scope. */
  mayQueue?: boolean;
  /** When a caller that keeps no place in the queue was first turned away. Defaults to the scope's, a run step's. */
  turnSinceMs?: number | null;
}): Promise<ProviderAdmissionVerdict> {
  const service = params.service?.trim() || KIE_PROVIDER_SERVICE;
  // Only a start with a generation row can be queued: the row is what waits.
  const mayQueue = Boolean(params.generationId) && (params.mayQueue ?? providerSubmissionMayQueue());
  const turnSinceMs = params.generationId
    ? (params.turnSinceMs !== undefined ? params.turnSinceMs : providerAdmissionTurnSinceMs())
    : null;
  let verdict: ProviderAdmissionVerdict;

  try {
    const client = params.client ?? createServiceClient();
    const rpcName = params.generationId
      ? 'reserve_provider_submission'
      : 'admit_provider_submission';
    const { data, error } = await askWithTimeout(client.rpc(rpcName, {
      ...(params.generationId
        ? {
            p_generation_id: params.generationId,
            p_turn_since: turnSinceMs === null ? null : new Date(turnSinceMs).toISOString(),
          }
        : {}),
      p_service: service,
      p_model: params.model?.trim() || null,
      p_rate_window_seconds: PROVIDER_ADMISSION_POLICY.rateWindowSeconds,
      p_rate_window_max: PROVIDER_ADMISSION_POLICY.rateWindowMax,
      p_model_rate_window_max: PROVIDER_ADMISSION_POLICY.modelRateWindowMax,
      p_max_in_flight: PROVIDER_ADMISSION_POLICY.maxInFlight,
      p_in_flight_window_seconds: PROVIDER_ADMISSION_POLICY.inFlightWindowSeconds,
      p_circuit_open_seconds: PROVIDER_ADMISSION_POLICY.circuitOpenSeconds,
      p_probe_timeout_seconds: PROVIDER_ADMISSION_POLICY.probeTimeoutSeconds,
    }));

    if (error) {
      if (error instanceof Error) throw error;
      throw new Error(isRecord(error) && typeof error.message === 'string' ? error.message : String(error));
    }
    verdict = normalizeVerdict(data);
  } catch (admissionError) {
    const message = admissionError instanceof Error
      ? `${admissionError.name}: ${admissionError.message}`
      : String(admissionError);
    const timedOut = ASK_TIMED_OUT.test(message);
    logBackendWarning('provider_admission_unavailable', { service, timedOut, error: message });

    if (!timedOut) {
      // Fail *open* on an infrastructure problem. The gate protects the
      // provider from us; it is not a correctness boundary, and refusing every
      // generation because an admission table is unreachable — or because the
      // service-role client cannot be constructed — would convert a monitoring
      // problem into a full outage. The per-user limiter and the provider's own
      // 429s still apply.
      return {
        allowed: true, reason: 'admitted', state: 'unknown', retryAfterSeconds: 0, inFlight: null, waitersAhead: null,
      };
    }

    // The database is there and did not answer in time: the reservation is
    // waiting behind others, which is load, not an outage. Letting the start
    // through unchecked would lift every limit at the moment the gate is
    // busiest. It is treated as having no place: queued if it may be, and told
    // the provider is busy if it may not.
    verdict = {
      allowed: false, reason: 'rate_limited', state: 'unknown', retryAfterSeconds: 0, inFlight: null, waitersAhead: null,
    };
  }

  if (verdict.allowed) return verdict;

  // A run with no place yet, whose caller can keep it for later: not an error.
  if (mayQueue && WAITABLE_REASONS.has(verdict.reason)) return verdict;

  // The rejection sits deliberately outside the catch above: a genuine "not
  // admitted" verdict must never be swallowed as an infrastructure blip.
  logBackendWarning('provider_admission_rejected', {
    service,
    model: params.model ?? null,
    reason: verdict.reason,
    state: verdict.state,
    retryAfterSeconds: verdict.retryAfterSeconds,
    inFlight: verdict.inFlight,
    waitersAhead: verdict.waitersAhead,
  });

  throw new GenerationServiceError(
    REJECTION_MESSAGES[verdict.reason] ?? REJECTION_MESSAGES.rate_limited,
    429,
    'provider_busy',
  );
}

/**
 * Reads the provider's own `Retry-After`. Uncapped apart from a one-hour sanity
 * bound, unlike the retry path's 10-second cap: that cap exists to keep a
 * caller from blocking, while this value only decides how long the circuit
 * stays open, where honouring a long backoff is the whole point.
 */
export function parseProviderRetryAfterSeconds(response: { headers?: { get?: (name: string) => string | null } } | null | undefined): number {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return 0;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds), 3600);

  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, Math.round((dateMs - Date.now()) / 1000)), 3600);
  }

  return 0;
}

/**
 * Classifies whether a failed submission is the *provider's* fault.
 *
 * This is the decision that makes the breaker safe. One user's malformed
 * prompt must never open the circuit for everybody, so a 4xx other than 429 is
 * not counted, and neither is a provider body-level rejection returned under
 * HTTP 200 — that shape is how Kie reports validation errors. What counts is
 * unresponsiveness (timeout), overload (429) and server faults (5xx).
 */
export function isProviderFaultFailure(error: unknown, status?: number | null): boolean {
  if (isExternalServiceTimeoutError(error)) return true;
  if (typeof status !== 'number') return false;
  return status === 429 || status >= 500;
}

/**
 * Await the breaker write so serverless shutdown cannot discard it. The write
 * remains failure-isolated: admission telemetry must never change the result
 * of the generation it describes.
 */
export async function recordProviderSubmissionOutcome(params: {
  service?: string;
  success: boolean;
  retryAfterSeconds?: number;
  client?: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
}): Promise<void> {
  const service = params.service?.trim() || KIE_PROVIDER_SERVICE;

  try {
    const client = params.client ?? createServiceClient();
    const { error } = await client.rpc('record_provider_submission_outcome', {
      p_service: service,
      p_success: params.success,
      p_failure_threshold: PROVIDER_ADMISSION_POLICY.failureThreshold,
      p_circuit_open_seconds: PROVIDER_ADMISSION_POLICY.circuitOpenSeconds,
      p_retry_after_seconds: Math.max(0, Math.round(params.retryAfterSeconds ?? 0)) || null,
    });
    if (error) {
      logBackendWarning('provider_circuit_outcome_unrecorded', {
        service,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } catch (outcomeError) {
    logBackendWarning('provider_circuit_outcome_unrecorded', {
      service,
      error: outcomeError instanceof Error ? outcomeError.message : String(outcomeError),
    });
  }
}
