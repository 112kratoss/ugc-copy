import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260725220000_generation_completion_source.sql',
), 'utf8');

describe('generation completion source migration', () => {
  it('adds a nullable attribution column constrained to the two runners', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS completed_via text');
    expect(migration).toContain("CHECK (completed_via IS NULL OR completed_via IN ('webhook_drain', 'cron_sweep'))");
    // Nullable on purpose: jobs completed before this column existed, and jobs
    // still awaiting a retry, legitimately have no attribution.
    expect(migration).not.toMatch(/completed_via text not null/i);
  });

  it('derives the runner from the lock owner rather than a new parameter', () => {
    // The RPC already receives p_locked_by, and the two callers write
    // distinguishable owners. Adding a parameter would change a signature on
    // the path that settles paid generations.
    expect(migration).toContain("WHEN p_locked_by LIKE 'kie-webhook:%' THEN 'webhook_drain'");
    expect(migration).toContain("ELSE 'cron_sweep'");
    expect(migration).toContain('finish_generation_completion_job(\n  p_id uuid,\n  p_locked_by text,\n  p_succeeded boolean,\n  p_error text DEFAULT NULL,\n  p_retry_delay_seconds integer DEFAULT 60\n)');
  });

  it('stamps attribution only on a terminal transition', () => {
    // A job returning to 'pending' for another attempt must keep whatever it
    // had, so a retry that later succeeds on the sweep is credited to the sweep.
    expect(migration).toContain('WHEN p_succeeded OR attempt_count >= 5');
    expect(migration).toContain('ELSE completed_via');
  });

  it('leaves the settlement semantics untouched', () => {
    // The guards this function exists to enforce must survive verbatim.
    expect(migration).toContain('locked_at = NULL');
    expect(migration).toContain('locked_by = NULL');
    expect(migration).toContain("AND status = 'processing'");
    expect(migration).toContain('AND locked_by = p_locked_by');
    expect(migration).toContain("RAISE EXCEPTION 'locked_by is required'");
    expect(migration).toContain("RAISE EXCEPTION 'retry delay must be positive'");
  });

  it('keeps the function service-role only', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.finish_generation_completion_job');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.finish_generation_completion_job(uuid, text, boolean, text, integer) TO service_role');
  });

  it('is additive and cannot destroy completion history', () => {
    expect(migration).not.toMatch(/drop\s+table/i);
    expect(migration).not.toMatch(/drop\s+column/i);
    expect(migration).not.toMatch(/truncate/i);
    expect(migration).not.toMatch(/delete\s+from/i);
  });
});
