import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260711154500_private_template_generations.sql',
), 'utf8');
const settlementMigration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260711201026_settle_template_generation_start_failures.sql',
), 'utf8');

describe('private template generations migration', () => {
  it('reserves credits and links one generation step in a backend-only transaction', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.start_template_generation');
    expect(migration).toContain('SET credits = credits - p_cost');
    expect(migration).toContain('template_run_id,');
    expect(migration).toContain('template_run_step_id');
    expect(migration).toContain('SET generation_id = v_generation_id');
    expect(migration).toContain("status = 'processing'");
    expect(migration).toContain('generations_template_run_step_unique_idx');
    expect(migration).toContain('TO service_role');
    expect(migration).toContain('FROM authenticated');
  });

  it('stores no creator prompt or workflow recipe in template generation rows', () => {
    expect(migration).toContain("'{}'::jsonb");
    expect(migration).not.toContain('p_prompt text');
    expect(migration).not.toContain('p_workflow_settings jsonb');
  });

  it('keeps linked rows out of authenticated selects and client mutations', () => {
    expect(migration).toContain('CREATE POLICY "Users can view accessible ordinary generations"');
    expect(migration).toMatch(/template_run_id IS NULL\s+AND template_run_step_id IS NULL\s+AND \(is_public = true/);
    expect(migration).toContain('CREATE POLICY "Users can create own ordinary generations"');
    expect(migration).toContain('CREATE POLICY "Users can update own ordinary generations"');
  });

  it('settles pre-provider failures atomically, idempotently, and only through the backend', () => {
    expect(settlementMigration).toContain('CREATE OR REPLACE FUNCTION public.settle_template_generation_start_failed');
    expect(settlementMigration).toContain('FOR UPDATE');
    expect(settlementMigration).toContain("IF NOT coalesce(v_generation.refunded, false)");
    expect(settlementMigration).toContain('SET credits = credits + greatest');
    expect(settlementMigration).toContain("status = 'failed'");
    expect(settlementMigration).toContain('refunded = true');
    expect(settlementMigration).toContain('client_request_key_hash = null');
    expect(settlementMigration).toContain('SECURITY DEFINER');
    expect(settlementMigration).toContain("SET search_path = ''");
    expect(settlementMigration).toContain('FROM PUBLIC, anon, authenticated');
    expect(settlementMigration).toContain('TO service_role');
  });

  it('persists only hashed run-creation keys behind a scoped unique index', () => {
    expect(settlementMigration).toContain('client_request_key_hash text');
    expect(settlementMigration).toContain("client_request_key_hash ~ '^[a-f0-9]{64}$'");
    expect(settlementMigration).toContain('template_runs_create_idempotency_unique_idx');
    expect(settlementMigration).toContain('(user_id, template_id, is_test, client_request_key_hash)');
  });
});
