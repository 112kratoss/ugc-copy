-- The post update RPC patches the two generation media columns the same way
-- it patches every other field: an absent key keeps the value, a present key
-- (including a JSON null) replaces it.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(6);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'a1000000-0000-4000-8000-00000000f001'::uuid, 'media-columns-author@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
);

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title,
  showcase_asset_path, output_url
)
values (
  'b0000000-0000-4000-8000-00000000f001'::uuid, 'a1000000-0000-4000-8000-00000000f001'::uuid,
  'public', 'image', 'magicbooklet', 'media', 'Generated post',
  'showcase/gen-1/example.abc123.jpg', 'generated_images/a1000000-0000-4000-8000-00000000f001/example.jpg'
);

-- 1. A patch without the media keys leaves both columns alone.
select public.update_post_with_resource_bundle(
  'b0000000-0000-4000-8000-00000000f001'::uuid,
  'a1000000-0000-4000-8000-00000000f001'::uuid,
  '{"title": "Renamed post"}'::jsonb
);

select is(
  (select showcase_asset_path from public.posts where id = 'b0000000-0000-4000-8000-00000000f001'::uuid),
  'showcase/gen-1/example.abc123.jpg',
  'a patch that omits showcase_asset_path keeps it'
);
select is(
  (select output_url from public.posts where id = 'b0000000-0000-4000-8000-00000000f001'::uuid),
  'generated_images/a1000000-0000-4000-8000-00000000f001/example.jpg',
  'a patch that omits output_url keeps it'
);
select is(
  (select title from public.posts where id = 'b0000000-0000-4000-8000-00000000f001'::uuid),
  'Renamed post',
  'the other fields still patch as before'
);

-- 2. Going private clears the public derivative and can move the durable copy.
select public.update_post_with_resource_bundle(
  'b0000000-0000-4000-8000-00000000f001'::uuid,
  'a1000000-0000-4000-8000-00000000f001'::uuid,
  '{"visibility": "private", "showcase_asset_path": null, "output_url": "generated_images/a1000000-0000-4000-8000-00000000f001/durable/example.jpg"}'::jsonb
);

select is(
  (select showcase_asset_path from public.posts where id = 'b0000000-0000-4000-8000-00000000f001'::uuid),
  null,
  'a JSON null clears showcase_asset_path'
);
select is(
  (select output_url from public.posts where id = 'b0000000-0000-4000-8000-00000000f001'::uuid),
  'generated_images/a1000000-0000-4000-8000-00000000f001/durable/example.jpg',
  'output_url follows the durable copy'
);

-- 3. Going public sets the derivative again.
select public.update_post_with_resource_bundle(
  'b0000000-0000-4000-8000-00000000f001'::uuid,
  'a1000000-0000-4000-8000-00000000f001'::uuid,
  '{"visibility": "public", "showcase_asset_path": "showcase/gen-1/example.def456.jpg"}'::jsonb
);

select is(
  (select showcase_asset_path from public.posts where id = 'b0000000-0000-4000-8000-00000000f001'::uuid),
  'showcase/gen-1/example.def456.jpg',
  'a present showcase_asset_path is written'
);

select finish();

rollback;
