import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(
  process.cwd(),
  'supabase/migrations/20260801120000_creator_payout_requests.sql',
), 'utf8');

describe('creator payout requests migration', () => {
  it('enforces the $100 floor in the database, not just the UI', () => {
    // 100 tokens/$1 x 100 subunits/token x $100.
    expect(migration).toContain('v_minimum_subunits constant bigint := 1000000');
    expect(migration).toContain("RETURN jsonb_build_object(\n      'status', 'below_minimum'");
  });

  it('allows only one open request per creator', () => {
    // Without this a creator could pass the balance check twice concurrently.
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS creator_payout_requests_one_open_per_user_idx');
    expect(migration).toContain("WHERE status = 'requested'");
    expect(migration).toContain("RETURN jsonb_build_object('status', 'already_pending')");
  });

  it('reads the balance and debits it under one row lock', () => {
    expect(migration).toContain('FROM public.creator_resource_wallets\n  WHERE user_id = p_user_id\n  FOR UPDATE');
    expect(migration).toContain('SET available_token_subunits = 0');
    expect(migration).toContain('held_token_subunits = held_token_subunits + v_amount');
  });

  it('returns the balance when a payout is rejected and consumes it when paid', () => {
    expect(migration).toContain('lifetime_paid_out_token_subunits =\n          lifetime_paid_out_token_subunits + v_request.amount_token_subunits');
    expect(migration).toContain('available_token_subunits = available_token_subunits + v_request.amount_token_subunits');
  });

  it('requires a reason for a rejection the creator will read', () => {
    expect(migration).toContain("IF p_action = 'reject' AND v_note IS NULL THEN");
    expect(migration).toContain("RETURN jsonb_build_object('status', 'reason_required')");
  });

  it('refuses to settle the same request twice', () => {
    expect(migration).toContain("IF v_request.status <> 'requested' THEN");
    expect(migration).toContain("'status', 'already_resolved'");
    expect(migration).toContain('WHERE id = p_request_id\n  FOR UPDATE');
  });

  it('lets a creator read their own requests and nobody else write them', () => {
    expect(migration).toContain('"Creators can view their own payout requests"');
    expect(migration).toContain('USING ((SELECT auth.uid()) = user_id)');
    expect(migration).toContain('GRANT SELECT ON TABLE public.creator_payout_requests TO authenticated;');
    // Creators may read; only the backend may create or settle.
    expect(migration).not.toMatch(/GRANT[^;]*INSERT[^;]*creator_payout_requests TO authenticated/);
  });

  it('keeps both payout functions service-role only', () => {
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.request_creator_payout(uuid, text, text)\n  FROM PUBLIC, anon, authenticated;',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.resolve_creator_payout_request(uuid, uuid, text, text, text)\n  FROM PUBLIC, anon, authenticated;',
    );
  });

  it('keeps a resolved request from claiming it is still open', () => {
    expect(migration).toContain('CONSTRAINT creator_payout_requests_resolution_shape CHECK');
  });
});
