-- A save that sends no recipe and changes its post's title takes the title of
-- the post's recipe along, sold or not (since 20261027172920: a sold recipe can
-- be corrected, and its buyers keep the revision they bought).
--
-- The recipe row keeps a copy of its post's title, written only by a save that
-- carries the recipe. A visibility change from Studio or a list sends none, and
-- since #554 it can still retitle the post: a title cut from the creation's
-- prompt goes out as the recipe's kind title ("Image recipe"). The recipe
-- panel, the marketplace card and search then kept the old title -- the
-- prompt's opening. A sold recipe's title is part of the revision its buyers
-- hold, so retitling it mints a new revision and theirs stays as it was.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

-- ─── Surface ─────────────────────────────────────────────────────────────────

select ok(
  (select procedures.prosecdef
     and procedures.proconfig @> array['search_path=""']
     and not has_function_privilege('service_role', procedures.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
     and not has_function_privilege('anon', procedures.oid, 'EXECUTE')
   from pg_catalog.pg_proc as procedures
   where procedures.oid = to_regprocedure('public.sync_post_resource_bundle_title(uuid, uuid)')),
  'the title sync runs as its owner with an empty search path and no caller grants'
);
select ok(
  has_function_privilege('service_role', 'public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.update_post_with_resource_bundle(uuid, uuid, jsonb, boolean, jsonb)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.upsert_post_with_resource_bundle(jsonb, jsonb, boolean)', 'EXECUTE'),
  'both post RPCs stay callable by the service role only'
);

-- ─── Fixture ─────────────────────────────────────────────────────────────────
-- A (…a1) writes every post; B (…a2) buys two recipes and unlocks a free one.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('e7a00000-0000-4000-8000-0000000000a1'::uuid, 'title-follow-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now()),
  ('e7a00000-0000-4000-8000-0000000000a2'::uuid, 'title-follow-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

update public.profiles
set username = 'titlefollower', display_name = 'Title Follower'
where id = 'e7a00000-0000-4000-8000-0000000000a1'::uuid;

insert into public.generations (
  id, user_id, prediction_id, status, cost, category, model, output_url, is_public, showcase_asset_path
) values
  ('e7e00000-0000-4000-8000-000000000007'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'title-follow-7', 'succeeded', 1, 'video', 'test',
   'generated_videos/e7a00000-0000-4000-8000-0000000000a1/seven.mp4', true,
   'showcase/e7e00000-0000-4000-8000-000000000007/seven.abc123.mp4'),
  ('e7e00000-0000-4000-8000-000000000008'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'title-follow-8', 'succeeded', 1, 'video', 'test',
   'generated_videos/e7a00000-0000-4000-8000-0000000000a1/eight.mp4', true,
   'showcase/e7e00000-0000-4000-8000-000000000008/eight.abc123.mp4');

-- Posts 1-6 and 9 take the edit route; 7 and 8 are creations' posts and take
-- the publish route; 10 is upserted by its id.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, title, body)
values
  ('e7b00000-0000-4000-8000-000000000001'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'text', 'external', 'text', 'A cinematic shot of a red fox', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-000000000002'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'text', 'external', 'text', 'A neon city street at night', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-000000000003'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'text', 'external', 'text', 'A post whose recipe has its own title', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-000000000004'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'text', 'external', 'text', 'A watercolor of a quiet harbor', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-000000000005'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'text', 'external', 'text', 'A post with no recipe', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-000000000006'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'private', 'text', 'external', 'text', 'A title to clear', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-000000000009'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'private', 'text', 'external', 'text', 'A post saved with its media', 'A body long enough to read as real public content.'),
  ('e7b00000-0000-4000-8000-00000000000a'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'private', 'text', 'external', 'text', 'A post named by its id', 'A body long enough to read as real public content.');

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, title, generation_id, showcase_asset_path, output_url
)
values
  ('e7b00000-0000-4000-8000-000000000007'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'video', 'magicbooklet', 'media', 'A slow pan across a desert',
   'e7e00000-0000-4000-8000-000000000007'::uuid,
   'showcase/e7e00000-0000-4000-8000-000000000007/seven.abc123.mp4',
   'generated_videos/e7a00000-0000-4000-8000-0000000000a1/seven.mp4'),
  ('e7b00000-0000-4000-8000-000000000008'::uuid, 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
   'public', 'video', 'magicbooklet', 'media', 'A drone shot over a glacier',
   'e7e00000-0000-4000-8000-000000000008'::uuid,
   'showcase/e7e00000-0000-4000-8000-000000000008/eight.abc123.mp4',
   'generated_videos/e7a00000-0000-4000-8000-0000000000a1/eight.mp4');

-- Every recipe but 3 carries its post's title, as a save with the recipe
-- writes it. Recipe 3 has a title of its own, as one made from an older
-- marketplace listing does.
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text, prompt_text, price_usd_cents
)
values
  ('e7c00000-0000-4000-8000-000000000001'::uuid, 'e7b00000-0000-4000-8000-000000000001'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'paid', 'published', 'A cinematic shot of a red fox',
   'Nobody has bought this one yet.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A cinematic shot of a red fox in tall grass at golden hour, shallow depth of field.', 500),
  ('e7c00000-0000-4000-8000-000000000002'::uuid, 'e7b00000-0000-4000-8000-000000000002'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'paid', 'published', 'A neon city street at night',
   'Someone bought this one already.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A neon city street at night, rain on the asphalt, reflections, anamorphic flare.', 500),
  ('e7c00000-0000-4000-8000-000000000003'::uuid, 'e7b00000-0000-4000-8000-000000000003'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'free', 'published', 'A recipe title of its own',
   'Anyone can take this recipe.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A free prompt that is long enough to count as a real resource.', 0),
  ('e7c00000-0000-4000-8000-000000000004'::uuid, 'e7b00000-0000-4000-8000-000000000004'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'free', 'published', 'A watercolor of a quiet harbor',
   'Anyone can take this recipe.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A watercolor of a quiet harbor at dawn, soft washes, moored boats.', 0),
  ('e7c00000-0000-4000-8000-000000000006'::uuid, 'e7b00000-0000-4000-8000-000000000006'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'free', 'draft', 'A title to clear',
   'Anyone can take this recipe.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A free prompt that is long enough to count as a real resource.', 0),
  ('e7c00000-0000-4000-8000-000000000007'::uuid, 'e7b00000-0000-4000-8000-000000000007'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'paid', 'published', 'A slow pan across a desert',
   'Nobody has bought this one yet.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A slow pan across a desert at noon, heat shimmer, a lone figure walking.', 500),
  ('e7c00000-0000-4000-8000-000000000008'::uuid, 'e7b00000-0000-4000-8000-000000000008'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'paid', 'published', 'A drone shot over a glacier',
   'Someone bought this one already.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A drone shot over a glacier, blue crevasses, low sun, slow forward motion.', 500),
  ('e7c00000-0000-4000-8000-000000000009'::uuid, 'e7b00000-0000-4000-8000-000000000009'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'free', 'draft', 'A post saved with its media',
   'Anyone can take this recipe.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A free prompt that is long enough to count as a real resource.', 0),
  ('e7c00000-0000-4000-8000-00000000000a'::uuid, 'e7b00000-0000-4000-8000-00000000000a'::uuid,
   'e7a00000-0000-4000-8000-0000000000a1'::uuid, 'free', 'draft', 'A post named by its id',
   'Anyone can take this recipe.', 'A preview long enough to satisfy the marketplace quality gate.',
   'A free prompt that is long enough to count as a real resource.', 0);

-- B buys recipes 2 and 8, each through a recorded cash order as completion
-- writes it, and unlocks free recipe 4.
insert into public.post_resource_bundle_orders (
  id, bundle_id, buyer_user_id, razorpay_order_id, razorpay_payment_id,
  amount_subunits, currency, status,
  quoted_price_usd_cents, quoted_revision_id, quoted_content_fingerprint, quoted_media
)
select
  orders.id, orders.bundle_id, 'e7a00000-0000-4000-8000-0000000000a2'::uuid,
  orders.razorpay_order_id, orders.razorpay_payment_id, 500, 'USD', 'created', 500,
  revisions.id, revisions.content_fingerprint, '[]'::jsonb
from (values
  ('e7d00000-0000-4000-8000-000000000002'::uuid, 'e7c00000-0000-4000-8000-000000000002'::uuid,
   'order_title_follow_2', 'pay_title_follow_2'),
  ('e7d00000-0000-4000-8000-000000000008'::uuid, 'e7c00000-0000-4000-8000-000000000008'::uuid,
   'order_title_follow_8', 'pay_title_follow_8')
) as orders (id, bundle_id, razorpay_order_id, razorpay_payment_id)
join lateral (
  select id, content_fingerprint
  from public.post_resource_bundle_revisions
  where bundle_id = orders.bundle_id
  order by revision_number desc
  limit 1
) as revisions on true;

insert into public.post_resource_bundle_purchases (
  bundle_id, buyer_user_id, order_id, price_usd_cents, amount_subunits, currency
)
values
  ('e7c00000-0000-4000-8000-000000000002'::uuid, 'e7a00000-0000-4000-8000-0000000000a2'::uuid,
   'e7d00000-0000-4000-8000-000000000002'::uuid, 500, 500, 'USD'),
  ('e7c00000-0000-4000-8000-000000000008'::uuid, 'e7a00000-0000-4000-8000-0000000000a2'::uuid,
   'e7d00000-0000-4000-8000-000000000008'::uuid, 500, 500, 'USD'),
  ('e7c00000-0000-4000-8000-000000000004'::uuid, 'e7a00000-0000-4000-8000-0000000000a2'::uuid,
   null, 0, 0, 'USD');

-- ─── Edit route: a visibility change that retitles the post ──────────────────
-- The save the edit route sends when a recipe post's title is the prompt's
-- opening: the new visibility, the kind title, and no recipe.

select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000001'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"visibility": "private", "title": "Image recipe"}'::jsonb
     ) $$,
  'a visibility change that retitles a post with an unsold recipe saves'
);
select is(
  (select title from public.posts where id = 'e7b00000-0000-4000-8000-000000000001'::uuid),
  'Image recipe',
  'the post takes the new title'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000001'::uuid),
  'Image recipe',
  'the unsold recipe takes the post''s new title'
);
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'e7c00000-0000-4000-8000-000000000001'::uuid),
  2,
  'the retitled recipe is a new revision, so a later checkout quotes the new title'
);

-- ─── Edit route: a sold recipe follows too; its buyer keeps their title ──────

select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000002'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"visibility": "private", "title": "Image recipe"}'::jsonb
     ) $$,
  'the same save on a post with a sold recipe succeeds'
);
select is(
  (select title from public.posts where id = 'e7b00000-0000-4000-8000-000000000002'::uuid),
  'Image recipe',
  'the post with a sold recipe takes the new title'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000002'::uuid),
  'Image recipe',
  'the sold recipe takes the post''s new title'
);
select is(
  (select count(*)::int from public.post_resource_bundle_revisions
   where bundle_id = 'e7c00000-0000-4000-8000-000000000002'::uuid),
  2,
  'the retitled sold recipe is a new revision'
);
select is(
  (select revisions.title
   from public.post_resource_bundle_purchases as purchases
   join public.post_resource_bundle_revisions as revisions on revisions.id = purchases.revision_id
   where purchases.bundle_id = 'e7c00000-0000-4000-8000-000000000002'::uuid),
  'A neon city street at night',
  'the buyer keeps the title they bought'
);

-- ─── Edit route: only a changed title moves the recipe's ─────────────────────

select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000003'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"visibility": "private", "title": "A post whose recipe has its own title"}'::jsonb
     ) $$,
  'a visibility change that restates the title saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000003'::uuid),
  'A recipe title of its own',
  'a save that leaves the post''s title as it was leaves the recipe''s own title alone'
);
select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000003'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"title": "A post retitled in the editor"}'::jsonb
     ) $$,
  'a save that only retitles the post saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000003'::uuid),
  'A post retitled in the editor',
  'once the post''s title changes, the recipe takes it, as a save with the recipe would'
);

-- ─── Edit route: a free unlock does not hold the title back ──────────────────
-- Someone who unlocked a free recipe keeps the revision they opened.

select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000004'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"title": "Image recipe"}'::jsonb
     ) $$,
  'retitling a post whose free recipe was unlocked saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000004'::uuid),
  'Image recipe',
  'a free recipe that was unlocked takes the new title'
);
select is(
  (select revisions.title
   from public.post_resource_bundle_purchases as purchases
   join public.post_resource_bundle_revisions as revisions on revisions.id = purchases.revision_id
   where purchases.bundle_id = 'e7c00000-0000-4000-8000-000000000004'::uuid),
  'A watercolor of a quiet harbor',
  'the free unlock still holds the revision it opened'
);

-- ─── Edit route: no recipe, a cleared title, and the media variant ───────────

select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000005'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"title": "A retitled post with no recipe"}'::jsonb
     ) $$,
  'retitling a post with no recipe saves'
);
select is(
  (select count(*)::int from public.post_resource_bundles
   where post_id = 'e7b00000-0000-4000-8000-000000000005'::uuid),
  0,
  'retitling a post with no recipe makes none'
);
select lives_ok(
  $$ select * from public.update_post_with_resource_bundle(
       'e7b00000-0000-4000-8000-000000000006'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"title": "   "}'::jsonb
     ) $$,
  'clearing the title of a private post with a recipe saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000006'::uuid),
  'Attached unlock',
  'a cleared post title leaves the recipe the name a save with the recipe gives it'
);
select lives_ok(
  $$ select * from public.update_post_with_resource_bundle_and_media(
       'e7b00000-0000-4000-8000-000000000009'::uuid,
       'e7a00000-0000-4000-8000-0000000000a1'::uuid,
       '{"title": "A post retitled with its media"}'::jsonb,
       false,
       null,
       '[]'::jsonb
     ) $$,
  'a save that also replaces the post''s media saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000009'::uuid),
  'A post retitled with its media',
  'the edit route''s media save takes the recipe''s title along too'
);

-- ─── Publish route: Studio unpublishes a creation's post ─────────────────────
-- The RPC's arguments as showcase-publish-service.ts builds them for a
-- visibility change to private: the post retitled, its public copy dropped,
-- found by its creation, and no recipe.

create function pg_temp.unpublish_retitled(p_generation uuid)
returns uuid
language sql
as $$
  select result.post_id
  from public.publish_generation_post_with_resource_bundle(
    p_generation,
    'e7a00000-0000-4000-8000-0000000000a1'::uuid,
    jsonb_build_object('is_public', false, 'showcase_asset_path', null, 'title', 'Video recipe'),
    jsonb_build_object(
      'user_id', 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
      'visibility', 'private',
      'category', 'video',
      'title', 'Video recipe',
      'post_format', 'media',
      'source_kind', 'magicbooklet',
      'generation_id', p_generation,
      'showcase_asset_path', null,
      'output_url', (select output_url from public.generations where id = p_generation)
    ),
    null,
    false
  ) as result;
$$;

select lives_ok(
  $$ select pg_temp.unpublish_retitled('e7e00000-0000-4000-8000-000000000007'::uuid) $$,
  'unpublishing a retitled creation post with an unsold recipe saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000007'::uuid),
  'Video recipe',
  'the publish route takes the unsold recipe''s title along'
);
select lives_ok(
  $$ select pg_temp.unpublish_retitled('e7e00000-0000-4000-8000-000000000008'::uuid) $$,
  'unpublishing a retitled creation post with a sold recipe saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-000000000008'::uuid),
  'Video recipe',
  'the publish route takes a sold recipe''s title along too'
);

-- ─── The upsert, with the post named by its id ───────────────────────────────
-- The publish route names the post by its creation; the upsert also takes an
-- id, and finds the post the same way for the title it had before the save.

select lives_ok(
  $$ select * from public.upsert_post_with_resource_bundle(
       jsonb_build_object(
         'id', 'e7b00000-0000-4000-8000-00000000000a'::uuid,
         'user_id', 'e7a00000-0000-4000-8000-0000000000a1'::uuid,
         'visibility', 'private',
         'category', 'text',
         'title', 'A post named by its id, retitled',
         'body', 'A body long enough to read as real public content.',
         'post_format', 'text',
         'source_kind', 'external'
       ),
       null,
       false
     ) $$,
  'an upsert that names the post by its id and sends no recipe saves'
);
select is(
  (select title from public.post_resource_bundles where id = 'e7c00000-0000-4000-8000-00000000000a'::uuid),
  'A post named by its id, retitled',
  'the upsert takes the recipe''s title along for a post named by its id too'
);

select finish();

rollback;
