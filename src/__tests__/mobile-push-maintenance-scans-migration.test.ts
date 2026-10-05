import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
const sql=readFileSync('supabase/migrations/20261005092947_advance_mobile_push_maintenance_scans.sql','utf8');
describe('push maintenance scan migration',()=>{
 it('limits scan state and execution to the service role',()=>{
  expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
  expect(sql).toContain('SECURITY INVOKER SET search_path =');
  expect(sql).toContain('REVOKE ALL ON FUNCTION public.scan_mobile_push_maintenance(text, integer, timestamptz) FROM PUBLIC, anon, authenticated');
  expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE public.mobile_push_maintenance_scans TO service_role');
 });
});
