-- A post whose recipe is paid stores no prompt (the owner's decision,
-- 2026-10-31).
--
-- posts.prompt holds the prompt a creator chose to show on a post. Once the
-- post's recipe is paid, that text is what the recipe sells. The feed and the
-- post page already blank it (sanitizePublicPostContent), but the search
-- document, the embedding and a sold recipe that is later retired still read
-- the column, so the column itself must be empty.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

-- ─── Fixture: one creator, five public posts that show a prompt ─────────────

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000c1ea-0000-4000-8000-000000000001'::uuid, 'paid-prompt-creator@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, prompt, showcase_asset_path, created_at, updated_at
) values
  ('0000c1ea-0000-4000-8000-000000000010'::uuid, '0000c1ea-0000-4000-8000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Sold recipe post', null, 'zebra quokka paid prompt', 'showcase/paid-prompt-1.png', now(), now()),
  ('0000c1ea-0000-4000-8000-000000000011'::uuid, '0000c1ea-0000-4000-8000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Free then paid post', null, 'walrus ibex free prompt', 'showcase/paid-prompt-2.png', now(), now()),
  ('0000c1ea-0000-4000-8000-000000000012'::uuid, '0000c1ea-0000-4000-8000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Paid draft post', null, 'okapi lynx draft prompt', 'showcase/paid-prompt-3.png', now(), now()),
  ('0000c1ea-0000-4000-8000-000000000013'::uuid, '0000c1ea-0000-4000-8000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Post without a recipe', null, 'tapir gecko shown prompt', 'showcase/paid-prompt-4.png', now(), now()),
  ('0000c1ea-0000-4000-8000-000000000014'::uuid, '0000c1ea-0000-4000-8000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'visible',
   'A post saved through the publish RPC', 'A body long enough to read as real public content.',
   'heron marmot stored prompt', null, now(), now());

select ok(
  exists (
    select 1 from public.post_search_documents
    where post_id = '0000c1ea-0000-4000-8000-000000000010'::uuid
      and search_text like '%zebra quokka%'
  ),
  'before it has a recipe, the post''s shown prompt is in its search document'
);

-- ─── A recipe saved as paid ──────────────────────────────────────────────────

insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text)
values ('0000c1ea-0000-4000-8000-000000000020'::uuid, '0000c1ea-0000-4000-8000-000000000010'::uuid,
        '0000c1ea-0000-4000-8000-000000000001'::uuid, 'paid', 'published', 'Sold recipe', 100, 'The prompt buyers unlock');

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000010'::uuid),
  null,
  'a recipe saved as paid clears the prompt its post stored'
);

select ok(
  not exists (
    select 1 from public.post_search_documents
    where post_id = '0000c1ea-0000-4000-8000-000000000010'::uuid
      and (search_text like '%quokka%' or search_vector @@ to_tsquery('simple', 'quokka'))
  ),
  'and takes it out of the post''s search document'
);

select is(
  (select count(*)::bigint from public.search_public_posts('zebra quokka', null, null, null, 20)),
  0::bigint,
  'so public search no longer matches the post by its prompt'
);

select is(
  (select title from public.posts where id = '0000c1ea-0000-4000-8000-000000000010'::uuid),
  'Sold recipe post',
  'the rest of the post is left as it was'
);

-- ─── A later write of the prompt ─────────────────────────────────────────────

create temp table paid_prompt_before on commit drop as
select nsfw_revision
from public.posts
where id = '0000c1ea-0000-4000-8000-000000000010'::uuid;

-- The publish route writes a post's prompt when a save carries no recipe (a
-- visibility change carries the stored one forward; the API takes one).
update public.posts
set prompt = 'zebra quokka paid prompt'
where id = '0000c1ea-0000-4000-8000-000000000010'::uuid;

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000010'::uuid),
  null,
  'a later write cannot store a prompt on a post whose recipe is paid'
);

select is(
  (select nsfw_revision from public.posts where id = '0000c1ea-0000-4000-8000-000000000010'::uuid),
  (select nsfw_revision from paid_prompt_before),
  'and the dropped write does not move the NSFW revision, which ends open reveals'
);

-- ─── Re-saving the paid recipe ───────────────────────────────────────────────

create temp table paid_prompt_row_before on commit drop as
select ctid::text as row_version
from public.posts
where id = '0000c1ea-0000-4000-8000-000000000010'::uuid;

update public.post_resource_bundles
set access_mode = 'paid', price_usd_cents = 200
where id = '0000c1ea-0000-4000-8000-000000000020'::uuid;

select is(
  (select ctid::text from public.posts where id = '0000c1ea-0000-4000-8000-000000000010'::uuid),
  (select row_version from paid_prompt_row_before),
  'saving a paid recipe whose post holds no prompt does not rewrite the post'
);

-- ─── Free recipes, and a free recipe made paid ───────────────────────────────

insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text)
values ('0000c1ea-0000-4000-8000-000000000021'::uuid, '0000c1ea-0000-4000-8000-000000000011'::uuid,
        '0000c1ea-0000-4000-8000-000000000001'::uuid, 'free', 'published', 'Free recipe', 0, 'A free prompt');

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000011'::uuid),
  'walrus ibex free prompt',
  'a free recipe leaves the shown prompt alone'
);

update public.post_resource_bundles
set access_mode = 'paid', price_usd_cents = 100
where id = '0000c1ea-0000-4000-8000-000000000021'::uuid;

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000011'::uuid),
  null,
  'making a free recipe paid clears it'
);

-- ─── A paid draft ────────────────────────────────────────────────────────────

insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text)
values ('0000c1ea-0000-4000-8000-000000000022'::uuid, '0000c1ea-0000-4000-8000-000000000012'::uuid,
        '0000c1ea-0000-4000-8000-000000000001'::uuid, 'paid', 'draft', 'Paid draft', 100, 'A drafted prompt');

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000012'::uuid),
  null,
  'a paid draft clears it too: a sold recipe that is retired becomes a draft'
);

-- ─── A post without a paid recipe ────────────────────────────────────────────

update public.posts
set prompt = 'tapir gecko edited prompt'
where id = '0000c1ea-0000-4000-8000-000000000013'::uuid;

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000013'::uuid),
  'tapir gecko edited prompt',
  'a post without a paid recipe stores the prompt it is given'
);

-- ─── Through the publish RPC ────────────────────────────────────────────────

-- upsert_post_with_resource_bundle writes the post, then its recipe.
select lives_ok(
  $$ select * from public.upsert_post_with_resource_bundle(
       jsonb_build_object(
         'id', '0000c1ea-0000-4000-8000-000000000014'::uuid,
         'user_id', '0000c1ea-0000-4000-8000-000000000001'::uuid,
         'visibility', 'public',
         'category', 'text',
         'title', 'A post saved through the publish RPC',
         'body', 'A body long enough to read as real public content.',
         'prompt', 'heron marmot stored prompt',
         'post_format', 'text',
         'source_kind', 'external'
       ),
       '{"accessMode": "paid", "priceUsdCents": 100,
         "summary": "A recipe sold with its post.",
         "previewText": "A preview long enough to satisfy the marketplace quality gate.",
         "resources": {"promptText": "The prompt buyers unlock, long enough to count as a real resource."}}'::jsonb,
       true
     ) $$,
  'one publish save can send a prompt and a paid recipe together'
);

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000014'::uuid),
  null,
  'and the post keeps no prompt: the recipe, saved after the post, clears it'
);

select lives_ok(
  $$ select * from public.upsert_post_with_resource_bundle(
       jsonb_build_object(
         'id', '0000c1ea-0000-4000-8000-000000000014'::uuid,
         'user_id', '0000c1ea-0000-4000-8000-000000000001'::uuid,
         'visibility', 'public',
         'category', 'text',
         'title', 'A post saved through the publish RPC',
         'body', 'A body long enough to read as real public content.',
         'prompt', 'heron marmot stored prompt',
         'post_format', 'text',
         'source_kind', 'external'
       ),
       null,
       false
     ) $$,
  'a later publish save that carries the prompt and no recipe goes through'
);

select is(
  (select prompt from public.posts where id = '0000c1ea-0000-4000-8000-000000000014'::uuid),
  null,
  'and stores no prompt while the recipe is paid'
);

-- ─── The functions and where they run ────────────────────────────────────────

-- client_rpc_boundaries.test.sql keeps clients off every SECURITY DEFINER
-- function; this pins how these two run.
select ok(
  (
    select count(*) = 2
      and bool_and(prosecdef)
      and bool_and(proconfig = array['search_path=""'])
      and bool_and(pg_get_userbyid(proowner) = 'postgres')
    from pg_proc
    where oid in (
      'public.clear_post_prompt_for_paid_recipe()'::regprocedure,
      'public.keep_post_prompt_out_of_paid_recipe()'::regprocedure
    )
  ),
  'both trigger functions run as postgres with an empty search_path'
);

-- BEFORE triggers fire in name order, and `name` sorts as Postgres fires them.
select is(
  (
    select array_agg(tgname::text order by tgname)
    from pg_trigger
    where tgrelid = 'public.posts'::regclass
      and not tgisinternal
      and (tgtype & 2) = 2    -- BEFORE
      and (tgtype & 16) = 16  -- UPDATE
      and tgname in (
        'a_posts_store_unlisted_as_private',
        'b_posts_keep_prompt_out_of_paid_recipe',
        'posts_advance_nsfw_revision'
      )
  ),
  array['a_posts_store_unlisted_as_private', 'b_posts_keep_prompt_out_of_paid_recipe', 'posts_advance_nsfw_revision'],
  'the prompt guard fires on update after the unlisted rule and before the NSFW revision'
);

select * from finish();

rollback;
