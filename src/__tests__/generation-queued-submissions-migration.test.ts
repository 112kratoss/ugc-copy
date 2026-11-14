import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROVIDER_ADMISSION_POLICY } from '@/lib/provider-admission';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261114215420_generation_queued_submissions.sql',
), 'utf8');

const enqueueStart = migration.indexOf('CREATE FUNCTION public.enqueue_provider_submission');
const claimStart = migration.indexOf('CREATE FUNCTION public.claim_queued_provider_submission');
const reserveStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.reserve_provider_submission');
const enqueue = migration.slice(enqueueStart, claimStart);
const claim = migration.slice(claimStart, reserveStart);
const reserve = migration.slice(reserveStart);

const previous = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261114174726_provider_submission_waiting_line.sql',
), 'utf8');

/** A function's parameter list, as written between its name and `RETURNS`. */
function parameters(sql: string, marker: string) {
  const start = sql.indexOf(marker);
  return sql.slice(sql.indexOf('(', start) + 1, sql.indexOf('RETURNS jsonb', start))
    .split('\n').map((line) => line.trim()).filter((line) => line.startsWith('p_'));
}

describe('generation queued submissions migration', () => {
  it('keeps a queued start\'s request where only the service role can read it', () => {
    // The request holds signed links to the creator's inputs and, for a
    // private recipe, the prompt, which is deliberately not on the generation.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.generation_queued_submissions');
    expect(migration).toContain('generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE');
    expect(migration).toContain('ALTER TABLE public.generation_queued_submissions ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.generation_queued_submissions FROM PUBLIC');
    expect(migration).toContain('REVOKE ALL ON public.generation_queued_submissions FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_queued_submissions TO service_role');
    expect(migration).not.toMatch(/TO (anon|authenticated)\b/);
    expect(migration).not.toMatch(/CREATE POLICY/i);
  });

  it('replaces the reservation in place: same call, same grants, for the code deployed before it', () => {
    // The migration lands before the code that queues. The deployed code goes
    // on calling the reservation as it does now, so its parameters are not
    // touched and the function is replaced, never dropped: a drop would lose
    // its grants and, until the next statement, the gate itself.
    expect(migration).not.toMatch(/ALTER TABLE public\.generations\b/);
    expect(migration).not.toMatch(/DROP FUNCTION/);
    expect(migration).not.toMatch(/(CREATE|REPLACE) FUNCTION[^\n]*admit_provider_submission/);
    expect(migration.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(1);
    expect(parameters(migration, 'CREATE OR REPLACE FUNCTION public.reserve_provider_submission'))
      .toEqual(parameters(previous, 'CREATE FUNCTION public.reserve_provider_submission'));
  });

  it('counts the queue itself as the line, with no heartbeat to lapse', () => {
    // A queued start waits with nothing asking for it. Counted only while
    // something asked, it would lose its place the moment its request ended,
    // and a new start would walk past the whole queue.
    const counted = reserve.slice(reserve.indexOf('FROM public.generation_queued_submissions s'));
    expect(counted).toContain('JOIN public.generations g ON g.id = s.generation_id');
    expect(counted).toContain("AND g.status = 'pending'");
    expect(counted).toContain('AND g.prediction_id IS NULL');
    expect(counted).toContain('AND g.provider_submission_reserved_at IS NULL');
    expect(counted.slice(0, counted.indexOf('GROUP BY s.model'))).not.toContain('seen_at');
    expect(reserve).toContain('v_ahead := v_ahead + v_queue_ahead;');
    expect(reserve).toContain('v_model_ahead := v_model_ahead + v_queue_model_ahead;');
  });

  it('reads a queued start\'s turn from its own row, so no caller has to say', () => {
    expect(reserve).toContain('SELECT queued_at INTO v_queued_at');
    const turn = reserve.slice(reserve.indexOf('v_turn := coalesce('), reserve.indexOf('v_turn := coalesce(') + 220);
    expect(turn.indexOf('v_ticket,')).toBeLessThan(turn.indexOf('v_queued_at,'));
    expect(turn.indexOf('v_queued_at,')).toBeLessThan(turn.indexOf('p_turn_since'));
    expect(reserve).toContain('OR s.queued_at < v_turn');
    expect(reserve).toContain('OR (s.queued_at = v_turn AND s.generation_id < p_generation_id)');
  });

  it('counts one model\'s queued starts only for the places that model\'s share still has', () => {
    // Counted whole, a single model's backlog would park every other model's
    // starts behind it while the places kept for them stood empty.
    expect(reserve).toContain('THEN greatest(v_model_rate_max - queued.taken, 0)');
    expect(reserve).toContain('WHEN v_model_rate_max > 0 AND queued.model IS NOT NULL');
    expect(reserve).toContain("WHERE b.scope = v_service || ':' || s.model");
    expect(reserve).toContain('AND admitted > v_now - make_interval(secs => v_rate_window)');
    expect(reserve).toContain('coalesce(sum(queued.starts) FILTER (WHERE v_model IS NOT NULL AND queued.model = v_model), 0)');
  });

  it('counts the queue under the lock that orders the line', () => {
    const lock = enqueue.indexOf("'provider-submission-reservation:' || v_service");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(enqueue.indexOf('SELECT count(*), count(*) FILTER (WHERE user_id = v_generation.user_id)'));
    expect(enqueue.indexOf('FOR UPDATE')).toBeGreaterThan(lock);
  });

  it('queues only a start that holds its credits and has reached nothing', () => {
    expect(enqueue).toContain("IF v_generation.status <> 'pending'");
    expect(enqueue).toContain('OR v_generation.prediction_id IS NOT NULL');
    expect(enqueue).toContain('OR v_generation.provider_submission_reserved_at IS NOT NULL');
    expect(enqueue).toContain('OR v_generation.submission_unknown_at IS NOT NULL');
    expect(enqueue).toContain("RETURN jsonb_build_object('status', 'not_queueable');");
  });

  it('refuses past the queue\'s length or the creator\'s share, and takes the refused start out of the line', () => {
    const refusal = enqueue.slice(enqueue.indexOf('IF v_total >= v_queue_max OR v_of_user >= v_user_queue_max THEN'));
    expect(refusal.indexOf('DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;'))
      .toBeLessThan(refusal.indexOf("'queue_full'"));
    expect(refusal).toContain("'user_queue_full'");
    // The limits the app sends are the function's defaults too.
    expect(enqueue).toContain(`p_queue_max integer DEFAULT ${PROVIDER_ADMISSION_POLICY.queueMax}`);
    expect(enqueue).toContain(`p_user_queue_max integer DEFAULT ${PROVIDER_ADMISSION_POLICY.queueUserMax}`);
  });

  it('does not count rows whose run was settled or sent behind the queue\'s back', () => {
    const prune = enqueue.indexOf('DELETE FROM public.generation_queued_submissions q');
    expect(prune).toBeGreaterThan(-1);
    expect(prune).toBeLessThan(enqueue.indexOf('SELECT count(*), count(*) FILTER'));
    expect(enqueue).toContain("AND (g.status <> 'pending' OR g.prediction_id IS NOT NULL);");
  });

  it('keeps the place and the request of a start that is queued twice', () => {
    expect(enqueue).toContain("RETURN jsonb_build_object('status', 'queued', 'queuedAt', v_queued_at, 'replayed', true);");
    expect(enqueue.indexOf("'replayed', true")).toBeLessThan(enqueue.indexOf('INSERT INTO public.generation_queued_submissions'));
  });

  it('stamps a queued start with the wall clock after its lock, the order it is served in', () => {
    expect(enqueue).toContain('v_queued_at := clock_timestamp();');
    expect(enqueue.indexOf('v_queued_at := clock_timestamp();')).toBeGreaterThan(enqueue.indexOf('pg_advisory_xact_lock'));
  });

  it('gives a queued request to exactly one caller: the claim is the delete', () => {
    // Whatever sends, cancels or expires a queued run must take its request
    // first, and a row can be deleted once.
    expect(claim).toMatch(/DELETE FROM public\.generation_queued_submissions\s+WHERE generation_id = p_generation_id\s+RETURNING jsonb_build_object\(/);
    expect(claim).toContain(') INTO v_claim;');
    expect(claim).toContain('RETURN v_claim;');
    expect(claim).not.toMatch(/\bUPDATE public\.generation_queued_submissions\b/);
    // Out of the queue, it waits in line no longer.
    expect(claim).toContain('DELETE FROM public.provider_submission_waiters WHERE generation_id = p_generation_id;');
  });

  it('never exposes either function to anon or authenticated callers', () => {
    for (const signature of [
      'enqueue_provider_submission(uuid, text, text, text, jsonb, integer, integer)',
      'claim_queued_provider_submission(uuid)',
    ]) {
      expect(migration.replace(/\s+/g, ' ')).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration.replace(/\s+/g, ' ')).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    // The replaced reservation keeps its grants; it is not granted again here.
    expect(migration).not.toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_provider_submission/);
    expect(migration.match(/SECURITY DEFINER/g)).toHaveLength(3);
    expect(migration.match(/SET search_path = public, pg_temp/g)).toHaveLength(3);
  });
});
