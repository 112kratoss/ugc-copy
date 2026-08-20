import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const additiveMigration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819072000_workflow_authorization_hardening.sql',
), 'utf8');

const contractMigration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/contract_migrations/security_remediation_stage3.sql',
), 'utf8');

describe('staged workflow authorization hardening', () => {
  it('keeps the legacy boundary compatible but enforces 20 starts per ten minutes internally', () => {
    expect(additiveMigration).toContain('CREATE OR REPLACE FUNCTION public.start_workflow_canvas_run');
    expect(additiveMigration).toContain("'legacy-workflow-run-start'");
    expect(additiveMigration).toMatch(/p_user_id::text,\s*20,\s*600/);
    expect(additiveMigration).toContain("RAISE EXCEPTION 'legacy workflow run rate limit exceeded'");
    expect(additiveMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.start_workflow_canvas_run\([\s\S]*?\) FROM PUBLIC, anon;/,
    );
    expect(additiveMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.start_workflow_canvas_run\([\s\S]*?\) TO authenticated, service_role;/,
    );
    expect(additiveMigration).not.toContain('DROP FUNCTION public.start_workflow_canvas_run');
    expect(additiveMigration).not.toContain('REVOKE INSERT, UPDATE, DELETE');
  });

  it('keeps authenticated polling but removes direct writes in the deferred contract', () => {
    expect(contractMigration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE\s+ON TABLE public\.workflow_canvas_runs\s+FROM anon, authenticated;/,
    );
    expect(contractMigration).toMatch(
      /REVOKE INSERT, UPDATE, DELETE\s+ON TABLE public\.workflow_canvas_run_steps\s+FROM anon, authenticated;/,
    );
    expect(contractMigration).toContain('GRANT SELECT ON TABLE public.workflow_canvas_runs TO authenticated;');
    expect(contractMigration).toContain('GRANT SELECT ON TABLE public.workflow_canvas_run_steps TO authenticated;');
    expect(contractMigration).toContain('DROP POLICY IF EXISTS "Users can create their own workflow runs"');
    expect(contractMigration).toContain('DROP POLICY IF EXISTS "Users can update their own workflow run steps"');
  });

  it('makes the idempotent initializer service-only only in the deferred contract', () => {
    expect(contractMigration).toMatch(
      /REVOKE ALL ON FUNCTION public\.initialize_workflow_canvas_run\([\s\S]*?\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(contractMigration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.initialize_workflow_canvas_run\([\s\S]*?\) TO service_role;/,
    );
    expect(contractMigration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.initialize_workflow_canvas_run\([\s\S]*?\) TO authenticated/,
    );
  });

  it('drops the compatibility RPC only after the telemetry-gated promotion', () => {
    expect(contractMigration).toContain('DEFERRED STAGE-3 CONTRACT MIGRATION');
    expect(contractMigration).toMatch(
      /DROP FUNCTION public\.start_workflow_canvas_run\(\s*uuid, uuid, text, text, text, jsonb, text\s*\);/,
    );
    expect(contractMigration).toMatch(
      /DROP FUNCTION public\.reserve_upload_bytes\(\s*uuid, text, text, bigint, bigint, bigint, integer\s*\);/,
    );
  });
});
