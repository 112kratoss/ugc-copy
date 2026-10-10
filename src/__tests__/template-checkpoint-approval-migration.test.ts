import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync('supabase/migrations/20261009163235_atomic_template_checkpoint_approval.sql', 'utf8');

describe('atomic template checkpoint approval migration', () => {
  it('restricts execution to service role under caller grants', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
  });

  it('locks the owned run before the checkpoint and commits durable execution together', () => {
    expect(migration).toContain('id = p_run_id AND user_id = p_user_id FOR UPDATE');
    expect(migration).toContain('id = p_step_id AND run_id = p_run_id FOR UPDATE');
    expect(migration).toContain("IF v_run.status IN ('succeeded', 'failed', 'cancelled')");
    expect(migration).toContain('attempt > v_step.attempt');
    expect(migration).toContain('PERFORM public.enqueue_template_run_job(v_run.id)');
    expect(migration).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});
