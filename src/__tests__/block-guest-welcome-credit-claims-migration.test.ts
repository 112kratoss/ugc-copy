import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations', file),
  'utf8',
);

const migration = read('20260811120000_block_guest_welcome_credit_claims.sql');
const foundation = read('20260713142640_onboarding_and_welcome_credits_foundation.sql');

describe('block guest welcome credit claims migration', () => {
  it('refuses an anonymous claimant outright', () => {
    // The bug: eligibility used "has a real username and display name" as a
    // proxy for "registered". PATCH /api/profile accepts any valid JWT and a
    // guest has one, so setting a username bypassed the proxy and paid out 25
    // credits per anonymous session, repeatable forever.
    expect(migration).toContain('coalesce(is_anonymous, false)');
    expect(migration).toContain('IF v_is_anonymous THEN');
    expect(migration).toContain("RETURN jsonb_build_object('status', 'not_eligible');");
  });

  it('checks anonymity before the username rule it backstops', () => {
    // The username check is the leaky proxy. If anonymity were tested after it,
    // a guest with a valid-looking username would still reach the payout path.
    expect(migration.indexOf('IF v_is_anonymous THEN'))
      .toBeLessThan(migration.indexOf("v_profile.username ~ '^creator-[a-f0-9]{8}$'"));
  });

  it('reads anonymity from auth.users, not from anything a client can write', () => {
    // profiles is client-writable through the profile route; auth.users.is_anonymous
    // is set by the auth server alone. Reading the wrong one would reintroduce
    // the same class of bug.
    expect(migration).toMatch(/INTO v_user_created_at, v_is_anonymous\s+FROM auth\.users/);
  });

  it('leaves the registered claim path intact', () => {
    // A guard that also blocked real signups would quietly kill the welcome
    // offer. These are the rules that must survive the function rewrite.
    expect(migration).toContain("v_user_created_at < v_program.activated_at");
    expect(migration).toContain("'legacy_ineligible'");
    expect(migration).toContain('ON CONFLICT (user_id, program_key) DO NOTHING');
    expect(migration).toContain("'already_claimed'");
    expect(migration).toContain("'claimed'");
  });

  it('keeps the function service-role only', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.claim_credit_grant_program(uuid, text, text)\n  FROM PUBLIC, anon, authenticated;',
    );
  });

  it('does not edit the applied migration it replaces', () => {
    expect(foundation).toContain('CREATE OR REPLACE FUNCTION public.claim_credit_grant_program');
    expect(foundation).not.toContain('v_is_anonymous');
  });
});
