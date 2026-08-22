import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260822120000_bound_upload_admission_and_reclaim.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');

describe('bounded upload admission and reclaim migration', () => {
  it('maintains constant-size user/global counters transactionally', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.upload_byte_global_counters');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.upload_byte_user_counters');
    expect(migration).toContain('CREATE TRIGGER upload_byte_reservations_sync_admission_counters');
    expect(migration).toContain('public.sync_upload_byte_admission_counters()');
    expect(migration).toContain('public.reconcile_upload_byte_admission_counters');
    expect(migration).not.toMatch(/AS \$\$\s*AS \$\$/u);
  });

  it('removes request-path reservation scans and the global advisory lock', () => {
    const v2Body = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.reserve_upload_bytes_v2('),
      migration.indexOf('-- Remove the obsolete global advisory lock'),
    );
    expect(v2Body).not.toContain("pg_advisory_xact_lock(hashtextextended('upload-byte-admission'");
    expect(v2Body).not.toMatch(/\bsum\s*\(/i);
    expect(v2Body).toContain('FROM public.upload_byte_user_counters');
    expect(v2Body).toContain('FROM public.upload_byte_global_counters');
  });

  it('uses an expiry-led candidate index and a separate scheduling hint', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS reclaim_after timestamptz');
    expect(migration).toContain('ON public.upload_byte_reservations (expires_at, id)');
    expect(migration).toContain('upload_byte_reservations_deferred_reclaim_idx');
    expect(migration).toContain("finalization_status IN (\n      'reserved', 'issued'");
  });

  it('keeps counters and reconciliation private to the service role', () => {
    expect(migration).toContain(
      'REVOKE ALL ON public.upload_byte_global_counters FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.reconcile_upload_byte_admission_counters(boolean)\n  TO service_role;',
    );
  });
});
