begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(12);

insert into auth.users(id, email, aud, role, raw_app_meta_data, raw_user_meta_data) values
('01c10000-0000-4000-8000-0000000000c1', 'remix-creator@example.invalid', 'authenticated', 'authenticated', '{}', '{}'),
('01c20000-0000-4000-8000-0000000000c2', 'remix-reader@example.invalid', 'authenticated', 'authenticated', '{}', '{}');
insert into public.generations(id, user_id, prediction_id, status, cost, category, model, output_url, is_public) values
('72000000-0000-4000-8000-000000000001', '01c10000-0000-4000-8000-0000000000c1', 'remix-source-test', 'succeeded', 1, 'image', 'test', 'https://example.invalid/source.png', true);
insert into public.posts(id, user_id, visibility, category, source_kind, generation_id, output_url) values
('73000000-0000-4000-8000-000000000001', '01c10000-0000-4000-8000-0000000000c1', 'public', 'image', 'ugc_copy', '72000000-0000-4000-8000-000000000001', 'https://example.invalid/source.png');

select public.increment_post_remix_count('73000000-0000-4000-8000-000000000001');
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 0, 'opening an editor does not count');
insert into public.generations(id, user_id, prediction_id, status, cost, category, model, source_generation_id) values
('72000000-0000-4000-8000-000000000002', '01c20000-0000-4000-8000-0000000000c2', 'remix-output-test', 'processing', 1, 'video', 'test', '72000000-0000-4000-8000-000000000001');
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 0, 'processing does not count');
update public.generations set status='failed' where id='72000000-0000-4000-8000-000000000002';
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 0, 'failure does not count');
update public.generations set status='succeeded' where id='72000000-0000-4000-8000-000000000002';
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 0, 'success without a durable output does not count');
update public.generations set output_url='https://example.invalid/result.mp4' where id='72000000-0000-4000-8000-000000000002';
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 1, 'durable success counts once');
update public.generations set status='succeeded', output_url='https://example.invalid/result.mp4' where id='72000000-0000-4000-8000-000000000002';
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 1, 'replayed completion cannot double count');
select is((select count(*) from public.completed_post_remixes where generation_id='72000000-0000-4000-8000-000000000002'), 1::bigint, 'one completion ledger row per generation');
select ok(not has_table_privilege('authenticated', 'public.completed_post_remixes', 'INSERT'), 'clients cannot forge completion records');
select ok(not has_table_privilege('anon', 'public.completed_post_remixes', 'SELECT'), 'anonymous callers cannot read private remix lineage');
update public.posts set visibility='private' where id='73000000-0000-4000-8000-000000000001';
insert into public.generations(id, user_id, prediction_id, status, cost, category, model, source_generation_id, output_url) values
('72000000-0000-4000-8000-000000000003', '01c20000-0000-4000-8000-0000000000c2', 'remix-private-output-test', 'succeeded', 1, 'image', 'test', '72000000-0000-4000-8000-000000000001', 'https://example.invalid/private.png');
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 1, 'a private source post is not credited publicly');

-- Both foreign keys cascade, so a removed output must take its count with it.
delete from public.generations where id='72000000-0000-4000-8000-000000000002';
select is((select count(*) from public.completed_post_remixes where post_id='73000000-0000-4000-8000-000000000001'), 0::bigint, 'deleting the remix output clears its ledger row');
select is((select remix_count from public.posts where id='73000000-0000-4000-8000-000000000001'), 0, 'a deleted remix stops being counted');
select * from finish();
rollback;
