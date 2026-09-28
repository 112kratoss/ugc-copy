import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260927191224_serialize_razorpay_credit_adjustments.sql'), 'utf8');
describe('Razorpay source state migration permissions', () => {
  it('keeps source state inaccessible to clients and writable only through the definer', () => {
    expect(migration).toContain('ALTER TABLE public.razorpay_credit_adjustment_sources ENABLE ROW LEVEL SECURITY;');
    expect(migration).toContain('REVOKE ALL ON public.razorpay_credit_adjustment_sources FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain('GRANT SELECT ON public.razorpay_credit_adjustment_sources TO service_role;');
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.reconcile_razorpay_credit_source(uuid,text,text,text,bigint,bigint) FROM PUBLIC, anon, authenticated;');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.reconcile_razorpay_credit_source(uuid,text,text,text,bigint,bigint) TO service_role;');
  });
});
