-- save_post_source_tools_with_catalog stores a Made with model by the
-- catalog's slug, dots and all: until 2026-11 it slugified a sent `veo-3.1`
-- to `veo-3-1` before the catalog lookup, so the lookup missed the seeded
-- row and the hyphenated form was stored, matching neither the catalog nor
-- `generations.model`. For the app's own models it keeps the label the
-- server sent, which is the name the post prints, over the June seed's
-- ("Kling 3.0 Motion"). A save that changes nothing leaves `posts` alone,
-- so the post's search document is not rebuilt on every save, and a save
-- for an account being deleted is still refused, as the posts write's
-- content freeze refused it while that write ran on every save. A post with
-- no media is refused a new tool with the validation error, not a check
-- violation.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values (
  '5d010000-0000-4000-8000-000000000001'::uuid, 'dotted-slugs-owner@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() - interval '30 days'
);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values (
  '5d000000-0000-4000-8000-000000000001'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'public', 'image', 'external', 'text', 'Made with fixture'
);

select public.save_post_source_tools_with_catalog(
  '5d000000-0000-4000-8000-000000000001'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'video',
  '[
    {"toolLabel": "magicbooklet", "toolSlug": "magicbooklet", "modelLabel": "Veo 3.1", "modelSlug": "veo-3.1"},
    {"toolLabel": "magicbooklet", "toolSlug": "magicbooklet", "modelLabel": "Kling 3.0", "modelSlug": "kling-3.0"},
    {"toolLabel": "magicbooklet", "toolSlug": "magicbooklet", "modelLabel": "Wan 2.7", "modelSlug": "wan-2.7"},
    {"toolLabel": "Kling AI", "toolSlug": "kling", "modelLabel": "kling 3.0", "modelSlug": "kling-3-0"},
    {"toolLabel": "Kling AI", "toolSlug": "kling", "modelLabel": "My Remix 2.0"}
  ]'::jsonb
);

select is(
  (select model_slug from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000001'::uuid and sort_order = 0),
  'veo-3.1',
  'a dotted slug the catalog holds is stored as the catalog has it'
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000001'::uuid and sort_order = 1),
  array['Kling 3.0', 'kling-3.0'],
  'an app model keeps the label the server sent, not the seed''s "Kling 3.0 Motion"'
);

select is(
  (select model_slug from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000001'::uuid and sort_order = 2),
  'wan-2.7',
  'an app model missing from the seed keeps the dotted id it was sent with'
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000001'::uuid and sort_order = 3),
  array['Kling 3.0', 'kling-3.0'],
  'a slugified slug finds the dotted catalog model, whose label wins for another tool'
);

select is(
  (select model_slug from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000001'::uuid and sort_order = 4),
  'my-remix-2-0',
  'a model the catalog lacks, sent with no slug, still gets one from its label'
);

-- `now()` is the same for every statement in this transaction, so
-- `updated_at` cannot show a rewrite here. Any UPDATE writes a new row
-- version, though, and the version's ctid moves.
create temporary table fixture_post_version on commit drop as
select ctid as post_ctid from public.posts where id = '5d000000-0000-4000-8000-000000000001'::uuid;

select public.save_post_source_tools_with_catalog(
  '5d000000-0000-4000-8000-000000000001'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'video',
  '[{"toolLabel": "magicbooklet", "toolSlug": "magicbooklet", "modelLabel": "Veo 3.1", "modelSlug": "veo-3.1"}]'::jsonb
);

select is(
  (select ctid from public.posts where id = '5d000000-0000-4000-8000-000000000001'::uuid),
  (select post_ctid from fixture_post_version),
  'a save that keeps the first tool leaves the post row untouched'
);

select public.save_post_source_tools_with_catalog(
  '5d000000-0000-4000-8000-000000000001'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'video',
  '[{"toolLabel": "Kling AI", "toolSlug": "kling", "modelLabel": "Kling 3.0", "modelSlug": "kling-3.0"}]'::jsonb
);

select is(
  (select array[source_tool, source_tool_slug] from public.posts
   where id = '5d000000-0000-4000-8000-000000000001'::uuid),
  array['Kling AI', 'kling'],
  'a save that changes the first tool still updates the post'
);

-- The lookup's other paths, on a second post.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values (
  '5d000000-0000-4000-8000-000000000002'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'public', 'image', 'external', 'text', 'Made with catalog paths'
);

-- A user's model under the hyphenated form of a seeded dotted slug, sorted
-- ahead of the seeded one: only the slug sent as it is tells them apart.
insert into public.source_tool_models (source_tool_id, slug, label, sort_order, is_active, created_by_user_id)
select id, 'veo-3-1', 'Veo 3 1 twin', -1, true, '5d010000-0000-4000-8000-000000000001'::uuid
from public.source_tools
where slug = 'veo';

select public.save_post_source_tools_with_catalog(
  '5d000000-0000-4000-8000-000000000002'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'video',
  '[
    {"toolLabel": "magicbooklet", "toolSlug": "magicbooklet", "modelLabel": "Hailuo 2.3", "modelSlug": "hailuo-2-3"},
    {"toolLabel": "Kling AI", "toolSlug": "kling", "modelLabel": "Kling 2.6"},
    {"toolLabel": "Google Veo", "toolSlug": "veo", "modelLabel": "Veo", "modelSlug": "veo-3.1"},
    {"toolLabel": "Google Veo", "toolSlug": "veo", "modelLabel": "Veo", "modelSlug": "veo-3-1"}
  ]'::jsonb
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000002'::uuid and sort_order = 0),
  array['Hailuo 2.3', 'hailuo-2.3'],
  'an app model the seed lacks, sent hyphenated, is stored under its generation model id'
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000002'::uuid and sort_order = 1),
  array['Kling 2.6', 'kling-2.6'],
  'a model sent by its label alone finds the dotted catalog model'
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000002'::uuid and sort_order = 2),
  array['Veo 3.1', 'veo-3.1'],
  'the slug sent as it is wins over a hyphenated twin sorted ahead of it'
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000002'::uuid and sort_order = 3),
  array['Veo 3 1 twin', 'veo-3-1'],
  'the hyphenated twin is still found by its own slug'
);

update public.source_tool_models
set is_active = false
where slug = 'gen-4.5'
  and source_tool_id = (select id from public.source_tools where slug = 'runway');

select public.save_post_source_tools_with_catalog(
  '5d000000-0000-4000-8000-000000000002'::uuid,
  '5d010000-0000-4000-8000-000000000001'::uuid,
  'video',
  '[
    {"toolLabel": "Runway", "toolSlug": "runway", "modelLabel": "Gen 4.5", "modelSlug": "gen-4-5", "createModel": true},
    {"toolLabel": "Runway", "toolSlug": "runway", "modelLabel": "Gen 9.1 Preview", "modelSlug": "gen-9.1-preview", "createModel": true}
  ]'::jsonb
);

select is(
  (select array[model_label, model_slug] from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000002'::uuid and sort_order = 0),
  array['Gen-4.5', 'gen-4.5'],
  'a hyphenated slug finds the inactive dotted catalog model'
);

select ok(
  (select is_active from public.source_tool_models
   where slug = 'gen-4.5'
     and source_tool_id = (select id from public.source_tools where slug = 'runway')),
  'and creating that model reactivates it'
);

select is(
  (select model_slug from public.post_source_tools
   where post_id = '5d000000-0000-4000-8000-000000000002'::uuid and sort_order = 1),
  'gen-9.1-preview',
  'a model the catalog lacks is stored under the dotted slug it was sent with'
);

select is(
  (select label from public.source_tool_models
   where slug = 'gen-9.1-preview'
     and created_by_user_id = '5d010000-0000-4000-8000-000000000001'::uuid),
  'Gen 9.1 Preview',
  'and created in the catalog under it'
);

-- A post with no media (a text post) sends no media kind. `NULL NOT IN
-- (...)` is NULL, so the guard let it through to source_tools' own check.
select throws_ok(
  $$select public.save_post_source_tools_with_catalog(
      '5d000000-0000-4000-8000-000000000002'::uuid,
      '5d010000-0000-4000-8000-000000000001'::uuid,
      null,
      '[{"toolLabel": "Brand New Tool", "createTool": true}]'::jsonb
    )$$,
  'P0001',
  'Creating source tools requires image or video media.',
  'a post with no media is refused a new tool with the validation error the API shows'
);

insert into public.account_deletion_jobs (user_id)
values ('5d010000-0000-4000-8000-000000000001'::uuid);

select throws_ok(
  $$select public.save_post_source_tools_with_catalog(
      '5d000000-0000-4000-8000-000000000001'::uuid,
      '5d010000-0000-4000-8000-000000000001'::uuid,
      'video',
      '[{"toolLabel": "Kling AI", "toolSlug": "kling", "modelLabel": "Kling 2.6", "modelSlug": "kling-2.6"}]'::jsonb
    )$$,
  '55000',
  'Account deletion is already in progress',
  'a save for an account being deleted is refused, though it keeps the first tool'
);

select * from finish();

rollback;
