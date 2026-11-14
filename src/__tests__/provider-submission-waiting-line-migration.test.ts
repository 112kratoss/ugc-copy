import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';

// The live body of reserve_provider_submission. The admission it wraps is still
// the one `provider-admission-sliding-rate-window-migration.test.ts` pins.
const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261114174726_provider_submission_waiting_line.sql',
), 'utf8');

const reserveStart = migration.indexOf('CREATE FUNCTION public.reserve_provider_submission');
const reserveBody = migration.slice(reserveStart);
const logic = reserveBody.slice(reserveBody.indexOf('AS $function$'));

const RESERVE_SIGNATURE = `uuid, text, text, numeric, numeric, numeric, numeric,
  integer, integer, integer, integer, integer, integer, integer, boolean, integer`;

describe('provider submission waiting line migration', () => {
  it('keeps the line in a table of its own, the service role\'s alone', () => {
    // A ticket is rewritten every few seconds while its start waits. On the
    // generation row that would churn the widest, most indexed table there is.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.provider_submission_waiters');
    expect(migration).toContain('generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE');
    expect(migration).not.toMatch(/ALTER TABLE public\.generations/);
    expect(migration).toContain('ALTER TABLE public.provider_submission_waiters ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.provider_submission_waiters FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON public.provider_submission_waiters FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_submission_waiters TO service_role');
    expect(migration).not.toMatch(/TO (anon|authenticated)\b/);
  });

  it('only lets a ticket say one of the three refusals a place clears', () => {
    expect(migration).toContain("CHECK (reason IN ('rate_limited', 'model_rate_limited', 'max_in_flight'))");
    expect(logic).toContain("IF v_wait AND v_reason IN ('rate_limited', 'model_rate_limited', 'max_in_flight') THEN");
  });

  it('replaces the reservation without leaving a second candidate, and leaves the admission alone', () => {
    expect(migration).toMatch(/DROP FUNCTION IF EXISTS public\.reserve_provider_submission\(\s*uuid, text, text, numeric, numeric, numeric, numeric,\s*integer, integer, integer, integer, integer, integer, integer\s*\);/);
    expect(migration.indexOf('DROP FUNCTION IF EXISTS public.reserve_provider_submission')).toBeLessThan(reserveStart);
    expect(migration).not.toContain('CREATE OR REPLACE FUNCTION');
    expect(migration).not.toMatch(/(CREATE|DROP) FUNCTION[^\n]*public\.admit_provider_submission/);
  });

  it('still resolves a call from the deployment before it, which does not wait', () => {
    const parameters = reserveBody.slice(reserveBody.indexOf('(') + 1, reserveBody.indexOf('RETURNS jsonb'));
    const lines = parameters.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('p_'));
    const names = lines.map((line) => line.split(' ')[0]);

    for (const sent of [
      'p_generation_id', 'p_service', 'p_model', 'p_rate_window_seconds', 'p_rate_window_max',
      'p_model_rate_window_max', 'p_max_in_flight', 'p_in_flight_window_seconds',
      'p_circuit_open_seconds', 'p_probe_timeout_seconds',
      // And the deployment before that one, should it ever be rolled back to.
      'p_global_capacity', 'p_global_refill_per_second', 'p_model_capacity', 'p_model_refill_per_second',
    ]) {
      expect(names).toContain(sent);
    }
    expect(lines.filter((line) => !line.includes(' DEFAULT ')).map((line) => line.split(' ')[0]))
      .toEqual(['p_generation_id', 'p_service']);
    expect(reserveBody).toContain('p_wait boolean DEFAULT false');
    expect(reserveBody).toContain(`p_waiter_ttl_seconds integer DEFAULT ${PROVIDER_ADMISSION_POLICY.waiterTtlSeconds}`);
  });

  it('reads the line under the lock that serialises every reservation', () => {
    const lock = logic.indexOf('pg_advisory_xact_lock');
    const lineRead = logic.indexOf('FROM public.provider_submission_waiters w');

    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(lineRead);
    // The ticket's stamp is the wall clock after that lock, not the transaction's start.
    expect(logic.indexOf('v_now := clock_timestamp()')).toBeGreaterThan(lock);
    expect(logic).toContain('VALUES (p_generation_id, v_service, v_model, v_now, v_now, v_reason)');
  });

  it('counts only tickets that are alive and whose generation is still waiting to be sent', () => {
    expect(logic).toContain('w.seen_at > v_now - make_interval(secs => v_ttl)');
    expect(logic).toContain("g.status = 'pending'");
    expect(logic).toContain('g.prediction_id IS NULL');
    expect(logic).toContain('g.provider_submission_reserved_at IS NULL');
  });

  it('puts a start with no ticket behind every ticket, and one with a ticket behind the older ones', () => {
    expect(logic).toContain('v_ticket IS NULL');
    expect(logic).toContain('OR w.waiting_since < v_ticket');
    expect(logic).toContain('OR (w.waiting_since = v_ticket AND w.generation_id < p_generation_id)');
  });

  it('does not let a start waiting on its model hold an account place', () => {
    expect(logic).toContain("count(*) FILTER (WHERE w.reason <> 'model_rate_limited')");
    expect(logic).toContain('count(*) FILTER (WHERE v_model IS NOT NULL AND w.model = v_model)');
  });

  it('asks for a place for this start and one for each start ahead of it', () => {
    expect(logic).toContain('p_max_in_flight => v_max_in_flight - v_ahead');
    expect(logic).toContain('p_rate_window_max => v_rate_max - v_ahead');
    expect(logic).toContain('WHEN v_model_rate_max > 0 THEN v_model_rate_max - v_model_ahead');
    // The admission clamps a limit of zero or less up to one, which would
    // admit a start with a whole window of others ahead of it. Those cases are
    // refused before the admission is asked.
    const guards = logic.indexOf('IF v_ahead >= v_max_in_flight THEN');
    expect(guards).toBeGreaterThan(-1);
    expect(logic).toContain('ELSIF v_ahead >= v_rate_max THEN');
    expect(logic).toContain('v_model_ahead >= v_model_rate_max THEN');
    expect(guards).toBeLessThan(logic.indexOf('public.admit_provider_submission('));
  });

  it('leaves the line out of it while the breaker is not closed', () => {
    expect(logic).toContain("IF coalesce(v_breaker_state, 'closed') = 'closed' THEN");
  });

  it('keeps a ticket\'s first stamp when the start asks again', () => {
    const upsert = logic.slice(logic.indexOf('INSERT INTO public.provider_submission_waiters AS w'));
    const update = upsert.slice(upsert.indexOf('DO UPDATE'), upsert.indexOf(';'));

    expect(update).toContain('seen_at = excluded.seen_at');
    expect(update).toContain('reason = excluded.reason');
    expect(update).not.toContain('waiting_since');
  });

  it('takes the ticket away when the start is admitted, not waiting, or already reserved', () => {
    expect(logic.split('DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;').length - 1)
      .toBe(3);
  });

  it('prunes tickets long dead, so the table stays the size of the line', () => {
    expect(logic).toContain('AND seen_at < v_now - make_interval(secs => greatest(v_ttl * 4, 60))');
  });

  it('never exposes the reservation to anon or authenticated callers', () => {
    expect(migration).toContain(`REVOKE ALL ON FUNCTION public.reserve_provider_submission(\n  ${RESERVE_SIGNATURE}\n) FROM PUBLIC, anon, authenticated;`);
    expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.reserve_provider_submission(\n  ${RESERVE_SIGNATURE}\n) TO service_role;`);
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(1);
    expect(migration.match(/SET search_path = public, pg_temp/g)).toHaveLength(1);
  });
});
