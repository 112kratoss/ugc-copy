import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
const sql=readFileSync('supabase/migrations/20261005100245_serialize_mobile_push_registration.sql','utf8');
describe('atomic push registration migration',()=>{
 it('uses service-only invoker execution and preserves existing preferences',()=>{
  expect(sql).toContain("SECURITY INVOKER SET search_path = ''");
  expect(sql).toContain('REVOKE ALL ON FUNCTION public.register_mobile_push_token(uuid,text,text,text,text) FROM PUBLIC, anon, authenticated');
  expect(sql).toContain('GRANT EXECUTE ON FUNCTION public.register_mobile_push_token(uuid,text,text,text,text) TO service_role');
  expect(sql).toContain('VALUES(p_user_id) ON CONFLICT(user_id) DO NOTHING');
 });
});
