import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
it('keeps serialized mobile settlement service-only and fails on unexpected definitions', () => {
  const sql = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260928090559_serialize_mobile_settlement_identity.sql'), 'utf8');
  expect(sql).toContain('Expected exactly one mobile identity lookup block');
  expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
  expect(sql).toContain('TO service_role;');
});
