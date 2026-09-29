import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('fails closed on unexpected mobile restore definitions and preserves service-only execution', () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260929080727_reject_conflicting_mobile_entitlement_restores.sql'), 'utf8');
  expect(sql).toContain('Expected exactly one marketplace restoration conflict block');
  expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
  expect(sql).toContain('TO service_role;');
});
