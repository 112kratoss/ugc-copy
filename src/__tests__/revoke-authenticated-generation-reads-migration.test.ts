import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readMigration(name: string) {
  return readFileSync(path.join(process.cwd(), 'supabase/migrations', name), 'utf8');
}

function statementAt(sql: string, start: string) {
  const from = sql.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return sql.slice(from, sql.indexOf(';', from) + 1);
}

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * The behaviour is asserted by pgTAP: client_rls_boundaries,
 * production_data_contract and public_private_projection_boundaries refuse
 * every client read of generations; workflow_parent_ownership (run steps) and
 * public_private_projection_boundaries (input media) evaluate the two
 * rewritten policies through the helper; client_rpc_boundaries pins its
 * answers and who may call it; policy_dependency_privileges fails any client
 * policy that reads what its role may not. This pins the migration's shape.
 */
describe('authenticated reads of generations are revoked', () => {
  const sql = readMigration('20261031033532_revoke_authenticated_generation_reads.sql');
  const statements = sql.replace(/--.*$/gm, '');
  const helper = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.current_identity_owns_generation(p_generation_id uuid)'),
    sql.indexOf('$$;') + 3,
  );
  const stepPolicy = statementAt(sql, 'CREATE POLICY workflow_step_generation_owned');
  const inputMediaPolicy = statementAt(sql, 'CREATE POLICY "Users can view own generation input media"');

  it('drops the resume policy and every privilege of the client roles', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS "Users can resume their own generations" ON public.generations;');
    // A table-level revoke also clears the column grants the projection was made of.
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.generations FROM PUBLIC, anon, authenticated;');
  });

  it('grants nothing on generations and leaves the service role alone', () => {
    expect(statements).not.toMatch(/\bGRANT\b[^;]*\bON\s+(?:TABLE\s+)?(?:public\.)?generations\b/i);
    expect(statements).not.toMatch(/\b(?:REVOKE|FROM)\b[^;]*\bservice_role\b/i);
  });

  // Settlement updates generations and its terminal trigger then reads run
  // steps; deletes cascade from generations. The migration takes the same order.
  it('locks generations before the tables that link it', () => {
    const lock = sql.indexOf('LOCK TABLE public.generations IN ACCESS EXCLUSIVE MODE;');
    expect(lock).toBeGreaterThan(sql.indexOf("SET LOCAL lock_timeout = '5s';"));
    for (const table of ['public.workflow_canvas_run_steps', 'public.generation_input_media']) {
      expect(sql.indexOf(table)).toBeGreaterThan(lock);
    }
  });

  it('answers ownership for the caller only, with the function owner\'s privileges', () => {
    expect(normalize(helper)).toBe(normalize(`
      CREATE OR REPLACE FUNCTION public.current_identity_owns_generation(p_generation_id uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = ''
      AS $$
        SELECT EXISTS (
          SELECT 1
          FROM public.generations AS generation
          WHERE generation.id = p_generation_id
            AND generation.user_id = (SELECT auth.uid())
        );
      $$;
    `));
    expect(sql).toContain('REVOKE ALL ON FUNCTION public.current_identity_owns_generation(uuid) FROM PUBLIC, anon;');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION public.current_identity_owns_generation(uuid) TO authenticated, service_role;',
    );
  });

  // A sub-select in a policy runs with the querying user's privileges, so
  // after the revoke these two may not read generations themselves.
  it('moves both owner checks onto the helper', () => {
    expect(statements.match(/\bFROM\s+public\.generations\b/gi)).toHaveLength(1);
    expect(helper).toContain('FROM public.generations');

    expect(sql).toContain('DROP POLICY IF EXISTS workflow_step_generation_owned ON public.workflow_canvas_run_steps;');
    expect(normalize(stepPolicy)).toBe(normalize(`
      CREATE POLICY workflow_step_generation_owned
      ON public.workflow_canvas_run_steps AS RESTRICTIVE FOR ALL TO authenticated
      USING (
        generation_id IS NULL
        OR public.current_identity_owns_generation(generation_id)
      )
      WITH CHECK (
        generation_id IS NULL
        OR public.current_identity_owns_generation(generation_id)
      );
    `));

    expect(sql).toContain(
      'DROP POLICY IF EXISTS "Users can view own generation input media" ON public.generation_input_media;',
    );
    expect(normalize(inputMediaPolicy)).toBe(normalize(`
      CREATE POLICY "Users can view own generation input media"
      ON public.generation_input_media FOR SELECT TO authenticated
      USING (
        (SELECT auth.uid()) = user_id
        AND public.current_identity_owns_generation(generation_id)
      );
    `));
  });

  it('runs in one transaction with a bounded lock wait', () => {
    expect(sql).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });
});
