import { AsyncLocalStorage } from 'node:async_hooks';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { logBackendInfo, logBackendWarning } from '@/lib/backend-logger';
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
   * How long a creator's start waits in line for a place before it is refused
   * and refunded. The limits it waits on clear in seconds: a rate-window place
   * within `rateWindowSeconds`, and with `maxInFlight` tasks running one ends
   * every few seconds. The wait is spent inside the start's own request, so it
   * has to end well before anything that would cut the request off: the app
   * abandons a start after 120 s (`GENERATION_START_TIMEOUT_MS`).
   */
  waitBudgetMs: 45_000,
  /**
   * The latest a start may still be waiting, counted from when the route took
   * the start rather than from when it reached the gate. A start can spend tens of
   * seconds preparing its inputs first (measuring reference clips, converting
   * tracks), and after the wait it still has to create the provider task (30 s
   * at most, `PROVIDER_TASK_CREATE_TIMEOUT_MS`) and attach it. A start that
   * arrives late waits for what is left of this, and one that arrives after it
   * does not wait at all. `provider-admission-wait.test.ts` holds the sum to
   * the app's timeout.
   */
  waitDeadlineMs: 75_000,
  /**
   * The same wait for a start an agent makes through the MCP server, whose
   * clients give a tool call less time than the app gives a start.
   */
  agentWaitBudgetMs: 25_000,
  /**
   * A waiting start asks again when the refusal said a place opens, and never
   * later than this: each ask is also the heartbeat that keeps its ticket
   * alive, and a place that opens for the start at the head of the line stays
   * empty until it asks.
   */
  waitPollMaxMs: 2_000,
  /**
   * How long one ask may take before it is given up as unanswered. Without it
   * a single stuck call could outlast the whole wait.
   */
  askTimeoutMs: 10_000,
  /**
   * A ticket nobody has asked on for this long no longer holds a place in the
   * line: its request died. Longer than the longest gap between two asks of a
   * live start, a pause and one ask that timed out, so a slow ask does not
   * cost a waiting start its turn.
   */
  waiterTtlSeconds: 15,
  /**
   * The longest the line gets. A start that finds this many already waiting
   * is refused at once: three rate windows of starts is all `waitBudgetMs` can
   * serve, so a place further back would be credits held for a wait that
   * cannot end well. A start with less time to wait (an agent's, or one that
   * reached the gate late) is held to the windows its own wait spans
   * (`lineMaxFor`). It also bounds what each ask reads under the gate's lock.
   */
  waitLineMax: 54,
  /**
   * The same bound for the starts of one model, which the line serves at the
   * model's share of each window, not the account's.
   */
  waitModelLineMax: 36,
} as const;

/** The refusals a place clears by itself: worth waiting in line for. The breaker's are not. */
const WAITABLE_REASONS: ReadonlySet<string> = new Set(['rate_limited', 'model_rate_limited', 'max_in_flight']);

type AdmissionScope =
  /** A creator's start: it may wait in line, for `budgetMs` and no later than its deadline. */
  | { kind: 'wait'; budgetMs: number; openedAtMs: number }
  /** A run step: it does not wait, and its turn dates from when it was first turned away. */
  | { kind: 'turn'; sinceMs: number | null };

const admissionScope = new AsyncLocalStorage<AdmissionScope>();

/**
 * Runs a start whose submission may wait in line for up to `budgetMs`.
 *
 * Waiting is something the caller asks for, never the default: only a request
 * a person is waiting on should be held open. A template or workflow step has
 * a durable retry of its own, with a backoff and a worker whose time is shared
 * by every step in its batch; it starts outside this scope, is refused at once
 * as before, and comes back later.
 */
export function withProviderAdmissionWait<T>(budgetMs: number, run: () => T): T {
  return admissionScope.run(
    { kind: 'wait', budgetMs: Math.max(0, Math.floor(budgetMs)), openedAtMs: Date.now() },
    run,
  );
}

/**
 * How long the start running now may wait in line: zero outside
 * `withProviderAdmissionWait`, and never past `waitDeadlineMs` from when that
 * scope opened, however much of its budget is left.
 */
export function providerAdmissionWaitBudgetMs(nowMs: number = Date.now()): number {
  const scope = admissionScope.getStore();
  if (scope?.kind !== 'wait') return 0;
  const untilDeadlineMs = PROVIDER_ADMISSION_POLICY.waitDeadlineMs - (nowMs - scope.openedAtMs);
  return Math.max(0, Math.min(scope.budgetMs, untilDeadlineMs));
}

/**
 * Runs a run step's start, which keeps its place in the line by date rather
 * than by ticket.
 *
 * A step does not wait in its request: its worker's time is shared, and a
 * busy step is put back and retried for up to thirty minutes. With no ticket
 * it would be behind every creator who is waiting, on every retry, for as long
 * as creators keep arriving. `firstRefusedAtMs` is when the provider first
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
  /** The start holds a ticket in the line and may ask again. */
  waiting: boolean;
  /** Live tickets ahead of this start when it asked. */
  waitersAhead: number | null;
  /** How long the start waited in line before this verdict. */
  waitedMs: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeVerdict(value: unknown): Omit<ProviderAdmissionVerdict, 'waitedMs'> {
  if (!isRecord(value)) throw new Error('Provider admission response was invalid');
  const inFlight = Number(value.inFlight);
  const waitersAhead = Number(value.waitersAhead);
  return {
    allowed: value.allowed === true,
    reason: (typeof value.reason === 'string' ? value.reason : 'admitted') as ProviderAdmissionReason,
    state: typeof value.state === 'string' ? value.state : 'closed',
    retryAfterSeconds: Math.max(0, Number(value.retryAfterSeconds ?? 0)),
    inFlight: Number.isFinite(inFlight) ? inFlight : null,
    waiting: value.waiting === true,
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

/** One ask, given up after `limitMs` where the client can be told to (supabase-js can). */
function askWithTimeout(
  call: PromiseLike<ProviderAdmissionAnswer>,
  limitMs: number,
): PromiseLike<ProviderAdmissionAnswer> {
  const abortable = call as PromiseLike<ProviderAdmissionAnswer> & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<ProviderAdmissionAnswer>;
  };
  return typeof abortable.abortSignal === 'function'
    ? abortable.abortSignal(AbortSignal.timeout(limitMs))
    : call;
}

/** An ask that ran into its time limit, as supabase-js reports the abort. */
const ASK_TIMED_OUT = /TimeoutError|AbortError|operation was aborted/i;

/**
 * The time limit of the last ask a waiting start makes, as its budget runs
 * out: enough for a healthy database to answer, and the most the wait can run
 * past its budget.
 */
const WAIT_LAST_ASK_MS = 2_000;

/**
 * How long a line a start with `budgetMs` to wait may join: the starts the
 * windows inside its budget can serve, at `perWindow` a window, and never more
 * than `most`. An agent's shorter wait, or a start that reached the gate late,
 * is served by fewer windows than a creator's full budget.
 */
function lineMaxFor(budgetMs: number, perWindow: number, most: number): number {
  const windows = Math.max(1, Math.floor(budgetMs / (PROVIDER_ADMISSION_POLICY.rateWindowSeconds * 1000)));
  return Math.min(most, windows * perWindow);
}

/** What the reservation raises for a generation that is gone or already settled: nothing to wait for. */
const GENERATION_GONE = /Generation \S+ (does not exist|is already terminal)/;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The shortest pause between two asks: a hint that rounds to nothing must not become a busy loop. */
const WAIT_POLL_MIN_MS = 250;

/**
 * Admits the submission, waiting in line for it when the caller asked to, and
 * throws when it is not admitted.
 *
 * A start inside `withProviderAdmissionWait` that is refused for capacity (the
 * rate window, its model's share, the in-flight cap) is not failed: it takes a
 * ticket in the database's line (`reserve_provider_submission`, `p_wait`) and
 * asks again, at the moment the refusal said a place opens and no later than
 * `waitPollMaxMs`, until it is admitted or its budget is spent. The line is
 * first come, first served, so the asking order does not matter. Only a start
 * with a generation row can wait: the row is its ticket.
 *
 * The refusal is deliberately a `GenerationServiceError` with status 429 rather
 * than a bespoke type: the route services already map `.status` onto the HTTP
 * response, and `getPublicGenerationStartFailure` already resolves a 429 to
 * `provider_busy`, whose copy ("busy right now, please retry shortly") is
 * exactly right here. Correct precisely because a rejected submission *is*
 * refunded — the request never left the box, so nothing will be billed and
 * retrying is safe. That is the opposite of the held-submission case, whose
 * copy must never say "retry". It holds after a wait too: a start that gave up
 * its place was never sent.
 *
 * It must also never be an `ExternalServiceTimeoutError`, or the shared settle
 * helper would hold the credits for 45 minutes instead of refunding them.
 */
export async function admitProviderSubmission(params: {
  service?: string;
  model?: string | null;
  generationId?: string | null;
  client?: ProviderAdmissionClient;
  /** How long to wait in line; defaults to the scope `withProviderAdmissionWait` set, which is none. */
  waitBudgetMs?: number;
  /** Test seams: the pause between two asks, and the clock the budget is measured on. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ProviderAdmissionVerdict> {
  const service = params.service?.trim() || KIE_PROVIDER_SERVICE;
  const now = params.now ?? Date.now;
  const sleep = params.sleep ?? defaultSleep;
  const waitBudgetMs = params.generationId
    ? Math.max(0, params.waitBudgetMs ?? providerAdmissionWaitBudgetMs())
    : 0;
  const turnSinceMs = params.generationId ? providerAdmissionTurnSinceMs() : null;
  const startedAt = now();
  let asks = 0;
  let refusal: Omit<ProviderAdmissionVerdict, 'waitedMs'> | null = null;
  let gone = false;

  for (;;) {
    // The first ask gets the full limit. Each later one gets what is left of
    // the budget, so the last ask cannot carry the wait far past its end.
    const askLimitMs = refusal === null
      ? PROVIDER_ADMISSION_POLICY.askTimeoutMs
      : Math.min(
          PROVIDER_ADMISSION_POLICY.askTimeoutMs,
          Math.max(waitBudgetMs - (now() - startedAt), WAIT_LAST_ASK_MS),
        );
    let verdict: Omit<ProviderAdmissionVerdict, 'waitedMs'> | null = null;

    try {
      const client = params.client ?? createServiceClient();
      const rpcName = params.generationId
        ? 'reserve_provider_submission'
        : 'admit_provider_submission';
      const { data, error } = await askWithTimeout(client.rpc(rpcName, {
        ...(params.generationId
          ? {
              p_generation_id: params.generationId,
              p_wait: waitBudgetMs > 0,
              p_waiter_ttl_seconds: PROVIDER_ADMISSION_POLICY.waiterTtlSeconds,
              p_line_max: lineMaxFor(
                waitBudgetMs, PROVIDER_ADMISSION_POLICY.rateWindowMax, PROVIDER_ADMISSION_POLICY.waitLineMax,
              ),
              p_model_line_max: lineMaxFor(
                waitBudgetMs, PROVIDER_ADMISSION_POLICY.modelRateWindowMax, PROVIDER_ADMISSION_POLICY.waitModelLineMax,
              ),
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
      }), askLimitMs);

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
      logBackendWarning('provider_admission_unavailable', {
        service, waiting: refusal !== null, timedOut, error: message,
      });
      // Something else settled or removed the generation while it waited. No
      // place will ever be its, so the wait ends here rather than at its budget.
      gone = refusal !== null && GENERATION_GONE.test(message);

      if (refusal === null && timedOut) {
        // The database is there and did not answer in time: the reservation is
        // queued behind others, which is load, not an outage. Letting the
        // start through unchecked would lift every limit at the moment the
        // gate is busiest. It is treated as refused for now: a start that may
        // wait asks again, and one that may not is told the provider is busy.
        refusal = {
          allowed: false, reason: 'rate_limited', state: 'unknown', retryAfterSeconds: 0, inFlight: null,
          waiting: waitBudgetMs > 0, waitersAhead: null,
        };
      } else if (refusal === null) {
        // Fail *open* on any other infrastructure problem. The gate protects
        // the provider from us; it is not a correctness boundary, and refusing
        // every generation because an admission table is unreachable — or
        // because the service-role client cannot be constructed — would
        // convert a monitoring problem into a full outage. The per-user
        // limiter and the provider's own 429s still apply.
        return {
          allowed: true, reason: 'admitted', state: 'unknown', retryAfterSeconds: 0, inFlight: null,
          waiting: false, waitersAhead: null, waitedMs: 0,
        };
      }
      // Otherwise the start is already waiting. The gate's last word to it was
      // "no place yet", and an ask that got no answer does not take that back:
      // letting every waiting start through on one failed ask would send the
      // whole line at once, at the moment the database is struggling. It keeps
      // its refusal and asks again.
    }
    asks += 1;
    // Read after the ask, which is part of the wait: an ask can take seconds.
    const elapsedMs = now() - startedAt;

    if (verdict?.allowed) {
      if (asks > 1) {
        logBackendInfo('provider_admission_waited', {
          service,
          model: params.model ?? null,
          generationId: params.generationId ?? null,
          outcome: 'admitted',
          waitedMs: elapsedMs,
          asks,
        });
      }
      return { ...verdict, waitedMs: asks > 1 ? elapsedMs : 0 };
    }

    // The rejection sits deliberately outside the catch above: a genuine "not
    // admitted" verdict must never be swallowed as an infrastructure blip.
    if (verdict) refusal = verdict;
    const standing = refusal!;
    const remainingMs = waitBudgetMs - elapsedMs;
    const mayWait = standing.waiting && WAITABLE_REASONS.has(standing.reason) && remainingMs > 0 && !gone;

    if (!mayWait) {
      logBackendWarning('provider_admission_rejected', {
        service,
        model: params.model ?? null,
        reason: standing.reason,
        state: standing.state,
        retryAfterSeconds: standing.retryAfterSeconds,
        inFlight: standing.inFlight,
        waitersAhead: standing.waitersAhead,
        waitedMs: elapsedMs,
        asks,
      });

      throw new GenerationServiceError(
        REJECTION_MESSAGES[standing.reason] ?? REJECTION_MESSAGES.rate_limited,
        429,
        'provider_busy',
      );
    }

    // Ask again when the refusal said a place opens, never later than the
    // heartbeat the ticket needs, and once more as the budget runs out so the
    // last moment of it is not spent asleep.
    const hintMs = standing.retryAfterSeconds > 0
      ? standing.retryAfterSeconds * 1000
      : PROVIDER_ADMISSION_POLICY.waitPollMaxMs;
    await sleep(Math.max(
      Math.min(hintMs, PROVIDER_ADMISSION_POLICY.waitPollMaxMs, remainingMs),
      Math.min(WAIT_POLL_MIN_MS, remainingMs),
    ));
  }
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
