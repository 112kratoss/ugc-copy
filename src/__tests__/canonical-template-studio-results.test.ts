import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.join(
  process.cwd(),
  'supabase/migrations/20260712063730_canonical_template_studio_results.sql',
), 'utf8');

const templateRunService = fs.readFileSync(path.join(
  process.cwd(),
  'src/lib/template-run-service.ts',
), 'utf8');

describe('canonical template Studio results', () => {
  it('adds a canonical generation reference and fails closed while backfilling', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS result_generation_id uuid');
    expect(migration).toContain('template_runs_result_generation_id_fkey');
    expect(migration).toContain('template_runs_result_generation_unique_idx');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS studio_visible boolean');
    expect(migration).toContain('WHERE studio_visible IS NULL');
    expect(migration).toContain('runs.is_test = false');
    expect(migration).toContain('WHERE match_count = 1');
    expect(migration).toContain('ALTER COLUMN studio_visible SET NOT NULL');
  });

  it('starts every template generation hidden regardless of the ordinary default', () => {
    expect(migration).toMatch(/template_run_step_id,\s+studio_visible\s+\)/);
    expect(migration).toMatch(/p_template_run_step_id,\s+false\s+\)/);
  });

  it('atomically promotes only the validated non-test canonical generation', () => {
    expect(migration).toContain('p_result_generation_id uuid');
    expect(migration).toContain('generations.user_id = v_run.user_id');
    expect(migration).toContain('generations.template_run_id = v_run.id');
    expect(migration).toContain("generations.status = 'succeeded'");
    expect(migration).toContain("AND run_step.status <> 'succeeded'");
    expect(migration).toContain('generation_step.output_url = p_result_url');
    expect(migration).toContain('result_generation_id = p_result_generation_id');
    expect(migration).toContain('SET studio_visible = NOT v_run.is_test');
    expect(migration).toContain('UPDATE public.generations\n  SET studio_visible = false');
  });

  it('keeps a hardened rolling-deploy wrapper for the legacy completion call', () => {
    expect(migration).toContain('public.record_template_run_success(\n  p_run_id uuid,\n  p_result_url text,\n  p_credits_used integer\n)');
    expect(migration).toContain('RETURN public.record_template_run_success(\n    p_run_id,\n    p_result_url,\n    p_credits_used,\n    v_generation_id');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_template_run_success(uuid, text, integer)');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.record_template_run_success(uuid, text, integer, uuid)');
  });

  it('walks approval outputs upstream and sends the exact generation to the RPC', () => {
    expect(templateRunService).toContain('resolveCanonicalResultGenerationId');
    expect(templateRunService).toContain('if (!isApprovalGateNode(node)) return null');
    expect(templateRunService).toContain('if (incomingEdges.length !== 1) return null');
    expect(templateRunService).toContain('generation.template_run_step_id === step.id');
    expect(templateRunService).toContain('p_result_generation_id: resultGenerationId');
  });
});
