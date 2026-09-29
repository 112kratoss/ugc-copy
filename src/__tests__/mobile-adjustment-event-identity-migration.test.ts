import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(process.cwd(),
  'supabase/migrations/20260929163206_retain_mobile_adjustment_event_identity.sql'), 'utf8');

describe('mobile adjustment event history migration', () => {
  it('keeps history private and writable only through the definer RPC', () => {
    expect(migration).toContain('ALTER TABLE public.mobile_purchase_adjustment_events ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('REVOKE ALL ON public.mobile_purchase_adjustment_events FROM PUBLIC, anon, authenticated, service_role');
    expect(migration).toContain('GRANT SELECT ON public.mobile_purchase_adjustment_events TO service_role');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.reconcile_mobile_purchase_adjustment(text,uuid,text,text,bigint,text) FROM PUBLIC, anon, authenticated');
    expect(migration.match(/Expected exactly one mobile event history block/g)).toHaveLength(5);
  });
});
