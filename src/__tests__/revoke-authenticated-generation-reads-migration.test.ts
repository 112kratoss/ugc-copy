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
 * every client read of generations; workflow_parent_ownership,
 * workflow_run_initialization and client_rpc_boundaries prove the policies
 * that check a generation's owner still work without the grant. This pins the
 * migration's shape.
 */
describe('authenticated reads of generations are revoked', () => {
  const sql = readMigration('20261031033532_revoke_authenticated_generation_reads.sql');
  const helper = sql.slice(
    sql.indexOf('CREATE OR REPLACE FUNCTION public.current_identity_owns_generation(p_generation_id uuid)'),
    sql.indexOf('$$;') + 3,
  );
  const stepPolicy = statementAt(sql, 'CREATE POLICY workflow_step_generation_owned');
  const inputMediaPolicy = statementAt(sql, 'CREATE POLICY "Users can view own generation input media"');

  it('drops the resume policy and every table and column privilege of the client roles', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS "Users can resume their own generations" ON public.generations;');
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON TABLE public.generations FROM PUBLIC, anon, authenticated;');
    // The resume projection was granted column by column, which a table
    // revoke leaves in place.
    expect(sql).toMatch(/WHERE columns\.table_schema = 'public'\s+AND columns\.table_name = 'generations';/);
    expect(sql).toContain(
      "'REVOKE ALL PRIVILEGES (%s) ON TABLE public.generations FROM PUBLIC, anon, authenticated'",
    );
  });

  it('grants nothing on generations and leaves the service role alone', () => {
    expect(sql).not.toMatch(/GRANT[^;]*ON TABLE public\.generations/);
    expect(sql).not.toMatch(/(?:REVOKE|FROM)[^;]*service_role/);
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
    expect(sql.split('FROM public.generations')).toHaveLength(2);
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
