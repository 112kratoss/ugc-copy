import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const sql = fs.readFileSync(path.resolve(process.cwd(), 'supabase/migrations/20260928083004_restore_verified_mobile_credit_settlement.sql'), 'utf8');
describe('mobile credit grant migration', () => {
  it('patches exactly the known grant block and keeps service-only authority', () => {
    expect(sql).toContain('Expected exactly one mobile add_credits grant block');
    expect(sql).toContain('FROM PUBLIC, anon, authenticated;');
    expect(sql).toContain('TO service_role;');
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public.add_credits/i);
  });
});
