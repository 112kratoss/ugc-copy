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
 * Conservative on purpose. Kie documents a 429 response on every model but
 * publishes no request rate and no concurrency cap anywhere in its API
 * references, so these are *our* ceilings, not the provider's. They exist to
 * make the failure mode a bounded queue-and-retry instead of a 429 storm, and
 * the right way to raise them is the certification load test, not a hunch.
 */
export const PROVIDER_ADMISSION_POLICY = {
  /** Burst allowed on purpose; sustained rate is the refill. */
  globalCapacity: 15,
  globalRefillPerSecond: 1.5,
  /** A single model cannot consume the whole account budget. */
  modelCapacity: 6,
  modelRefillPerSecond: 0.6,
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
} as const;

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
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeVerdict(value: unknown): ProviderAdmissionVerdict {
  if (!isRecord(value)) throw new Error('Provider admission response was invalid');
  const inFlight = Number(value.inFlight);
  return {
    allowed: value.allowed === true,
    reason: (typeof value.reason === 'string' ? value.reason : 'admitted') as ProviderAdmissionReason,
    state: typeof value.state === 'string' ? value.state : 'closed',
    retryAfterSeconds: Math.max(0, Number(value.retryAfterSeconds ?? 0)),
    inFlight: Number.isFinite(inFlight) ? inFlight : null,
  };
}

const REJECTION_MESSAGES: Record<string, string> = {
  circuit_open: 'The generation provider is not accepting requests right now. No credits were charged. Please retry shortly.',
  circuit_probe_in_flight: 'The generation provider is recovering. No credits were charged. Please retry shortly.',
  max_in_flight: 'Too many generations are already running. No credits were charged. Please retry once some finish.',
  rate_limited: 'The generation provider is busy right now. No credits were charged. Please retry shortly.',
  model_rate_limited: 'This model is busy right now. No credits were charged. Please retry shortly.',
};

/**
 * Throws when the submission is not admitted.
 *
 * Deliberately a `GenerationServiceError` with status 429 rather than a bespoke
 * type: the route services already map `.status` onto the HTTP response, and
 * `getPublicGenerationStartFailure` already resolves a 429 to `provider_busy`,
 * whose copy ("busy right now, please retry shortly") is exactly right here.
 * Correct precisely because a rejected submission *is* refunded — the request
 * never left the box, so nothing will be billed and retrying is safe. That is
 * the opposite of the held-submission case, whose copy must never say "retry".
 *
 * It must also never be an `ExternalServiceTimeoutError`, or the shared settle
 * helper would hold the credits for 45 minutes instead of refunding them.
 */
export async function admitProviderSubmission(params: {
  service?: string;
  model?: string | null;
  generationId?: string | null;
  client?: { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };
}): Promise<ProviderAdmissionVerdict> {
  const service = params.service?.trim() || KIE_PROVIDER_SERVICE;
  let verdict: ProviderAdmissionVerdict;

  // Fail *open* on any infrastructure problem. The gate protects the provider
  // from us; it is not a correctness boundary, and refusing every generation
  // because an admission table is unreachable — or because the service-role
  // client cannot be constructed — would convert a monitoring problem into a
  // full outage. The per-user limiter and the provider's own 429s still apply.
  //
  // The rejection throw below sits deliberately *outside* this block: a genuine
  // "not admitted" verdict must never be swallowed as an infrastructure blip.
  try {
    const client = params.client ?? createServiceClient();
    const rpcName = params.generationId
      ? 'reserve_provider_submission'
      : 'admit_provider_submission';
    const { data, error } = await client.rpc(rpcName, {
      ...(params.generationId ? { p_generation_id: params.generationId } : {}),
      p_service: service,
      p_model: params.model?.trim() || null,
      p_global_capacity: PROVIDER_ADMISSION_POLICY.globalCapacity,
      p_global_refill_per_second: PROVIDER_ADMISSION_POLICY.globalRefillPerSecond,
      p_model_capacity: PROVIDER_ADMISSION_POLICY.modelCapacity,
      p_model_refill_per_second: PROVIDER_ADMISSION_POLICY.modelRefillPerSecond,
      p_max_in_flight: PROVIDER_ADMISSION_POLICY.maxInFlight,
      p_in_flight_window_seconds: PROVIDER_ADMISSION_POLICY.inFlightWindowSeconds,
      p_circuit_open_seconds: PROVIDER_ADMISSION_POLICY.circuitOpenSeconds,
      p_probe_timeout_seconds: PROVIDER_ADMISSION_POLICY.probeTimeoutSeconds,
    });

    if (error) throw error instanceof Error ? error : new Error(String(error));
    verdict = normalizeVerdict(data);
  } catch (admissionError) {
    logBackendWarning('provider_admission_unavailable', {
      service,
      error: admissionError instanceof Error ? admissionError.message : String(admissionError),
    });
    return { allowed: true, reason: 'admitted', state: 'unknown', retryAfterSeconds: 0, inFlight: null };
  }

  if (!verdict.allowed) {
    logBackendWarning('provider_admission_rejected', {
      service,
      model: params.model ?? null,
      reason: verdict.reason,
      state: verdict.state,
      retryAfterSeconds: verdict.retryAfterSeconds,
      inFlight: verdict.inFlight,
    });

    throw new GenerationServiceError(
      REJECTION_MESSAGES[verdict.reason] ?? REJECTION_MESSAGES.rate_limited,
      429,
      'provider_busy',
    );
  }

  return verdict;
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
