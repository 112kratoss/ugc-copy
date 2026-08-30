import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations', file),
  'utf8',
);

const migration = read('20260829120000_durable_welcome_credit_identity_fingerprints.sql');
const guestGuard = read('20260811120000_block_guest_welcome_credit_claims.sql');

describe('durable welcome credit identity fingerprints migration', () => {
  it('keeps the ledger free of any tie to auth.users', () => {
    // The bug: the only replay guard was UNIQUE (user_id, program_key) on
    // credit_grants, whose user_id cascades away with auth.users. Delete the
    // account and the record that 25 credits were already paid deletes with it.
    // The durable ledger must therefore never reference auth.users — not as a
    // foreign key, not as a column.
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.credit_grant_identity_fingerprints');
    const tableDefinition = migration.slice(
      migration.indexOf('CREATE TABLE IF NOT EXISTS public.credit_grant_identity_fingerprints'),
      migration.indexOf('ALTER TABLE public.credit_grant_identity_fingerprints'),
    );
    expect(tableDefinition).not.toContain('auth.users');
    expect(tableDefinition).not.toContain('user_id');
    expect(tableDefinition).toContain('PRIMARY KEY (program_key, fingerprint)');
  });

  it('makes the ledger append-only for service_role, not just clients', () => {
    // New tables are born with full privileges for service_role, so GRANT
    // SELECT, INSERT alone changes nothing — the ledger only keeps its memory
    // if UPDATE and DELETE are explicitly revoked first.
    expect(migration).toContain('REVOKE ALL ON public.credit_grant_identity_fingerprints FROM service_role;');
    expect(migration).toContain('GRANT SELECT, INSERT ON public.credit_grant_identity_fingerprints TO service_role;');
    expect(migration).toContain('REVOKE ALL ON public.credit_grant_identity_fingerprints FROM PUBLIC;');
    expect(migration).toContain('REVOKE ALL ON public.credit_grant_identity_fingerprints FROM anon, authenticated;');
    expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
  });

  it('drops the 3-argument function and re-issues the ACLs for the new signature', () => {
    // CREATE OR REPLACE cannot change a parameter list, and DROP discards the
    // ACLs — forgetting either leaves two overloads or an unrestricted
    // function.
    expect(migration).toContain('DROP FUNCTION IF EXISTS public.claim_credit_grant_program(uuid, text, text);');
    expect(migration).toContain('p_identity_fingerprints text[] DEFAULT NULL');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.claim_credit_grant_program(uuid, text, text, text[])\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION public.claim_credit_grant_program(uuid, text, text, text[])\n  TO service_role;',
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
  });

  it('checks the ledger only after the same-account claim record', () => {
    // A live account re-claiming must still read its own 'already_claimed'
    // row (with balances); the ledger answers only for accounts that no longer
    // have one. Reversing the order would overwrite the richer answer.
    const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));
    expect(body.indexOf("'already_claimed'"))
      .toBeLessThan(body.indexOf("'identity_already_claimed'"));
    expect(body.indexOf('FROM public.credit_grants'))
      .toBeLessThan(body.indexOf('FROM public.credit_grant_identity_fingerprints'));
  });

  it('trusts nothing shaped unlike a digest and skips the guard when none are passed', () => {
    // Digests are computed app-side; the function re-validates their shape.
    // NULL/empty skips the guard, which is what lets code deployed before this
    // migration keep calling with three arguments during the release window.
    expect(migration).toMatch(/WHERE f ~ '\^\[a-f0-9\]\{64\}\$'/);
    expect(migration).toContain("coalesce(p_identity_fingerprints, ARRAY[]::text[])");
    expect(migration).toContain('cardinality(v_fingerprints) > 0');
  });

  it('records the claim into the ledger inside the payout transaction', () => {
    expect(migration).toContain('INSERT INTO public.credit_grant_identity_fingerprints (program_key, fingerprint, recorded_via)');
    expect(migration).toContain("SELECT v_program.program_key, f, 'claim'");
    expect(migration).toContain('ON CONFLICT (program_key, fingerprint) DO NOTHING');
  });

  it('leaves every pre-existing claim rule intact', () => {
    // The verbatim-reproduction convention: the diff against 20260811120000
    // must show the fingerprint guard and nothing else.
    expect(migration).toContain('IF v_is_anonymous THEN');
    expect(migration).toContain('v_user_created_at < v_program.activated_at');
    expect(migration).toContain("'legacy_ineligible'");
    expect(migration).toContain("v_profile.username ~ '^creator-[a-f0-9]{8}$'");
    expect(migration).toContain('ON CONFLICT (user_id, program_key) DO NOTHING');
    expect(migration).toContain("'already_claimed'");
    expect(migration).toContain("'claimed'");
  });

  it('does not edit the applied migration it replaces', () => {
    expect(guestGuard).toContain('CREATE OR REPLACE FUNCTION public.claim_credit_grant_program(');
    expect(guestGuard).not.toContain('p_identity_fingerprints');
    expect(guestGuard).not.toContain('credit_grant_identity_fingerprints');
  });
});
