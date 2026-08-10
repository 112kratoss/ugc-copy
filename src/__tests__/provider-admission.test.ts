import { describe, expect, it, vi } from 'vitest';

import { GenerationServiceError } from '@/lib/generation-service-core';
import { getPublicGenerationStartFailure } from '@/lib/generation-public-failure';
import { ExternalServiceTimeoutError, isExternalServiceTimeoutError } from '@/lib/provider-fetch';
import {
  admitProviderSubmission,
  isProviderFaultFailure,
  parseProviderRetryAfterSeconds,
  PROVIDER_ADMISSION_POLICY,
  recordProviderSubmissionOutcome,
} from '@/lib/provider-admission';

function clientReturning(data: unknown, error: unknown = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { client: { rpc }, rpc };
}

const ADMITTED = { allowed: true, reason: 'admitted', state: 'closed', retryAfterSeconds: 0, inFlight: 3 };

describe('provider admission', () => {
  it('admits and reports the verdict when the gate allows the submission', async () => {
    const { client } = clientReturning(ADMITTED);

    await expect(admitProviderSubmission({ model: 'veo-3-1', client })).resolves.toMatchObject({
      allowed: true,
      reason: 'admitted',
      inFlight: 3,
    });
  });

  it('sends the policy the app owns rather than letting the database choose it', async () => {
    // The repo's standing posture: a database function must not be the place a
    // spend-shaped ceiling is defined. The same reasoning as the media byte
    // admission, which re-applies its attempt cap in the app.
    const { client, rpc } = clientReturning(ADMITTED);
    await admitProviderSubmission({ model: 'veo-3-1', client });

    expect(rpc).toHaveBeenCalledWith('admit_provider_submission', expect.objectContaining({
      p_service: 'kie',
      p_model: 'veo-3-1',
      p_global_capacity: PROVIDER_ADMISSION_POLICY.globalCapacity,
      p_max_in_flight: PROVIDER_ADMISSION_POLICY.maxInFlight,
      p_in_flight_window_seconds: PROVIDER_ADMISSION_POLICY.inFlightWindowSeconds,
    }));
  });

  it('atomically reserves an in-flight slot when a generation already exists', async () => {
    const { client, rpc } = clientReturning(ADMITTED);
    await admitProviderSubmission({
      generationId: 'e2000000-0000-4000-8000-000000000001',
      model: 'veo-3-1',
      client,
    });

    expect(rpc).toHaveBeenCalledWith('reserve_provider_submission', expect.objectContaining({
      p_generation_id: 'e2000000-0000-4000-8000-000000000001',
      p_service: 'kie',
      p_model: 'veo-3-1',
    }));
  });

  it('rejects with a 429 the route layer already knows how to return', async () => {
    const { client } = clientReturning({
      allowed: false, reason: 'rate_limited', state: 'closed', retryAfterSeconds: 4, inFlight: 12,
    });

    await expect(admitProviderSubmission({ client })).rejects.toMatchObject({
      name: 'GenerationServiceError',
      status: 429,
    });
  });

  it('never rejects with the one error type that would hold the credits', async () => {
    // This is the money-critical property. settleGenerationStartFailureQuietly
    // holds *only* ExternalServiceTimeoutError, for up to the reaper's 45
    // minutes. An admission rejection never sent a request, so the provider
    // cannot bill for it and the credits must come straight back.
    const { client } = clientReturning({
      allowed: false, reason: 'circuit_open', state: 'open', retryAfterSeconds: 30, inFlight: null,
    });

    const error = await admitProviderSubmission({ client }).catch((thrown) => thrown);

    expect(isExternalServiceTimeoutError(error)).toBe(false);
    expect(error).toBeInstanceOf(GenerationServiceError);
  });

  it('reaches the user as provider_busy, whose copy invites the retry that is safe here', async () => {
    // "Please retry this step shortly" is correct on this path precisely
    // because it refunds -- the opposite of the held ambiguous-submission case,
    // whose copy must never say retry.
    const { client } = clientReturning({
      allowed: false, reason: 'model_rate_limited', state: 'closed', retryAfterSeconds: 2, inFlight: 9,
    });

    const error = await admitProviderSubmission({ client }).catch((thrown) => thrown);

    expect(getPublicGenerationStartFailure(error).code).toBe('provider_busy');
  });

  it('fails open when the admission table is unreachable', async () => {
    // The gate protects the provider from us; it is not a correctness boundary.
    // Refusing every generation because one table is unavailable would turn a
    // monitoring problem into a full outage. The per-user limiter and the
    // provider's own 429s still apply underneath.
    const { client } = clientReturning(null, new Error('relation does not exist'));

    await expect(admitProviderSubmission({ client })).resolves.toMatchObject({
      allowed: true,
      state: 'unknown',
    });
  });

  it('fails open when the client itself cannot be built or the call throws', async () => {
    // Distinct from the error-return path above: a missing service-role env or
    // a thrown transport error must not be able to reject a generation either,
    // and the throw must not escape as a start failure.
    const rpc = vi.fn().mockRejectedValue(new Error('fetch failed'));

    await expect(admitProviderSubmission({ client: { rpc } })).resolves.toMatchObject({
      allowed: true,
      state: 'unknown',
    });
  });

  it('still rejects a genuine refusal even though infrastructure errors fail open', async () => {
    // The guard on the fail-open block: a "not admitted" verdict is a decision,
    // not a blip, and swallowing it would silently disable the whole gate.
    const { client } = clientReturning({
      allowed: false, reason: 'max_in_flight', state: 'closed', retryAfterSeconds: 15, inFlight: 50,
    });

    await expect(admitProviderSubmission({ client })).rejects.toBeInstanceOf(GenerationServiceError);
  });

  it('treats a blank model as no per-model bucket rather than an empty scope', async () => {
    const { client, rpc } = clientReturning(ADMITTED);
    await admitProviderSubmission({ model: '   ', client });

    expect(rpc).toHaveBeenCalledWith('admit_provider_submission', expect.objectContaining({ p_model: null }));
  });
});

describe('provider fault classification', () => {
  it('counts unresponsiveness, overload and server faults', () => {
    expect(isProviderFaultFailure(new ExternalServiceTimeoutError('KIE task creation', 30_000))).toBe(true);
    expect(isProviderFaultFailure(null, 429)).toBe(true);
    expect(isProviderFaultFailure(null, 500)).toBe(true);
    expect(isProviderFaultFailure(null, 503)).toBe(true);
  });

  it('never lets one user’s bad input open the circuit for everybody', () => {
    // A 4xx other than 429 is this account's mistake, not the provider's
    // outage. So is a body-level rejection returned under HTTP 200, which is
    // how Kie reports validation failures -- there is no status to judge.
    expect(isProviderFaultFailure(null, 400)).toBe(false);
    expect(isProviderFaultFailure(null, 404)).toBe(false);
    expect(isProviderFaultFailure(new Error('Provider rejected the request'))).toBe(false);
    expect(isProviderFaultFailure(new Error('invalid prompt'), 200)).toBe(false);
  });
});

describe('provider Retry-After parsing', () => {
  function headerResponse(value: string | null) {
    return { headers: { get: (name: string) => (name === 'retry-after' ? value : null) } };
  }

  it('reads a seconds value', () => {
    expect(parseProviderRetryAfterSeconds(headerResponse('45'))).toBe(45);
  });

  it('reads an HTTP-date value', () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    expect(parseProviderRetryAfterSeconds(headerResponse(future))).toBeGreaterThan(100);
  });

  it('is not capped at the retry path’s ten seconds', () => {
    // fetchWithProviderRetry caps Retry-After at 10s because a caller is
    // blocked waiting on it. Nothing blocks here -- the value only decides how
    // long the circuit stays open, where honouring a long backoff is the point.
    expect(parseProviderRetryAfterSeconds(headerResponse('600'))).toBe(600);
  });

  it('clamps an absurd value and tolerates a missing or unparseable header', () => {
    expect(parseProviderRetryAfterSeconds(headerResponse('999999'))).toBe(3600);
    expect(parseProviderRetryAfterSeconds(headerResponse(null))).toBe(0);
    expect(parseProviderRetryAfterSeconds(headerResponse('soon'))).toBe(0);
    expect(parseProviderRetryAfterSeconds(undefined)).toBe(0);
  });
});

describe('provider circuit outcome recording', () => {
  it('never throws when the breaker table is unavailable', async () => {
    // The write is awaited so serverless shutdown cannot discard it, but its
    // failure remains isolated from the generation request.
    const rpc = vi.fn().mockRejectedValue(new Error('unreachable'));
    await expect(recordProviderSubmissionOutcome({ success: true, client: { rpc } })).resolves.toBeUndefined();
  });

  it('passes a provider Retry-After through as the open duration input', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await recordProviderSubmissionOutcome({ success: false, retryAfterSeconds: 90, client: { rpc } });

    expect(rpc).toHaveBeenCalledWith('record_provider_submission_outcome', expect.objectContaining({
      p_success: false,
      p_retry_after_seconds: 90,
    }));
  });
});
