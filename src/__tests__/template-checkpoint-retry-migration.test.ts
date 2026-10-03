import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(), 'supabase/migrations/20261003010000_atomic_template_checkpoint_retry.sql',
), 'utf8');

describe('atomic template checkpoint retry migration', () => {
  it('keeps checkpoint replacement behind the service role without definer elevation', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain("SET search_path = ''");
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
    expect(migration).toContain('id = p_run_id AND user_id = p_user_id FOR UPDATE');
  });

  it('queues both replacements and durable execution in the same function', () => {
    expect(migration).toContain("IF v_run.status IN ('succeeded', 'failed', 'cancelled')");
    expect(migration).toContain('v_source.attempt + 1');
    expect(migration).toContain('v_step.attempt + 1');
    expect(migration).toContain('PERFORM public.enqueue_template_run_job(p_run_id)');
    expect(migration).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});
