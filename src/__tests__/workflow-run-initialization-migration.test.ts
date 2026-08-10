import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260810100000_require_workflow_run_idempotency.sql',
), 'utf8');

describe('atomic workflow run initialization migration', () => {
  it('makes the atomic initializer reject keyless starts and bind one run to a canvas/key pair', () => {
    expect(migration).toContain("v_key := nullif(btrim(coalesce(p_idempotency_key, '')), '')");
    expect(migration).toContain("RAISE EXCEPTION 'idempotency_key is required'");
    expect(migration).toContain('ON CONFLICT (canvas_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
  });

  it('initializes the complete step skeleton and first durable ticket atomically', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.initialize_workflow_canvas_run');
    expect(migration).toContain('Keep the older start_workflow_canvas_run grant for one release only');
    expect(migration).toContain('jsonb_array_elements(p_step_skeleton) AS item');
    expect(migration).toContain('INSERT INTO public.workflow_canvas_run_steps');
    expect(migration).toContain('INSERT INTO public.workflow_run_step_jobs');
    expect(migration).toContain('workflow_canvas_run_steps_run_node_idx');
  });

  it('validates ownership and keeps the definer RPC off anonymous callers', () => {
    expect(migration).toMatch(
      /SELECT 1 FROM public\.workflow_canvases\s+WHERE id = p_canvas_id AND user_id = p_user_id/,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.initialize_workflow_canvas_run\(\s*uuid, uuid, text, text, text, jsonb, text, jsonb\s*\) FROM PUBLIC, anon/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.initialize_workflow_canvas_run\(\s*uuid, uuid, text, text, text, jsonb, text, jsonb\s*\) TO authenticated, service_role/,
    );
  });
});
