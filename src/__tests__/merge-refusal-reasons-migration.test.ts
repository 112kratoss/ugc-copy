import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const migrationsDirectory = join(process.cwd(), 'supabase', 'migrations');
const migration = readMigration('20261125073220_merge_refusals_say_why.sql');

function readMigration(name: string) {
  return readFileSync(join(migrationsDirectory, name), 'utf8');
}

/** One function's CREATE OR REPLACE statement, through its closing dollar quote. */
function functionDefinition(sql: string, name: string) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is not defined`).toBeGreaterThanOrEqual(0);
  const tag = /\bAS (\$[a-z_]*\$)/.exec(sql.slice(start));
  if (!tag) throw new Error(`${name} has no dollar-quoted body`);
  const bodyStart = start + tag.index + tag[0].length;
  const end = sql.indexOf(`${tag[1]};`, bodyStart);
  expect(end, `${name} body is not closed`).toBeGreaterThan(bodyStart);
  return sql.slice(start, end + tag[1].length + 1);
}

/** The statements alone: comments dropped, whitespace collapsed. */
function code(sql: string) {
  return sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
}

const REFUSAL = /jsonb_build_object\('status', 'not_eligible'(?:, 'reason', '([a-z_]+)', 'retryable', (true|false))?\)/g;

/** Every not_eligible answer in a body, as [reason, retryable]. */
function refusals(definition: string) {
  return [...code(definition).matchAll(REFUSAL)].map(([, reason, retryable]) => [reason ?? null, retryable ?? null]);
}

/** The body with every refusal reduced to the bare answer it used to be. */
function withBareRefusals(definition: string) {
  return code(definition).replace(REFUSAL, "jsonb_build_object('status', 'not_eligible')");
}

describe('merge refusals say why (2026-11-25)', () => {
  const merge = functionDefinition(migration, 'merge_guest_account');
  const redeem = functionDefinition(migration, 'redeem_account_merge_ticket');

  it('gives every refusal of the merge a reason, retryable only for the account not being ready', () => {
    expect(refusals(merge)).toEqual([
      ['invalid_request', 'false'],
      ['same_account', 'false'],
      ['guest_gone', 'false'],
      ['account_not_ready', 'true'],
      ['guest_registered', 'false'],
      ['guest_linked', 'false'],
      ['account_not_ready', 'true'],
    ]);
  });

  it('gives an unknown ticket and a malformed request a reason no retry cures', () => {
    expect(refusals(redeem)).toEqual([
      ['invalid_request', 'false'],
      ['unknown_ticket', 'false'],
    ]);
  });

  it("checks the guest's own state before the account's, so a permanent refusal is never reported as a retryable one", () => {
    const body = code(merge);
    expect(body.indexOf("'guest_gone'")).toBeLessThan(body.indexOf("'account_not_ready'"));
    expect(body.indexOf("'guest_registered'")).toBeLessThan(body.lastIndexOf("'account_not_ready'"));
    expect(body.indexOf("'guest_linked'")).toBeLessThan(body.lastIndexOf("'account_not_ready'"));
  });

  it('changes nothing else in the merge: the same checks, balances, ledger row and replay answer', () => {
    const previous = code(functionDefinition(
      readMigration('20261015054611_merge_carries_guest_feed_preferences.sql'),
      'merge_guest_account',
    ));
    // The two combined refusals of the previous body, split one condition per
    // answer; everything between and around them is the same text.
    const merged = withBareRefusals(merge)
      .replace(
        "OR p_source_surface NOT IN ('mobile', 'web') THEN RETURN jsonb_build_object('status', 'not_eligible'); END IF; IF p_guest_user_id = p_target_user_id THEN RETURN jsonb_build_object('status', 'not_eligible'); END IF;",
        "OR p_guest_user_id = p_target_user_id OR p_source_surface NOT IN ('mobile', 'web') THEN RETURN jsonb_build_object('status', 'not_eligible'); END IF;",
      )
      .replace(
        "IF NOT v_guest_is_anonymous THEN RETURN jsonb_build_object('status', 'not_eligible'); END IF; IF v_guest.merged_into_user_id IS NOT NULL THEN RETURN jsonb_build_object('status', 'not_eligible'); END IF; IF v_target_is_anonymous OR v_target.merged_into_user_id IS NOT NULL THEN",
        'IF NOT v_guest_is_anonymous OR v_target_is_anonymous OR v_guest.merged_into_user_id IS NOT NULL OR v_target.merged_into_user_id IS NOT NULL THEN',
      );
    expect(merged).toBe(previous);
  });

  it('changes nothing else in the redemption: a refusal still never spends the ticket', () => {
    const previous = code(functionDefinition(
      readMigration('20260811110000_merge_guest_account_into_registered.sql'),
      'redeem_account_merge_ticket',
    ));
    expect(withBareRefusals(redeem)).toBe(previous);
    expect(code(redeem)).toContain("IF v_status IN ('merged', 'already_merged', 'conflict') THEN UPDATE public.account_merge_tickets SET consumed_at");
  });

  it('keeps both functions out of every client role', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.merge_guest_account\(uuid, uuid, text\)\s+FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.merge_guest_account\(uuid, uuid, text\) TO service_role;/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.redeem_account_merge_ticket\(text, uuid, text\)\s+FROM PUBLIC, anon, authenticated;/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.redeem_account_merge_ticket\(text, uuid, text\)\s+TO service_role;/);
  });
});
