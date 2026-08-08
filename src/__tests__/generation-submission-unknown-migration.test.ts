import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809120000_generation_submission_unknown.sql',
), 'utf8');

const statusConstraint = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260309050444_remote_schema.sql',
), 'utf8');

describe('generation submission-unknown migration', () => {
  it('marks the ambiguous case without inventing a new generations.status value', () => {
    // status is read as set membership in at least eight places outside the
    // reaper. Widening the CHECK would mean auditing every one, and missing
    // ACTIVE_START_STATUSES in generation-start-idempotency.ts would stop a
    // same-key resubmit being deduped as a replay -- charging the user twice
    // while the first submission may still be accepted.
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS submission_unknown_at timestamptz');
    expect(migration).not.toContain('generations_status_check');
    // The constraint the migration deliberately does not touch.
    expect(statusConstraint).toContain("'pending'::text");
  });

  it('refuses to mark a generation the provider already claimed', () => {
    // The callback can beat the mark: task creation waits 30s, and Kie may have
    // accepted and called back in that window. Marking a running generation
    // would make the flag mean two different things.
    expect(migration).toContain("RETURN jsonb_build_object(\n      'status', 'provider_task_attached'");
    expect(migration).toContain('FOR UPDATE');
  });

  it('keeps the marker after settlement so the discrepancy stays attributable', () => {
    // record_provider_submission_reconciliation keys on it, and a late callback
    // arrives strictly after the reaper has settled the row.
    const settleBody = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.settle_generation_start_failed'));
    expect(settleBody).toContain("'submission_unknown', v_generation.submission_unknown_at IS NOT NULL");
    expect(settleBody).not.toContain('submission_unknown_at = NULL');
  });

  it('records a reconciliation row only for the shape that loses money', () => {
    // The webhook reaches this path via `already_settled`, which also fires for
    // ordinary duplicate callbacks on generations that succeeded normally. A
    // ledger full of benign duplicates is one nobody reads, so the test lives in
    // the RPC rather than in the caller.
    expect(migration).toContain('IF v_generation.submission_unknown_at IS NULL');
    expect(migration).toContain('OR NOT coalesce(v_generation.refunded, false) THEN');
    expect(migration).toContain("RETURN jsonb_build_object('status', 'not_applicable'");
  });

  it('treats a retried callback as one discrepancy, not several', () => {
    expect(migration).toContain('generation_id uuid NOT NULL UNIQUE');
    expect(migration).toContain('ON CONFLICT (generation_id) DO NOTHING');
  });

  it('keeps the new surface service-role only', () => {
    // Same posture as generation_completion_jobs: RLS on with no policies, so
    // only the service role (which bypasses RLS) can reach it.
    expect(migration).toContain('ALTER TABLE public.provider_submission_reconciliations ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.provider_submission_reconciliations FROM anon, authenticated');
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_submission_reconciliations TO service_role');

    for (const fn of [
      'public.mark_generation_submission_unknown(uuid)',
      'public.record_provider_submission_reconciliation(uuid, text)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM authenticated`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION ${fn} TO service_role`);
    }
  });

  it('pins search_path on every SECURITY DEFINER function it adds', () => {
    // The standing rule after the 6303a95 seam bug: a SECURITY DEFINER function
    // with a mutable search_path is the advisor's first finding every time.
    const definerCount = migration.match(/SECURITY DEFINER/g)?.length ?? 0;
    const searchPathCount = migration.match(/SET search_path = public, pg_temp/g)?.length ?? 0;
    expect(definerCount).toBeGreaterThan(0);
    expect(searchPathCount).toBe(definerCount);
  });
});
