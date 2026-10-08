BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path=public,extensions;
SELECT plan(10);
SELECT ok(NOT has_table_privilege('anon','public.media_upload_intents','SELECT,INSERT,UPDATE,DELETE'),'anonymous intent access remains denied');
SELECT ok(NOT has_table_privilege('authenticated','public.media_upload_intents','SELECT,INSERT,UPDATE,DELETE'),'authenticated intent access remains denied');
SELECT ok(has_table_privilege('service_role','public.media_upload_intents','SELECT,UPDATE'),'service retains operational marker access');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.media_upload_intents'::regclass),'intent RLS remains enabled');
INSERT INTO auth.users(id,email,aud,role,created_at) VALUES('682ad0d1-b784-4190-b12d-87cde5ffb191','upload-rotation@audit.invalid','authenticated','authenticated',now());
INSERT INTO public.media_upload_intents(id,user_id,storage_path,kind,created_at,consumed_at,consumed_by) VALUES
('30887507-2787-47f7-abf2-284d4a146979','682ad0d1-b784-4190-b12d-87cde5ffb191','682ad0d1-b784-4190-b12d-87cde5ffb191/older.png','image',now()-interval '72 hours',now(),'generation_input'),
('a4d1be4f-c11d-4125-983d-d9e771a53a8f','682ad0d1-b784-4190-b12d-87cde5ffb191','682ad0d1-b784-4190-b12d-87cde5ffb191/later.png','image',now()-interval '71 hours',now(),'generation_input');
SELECT is((SELECT reclaim_priority_at FROM public.media_upload_intents WHERE id='30887507-2787-47f7-abf2-284d4a146979'),now()-interval '72 hours','unscanned priority is original age');
SET LOCAL ROLE service_role;
UPDATE public.media_upload_intents SET reclaim_checked_at=now() WHERE id='30887507-2787-47f7-abf2-284d4a146979';
RESET ROLE;
SELECT is((SELECT id::text FROM public.media_upload_intents WHERE user_id='682ad0d1-b784-4190-b12d-87cde5ffb191' ORDER BY reclaim_priority_at,id LIMIT 1),'a4d1be4f-c11d-4125-983d-d9e771a53a8f','checked work rotates behind waiting work');
SELECT is((SELECT created_at FROM public.media_upload_intents WHERE id='30887507-2787-47f7-abf2-284d4a146979'),now()-interval '72 hours','scan preserves original expiry age');
SELECT ok((SELECT storage_cleared_at IS NULL FROM public.media_upload_intents WHERE id='30887507-2787-47f7-abf2-284d4a146979'),'scan does not claim deletion');
SELECT throws_ok($$UPDATE public.media_upload_intents SET reclaim_priority_at=now() WHERE id='30887507-2787-47f7-abf2-284d4a146979'$$,'428C9',NULL,'generated priority cannot be set independently');
SELECT ok(EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='media_upload_intents_reclaim_priority_idx'),'bounded candidate index exists');
SELECT * FROM finish();
ROLLBACK;
