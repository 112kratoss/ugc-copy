import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260809100000_workflow_run_start_caller_guard.sql',
), 'utf8');

const original = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260808160000_workflow_run_durability.sql',
), 'utf8');

describe('workflow run start caller guard migration', () => {
  it('binds the acting user to auth.uid() when a user JWT is present', () => {
    // The hole: the function is SECURITY DEFINER and granted to `authenticated`,
    // but took the acting user as a parameter and only checked that the canvas
    // belonged to *that parameter*. Passing a victim's user id together with the
    // victim's canvas id satisfied the check, because the canvas really does
    // belong to the id supplied.
    expect(migration).toContain('v_caller := auth.uid();');
    expect(migration).toContain(
      'IF v_caller IS NOT NULL AND v_caller IS DISTINCT FROM p_user_id THEN',
    );
    expect(migration).toContain('cannot start a workflow run for another user');
  });

  it('runs the caller guard before the ownership check', () => {
    // Order matters for the error surfaced: a forged call should report the
    // caller mismatch, not leak whether the victim's canvas id exists.
    expect(migration.indexOf('v_caller := auth.uid();'))
      .toBeLessThan(migration.indexOf('workflow canvas not found for this user'));
  });

  it('leaves the service_role path working', () => {
    // auth.uid() is NULL for service_role, so the cron worker and ops paths keep
    // passing an explicit user id. Guarding on IS NOT NULL rather than equality
    // alone is what preserves that.
    expect(migration).toContain('IF v_caller IS NOT NULL');
    expect(migration).not.toMatch(/IF v_caller IS NULL THEN\s+RAISE EXCEPTION/);
  });

  it('preserves the idempotency semantics it replaces', () => {
    // This migration re-creates the whole function, so the F12 guarantees have
    // to survive the copy or the money fix silently regresses.
    expect(migration).toContain(
      'ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL\n  DO NOTHING',
    );
    expect(migration).not.toMatch(/ON CONFLICT \(canvas_id, idempotency_key\)[\s\S]{0,80}DO UPDATE/);
    expect(migration).toContain('idempotent workflow run lookup failed for key %');
    expect(migration).toContain('RETURN QUERY SELECT v_run.id, v_run.status, v_run.created_at, true;');
  });

  it('changes only the guard relative to the function it replaces', () => {
    // Everything except the new caller check is reproduced verbatim, so a diff
    // against 20260808160000 shows the security fix and nothing else.
    // Bound the slice to the first function end after the marker: the original
    // migration defines eight functions, so lastIndexOf would pick up the prune
    // helper instead.
    const bodyOf = (sql: string) => {
      const start = sql.indexOf('v_key := nullif');
      const end = sql.indexOf('END;\n$$;', start);
      return sql.slice(start, end).replace(/\s+/g, ' ').trim();
    };

    expect(bodyOf(migration)).toBe(bodyOf(original));
  });

  it('does not edit the already-applied migration', () => {
    // 20260808160000 is live in production; the guard has to arrive as a new
    // file. If the original ever grows the guard, this migration is redundant
    // and one of them is lying about what production runs.
    expect(original).not.toContain('auth.uid()');
  });
});
