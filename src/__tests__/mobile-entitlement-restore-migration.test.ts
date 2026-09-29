import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';

it('fails closed on unexpected mobile restore definitions and preserves service-only execution', () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260929120001_reject_conflicting_mobile_entitlement_restores.sql'), 'utf8');
  expect(sql).toContain('Expected exactly one marketplace restoration conflict block');
  expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
  expect(sql).toContain('TO service_role;');
});

it('guards the legacy bundle restore patch and keeps reconciliation service-only', () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260929191934_reject_conflicting_legacy_bundle_restores.sql'), 'utf8');
  expect(sql).toContain('Expected exactly one legacy bundle restoration conflict block');
  expect(sql).toContain('Expected exactly one marketplace resource lock block');
  expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
  expect(sql).toContain('TO service_role;');
});
