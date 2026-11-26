import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Security audit, 2026-11-27: a store refund RevenueCat named under another app user (a receipt
 * moved by a restore, or a guest's receipt that followed it into an account) answered
 * identity_mismatch, which the webhook acknowledges, and the credits stayed. The purchase now
 * settles on the ledger's owner. supabase/tests/database/mobile_refund_follows_ledger_owner.test.sql
 * proves it on a database; this pins the migration's shape.
 */
const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
const migrationFile = fs.readdirSync(migrationsDir).find((file) => file.endsWith('_mobile_refund_settles_on_ledger_owner.sql'));
const migration = migrationFile ? fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8') : '';
const body = migration.replace(/^\s*--.*$/gm, '');

describe('mobile refunds settle on the ledger owner', () => {
  it('redefines the adjustment and keeps it the service role\'s alone', () => {
    expect(migrationFile).toBeTruthy();
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.reconcile_mobile_purchase_adjustment(p_external_order_id text, p_user_id uuid, p_product_id text, p_event_id text, p_event_timestamp_ms bigint, p_action text)');
    expect(body).toContain('SECURITY DEFINER');
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(body).toContain('REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;');
    expect(body).toContain('GRANT EXECUTE ON FUNCTION public.reconcile_mobile_purchase_adjustment(text, uuid, text, text, bigint, text) TO service_role;');
  });

  it('settles on the owner instead of refusing another app user', () => {
    expect(body).toContain("v_owner := coalesce(v_ledger.user_id, CASE WHEN v_ledger.entitlement_type = 'credits' THEN v_ledger.detached_user_id END);");
    expect(body).toContain('p_user_id := v_owner;');
    expect(body).not.toContain('IS DISTINCT FROM p_user_id THEN');
    // Only a purchase with nobody to settle on, or another product, still answers identity_mismatch.
    expect(body.match(/'identity_mismatch'/g)?.length).toBe(2);
    expect(body).toContain('IF v_owner IS NULL THEN');
    expect(body).toContain('IF v_ledger.product_id <> p_product_id THEN');
    expect(body).toContain("'event_user_is_owner', v_event_user_id IS NOT DISTINCT FROM v_owner");
  });

  it('settles before anything is changed: the owner is set ahead of every effect', () => {
    const ownerAt = body.indexOf('p_user_id := v_owner;');
    for (const effect of [
      'public.reconcile_mobile_credit_purchase_adjustment(',
      'DELETE FROM public.marketplace_purchases',
      'DELETE FROM public.post_resource_bundle_purchases',
      'INSERT INTO public.mobile_purchase_adjustment_events',
    ]) {
      expect(body.indexOf(effect)).toBeGreaterThan(ownerAt);
    }
  });
});
