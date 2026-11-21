import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readMigration(name: string) {
  return readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

/**
 * The behaviour is asserted by pgTAP: data_api_contract_grants,
 * workflow_run_initialization and workflow_parent_ownership refuse every
 * client write of runs and steps and keep the owner's reads;
 * public_private_projection_boundaries refuses every client read of input
 * media; client_rpc_boundaries pins the client-callable list without the
 * helper; policy_dependency_privileges fails any client policy that reads what
 * its role may not. This pins the migration's shape.
 */
describe('client run writes, input media reads and the generation owner helper are retired', () => {
  const sql = readMigration('20261121214810_retire_client_run_writes_and_input_media_reads.sql');
  const statements = sql.replace(/--.*$/gm, '');

  it('revokes client writes of runs and steps and keeps their reads', () => {
    for (const table of ['workflow_canvas_runs', 'workflow_canvas_run_steps']) {
      expect(sql).toContain(`REVOKE INSERT, UPDATE, DELETE ON TABLE public.${table} FROM anon, authenticated;`);
    }
    expect(statements).not.toMatch(/\bREVOKE\b[^;]*\bSELECT\b[^;]*\bworkflow_canvas_run/i);
    expect(statements).not.toMatch(/\bREVOKE\s+ALL\b[^;]*\bworkflow_canvas_run/i);
  });

  it('drops the client write policies and the step generation check, and no read policy', () => {
    for (const [policy, table] of [
      ['"Users can create their own workflow runs"', 'workflow_canvas_runs'],
      ['"Users can update their own workflow runs"', 'workflow_canvas_runs'],
      ['"Users can create their own workflow run steps"', 'workflow_canvas_run_steps'],
      ['"Users can update their own workflow run steps"', 'workflow_canvas_run_steps'],
      ['workflow_step_generation_owned', 'workflow_canvas_run_steps'],
    ]) {
      expect(sql).toContain(`DROP POLICY IF EXISTS ${policy} ON public.${table};`);
    }
    expect(statements.match(/\bDROP POLICY\b/g)).toHaveLength(6);
    expect(statements).not.toMatch(/\bCREATE POLICY\b/i);
    expect(statements).not.toMatch(/Users can view their own workflow run|authenticated_identity_active|workflow_parent_owned/);
  });

  it('closes generation_input_media to every client role', () => {
    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Users can view own generation input media" ON public.generation_input_media;',
    );
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.generation_input_media FROM PUBLIC, anon, authenticated;');
  });

  it('grants nothing and leaves the service role alone', () => {
    expect(statements).not.toMatch(/\bGRANT\b/i);
    expect(statements).not.toMatch(/\bservice_role\b/i);
  });

  // IF EXISTS keeps a repeated apply harmless; without CASCADE a policy still
  // calling the helper fails the migration.
  it('drops the helper after the policies that called it, without cascading', () => {
    const drop = sql.indexOf('DROP FUNCTION IF EXISTS public.current_identity_owns_generation(uuid);');
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(sql.indexOf('DROP POLICY IF EXISTS workflow_step_generation_owned'));
    expect(drop).toBeGreaterThan(sql.indexOf('DROP POLICY IF EXISTS "Users can view own generation input media"'));
    expect(statements).not.toMatch(/\bCASCADE\b/i);
  });

  // Settlement and generation deletes write generations, then reach run steps
  // and input media. SHARE holds them off and still lets a child insert check
  // its foreign key against generations (ROW SHARE).
  it('holds off generation writers before touching the tables that link it', () => {
    const lock = sql.indexOf('LOCK TABLE public.generations IN SHARE MODE;');
    expect(lock).toBeGreaterThan(sql.indexOf("SET LOCAL lock_timeout = '5s';"));
    for (const table of [
      'public.workflow_canvas_runs',
      'public.workflow_canvas_run_steps',
      'public.generation_input_media',
    ]) {
      expect(sql.indexOf(table, sql.indexOf('BEGIN;'))).toBeGreaterThan(lock);
    }
  });

  it('runs in one transaction with a bounded lock wait', () => {
    expect(sql).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
