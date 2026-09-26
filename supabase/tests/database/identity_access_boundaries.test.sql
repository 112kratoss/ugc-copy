begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- All records are disposable fixtures; never run this file on production.
insert into auth.users (id, email, aud, role, is_anonymous, created_at) values
 ('a3000001-0000-4000-8000-000000000001', null, 'authenticated', 'authenticated', true, now()),
 ('a3000002-0000-4000-8000-000000000002', 'boundary-owner@example.invalid', 'authenticated', 'authenticated', false, now()),
 ('a3000003-0000-4000-8000-000000000003', 'boundary-other@example.invalid', 'authenticated', 'authenticated', false, now());
insert into auth.sessions (id, user_id, created_at, updated_at) values
 ('f3000000-0000-4000-8000-000000000001', 'a3000001-0000-4000-8000-000000000001', now(), now()),
 ('f3000000-0000-4000-8000-000000000002', 'a3000002-0000-4000-8000-000000000002', now(), now());
insert into storage.buckets (id,name,public) values ('generated_images','generated_images',false) on conflict (id) do nothing;
insert into storage.objects (bucket_id, name) values
 ('generated_images', 'a3000002-0000-4000-8000-000000000002/identity-boundary.png');
insert into public.workflow_canvases (id, user_id, title, graph) values
 ('b3000000-0000-4000-8000-000000000002', 'a3000002-0000-4000-8000-000000000002', 'Identity boundary', '{"version":1,"nodes":[],"edges":[]}');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a3000001-0000-4000-8000-000000000001","role":"authenticated","is_anonymous":true,"session_id":"f3000000-0000-4000-8000-000000000001"}', true);
select is((select count(*) from public.profiles), 1::bigint, 'a live guest can read its own profile');
with changed as (update public.profiles set username='guest-squatting' returning id) select is((select count(*) from changed), 0::bigint, 'a guest cannot reserve a username through the Data API');
with changed as (update public.profiles set bio='guest profile mutation' returning id) select is((select count(*) from changed), 0::bigint, 'a guest cannot mutate other creator fields either');

select set_config('request.jwt.claims', '{"sub":"a3000002-0000-4000-8000-000000000002","role":"authenticated","session_id":"f3000000-0000-4000-8000-000000000002"}', true);
with changed as (update public.profiles set username='boundary-owner' where id='a3000002-0000-4000-8000-000000000002' returning id) select is((select count(*) from changed), 1::bigint, 'a registered owner can update their creator profile');
with changed as (update public.profiles set bio='foreign' where id='a3000003-0000-4000-8000-000000000003' returning id) select is((select count(*) from changed), 0::bigint, 'a registered owner cannot update another profile');
select throws_ok($$update public.profiles set credits=999 where id='a3000002-0000-4000-8000-000000000002'$$, '42501', null, 'profile balance columns remain inaccessible');
select is((select count(*) from storage.objects where name='a3000002-0000-4000-8000-000000000002/identity-boundary.png'), 1::bigint, 'a live owner retains Storage access');

-- A correctly shaped but revoked session must lose both table and definer access.
reset role;
delete from auth.sessions where id='f3000000-0000-4000-8000-000000000002';
set local role authenticated;
select is(public.current_identity_is_active(), false, 'revoked sessions fail the shared predicate');
select is((select count(*) from public.profiles), 0::bigint, 'revoked sessions cannot read their profile');
with changed as (update public.profiles set bio='revoked' returning id) select is((select count(*) from changed), 0::bigint, 'revoked sessions cannot update their profile');
select is((select count(*) from storage.objects where name='a3000002-0000-4000-8000-000000000002/identity-boundary.png'), 0::bigint, 'revoked sessions lose Storage access');
select throws_ok($$select * from public.initialize_workflow_canvas_run('b3000000-0000-4000-8000-000000000002','a3000002-0000-4000-8000-000000000002','start','node',null,'{}','revoked-initializer','[{"nodeId":"start"}]')$$, '42501', 'Active identity required', 'revoked sessions cannot bypass RLS through the initializer');
select throws_ok($$select * from public.start_workflow_canvas_run('b3000000-0000-4000-8000-000000000002','a3000002-0000-4000-8000-000000000002','start','node',null,'{}','revoked-legacy')$$, '42501', 'Active identity required', 'revoked sessions cannot bypass RLS through the legacy starter');

reset role;
insert into auth.sessions (id,user_id,created_at,updated_at) values ('f3000000-0000-4000-8000-000000000002','a3000002-0000-4000-8000-000000000002',now(),now());
update auth.users set banned_until=now()+interval '1 hour' where id='a3000002-0000-4000-8000-000000000002';
set local role authenticated;
select is(public.current_identity_is_active(), false, 'a banned account with a live session is denied');
select is((select count(*) from public.profiles), 0::bigint, 'banned accounts cannot read their profile');
reset role;
update auth.users set banned_until=now()-interval '1 hour' where id='a3000002-0000-4000-8000-000000000002';
set local role authenticated;
select is(public.current_identity_is_active(), true, 'an expired ban does not strand a valid session');
select lives_ok($$select * from public.initialize_workflow_canvas_run('b3000000-0000-4000-8000-000000000002','a3000002-0000-4000-8000-000000000002','start','node',null,'{}','live-initializer','[{"nodeId":"start"}]')$$, 'a live registered session retains the compatibility initializer');

select set_config('request.jwt.claims', '{"sub":"a3000002-0000-4000-8000-000000000002","role":"authenticated","session_id":"f3000000-0000-4000-8000-000000000001"}', true);
select is(public.current_identity_is_active(), false, 'another users session cannot validate the subject');
select set_config('request.jwt.claims', '{"sub":"a3000002-0000-4000-8000-000000000002","role":"authenticated","session_id":"malformed"}', true);
select is(public.current_identity_is_active(), false, 'a malformed session fails closed without a cast error');
select set_config('request.jwt.claims', '{"sub":"a3000002-0000-4000-8000-000000000002","role":"authenticated"}', true);
select is(public.current_identity_is_active(), true, 'legacy sessionless signed tokens preserve existing API compatibility');
reset role;
update auth.users set deleted_at=now() where id='a3000002-0000-4000-8000-000000000002';
set local role authenticated;
select is(public.current_identity_is_active(), false, 'soft-deleted accounts fail even with legacy claims');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($$select * from public.initialize_workflow_canvas_run('b3000000-0000-4000-8000-000000000002','a3000002-0000-4000-8000-000000000002','start','node',null,'{}','no-sub','[{"nodeId":"start"}]')$$, '42501', 'Active identity required', 'an authenticated caller without a subject is not treated as service role');
reset role;

select * from finish();
rollback;
