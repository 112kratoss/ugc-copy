import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260808160000_workflow_run_durability.sql',
), 'utf8');

describe('workflow run durability migration', () => {
  it('binds run creation to a unique idempotency key per canvas', () => {
    // The money half of F12. Without this index a timed-out client retry
    // creates a second run that re-charges every node's generation, and
    // per-generation idempotency cannot catch it because each new run
    // legitimately starts new generations.
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS idempotency_key text');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS workflow_canvas_runs_canvas_idempotency_key_idx',
    );
    expect(migration).toContain('ON public.workflow_canvas_runs (canvas_id, idempotency_key)');
    // Partial, so a keyless run stays insertable and ON CONFLICT can name it.
    expect(migration).toContain('WHERE idempotency_key IS NOT NULL');
  });

  it('returns the existing run on a replay instead of upserting over it', () => {
    // An upsert would rewrite graph_snapshot on a run that may already be
    // mid-flight, so the conflict path must be DO NOTHING followed by a read.
    expect(migration).toContain(
      'ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL\n  DO NOTHING',
    );
    expect(migration).not.toMatch(/ON CONFLICT \(canvas_id, idempotency_key\)[\s\S]{0,80}DO UPDATE/);
    expect(migration).toContain('reused boolean');
  });

  it('re-checks canvas ownership inside the SECURITY DEFINER run starter', () => {
    // The function bypasses RLS, so the route's ownership check is not the
    // boundary -- this is.
    expect(migration).toContain('workflow canvas not found for this user');
    expect(migration).toMatch(
      /SELECT 1 FROM public\.workflow_canvases\s+WHERE id = p_canvas_id AND user_id = p_user_id/,
    );
  });

  it('keeps one job per node per attempt so an enqueue cannot double-execute', () => {
    expect(migration).toContain(
      'CONSTRAINT workflow_run_step_jobs_run_node_attempt_key UNIQUE (run_id, node_id, attempt)',
    );
    expect(migration).toContain(
      'ON CONFLICT ON CONSTRAINT workflow_run_step_jobs_run_node_attempt_key',
    );
  });

  it('claims with SKIP LOCKED and reclaims on heartbeat before lock age', () => {
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    // coalesce(heartbeat_at, locked_at): a long-running node refreshes its
    // heartbeat so it is not stolen out from under itself, while a worker that
    // died before its first heartbeat still becomes reclaimable.
    expect(migration).toContain(
      'AND coalesce(heartbeat_at, locked_at) <= now() - make_interval(secs => p_lock_ttl_seconds)',
    );
  });

  it('schedules a retry as a new attempt row in the failing transaction', () => {
    // A retry is a new row, not a reset counter, so each attempt keeps its own
    // error and timing -- which is what makes "was this node charged twice?"
    // answerable after the fact.
    expect(migration).toContain('v_job.attempt + 1');
    expect(migration).toContain("RETURN 'retry_scheduled'");
    expect(migration).toContain("RETURN 'exhausted'");
    expect(migration).toContain('IF v_job.attempt < p_max_attempts THEN');
  });

  it('refuses to finish or heartbeat a job the caller no longer holds', () => {
    // Two workers must never both report an outcome for one attempt.
    const finishGuards = migration.match(/AND status = 'processing'\n    AND locked_by = p_locked_by/g);
    expect(finishGuards?.length).toBeGreaterThanOrEqual(3);
  });

  it('defers a waiting run without consuming its attempt budget', () => {
    // A run still waiting on a provider generation has not failed. Charging the
    // wait against the retry cap would let a slow video generation "retry"
    // itself to exhaustion while nothing was wrong.
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.defer_workflow_run_step_job');
    expect(migration).toContain("RETURNING 'deferred' INTO v_status");
    const deferBody = migration.slice(
      migration.indexOf('FUNCTION public.defer_workflow_run_step_job'),
      migration.indexOf('FUNCTION public.cancel_workflow_run_step_jobs'),
    );
    // It reschedules via next_attempt_at but must never write the attempt
    // counter itself, or a deferral would be indistinguishable from a retry.
    expect(deferBody).toContain('next_attempt_at = now() + make_interval');
    expect(deferBody).not.toMatch(/(^|[^_])attempt\s*=(?!=)/m);
    expect(deferBody).not.toMatch(/attempt\s*\+/);
  });

  it('keeps the queue service-role only', () => {
    expect(migration).toContain('ALTER TABLE public.workflow_run_step_jobs ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.workflow_run_step_jobs FROM anon, authenticated');
    expect(migration).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.workflow_run_step_jobs TO service_role',
    );

    for (const fn of [
      'enqueue_workflow_run_step_job',
      'claim_workflow_run_step_jobs',
      'heartbeat_workflow_run_step_job',
      'finish_workflow_run_step_job',
      'defer_workflow_run_step_job',
      'cancel_workflow_run_step_jobs',
      'prune_workflow_run_step_jobs',
    ]) {
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM anon, authenticated`),
      );
    }
  });

  it('grants run creation to authenticated because the run route uses the caller client', () => {
    // The only function on this path a signed-in user reaches. It re-checks
    // ownership internally, so SECURITY DEFINER does not widen what they can
    // start.
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.start_workflow_canvas_run(uuid, uuid, text, text, text, jsonb, text) TO authenticated',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.start_workflow_canvas_run(uuid, uuid, text, text, text, jsonb, text) FROM anon',
    );
  });

  it('indexes the queue for the claim predicate and for retention', () => {
    expect(migration).toContain('workflow_run_step_jobs_due_idx');
    expect(migration).toContain('(status, next_attempt_at, created_at)');
    expect(migration).toContain('workflow_run_step_jobs_updated_idx');
  });
});
