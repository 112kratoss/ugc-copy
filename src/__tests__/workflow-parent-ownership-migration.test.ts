import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260926193740_enforce_workflow_parent_ownership.sql',
), 'utf8');

// pgTAP exercises writes/reads as actual client roles. These checks protect the
// schema-first rollout contract and prevent silently widening client access.
describe('workflow parent ownership migration', () => {
  it('adds restrictive parent checks to all four canvas child tables', () => {
    for (const table of [
      'workflow_canvas_history', 'workflow_canvas_runs',
      'workflow_canvas_assistant_proposals', 'workflow_canvas_assistant_messages',
    ]) {
      expect(migration).toContain(
        `ON public.${table} AS RESTRICTIVE FOR ALL TO authenticated`,
      );
      expect(migration).toContain(`canvas.id = ${table}.canvas_id`);
      expect(migration).toContain(`canvas.user_id = ${table}.user_id`);
    }
    expect(migration.match(/WITH CHECK/g)).toHaveLength(6);
  });

  it('checks optional proposal and generation references without broadening grants', () => {
    expect(migration).toContain('proposal.canvas_id = workflow_canvas_assistant_messages.canvas_id');
    expect(migration).toContain('proposal.user_id = (SELECT auth.uid())');
    expect(migration).toContain('generation.user_id = (SELECT auth.uid())');
    expect(migration).toContain('proposal_id IS NULL');
    expect(migration).toContain('generation_id IS NULL');
    expect(migration).not.toMatch(/\b(?:GRANT|REVOKE|SECURITY DEFINER|DROP POLICY)\b/);
  });

  it('bounds production lock acquisition and changes no existing records', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE FROM|INSERT INTO|ALTER TABLE)\b/);
  });
});
