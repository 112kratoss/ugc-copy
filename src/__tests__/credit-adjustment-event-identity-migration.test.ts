import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260929150256_bind_credit_adjustment_events.sql'), 'utf8');

describe('credit adjustment event binding migration', () => {
  it('guards every replacement and preserves service-only execution', () => {
    expect(migration.match(/Expected exactly one credit event identity block/g)).toHaveLength(6);
    for (const signature of [
      'reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)',
      'reconcile_razorpay_credit_purchase_adjustment(uuid,text,text,bigint,text,text)',
      'reconcile_mobile_credit_purchase_adjustment(text,uuid,text,text,bigint,text)',
      'reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon, authenticated;`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${signature} TO service_role;`);
    }
    expect(migration).not.toMatch(/DROP\s+(TABLE|FUNCTION)|TRUNCATE/i);
  });
});
