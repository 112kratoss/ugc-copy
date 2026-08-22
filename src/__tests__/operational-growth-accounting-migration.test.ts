import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260822121000_complete_operational_growth_accounting.sql',
), 'utf8');

describe('complete operational growth accounting migration', () => {
  it('reports every new upload and durable workflow table', () => {
    for (const table of [
      'upload_byte_reservations',
      'upload_byte_user_counters',
      'upload_path_tombstones',
      'account_merge_tickets',
      'workflow_canvas_runs',
      'workflow_canvas_run_steps',
      'template_runs',
      'template_run_steps',
    ]) {
      expect(migration).toContain(`'${table}'`);
    }
  });

  it('prunes expired merge tickets in an indexed bounded batch', () => {
    expect(migration).toContain('account_merge_tickets_retention_expiry_idx');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.prune_account_merge_tickets');
    expect(migration).toContain("ticket.expires_at < now() - interval '30 days'");
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('TO service_role;');
  });

  it('exposes actionable/deferred reclaim age without exposing the tables publicly', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_upload_reclaim_health');
    expect(migration).toContain('oldest_actionable_at timestamptz');
    expect(migration).toContain('LIMIT 20001');
    expect(migration).toContain('pg_catalog.pg_stat_user_tables');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.get_upload_reclaim_health');
  });
});
