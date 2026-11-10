import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20261110070035_referral_abuse_guard.sql', 'utf8');

// What the migration does is proved against a real database by
// supabase/tests/database/referral_abuse_guard.test.sql. These hold the text to
// the things a replay cannot see: that nothing is granted to a client, that the
// trails cannot be rewritten, and that the two patched functions were patched
// in place rather than restated from an old copy.
describe('referral abuse guard migration', () => {
  it('keeps every new table private and enables RLS on each', () => {
    for (const table of ['referral_account_devices', 'referral_review_events', 'deleted_account_identity_fingerprints']) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM PUBLIC, anon, authenticated`);
    }
    expect(sql).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
  });

  it('makes the review trail and the deleted-identity ledger append-only for the service role too', () => {
    for (const table of ['referral_review_events', 'deleted_account_identity_fingerprints']) {
      expect(sql).toContain(`REVOKE ALL ON public.${table} FROM service_role`);
      expect(sql).toContain(`GRANT SELECT, INSERT ON public.${table} TO service_role`);
    }
    expect(sql).toMatch(/CREATE TRIGGER referral_review_events_append_only\s+BEFORE UPDATE OR DELETE ON public\.referral_review_events\s+FOR EACH ROW EXECUTE FUNCTION public\.prevent_referral_audit_mutation\(\)/);
  });

  it('gives every function to the service role alone', () => {
    const functions = [
      'create_referral_visit(text, text, text, uuid, text, text, text, text)',
      'record_referral_account_device(uuid, text, text)',
      'referral_device_hash(text)',
      'referral_account_device_hashes(uuid)',
      'referral_inviter_friend_device_hashes(uuid, uuid, timestamptz)',
      'claim_referral_visit(uuid, uuid, text[], text)',
      'set_referral_attribution_reward_state(uuid, text, text, uuid)',
      'set_referral_code_enabled(uuid, boolean, text, uuid)',
      'prune_referral_risk_signals(integer)',
    ];
    for (const signature of functions) {
      const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped}\\s+FROM PUBLIC, anon, authenticated`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped}\\s+TO service_role`));
    }
  });

  it('replaces the two widened functions instead of overloading them', () => {
    // A second signature beside the first makes a call with the old arguments
    // ambiguous to PostgREST, which is how the server still running the old
    // code calls them while this migration is the only thing deployed.
    expect(sql).toContain('DROP FUNCTION public.create_referral_visit(text, text, text, uuid, text, text);');
    expect(sql).toContain('DROP FUNCTION public.claim_referral_visit(uuid, uuid);');
    expect(sql).toContain('p_device_hash text DEFAULT NULL');
    expect(sql).toContain("p_kind text DEFAULT 'invite'");
    expect(sql).toContain('p_identity_fingerprints text[] DEFAULT NULL');
    expect(sql).toContain('p_claim_device_hash text DEFAULT NULL');
  });

  it('patches settlement and its work list in place, each at exactly one anchor', () => {
    expect(sql).toContain("pg_get_functiondef('public.settle_referral_purchase_rewards(uuid)'::regprocedure)");
    expect(sql).toContain('Expected exactly one no_attribution return in settle_referral_purchase_rewards');
    expect(sql).toContain("pg_get_functiondef('public.list_unsettled_referral_purchase_transactions(integer)'::regprocedure)");
    expect(sql).toContain('Expected exactly one unsettled-event predicate in list_unsettled_referral_purchase_transactions');
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.settle_referral_purchase_rewards/);
    expect(sql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.list_unsettled_referral_purchase_transactions/);
  });

  it('pays nothing for a blocked referral and writes no purchase event for it', () => {
    const guard = sql.slice(sql.indexOf('guard text := $guard$'), sql.indexOf('$guard$;'));
    expect(guard).toContain("IF v_attribution.reward_state = 'blocked' THEN");
    expect(guard).toContain("'attribution_blocked'");
    // The guard returns before the function's INSERT INTO referral_purchase_events.
    expect(guard).not.toContain('referral_purchase_events');
    // An operator's decision outranks the guard's second look.
    expect(guard).toContain("v_attribution.reward_state_source = 'system'");
    expect(sql).toContain("AND attributions.reward_state = 'eligible'");
  });

  it('holds the referrals of a link an operator switched off, and pays them when it is back on', () => {
    const guard = sql.slice(sql.indexOf('guard text := $guard$'), sql.indexOf('$guard$;'));
    expect(guard).toContain("'link_disabled'");
    // A deleted inviter's link is off too, but nobody is left to switch it on:
    // only an owned link holds.
    expect(guard).toContain('held_codes.user_id IS NOT NULL');
    expect(sql).toMatch(/AND attributions\.reward_state = 'eligible'\s+AND NOT EXISTS \(/);
  });

  it('runs the settlement recheck over the same device views as the claim', () => {
    const guard = sql.slice(sql.indexOf('guard text := $guard$'), sql.indexOf('$guard$;'));
    expect(guard).toContain('public.referral_account_device_hashes(v_attribution.invitee_user_id)');
    expect(guard).toContain('public.referral_account_device_hashes(v_attribution.inviter_user_id)');
    expect(guard).toContain('public.referral_inviter_friend_device_hashes(');
    expect(guard).toContain("'device_reused_by_invitees'");
  });

  it('never evicts a recorded device, and holds a claim that names none', () => {
    const recorder = sql.slice(
      sql.indexOf('CREATE FUNCTION public.record_referral_account_device('),
      sql.indexOf('REVOKE ALL ON FUNCTION public.record_referral_account_device'),
    );
    expect(recorder).not.toMatch(/DELETE FROM public\.referral_account_devices/);
    expect(recorder).not.toContain('OFFSET');
    expect(sql).toContain("v_block_reason := 'no_device'");
    expect(sql).toContain("v_block_reason := 'inviter_device_cap'");
  });

  it('serialises one inviter\'s claims and copies no network digest into a device row', () => {
    expect(sql).toContain("hashtextextended('referral_claim:' || v_visit.inviter_user_id::text, 0)");
    expect(sql).toContain('PERFORM public.record_referral_account_device(p_invitee_user_id, device, NULL)');
  });

  it('refuses a re-registered identity and lets a digest the account recorded itself pass', () => {
    expect(sql).toContain('deleted.first_recorded_at < v_auth_created_at');
    expect(sql).toContain('granted.first_claimed_at < v_auth_created_at');
    // The ledger's primary key leads with program_key; the lookup by digest
    // alone needs its own index, or every claim scans the ledger under locks.
    expect(sql).toContain('ON public.credit_grant_identity_fingerprints (fingerprint)');
    expect(sql).toContain("VALUES (v_visit.referral_code_id, 'refuse_claim', 'system', 'reregistered_identity')");
  });

  it('clears the digests of visits older than 90 days and of a deleted inviter', () => {
    expect(sql).toContain("visits.visited_at < now() - interval '90 days'");
    // Never a visit that can still be claimed, whatever a program's window.
    expect(sql).toContain('AND (visits.claimed_at IS NOT NULL OR visits.expires_at <= now())');
    expect(sql).toContain("attributions.attributed_at < now() - interval '90 days'");
    expect(sql).toContain("devices.last_seen_at < now() - interval '90 days'");
    expect(sql).toContain("events.created_at > now() - interval '90 days'");
    expect(sql).toMatch(/SET ip_hash = NULL,\s+user_agent_hash = NULL,\s+device_hash = NULL/);
    expect(sql).toMatch(/SET ip_hash = NULL, user_agent_hash = NULL, device_hash = NULL, destination_path = NULL\s+WHERE inviter_user_id = OLD\.id/);
  });

  it('never switches a trigger off', () => {
    expect(sql).not.toMatch(/DISABLE TRIGGER|session_replication_role/i);
  });
});
