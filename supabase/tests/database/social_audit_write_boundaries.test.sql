-- API save/audit writes must not be forgeable directly. Fixtures roll back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();
insert into auth.users (id,email,aud,role,created_at) values
('e3100001-0000-4000-8000-000000000001','social-owner@example.invalid','authenticated','authenticated',now()),
('e3100002-0000-4000-8000-000000000002','social-other@example.invalid','authenticated','authenticated',now());
insert into auth.sessions (id,user_id,created_at,updated_at) values
('e3200000-0000-4000-8000-000000000001','e3100001-0000-4000-8000-000000000001',now(),now());
insert into public.posts (id,user_id,visibility,category,source_kind,title,output_url) values
('e3300000-0000-4000-8000-000000000001','e3100002-0000-4000-8000-000000000002','private','image','external','Private fixture','generated_images/social-private.png'),
('e3300000-0000-4000-8000-000000000002','e3100002-0000-4000-8000-000000000002','public','image','external','Public fixture','generated_images/social-public.png');
insert into public.generations (id,user_id,model,status,is_public) values
('e3400000-0000-4000-8000-000000000001','e3100002-0000-4000-8000-000000000002','test-model','succeeded',false);
insert into public.post_saves (id,user_id,post_id) values
('e3500000-0000-4000-8000-000000000001','e3100001-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000002');
update public.posts set save_count=1 where id='e3300000-0000-4000-8000-000000000002';
insert into public.showcase_saves (id,user_id,generation_id) values
('e3500000-0000-4000-8000-000000000002','e3100001-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000001');
insert into public.post_deletion_audits (id,owner_user_id,visibility,source_kind) values
('e3500000-0000-4000-8000-000000000003','e3100001-0000-4000-8000-000000000001','private','external');
insert into public.post_save_events (id,user_id,post_id,requested_state,result_state) values
('e3500000-0000-4000-8000-000000000004','e3100001-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000002',true,true);
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e3100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e3200000-0000-4000-8000-000000000001"}',true);
select ok(public.current_identity_is_active(),'fixture has a live session');
select throws_ok($$ select asset_id from public.marketplace_asset_content limit 1 $$,'42501',null,
'marketplace content reads stay behind server entitlement checks');
select throws_ok($$ update public.marketplace_asset_content set guide_markdown='forged' where false $$,'42501',null,
'marketplace content direct writes are denied');
select throws_ok($$ insert into public.post_saves (user_id,post_id) values
('e3100001-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000001') $$,'42501',null,
'cannot save a private foreign post by bypassing the API');
select throws_ok($$ delete from public.post_saves where id='e3500000-0000-4000-8000-000000000001' $$,'42501',null,
'cannot bypass atomic post save-count maintenance with direct deletion');
select throws_ok($$ insert into public.showcase_saves (user_id,generation_id) values
('e3100001-0000-4000-8000-000000000001','e3400000-0000-4000-8000-000000000001')
on conflict (user_id,generation_id) do nothing $$,'42501',null,
'cannot save a private foreign generation directly');
select throws_ok($$ delete from public.showcase_saves where id='e3500000-0000-4000-8000-000000000002' $$,'42501',null,
'cannot mutate legacy saves outside the service path');
select throws_ok($$ insert into public.post_deletion_audits
(owner_user_id,post_id,visibility,source_kind,had_paid_orders,sales_count,earnings_usd_cents) values
('e3100001-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000001','public','external',true,500,1000000) $$,'42501',null,
'cannot fabricate deletion and earnings audit data for own identity');
select throws_ok($$ insert into public.post_save_events (user_id,post_id,requested_state,result_state,changed) values
('e3100001-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000001',true,true,true) $$,'42501',null,
'cannot fabricate successful save events for an inaccessible post');
select is((select count(*) from public.post_saves),1::bigint,'post_saves: owner read compatibility remains');
select ok(not has_table_privilege('authenticated','public.post_saves','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'post_saves: no authenticated mutation privileges');
select is((select count(*) from public.showcase_saves),1::bigint,'showcase_saves: owner read compatibility remains');
select ok(not has_table_privilege('authenticated','public.showcase_saves','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'showcase_saves: no authenticated mutation privileges');
select is((select count(*) from public.post_save_events),1::bigint,'post_save_events: owner read compatibility remains');
select ok(not has_table_privilege('authenticated','public.post_save_events','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'post_save_events: no authenticated mutation privileges');
select is((select count(*) from public.post_deletion_audits),1::bigint,'post_deletion_audits: owner read compatibility remains');
select ok(not has_table_privilege('authenticated','public.post_deletion_audits','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'post_deletion_audits: no authenticated mutation privileges');
select set_config('request.jwt.claims','{"sub":"e3100002-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*) from public.post_saves),0::bigint,'post_saves: foreign rows remain hidden');
select is((select count(*) from public.showcase_saves),0::bigint,'showcase_saves: foreign rows remain hidden');
select is((select count(*) from public.post_save_events),0::bigint,'post_save_events: foreign rows remain hidden');
select is((select count(*) from public.post_deletion_audits),0::bigint,'post_deletion_audits: foreign rows remain hidden');
reset role;
select set_config('request.jwt.claims','{}',true);
set local role service_role;
select lives_ok($$ select asset_id from public.marketplace_asset_content limit 1 $$,
'trusted marketplace service retains content reads');
select lives_ok($$ select * from public.set_post_save_state('e3300000-0000-4000-8000-000000000002','e3100001-0000-4000-8000-000000000001',false) $$,'trusted API can remove an existing save');
select is((select save_count from public.posts where id='e3300000-0000-4000-8000-000000000002'),0,'removal updates the counter atomically');
select lives_ok($$ select * from public.set_post_save_state('e3300000-0000-4000-8000-000000000002','e3100001-0000-4000-8000-000000000001',true) $$,'trusted API can save a public post');
select lives_ok($$ select * from public.set_post_save_state('e3300000-0000-4000-8000-000000000002','e3100001-0000-4000-8000-000000000001',true) $$,'repeated save state stays idempotent');
select is((select save_count from public.posts where id='e3300000-0000-4000-8000-000000000002'),1,'repeated save does not overcount');
select lives_ok($$ insert into public.post_deletion_audits (owner_user_id,visibility,source_kind) values
('e3100001-0000-4000-8000-000000000001','private','external') $$,'trusted deletion service can write audit history');
select lives_ok($$ insert into public.post_save_events (user_id,post_id,requested_state,result_state) values
('e3100001-0000-4000-8000-000000000001','e3300000-0000-4000-8000-000000000002',true,true) $$,'trusted save service can record events');
reset role;
delete from auth.sessions where id='e3200000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e3100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e3200000-0000-4000-8000-000000000001"}',true);
select is((select count(*) from public.post_saves),0::bigint,'post_saves: revoked session loses access');
select is((select count(*) from public.showcase_saves),0::bigint,'showcase_saves: revoked session loses access');
select is((select count(*) from public.post_save_events),0::bigint,'post_save_events: revoked session loses access');
select is((select count(*) from public.post_deletion_audits),0::bigint,'post_deletion_audits: revoked session loses access');
reset role;
select * from finish();
rollback;
