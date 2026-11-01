-- Deleting an account removes its posts and recipes through cascades from
-- auth.users, which fire in trigger-name order, so whether the posts' or the
-- recipes' cascade runs first depends on their constraints' OIDs. The recipe
-- trigger that re-projects a post's search document
-- (trg_refresh_post_search_document_for_recipe) must not write a document for
-- the account being deleted, whose foreign key would then fail the deletion.
-- A cascade's own triggers fire only after every cascade of the DELETE that
-- started it, so the trigger finds the post gone either way. This file holds
-- that with the recipes' cascade first: it re-creates both foreign keys, the
-- recipes' first, so their cascade triggers take adjacent OIDs and the
-- recipes' name sorts first (the names compare as text, so an OID kept from
-- the replay could sort either way against a new one).

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);

-- Before any write to either table: ALTER TABLE refuses a table with pending
-- trigger events.
alter table public.post_resource_bundles drop constraint post_resource_bundles_owner_user_id_fkey;
alter table public.post_resource_bundles add constraint post_resource_bundles_owner_user_id_fkey
  foreign key (owner_user_id) references auth.users(id) on delete cascade;
alter table public.posts drop constraint posts_user_id_fkey;
alter table public.posts add constraint posts_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

select is(
  (select string_agg(c.conname, ' then ' order by t.tgname)
   from pg_trigger as t
   join pg_constraint as c on c.oid = t.tgconstraint
   where t.tgrelid = 'auth.users'::regclass
     and t.tgname like 'RI_ConstraintTrigger_a_%'
     and t.tgtype & 8 = 8
     and c.conname in ('posts_user_id_fkey', 'post_resource_bundles_owner_user_id_fkey')),
  'post_resource_bundles_owner_user_id_fkey then posts_user_id_fkey',
  'fixture: deleting an account cascades to its recipes before its posts'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000c5eb-0000-4000-9000-000000000001'::uuid, 'c5eb-account-deletion@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values (
  '0000c5eb-0000-4000-9000-000000000011'::uuid, '0000c5eb-0000-4000-9000-000000000001'::uuid,
  'public', 'image', 'magicbooklet', 'media', 'visible', false,
  'Tarn study', E'Saved generation setup\nGrade: tarnwhistle',
  'showcase/c5eb-011.png', 'Nano Banana', 'nano-banana', now(), now()
);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '0000c5eb-0000-4000-9000-000000000021'::uuid, '0000c5eb-0000-4000-9000-000000000011'::uuid,
  '0000c5eb-0000-4000-9000-000000000001'::uuid, 'paid', 'published', 'Tarn recipe',
  'Three steps to the finished picture', 'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a buyer unlocks for this picture')),
  '[]'::jsonb, 300, 0, 0, now(), now()
);

select ok(
  exists (select 1 from public.post_search_documents
          where post_id = '0000c5eb-0000-4000-9000-000000000011'::uuid),
  'fixture: the public post has a search document'
);

select lives_ok(
  $$ delete from auth.users where id = '0000c5eb-0000-4000-9000-000000000001'::uuid $$,
  'deleting the account succeeds with its recipe''s cascade first'
);

select is(
  (select count(*) from public.posts where id = '0000c5eb-0000-4000-9000-000000000011'::uuid)
    + (select count(*) from public.post_resource_bundles where id = '0000c5eb-0000-4000-9000-000000000021'::uuid)
    + (select count(*) from public.post_search_documents where post_id = '0000c5eb-0000-4000-9000-000000000011'::uuid),
  0::bigint,
  'and leaves no post, recipe or search document behind'
);

select * from finish();

rollback;
