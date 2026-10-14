import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20261014145937_account_deletion_wallet_records.sql',
), 'utf8');

const tableDefinition = migration.slice(
  migration.indexOf('CREATE TABLE public.account_deletion_wallet_records'),
  migration.indexOf('COMMENT ON TABLE'),
);
const statements = migration.replace(/--[^\n]*/g, '');

describe('account deletion wallet records migration', () => {
  it('keeps every wallet amount the deletion service copies', () => {
    for (const column of [
      'available_token_subunits bigint NOT NULL',
      'held_token_subunits bigint NOT NULL',
      'lifetime_earned_token_subunits bigint NOT NULL',
      'lifetime_refunded_token_subunits bigint NOT NULL',
      'lifetime_paid_out_token_subunits bigint NOT NULL',
      'user_id uuid NOT NULL',
      'job_id uuid NOT NULL',
      "recorded_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())",
    ]) {
      expect(tableDefinition).toContain(column);
    }
  });

  it('outlives the account: no foreign key can cascade a record away', () => {
    expect(tableDefinition).not.toContain('REFERENCES');
  });

  it('makes a retried deletion write once per wallet and job', () => {
    // The service upserts with onConflict 'user_id,job_id' and ignoreDuplicates.
    expect(tableDefinition).toContain(
      'CONSTRAINT account_deletion_wallet_records_user_job_key UNIQUE (user_id, job_id)',
    );
  });

  it('is append-only and out of every client\'s reach', () => {
    expect(migration).toContain('ALTER TABLE public.account_deletion_wallet_records ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain(
      'REVOKE ALL ON TABLE public.account_deletion_wallet_records\n  FROM PUBLIC, anon, authenticated, service_role;',
    );
    // New tables are born with every privilege, so the revoke above is what
    // makes this the only grant anyone holds.
    expect(statements.match(/\bGRANT\b[^;]*;/g)).toEqual([
      'GRANT SELECT, INSERT ON TABLE public.account_deletion_wallet_records TO service_role;',
    ]);
    expect(migration).toContain('ON public.account_deletion_wallet_records FOR ALL TO anon, authenticated');
  });
});
