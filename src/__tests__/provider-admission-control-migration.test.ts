import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809130000_provider_admission_control.sql',
), 'utf8');

const admitBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.admit_provider_submission'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.record_provider_submission_outcome'),
);

const outcomeBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.record_provider_submission_outcome'),
);

describe('provider admission control migration', () => {
  it('decides every gate in one function so a global token cannot leak', () => {
    // Consuming the global token and then rejecting on the per-model bucket
    // would spend budget on a submission that never goes out. Both buckets are
    // therefore read first and only consumed once both can pay -- which is only
    // expressible if they are decided in the same statement.
    const firstGlobalConsume = admitBody.indexOf('SET tokens = v_global_tokens - 1');
    const modelShortfallCheck = admitBody.indexOf('v_model_tokens IS NOT NULL AND v_model_tokens < 1');

    expect(modelShortfallCheck).toBeGreaterThan(-1);
    expect(firstGlobalConsume).toBeGreaterThan(-1);
    expect(modelShortfallCheck).toBeLessThan(firstGlobalConsume);
  });

  it('checks the circuit before spending a token', () => {
    // A token spent on a call we already expect to fail is a token unavailable
    // to the recovery traffic once the breaker closes.
    const circuitCheck = admitBody.indexOf("v_breaker.state = 'open'");
    const bucketSeed = admitBody.indexOf('INSERT INTO public.provider_admission_buckets');

    expect(circuitCheck).toBeGreaterThan(-1);
    expect(circuitCheck).toBeLessThan(bucketSeed);
  });

  it('lets the probe bypass the remaining gates, or the breaker can never close', () => {
    // A bucket that drained while the circuit was open would otherwise block
    // the one request whose entire purpose is to discover recovery.
    expect(admitBody).toContain('IF v_probe THEN');
    const probeReturn = admitBody.indexOf('IF v_probe THEN');
    const inFlightCount = admitBody.indexOf('SELECT count(*) INTO v_in_flight');
    expect(probeReturn).toBeLessThan(inFlightCount);
  });

  it('reclaims a probe that never reported an outcome', () => {
    // An instance that dies mid-probe would otherwise leave probe_started_at
    // set forever and wedge the breaker permanently half-open -- the same
    // failure F12 avoided by reclaiming on coalesce(heartbeat_at, locked_at).
    expect(admitBody).toContain('v_breaker.probe_started_at + make_interval(secs => v_probe_timeout)');
    expect(admitBody).toContain("'circuit_probe_in_flight'");
  });

  it('bounds the in-flight count by a window so stuck rows cannot wedge submissions', () => {
    // Counting every non-terminal generation would let a handful of
    // permanently stuck rows block the whole account's submissions.
    expect(admitBody).toContain('created_at > now() - make_interval(secs => v_window_seconds)');
    expect(admitBody).toContain("status IN ('pending', 'waiting', 'processing')");
  });

  it('re-opens immediately when a probe fails', () => {
    // The probe already proved the provider is still failing; making it serve
    // out another threshold of real user requests to re-learn that is the storm
    // the breaker exists to prevent.
    expect(outcomeBody).toContain("v_failures >= v_threshold OR v_breaker.state = 'half_open'");
  });

  it("honours the provider's Retry-After when it exceeds our own backoff", () => {
    // Kie publishes no numeric limits anywhere, so a Retry-After header is the
    // only authoritative statement about when it will accept traffic again.
    expect(outcomeBody).toContain('v_open_for := greatest(v_open_seconds, v_retry_after)');
  });

  it('closes the circuit outright on success rather than climbing down', () => {
    // A half-open probe that succeeds is the definition of recovered; a gradual
    // decrement would keep rejecting real traffic after the provider is healthy.
    expect(outcomeBody).toContain("SET state = 'closed'");
    expect(outcomeBody).toContain('consecutive_failures = 0');
  });

  it('keeps both tables service-role only', () => {
    for (const table of ['provider_admission_buckets', 'provider_circuit_breakers']) {
      expect(migration).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(migration).toContain(`REVOKE ALL ON public.${table} FROM anon, authenticated`);
      expect(migration).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${table} TO service_role`);
    }
  });

  it('never exposes either function to authenticated callers', () => {
    // F12's lesson: a SECURITY DEFINER function reachable by `authenticated`
    // must derive identity rather than accept it. These take no user identity
    // at all, so the safe posture is simply not to grant them.
    expect(migration).toContain('SECURITY DEFINER');
    for (const fn of ['admit_provider_submission', 'record_provider_submission_outcome']) {
      const grants = migration.slice(migration.indexOf(`REVOKE ALL ON FUNCTION public.${fn}(`));
      expect(grants).toContain('FROM authenticated');
      expect(grants).toContain('TO service_role');
      expect(grants).not.toContain('TO authenticated');
    }
  });
});
