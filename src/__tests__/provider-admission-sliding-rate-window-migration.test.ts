import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';

// The live bodies of admit_provider_submission and reserve_provider_submission.
// `provider-admission-control-migration.test.ts` reads the migration that first
// created them; its breaker assertions still describe the outcome function,
// which this migration does not touch.
const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261114161754_provider_admission_sliding_rate_window.sql',
), 'utf8');

const admitStart = migration.indexOf('CREATE FUNCTION public.admit_provider_submission');
const reserveStart = migration.indexOf('CREATE FUNCTION public.reserve_provider_submission');
const admitBody = migration.slice(admitStart, reserveStart);
const reserveBody = migration.slice(reserveStart);

const ADMIT_SIGNATURE = `text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer`;
const RESERVE_SIGNATURE = `uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer`;

describe('provider admission sliding rate window migration', () => {
  it('finds both function bodies', () => {
    expect(admitStart).toBeGreaterThan(-1);
    expect(reserveStart).toBeGreaterThan(admitStart);
  });

  it('keeps the window on the scope row instead of a table that grows with traffic', () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS admitted_at timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[]");
    expect(migration).toContain('DROP COLUMN IF EXISTS tokens');
    expect(migration).not.toMatch(/CREATE TABLE/i);
  });

  it('drops the old signatures so PostgREST has one candidate, not two', () => {
    // CREATE OR REPLACE with added parameters makes an overload. A call from
    // the code deployed before this migration names only the old arguments,
    // which both would accept, and PostgREST answers that with an error the
    // app fails open on.
    expect(migration).toMatch(/DROP FUNCTION IF EXISTS public\.admit_provider_submission\(\s*text, text, numeric, numeric, numeric, numeric,\s*integer, integer, integer, integer\s*\);/);
    expect(migration).toMatch(/DROP FUNCTION IF EXISTS public\.reserve_provider_submission\(\s*uuid, text, text, numeric, numeric, numeric, numeric,\s*integer, integer, integer, integer\s*\);/);
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(migration.indexOf('DROP FUNCTION IF EXISTS public.admit_provider_submission'))
      .toBeLessThan(admitStart);
  });

  it('still resolves a call from the code deployed before it', () => {
    // Migrations are applied before the deployment that stops sending the
    // bucket arguments, and a rollback restores that deployment. Every name it
    // sends must still be a parameter, and nothing new may be required.
    const previousArguments = [
      'p_service', 'p_model', 'p_global_capacity', 'p_global_refill_per_second',
      'p_model_capacity', 'p_model_refill_per_second', 'p_max_in_flight',
      'p_in_flight_window_seconds', 'p_circuit_open_seconds', 'p_probe_timeout_seconds',
    ];
    for (const [body, required] of [[admitBody, ['p_service']], [reserveBody, ['p_generation_id', 'p_service']]] as const) {
      const parameters = body.slice(body.indexOf('(') + 1, body.indexOf('RETURNS jsonb'));
      const lines = parameters.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('p_'));
      const names = lines.map((line) => line.split(' ')[0]);
      for (const name of previousArguments) expect(names).toContain(name);
      const withoutDefault = lines.filter((line) => !line.includes(' DEFAULT ')).map((line) => line.split(' ')[0]);
      expect(withoutDefault).toEqual(required);
    }
  });

  it('ignores the retired bucket arguments', () => {
    const logic = admitBody.slice(admitBody.indexOf('AS $function$'));
    for (const retired of [
      'p_global_capacity', 'p_global_refill_per_second', 'p_model_capacity', 'p_model_refill_per_second',
    ]) {
      expect(logic).not.toContain(retired);
    }
    expect(logic).not.toContain('tokens');
  });

  it('defaults to the window the app sends, for the caller that sends none', () => {
    expect(admitBody).toContain(`p_rate_window_seconds integer DEFAULT ${PROVIDER_ADMISSION_POLICY.rateWindowSeconds}`);
    expect(admitBody).toContain(`p_rate_window_max integer DEFAULT ${PROVIDER_ADMISSION_POLICY.rateWindowMax}`);
    expect(reserveBody).toContain(`p_rate_window_seconds integer DEFAULT ${PROVIDER_ADMISSION_POLICY.rateWindowSeconds}`);
    expect(reserveBody).toContain(`p_rate_window_max integer DEFAULT ${PROVIDER_ADMISSION_POLICY.rateWindowMax}`);
  });

  it('checks the circuit and the in-flight cap before touching the window', () => {
    const circuitCheck = admitBody.indexOf("v_breaker.state = 'open'");
    const inFlightCount = admitBody.indexOf('SELECT count(*) INTO v_in_flight');
    const windowSeed = admitBody.indexOf('INSERT INTO public.provider_admission_buckets');

    expect(circuitCheck).toBeGreaterThan(-1);
    expect(circuitCheck).toBeLessThan(inFlightCount);
    expect(inFlightCount).toBeLessThan(windowSeed);
    expect(admitBody).toContain('created_at > now() - make_interval(secs => v_window_seconds)');
  });

  it('stamps an admission with the wall clock read after its locks', () => {
    // now() is the transaction's start. An admission that waited for the row
    // would be stamped before it left, age out early and let an extra request
    // through, which is the overshoot the window exists to prevent.
    const lastLock = admitBody.lastIndexOf('FOR UPDATE');
    const clockRead = admitBody.indexOf('v_now := clock_timestamp()');

    expect(clockRead).toBeGreaterThan(lastLock);
    expect(admitBody).toContain('v_cutoff := v_now - make_interval(secs => v_rate_window)');
    expect(admitBody).not.toMatch(/admitted_at = [^\n]*now\(\)/);
  });

  it('reads both windows before writing either, so a model refusal takes no account place', () => {
    const modelRefusal = admitBody.indexOf("'model_rate_limited'");
    const admitWrite = admitBody.lastIndexOf('SET admitted_at = v_global_recent || v_now');
    const probeBlock = admitBody.slice(admitBody.indexOf('IF v_probe THEN'), admitBody.indexOf("'circuit_probe'"));

    expect(modelRefusal).toBeGreaterThan(-1);
    expect(modelRefusal).toBeLessThan(admitWrite);
    // The only earlier write is the probe's own.
    const writes = admitBody.split('SET admitted_at = v_global_recent || v_now').length - 1;
    expect(writes).toBe(2);
    expect(probeBlock).toContain('SET admitted_at = v_global_recent || v_now');
  });

  it('lets the probe through a full window but records it', () => {
    const probeReturn = admitBody.indexOf("'circuit_probe'");
    const windowRefusal = admitBody.indexOf("'rate_limited'");

    expect(probeReturn).toBeGreaterThan(-1);
    expect(probeReturn).toBeLessThan(windowRefusal);
    expect(admitBody).toContain('IF NOT v_probe AND v_model_scope IS NOT NULL AND v_model_rate_max > 0 THEN');
  });

  it('tells a refused caller when the place it needs opens', () => {
    expect(admitBody).toContain('v_global_recent[cardinality(v_global_recent) - v_rate_max + 1]');
    expect(admitBody).toContain('v_model_recent[cardinality(v_model_recent) - v_model_rate_max + 1]');
  });

  it('forwards the window to the admission the reservation wraps', () => {
    for (const forwarded of [
      'p_rate_window_seconds => p_rate_window_seconds',
      'p_rate_window_max => p_rate_window_max',
      'p_model_rate_window_max => p_model_rate_window_max',
      'p_max_in_flight => p_max_in_flight',
    ]) {
      expect(reserveBody).toContain(forwarded);
    }
    expect(reserveBody).toContain('pg_advisory_xact_lock');
    expect(reserveBody).toContain('v_generation.provider_submission_reserved_at IS NOT NULL');
  });

  it('never exposes either function to anon or authenticated callers', () => {
    // A dropped and recreated function loses its grants and gains the
    // defaults, which include EXECUTE for PUBLIC.
    for (const [fn, signature] of [
      ['admit_provider_submission', ADMIT_SIGNATURE],
      ['reserve_provider_submission', RESERVE_SIGNATURE],
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${fn}(\n  ${signature}\n) FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(\n  ${signature}\n) TO service_role;`);
    }
    expect(migration).not.toMatch(/TO (anon|authenticated)\b/);
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(2);
    expect(migration.match(/SET search_path = public, pg_temp/g)).toHaveLength(2);
  });
});
