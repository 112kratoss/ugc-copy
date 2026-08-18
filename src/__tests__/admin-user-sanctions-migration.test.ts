import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260819040000_admin_user_sanctions.sql',
), 'utf8');

describe('admin user sanctions migration', () => {
  /**
   * The whole point of the feature. An app-level `profiles.is_banned` flag would
   * need every read path to honour it; `auth.users.banned_until` is enforced by
   * GoTrue itself, so a suspension blocks sign-in without app cooperation.
   */
  it('enforces the suspension in GoTrue rather than as an app-level flag', () => {
    expect(migration).toContain('UPDATE auth.users SET banned_until = v_suspended_until WHERE id = p_user_id');
    expect(migration).toContain('UPDATE auth.users SET banned_until = NULL WHERE id = p_user_id');
  });

  it('records the operator and a mandatory rationale for every sanction', () => {
    expect(migration).toContain('CREATE TABLE public.admin_user_sanctions');
    expect(migration).toContain('reviewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT');
    expect(migration).toContain('CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000)');
  });

  it('applies the ban and its audit row in one transaction', () => {
    // Both writes live inside the same function body, so a failure cannot leave
    // an account banned with no record of who did it or why.
    const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.apply_admin_user_sanction'));
    expect(body).toContain('UPDATE auth.users SET banned_until');
    expect(body).toContain('INSERT INTO public.admin_user_sanctions');
  });

  it('makes a replayed sanction idempotent instead of re-applying it', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX admin_user_sanctions_idempotency_key_idx');
    expect(migration).toContain("'status', 'already_applied'");
  });

  it('locks the account row so a concurrent suspend and reinstate cannot interleave', () => {
    expect(migration).toContain('PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE');
  });

  it('refuses to let an operator sanction their own account', () => {
    expect(migration).toContain('IF p_user_id = p_reviewer_id THEN');
    expect(migration).toContain('an operator cannot sanction their own account');
  });

  it('never records an expiry on a reinstatement', () => {
    expect(migration).toContain('CONSTRAINT admin_user_sanctions_reinstate_has_no_expiry');
  });

  /**
   * Suspension governs account access only. Bundling content removal in would
   * mean one click destroyed published work with no separate audit record.
   */
  it('does not touch the user\'s content', () => {
    const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION public.apply_admin_user_sanction'));
    expect(body).not.toContain('UPDATE public.posts');
    expect(body).not.toContain('DELETE FROM public.posts');
  });

  it('keeps operator audit data and the auth-derived view off the public Data API', () => {
    expect(migration).toContain('ALTER TABLE public.admin_user_sanctions ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON TABLE public.admin_user_sanctions FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON public.admin_user_account_state FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT SELECT ON public.admin_user_account_state TO service_role');
  });

  it('reads live state from GoTrue rather than from the audit log', () => {
    // A ban applied from the Supabase dashboard, or one that lapsed on its own
    // expiry, never appears in the audit table.
    expect(migration).toContain('CREATE OR REPLACE VIEW public.admin_user_account_state');
    expect(migration).toContain('FROM auth.users');
    expect(migration).toContain('users.banned_until > timezone(\'utc\'::text, now())');
  });

  it('grants execution only to service_role', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.apply_admin_user_sanction(uuid, uuid, text, text, integer, text)\n  FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.apply_admin_user_sanction(uuid, uuid, text, text, integer, text)\n  TO service_role');
  });
});
