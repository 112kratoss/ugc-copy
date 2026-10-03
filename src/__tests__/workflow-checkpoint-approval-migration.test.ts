import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(), 'supabase/migrations/20261003050000_atomic_workflow_checkpoint_approval.sql',
), 'utf8');

describe('atomic workflow checkpoint approval migration', () => {
  it('uses only the service role and binds locks to the run owner and canvas', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration).toContain('id = p_run_id AND canvas_id = p_canvas_id AND user_id = p_user_id FOR UPDATE');
  });
  it('commits the approved gate, resumed run and wake ticket in one transaction', () => {
    expect(migration).toContain("v_step.status <> 'awaiting_approval'");
    expect(migration).toContain("node ->> 'type' = 'approval-gate'");
    expect(migration).toContain('UPDATE public.workflow_canvas_run_steps');
    expect(migration).toContain('UPDATE public.workflow_canvas_runs');
    expect(migration).toContain("PERFORM public.enqueue_workflow_run_step_job(p_run_id, 'approval:' || v_step.node_id, 1)");
    expect(migration).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});
