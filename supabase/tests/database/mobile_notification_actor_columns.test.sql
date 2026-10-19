-- An alert's owner reads what their Alerts show, never who else is behind it.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(9);

insert into auth.users(id,email,aud,role,is_anonymous,created_at) values
  ('e5100001-0000-4000-8000-000000000001','actor-columns-creator@example.invalid','authenticated','authenticated',false,now()),
  ('e5100002-0000-4000-8000-000000000002','actor-columns-saver@example.invalid','authenticated','authenticated',false,now());
insert into auth.sessions(id,user_id,created_at,updated_at) values
  ('e5200000-0000-4000-8000-000000000001','e5100001-0000-4000-8000-000000000001',now(),now());
insert into public.mobile_notifications(id,user_id,actor_user_id,type,category,title,body,object_type,object_id,dedupe_key,aggregation_key) values
  ('e5300000-0000-4000-8000-000000000001','e5100001-0000-4000-8000-000000000001','e5100002-0000-4000-8000-000000000002',
   'post_saved','social','@maya saved your post','It is in their saved media now.','post','post-1',
   'post-save:e5100002-0000-4000-8000-000000000002:post-1',null),
  ('e5300000-0000-4000-8000-000000000002','e5100001-0000-4000-8000-000000000001','e5100002-0000-4000-8000-000000000002',
   'post_saved','social','Someone saved your post','It is in their saved media now.','post','post-2',
   null,'post-social:post_saved:e5100001-0000-4000-8000-000000000001:post-2:1');

reset role;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"e5100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e5200000-0000-4000-8000-000000000001","is_anonymous":false}',true);

select is((select count(*) from public.mobile_notifications),2::bigint,'the owner still reads their own alerts');
select lives_ok($$ select id, type, category, title, body, deep_link, object_type, object_id, event_count, is_read, created_at, updated_at, last_event_at from public.mobile_notifications $$,'the owner reads every column Alerts show');
select throws_ok($$ select actor_user_id from public.mobile_notifications $$,'42501',null,'the owner cannot read who is behind an alert');
select throws_ok($$ select dedupe_key from public.mobile_notifications $$,'42501',null,'the owner cannot read the saver id a named save key carries');
select throws_ok($$ select save_user_id from public.mobile_notifications $$,'42501',null,'the owner cannot read the save a named alert belongs to');
select throws_ok($$ select save_post_id from public.mobile_notifications $$,'42501',null,'nor the post half of it');
select throws_ok($$ select * from public.mobile_notifications $$,'42501',null,'a whole-row read is refused rather than leaking the hidden columns');
select lives_ok($$ update public.mobile_notifications set is_read=true where id='e5300000-0000-4000-8000-000000000001' $$,'the owner still marks an alert read');

reset role;
set local role service_role;
select is(
  (select actor_user_id from public.mobile_notifications where id='e5300000-0000-4000-8000-000000000002'),
  'e5100002-0000-4000-8000-000000000002'::uuid,
  'the service role still reads every column'
);

select * from finish();
rollback;
