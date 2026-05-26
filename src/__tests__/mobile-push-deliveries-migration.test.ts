import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = path.resolve(
  process.cwd(),
  'supabase/migrations/20260525203630_mobile_push_deliveries.sql'
);

describe('mobile push deliveries migration', () => {
  it('creates the delivery ledger table with receipt tracking columns', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.mobile_push_deliveries');
    expect(migration).toContain('send_status text NOT NULL DEFAULT \'pending\'');
    expect(migration).toContain('receipt_status text NOT NULL DEFAULT \'pending\'');
    expect(migration).toContain('receipt_error_code text');
    expect(migration).toContain('provider_details jsonb');
    expect(migration).toContain('ALTER TABLE public.mobile_push_deliveries ENABLE ROW LEVEL SECURITY');
  });

  it('adds delivery indexes without exposing the table to authenticated clients', () => {
    const migration = fs.readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('CREATE INDEX IF NOT EXISTS mobile_push_deliveries_pending_receipts_idx');
    expect(migration).toContain('CREATE INDEX IF NOT EXISTS mobile_push_deliveries_notification_idx');
    expect(migration).toContain('CREATE TRIGGER mobile_push_deliveries_set_updated_at');
    expect(migration).not.toContain('GRANT SELECT');
    expect(migration).not.toContain('TO authenticated');
  });
});
