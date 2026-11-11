import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { INVITE_SHORT_CODE_ALPHABET } from '../../ugc-mobile/lib/invite-share-link/invite-typed-code';

const sql = readFileSync('supabase/migrations/20261111073612_referral_short_codes.sql', 'utf8');

// What the migration does is proved against a real database by
// supabase/tests/database/referral_short_codes.test.sql. These hold the text to
// what a replay cannot see: that nothing reaches a client, that the database and
// both clients draw codes from one alphabet, and that the three functions it
// restates kept everything they had.
describe('referral short codes migration', () => {
  it('draws codes from the alphabet the clients read', () => {
    expect(sql).toContain(`v_alphabet constant text := '${INVITE_SHORT_CODE_ALPHABET}'`);
    expect(INVITE_SHORT_CODE_ALPHABET).toHaveLength(32);
    expect(INVITE_SHORT_CODE_ALPHABET).not.toMatch(/[01IO]/);
    expect(sql).toContain("CHECK (short_code ~ '^[2-9A-HJ-NP-Z]{6}$')");
  });

  it('gives no function to a client', () => {
    expect(sql).not.toMatch(/GRANT[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
    for (const fn of [
      'new_referral_short_code()',
      'ensure_referral_code(uuid)',
      'get_referral_dashboard(uuid)',
      'create_referral_visit(text, text, text, uuid, text, text, text, text)',
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[()]/g, '\\$&')}\\s+TO service_role`));
    }
  });

  it('backfills every invite before the column becomes required', () => {
    const backfill = sql.indexOf('SET short_code = public.new_referral_short_code()');
    const required = sql.indexOf('ALTER COLUMN short_code SET NOT NULL');
    expect(backfill).toBeGreaterThan(0);
    expect(required).toBeGreaterThan(backfill);
    expect(sql).toContain('ALTER COLUMN short_code SET DEFAULT public.new_referral_short_code()');
    expect(sql).toContain('CREATE UNIQUE INDEX referral_codes_short_code_key');
  });

  it('restates the visit function with the abuse guard intact', () => {
    // Patched in place from 20261110070035: the device digest, the kind, the
    // shared-link rule and the first-invite rule all survive.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.create_referral_visit(');
    expect(sql).toContain('p_device_hash text DEFAULT NULL');
    expect(sql).toContain("v_kind NOT IN ('invite', 'shared_link', 'code')");
    expect(sql).toContain("(v_kind = 'code' OR (v_kind = 'invite' AND v_existing.kind = 'shared_link'))");
    expect(sql).toContain('A visit kept from before the device digest existed learns it now.');
    expect(sql).toContain("CHECK (kind IN ('invite', 'shared_link', 'code'))");
  });

  it('keeps the dashboard and the code function answering what they did, plus the short code', () => {
    expect(sql).toContain("'shortCode', v_code ->> 'short_code'");
    // Three answers of ensure_referral_code and the visit's 'created' answer.
    expect(sql.match(/'short_code', v_code\.short_code,/g)).toHaveLength(4);
    for (const field of ["'visits', v_visits", "'referredUsers', v_signups", "'recentRewards', v_recent"]) {
      expect(sql).toContain(field);
    }
  });
});
