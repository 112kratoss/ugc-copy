import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(
  path.resolve(process.cwd(), 'supabase/migrations', file),
  'utf8',
);

const migration = read('20260811100000_guest_accounts_and_welcome_credit_activation.sql');
const originalTrigger = read('20260320120000_creator_profiles_and_remix_lineage.sql');
const foundation = read('20260713142640_onboarding_and_welcome_credits_foundation.sql');
const hardening = read('20260320133000_harden_security_warnings.sql');

describe('guest accounts and welcome credit activation migration', () => {
  it('stops the signup trigger from minting credits', () => {
    // This is the whole point. Anonymous sign-ins make an auth.users row cost
    // one unauthenticated API call, so a 25-credit trigger becomes a faucet
    // that pays out on every reinstall and every app-data clear.
    expect(migration).toContain('insert into public.profiles (id, credits, username)');
    expect(migration).toMatch(/values \(\s*new\.id,\s*0,/);
    expect(migration).not.toMatch(/values \(\s*new\.id,\s*25,/);
  });

  it('keeps the derived placeholder username', () => {
    // Not cosmetic. claim_credit_grant_program() rejects exactly this pattern as
    // "identity not claimed", which is what stops a guest from claiming the
    // welcome credits without registering. Changing the shape here silently
    // hands every anonymous user 25 credits.
    expect(migration).toContain("lower('creator-' || left(replace(new.id::text, '-', ''), 8))");
    expect(foundation).toContain('welcome_credits_v1');
    expect(originalTrigger).toContain("lower('creator-' || left(replace(new.id::text, '-', ''), 8))");
  });

  it('activates the welcome program in the same migration that drains the trigger', () => {
    // One file is one transaction. If these ever split into two migrations there
    // is a window where new users get nothing at all (trigger drained, program
    // still disabled) or, worse in the other order, get paid twice.
    expect(migration).toContain('UPDATE public.credit_grant_programs');
    expect(migration).toContain('SET enabled = true');
    expect(migration).toContain("WHERE program_key = 'welcome_credits_v1'");
    expect(migration.indexOf('insert into public.profiles'))
      .toBeLessThan(migration.indexOf('UPDATE public.credit_grant_programs'));
  });

  it('pins the cutover instant instead of moving it on replay', () => {
    // activated_at is what claim_credit_grant_program() compares
    // auth.users.created_at against to return 'legacy_ineligible'. coalesce
    // keeps an already-set cutover, so replaying this migration cannot make
    // previously-ineligible legacy users eligible for a second 25 credits.
    expect(migration).toContain('activated_at = coalesce(activated_at, timezone(\'utc\'::text, now()))');
    expect(foundation).toContain('v_user_created_at < v_program.activated_at');
    expect(foundation).toContain("'legacy_ineligible'");
  });

  it('preserves the search_path hardening applied to the trigger function', () => {
    // 20260320133000 hardened this function with ALTER FUNCTION. A plain
    // CREATE OR REPLACE that omits the setting would silently undo it, because
    // the replacement carries its own (empty) configuration.
    expect(hardening).toContain('ALTER FUNCTION public.handle_new_user()');
    expect(migration).toContain('SET search_path = public, pg_temp');
  });

  it('does not enable anonymous sign-ins itself', () => {
    // Anonymous sign-in is an auth-server setting, not SQL. Keeping it out of
    // the migration is what makes the ordering safe: this can be applied before
    // the setting is flipped, and must be.
    expect(migration).not.toMatch(/enable_anonymous_sign_ins/);
  });

  it('does not edit the already-applied migrations it supersedes', () => {
    // Both are live in production. The 25 has to leave the trigger as a new
    // file, or the ledger and the repository disagree about what production ran.
    expect(originalTrigger).toMatch(/values \(\s*new\.id,\s*25,/);
    expect(foundation).toContain("VALUES ('welcome_credits_v1', 'Creator Pack', 25, 25, false, NULL)");
  });
});
