import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// D5 (2026-10-15): a guest deletes its own data, and the retention job deletes
// guests nobody uses that hold nothing. Behaviour is pinned against real rows
// in supabase/tests/database/guest_data_retention.test.sql; this pins the
// shape that pgTAP cannot see: who may call the functions, and that the list
// only ever reads.

const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationName = fs.readdirSync(migrationsDir)
  .find((name) => name.endsWith('_guest_self_deletion_and_idle_guest_retention.sql'));
const migration = migrationName
  ? fs.readFileSync(path.join(migrationsDir, migrationName), 'utf8')
  : '';

function functionBody(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('\n$$;', start);
  expect(end, name).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe('guest data migration (D5)', () => {
  it('exists and is stamped like every other migration', () => {
    expect(migrationName).toMatch(/^\d{14}_guest_self_deletion_and_idle_guest_retention\.sql$/);
  });

  it('keeps both functions to the service role', () => {
    for (const signature of [
      'prepare_guest_account_deletion\\(uuid\\)',
      'list_idle_guest_identities\\(timestamptz, integer, uuid\\)',
    ]) {
      expect(migration).toMatch(new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${signature}\\s+FROM PUBLIC, anon, authenticated;`,
      ));
      expect(migration).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${signature}\\s+TO service_role;`,
      ));
    }
  });

  it('guards a guest deletion under the deletion lock, then hands over to the account pipeline', () => {
    const body = functionBody('prepare_guest_account_deletion');

    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path = ''");
    // The key prepare_account_deletion() locks first.
    expect(body).toContain("hashtextextended('account-deletion:' || p_user_id::text, 0)");
    expect(body).toContain('FROM auth.users AS users');
    expect(body).toContain("RETURN jsonb_build_object('status', 'not_a_guest')");
    expect(body).toContain('FOR UPDATE');
    expect(body).toContain('v_profile.merged_into_user_id IS NOT NULL');
    expect(body).toContain('link_row.target_user_id = p_user_id');
    expect(body).toContain('linked.merged_into_user_id = p_user_id');
    expect(body).toContain("RETURN jsonb_build_object('status', 'merged')");
    expect(body.indexOf("'merged'")).toBeLessThan(
      body.lastIndexOf('RETURN public.prepare_account_deletion(p_user_id)'),
    );
  });

  it('lists idle guests read-only, bounded, and never sooner than 90 days by the database clock', () => {
    const body = functionBody('list_idle_guest_identities');

    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain('STABLE');
    expect(body).toContain("SET search_path = ''");
    expect(body).toContain('SET plan_cache_mode = force_custom_plan');
    expect(body).toContain("least(coalesce(p_now, now()), now()) - interval '90 days'");
    expect(body).toContain('least(greatest(coalesce(p_limit, 100), 1), 500)');
    expect(body).toContain('WHERE guest.is_anonymous');
    expect(body).toContain('(p_user_id IS NULL OR guest.id = p_user_id)');
    expect(body).toContain('LIMIT v_limit');
    expect(body).not.toMatch(/\b(DELETE|UPDATE|INSERT)\b/);
    expect(migration).not.toMatch(/DELETE\s+FROM\s+auth\.users/i);
  });

  it('counts every trace of use, and not what the feed maintenance writes', () => {
    const body = functionBody('list_idle_guest_identities');

    for (const trace of [
      'guest.last_sign_in_at',
      'auth_session.refreshed_at AT TIME ZONE \'UTC\'',
      'auth_session.updated_at',
      'auth.refresh_tokens AS refresh_token',
      'public.feed_sessions AS feed_session',
      'public.feed_events AS feed_event',
      'public.feed_delivery_facts AS delivery',
      'public.feed_viewer_daily AS viewer_day',
      'public.feed_experiment_assignments AS experiment_assignment',
      'public.feed_user_post_feedback AS post_feedback',
      'public.feed_user_creator_feedback AS creator_feedback',
      'interest.last_event_received_at >= v_cutoff',
      'public.onboarding_events AS onboarding_event',
      'public.post_share_events AS post_share',
      'public.profile_share_events AS profile_share',
      'public.generation_share_events AS generation_share',
    ]) {
      expect(body, trace).toContain(trace);
    }
    expect(body).not.toContain('user_interest_refresh_state');
    expect(body).not.toContain('interest.updated_at');
  });

  it('keeps every guest that holds, bought, made, uploaded or is linked to anything', () => {
    const body = functionBody('list_idle_guest_identities');

    expect(body).toContain('coalesce(profile.credits, 0) = 0');
    expect(body).toContain('coalesce(profile.promotional_credits, 0) = 0');
    expect(body).toContain("profile.identity_state = 'active'");
    expect(body).toContain('profile.merged_into_user_id IS NULL');
    for (const table of [
      'account_merges',
      'account_merge_tickets',
      'account_deletion_jobs',
      'transactions',
      'mobile_store_transactions',
      'mobile_purchase_intents',
      'razorpay_checkout_intents',
      'credit_grants',
      'referral_credit_ledger',
      'admin_credit_adjustments',
      'creation_credit_reservations',
      'post_resource_bundle_orders',
      'post_resource_bundle_purchases',
      'marketplace_orders',
      'marketplace_purchases',
      'creator_resource_wallets',
      'generations',
      'generation_input_media',
      'generation_start_requests',
      'generation_spend_audits',
      'ai_usage_events',
      'template_runs',
      'workflow_canvases',
      'workflow_canvas_runs',
      'workflow_shares',
      'templates',
      'posts',
      'post_comments',
      'post_resource_bundles',
      'marketplace_assets',
      'media_upload_intents',
      'upload_byte_reservations',
      'admin_user_sanctions',
      'moderation_reports',
    ]) {
      expect(body, table).toMatch(new RegExp(`NOT EXISTS \\(\\s+SELECT 1 FROM public\\.${table} AS \\w+`));
    }
  });

  it('is what the retention job acts on, through the Auth admin API, re-checking each guest', () => {
    const retention = fs.readFileSync(
      path.resolve(process.cwd(), 'src/lib/operational-data-retention.ts'),
      'utf8',
    );

    expect(retention).toContain("client.rpc('list_idle_guest_identities'");
    expect(retention).toContain('p_user_id: userId');
    expect(retention).toContain('client.auth.admin.deleteUser(userId)');
  });
});
