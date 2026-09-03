-- Declarative Data API, RLS, default-privilege, and Storage bucket contract.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(60);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('91000000-0000-4000-8000-000000000001'::uuid, 'contract-a@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('92000000-0000-4000-8000-000000000002'::uuid, 'contract-b@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('99000000-0000-4000-8000-000000000003'::uuid, 'contract-reviewer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.generations (
  id,
  user_id,
  model,
  status,
  is_public,
  category,
  prediction_id,
  prompt
)
values
  ('93000000-0000-4000-8000-000000000001'::uuid,
   '91000000-0000-4000-8000-000000000001'::uuid,
   'test-model', 'processing', false, 'image', 'prediction-owner', 'owner secret prompt'),
  ('93000000-0000-4000-8000-000000000002'::uuid,
   '92000000-0000-4000-8000-000000000002'::uuid,
   'test-model', 'processing', true, 'image', 'prediction-other', 'other secret prompt'),
  ('93000000-0000-4000-8000-000000000003'::uuid,
   '92000000-0000-4000-8000-000000000002'::uuid,
   'test-model', 'succeeded', true, 'image', 'prediction-moderated', 'moderated prompt');

insert into public.posts (
  id,
  user_id,
  visibility,
  category,
  source_kind,
  title,
  output_url,
  review_status
)
values
  ('94000000-0000-4000-8000-000000000001'::uuid,
   '92000000-0000-4000-8000-000000000002'::uuid,
   'public', 'image', 'external', 'Visible post',
   'showcase_media/posts/visible.png', 'visible'),
  ('94000000-0000-4000-8000-000000000002'::uuid,
   '92000000-0000-4000-8000-000000000002'::uuid,
   'public', 'image', 'external', 'Hidden post',
   'showcase_media/posts/hidden.png', 'hidden');

insert into public.posts (
  id,
  user_id,
  generation_id,
  visibility,
  category,
  source_kind,
  title,
  output_url,
  review_status
)
values (
  '94000000-0000-4000-8000-000000000003'::uuid,
  '92000000-0000-4000-8000-000000000002'::uuid,
  '93000000-0000-4000-8000-000000000003'::uuid,
  'public',
  'image',
  'magicbooklet',
  'Generation-backed moderated post',
  'showcase_media/posts/moderated.png',
  'visible'
);

insert into public.post_media (
  id,
  post_id,
  storage_path,
  media_kind,
  content_type,
  original_name,
  sort_order
)
values (
  '95000000-0000-4000-8000-000000000001'::uuid,
  '94000000-0000-4000-8000-000000000001'::uuid,
  'posts/94000000-0000-4000-8000-000000000001/media.png',
  'image',
  'image/png',
  'media.png',
  0
);

insert into public.showcase_saves (id, user_id, generation_id)
values
  ('96000000-0000-4000-8000-000000000001'::uuid,
   '91000000-0000-4000-8000-000000000001'::uuid,
   '93000000-0000-4000-8000-000000000002'::uuid),
  ('96000000-0000-4000-8000-000000000002'::uuid,
   '92000000-0000-4000-8000-000000000002'::uuid,
   '93000000-0000-4000-8000-000000000001'::uuid);

insert into public.workflow_shares (
  id,
  owner_user_id,
  title,
  graph
)
values (
  '97000000-0000-4000-8000-000000000001'::uuid,
  '92000000-0000-4000-8000-000000000002'::uuid,
  'Private workflow graph',
  '{"nodes":[],"edges":[]}'::jsonb
);

insert into public.post_reports (
  post_id,
  reporter_user_id,
  reason,
  details
)
values (
  '94000000-0000-4000-8000-000000000001'::uuid,
  '91000000-0000-4000-8000-000000000001'::uuid,
  'spam',
  'first report must not auto-hide content'
);

select is(
  (
    select review_status
    from public.posts
    where id = '94000000-0000-4000-8000-000000000001'::uuid
  ),
  'visible',
  'a first user report does not remove content from the public feed'
);

insert into public.post_reports (
  post_id,
  reporter_user_id,
  reason,
  details
)
values (
  '94000000-0000-4000-8000-000000000001'::uuid,
  '92000000-0000-4000-8000-000000000002'::uuid,
  'other',
  'multiple reports still require operator review'
);

select is(
  (
    select jsonb_build_array(review_status, report_count)
    from public.posts
    where id = '94000000-0000-4000-8000-000000000001'::uuid
  ),
  '["visible",2]'::jsonb,
  'multiple reports queue review without changing visibility'
);

insert into public.post_reports (
  id,
  post_id,
  reporter_user_id,
  reason,
  details
)
values (
  '98000000-0000-4000-8000-000000000003'::uuid,
  '94000000-0000-4000-8000-000000000003'::uuid,
  '91000000-0000-4000-8000-000000000001'::uuid,
  'spam',
  'operator takedown fixture'
);

create temporary table moderation_resolution as
select public.resolve_post_report_for_ops(
  '98000000-0000-4000-8000-000000000003'::uuid,
  '99000000-0000-4000-8000-000000000003'::uuid,
  'take_down',
  'verified policy violation'
) as payload;

select is(
  (select payload ->> 'status' from moderation_resolution),
  'taken_down',
  'a trusted operator can atomically take down a reported post'
);
select is(
  (
    select review_status
    from public.posts
    where id = '94000000-0000-4000-8000-000000000003'::uuid
  ),
  'hidden',
  'operator takedown hides the post'
);
select is(
  (
    select is_public
    from public.generations
    where id = '93000000-0000-4000-8000-000000000003'::uuid
  ),
  false,
  'operator takedown also closes the linked legacy generation publication flag'
);

set local role service_role;
select throws_ok(
  $$
    update public.generations
    set is_public = true
    where id = '93000000-0000-4000-8000-000000000003'::uuid
  $$,
  '42501',
  'Cannot publish a generation linked to hidden content',
  'service publication cannot bypass a linked post takedown'
);
reset role;

-- Objects created after the migration prove future public-schema exposure is
-- opt-in for every Data API role.
create table public.data_api_default_acl_probe (id integer);
create sequence public.data_api_default_acl_probe_seq;
create function public.data_api_default_acl_probe_fn()
returns integer
language sql
as $$ select 1 $$;

select ok(
  not has_table_privilege('anon', 'public.posts', 'SELECT'),
  'anonymous has no posts table SELECT'
);
select ok(
  not has_table_privilege('authenticated', 'public.posts', 'SELECT'),
  'authenticated has no posts table SELECT'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.posts',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role has explicit posts DML'
);

select ok(
  not has_table_privilege('anon', 'public.post_media', 'SELECT'),
  'anonymous has no post_media table SELECT'
);
select ok(
  not has_table_privilege('authenticated', 'public.post_media', 'SELECT'),
  'authenticated has no post_media table SELECT'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.post_media',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role has explicit post_media DML'
);

select ok(
  not has_column_privilege(
    'anon',
    'public.generations',
    'id',
    'SELECT'
  ),
  'anonymous has no generation projection'
);
select ok(
  has_column_privilege(
    'authenticated',
    'public.generations',
    'id',
    'SELECT'
  ),
  'authenticated can read the generation resume id'
);
select ok(
  not has_column_privilege(
    'authenticated',
    'public.generations',
    'prompt',
    'SELECT'
  ),
  'authenticated cannot read generation prompts directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.generations', 'INSERT'),
  'authenticated cannot insert generations'
);
select ok(
  not has_table_privilege('authenticated', 'public.generations', 'UPDATE'),
  'authenticated cannot update generations'
);
select ok(
  not has_table_privilege('authenticated', 'public.generations', 'DELETE'),
  'authenticated cannot delete generations'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.generations',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role has explicit generation DML'
);

select ok(
  not has_table_privilege('anon', 'public.showcase_saves', 'SELECT'),
  'anonymous cannot enumerate save relationships'
);
select ok(
  has_table_privilege('authenticated', 'public.showcase_saves', 'SELECT'),
  'authenticated can select owner-scoped saves'
);
select ok(
  has_table_privilege('authenticated', 'public.showcase_saves', 'INSERT'),
  'authenticated can insert owner-scoped saves'
);
select ok(
  has_table_privilege('authenticated', 'public.showcase_saves', 'DELETE'),
  'authenticated can delete owner-scoped saves'
);
select ok(
  not has_table_privilege('authenticated', 'public.showcase_saves', 'UPDATE'),
  'authenticated cannot update save relationships'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.showcase_saves',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role has explicit showcase_saves DML'
);

select ok(
  not has_table_privilege('anon', 'public.workflow_shares', 'SELECT'),
  'anonymous cannot read workflow share graphs'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_shares', 'SELECT'),
  'authenticated cannot enumerate workflow share graphs'
);
select ok(
  not has_table_privilege('authenticated', 'public.workflow_shares', 'INSERT'),
  'authenticated cannot insert workflow share graphs'
);
select ok(
  has_table_privilege(
    'service_role',
    'public.workflow_shares',
    'SELECT,INSERT,UPDATE,DELETE'
  ),
  'service role has explicit workflow_shares DML'
);

select ok(
  not has_table_privilege('anon', 'public.data_api_default_acl_probe', 'SELECT'),
  'future tables are not exposed to anonymous'
);
select ok(
  not has_table_privilege(
    'authenticated',
    'public.data_api_default_acl_probe',
    'SELECT'
  ),
  'future tables are not exposed to authenticated'
);
select ok(
  not has_table_privilege(
    'service_role',
    'public.data_api_default_acl_probe',
    'SELECT'
  ),
  'future tables require an explicit service-role grant'
);
select ok(
  not has_sequence_privilege(
    'anon',
    'public.data_api_default_acl_probe_seq',
    'USAGE'
  ),
  'future sequences are not exposed to anonymous'
);
select ok(
  not has_sequence_privilege(
    'authenticated',
    'public.data_api_default_acl_probe_seq',
    'USAGE'
  ),
  'future sequences are not exposed to authenticated'
);
select ok(
  not has_sequence_privilege(
    'service_role',
    'public.data_api_default_acl_probe_seq',
    'USAGE'
  ),
  'future sequences require an explicit service-role grant'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.data_api_default_acl_probe_fn()',
    'EXECUTE'
  ),
  'future functions are not executable by anonymous'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.data_api_default_acl_probe_fn()',
    'EXECUTE'
  ),
  'future functions are not executable by authenticated'
);
select ok(
  not has_function_privilege(
    'service_role',
    'public.data_api_default_acl_probe_fn()',
    'EXECUTE'
  ),
  'future functions require an explicit service-role grant'
);

-- Authenticated client A can resume only A's generation and can see only A's
-- save relationships.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select is(
  (
    select count(*)
    from public.generations
    where id = '93000000-0000-4000-8000-000000000001'::uuid
  ),
  1::bigint,
  'authenticated can read their own safe generation projection'
);
select is(
  (
    select count(*)
    from public.generations
    where id = '93000000-0000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'authenticated cannot read another user generation'
);
select throws_ok(
  $$
    select prompt
    from public.generations
    where id = '93000000-0000-4000-8000-000000000001'::uuid
  $$,
  '42501',
  null,
  'authenticated cannot select a sensitive generation column'
);
select throws_ok(
  $$
    update public.generations
    set status = 'succeeded'
    where id = '93000000-0000-4000-8000-000000000001'::uuid
  $$,
  '42501',
  null,
  'authenticated cannot write generation state'
);
select throws_ok(
  $$ select id from public.posts limit 1 $$,
  '42501',
  null,
  'authenticated cannot query posts directly'
);
select throws_ok(
  $$ select id from public.post_media limit 1 $$,
  '42501',
  null,
  'authenticated cannot query post_media directly'
);
select throws_ok(
  $$ select id from public.workflow_shares limit 1 $$,
  '42501',
  null,
  'authenticated cannot query workflow shares directly'
);
select is(
  (
    select count(*)
    from public.showcase_saves
    where user_id = '91000000-0000-4000-8000-000000000001'::uuid
  ),
  1::bigint,
  'authenticated can read their own saves'
);
select is(
  (
    select count(*)
    from public.showcase_saves
    where user_id = '92000000-0000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'authenticated cannot read another user saves'
);

reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

select throws_ok(
  $$ select id from public.generations limit 1 $$,
  '42501',
  null,
  'anonymous cannot query generations'
);
select throws_ok(
  $$ select id from public.showcase_saves limit 1 $$,
  '42501',
  null,
  'anonymous cannot query save relationships'
);

-- Owner post writes are service-only, including moderation fields.
reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select throws_ok(
  $$
    update public.posts
    set review_status = 'visible'
    where id = '94000000-0000-4000-8000-000000000002'::uuid
  $$,
  '42501',
  null,
  'a post owner cannot reverse a moderation takedown'
);

-- Temporarily grant only the id projection to exercise the defense-in-depth
-- post policy independently of the service-only table grant.
reset role;
grant select (id) on table public.posts to anon, authenticated;

set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select is(
  (
    select count(*)
    from public.posts
    where id = '94000000-0000-4000-8000-000000000001'::uuid
  ),
  1::bigint,
  'post RLS permits an otherwise-readable visible public row'
);
select is(
  (
    select count(*)
    from public.posts
    where id = '94000000-0000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'post RLS hides a moderated row from anonymous'
);

reset role;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select is(
  (
    select count(*)
    from public.posts
    where id = '94000000-0000-4000-8000-000000000002'::uuid
  ),
  0::bigint,
  'post RLS hides a moderated row from a non-owner'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"92000000-0000-4000-8000-000000000002","role":"authenticated"}',
  true
);
select is(
  (
    select count(*)
    from public.posts
    where id = '94000000-0000-4000-8000-000000000002'::uuid
  ),
  1::bigint,
  'post RLS still lets an owner identify their moderated row'
);
select throws_ok(
  $$
    update public.generations
    set is_public = true
    where id = '93000000-0000-4000-8000-000000000003'::uuid
  $$,
  '42501',
  null,
  'a generation owner cannot republish generation-backed moderated content'
);

reset role;

update public.posts
set review_status = 'visible'
where id = '94000000-0000-4000-8000-000000000003'::uuid;

set local role service_role;
update public.generations
set is_public = true
where id = '93000000-0000-4000-8000-000000000003'::uuid;
reset role;

select is(
  (
    select is_public
    from public.generations
    where id = '93000000-0000-4000-8000-000000000003'::uuid
  ),
  true,
  'trusted publication is allowed only after moderation restores the linked post'
);

select is(
  (
    select jsonb_build_object(
      'public', buckets.public,
      'limit', buckets.file_size_limit,
      'mimes', to_jsonb(buckets.allowed_mime_types)
    )
    from storage.buckets buckets
    where id = 'generated_videos'
  ),
  '{
    "public": false,
    "limit": 262144000,
    "mimes": ["video/mp4","video/quicktime","video/webm","video/x-m4v","image/webp"]
  }'::jsonb,
  -- image/webp is the poster a video keeps beside itself, and nothing else
  -- writes an image here. Restricting the bucket to video mime types alone once
  -- made every video poster upload fail.
  'generated_videos bucket is reproducible and restricted'
);
select is(
  (
    select jsonb_build_object(
      'public', buckets.public,
      'limit', buckets.file_size_limit,
      'mimes', to_jsonb(buckets.allowed_mime_types)
    )
    from storage.buckets buckets
    where id = 'uploads'
  ),
  '{
    "public": false,
    "limit": 262144000,
    "mimes": [
      "image/jpeg","image/png","image/webp","image/gif","image/avif","image/heic","image/heif",
      "video/mp4","video/quicktime","video/webm","video/x-m4v",
      "audio/mpeg","audio/mp4","audio/wav","audio/x-wav","audio/aac","audio/ogg","audio/webm"
    ]
  }'::jsonb,
  'uploads bucket is reproducible and restricted'
);
select is(
  (
    select jsonb_build_object(
      'public', buckets.public,
      'limit', buckets.file_size_limit,
      'mimes', to_jsonb(buckets.allowed_mime_types)
    )
    from storage.buckets buckets
    where id = 'post_resource_files'
  ),
  '{
    "public": false,
    "limit": 52428800,
    "mimes": [
      "application/csv","application/json","application/pdf","application/gzip",
      "application/octet-stream","application/x-yaml","application/x-gzip",
      "application/zip","application/x-zip-compressed","application/yaml",
      "text/comma-separated-values","text/csv","text/markdown","text/plain",
      "text/x-markdown","text/x-yaml","text/yaml",
      "image/jpeg","image/png","image/webp","image/gif","image/heic","image/heif",
      "video/mp4","video/x-m4v","video/quicktime","video/webm",
      "audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/aac","audio/ogg","audio/flac"
    ]
  }'::jsonb,
  'post_resource_files bucket is reproducible and restricted'
);
select is(
  (
    select jsonb_build_object(
      'public', buckets.public,
      'limit', buckets.file_size_limit,
      'mimes', to_jsonb(buckets.allowed_mime_types)
    )
    from storage.buckets buckets
    where id = 'showcase_media'
  ),
  '{
    "public": true,
    "limit": 262144000,
    "mimes": [
      "image/jpeg","image/png","image/webp","image/gif","image/avif","image/heic","image/heif",
      "video/mp4","video/quicktime","video/webm","video/x-m4v"
    ]
  }'::jsonb,
  'showcase_media bucket is reproducible and media-restricted'
);

select * from finish();
rollback;
