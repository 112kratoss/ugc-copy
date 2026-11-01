-- The marketplace list applies two rules the feed, the post page and search
-- already apply:
--   - a paid recipe's post shows no body whose first line is "Saved
--     generation setup" (sanitizePublicPostContent and
--     isGeneratedRecipeSetupText, src/lib/post-public-content.ts). The search
--     document does not hold that body, and the listing's quality gate does
--     not count it as the post's public proof, as the app's check (which
--     reads the post as shown) does not;
--   - a recipe on an NSFW-labelled post is not listed, as search_public_posts
--     leaves the post out, so a page never holds a row the app then drops.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(41);

create function pg_temp.finds(p_query text, p_bundle_id uuid)
returns boolean
language sql
as $$
  select exists (
    select 1
    from public.list_marketplace_resource_bundles('all', 'all', null, p_query, 'recent', 0, 100)
    where id = p_bundle_id
  );
$$;

create function pg_temp.document(p_bundle_id uuid)
returns text
language sql
as $$
  select search_text
  from public.marketplace_bundle_search_documents
  where bundle_id = p_bundle_id;
$$;

create function pg_temp.listable(p_bundle_id uuid)
returns boolean
language sql
as $$
  select listable
  from public.marketplace_bundle_listings
  where bundle_id = p_bundle_id;
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- One seller. Posts …011–…017 and their recipes …021–…027:
--   …021 paid, on a picture whose caption is the setup it sells;
--   …022 paid, on an untitled text post whose only text is that setup;
--   …023 free, on the same kind of text post;
--   …024 free, on a picture with a setup caption (made paid below);
--   …025 paid, on a picture with an ordinary caption;
--   …026 free, on an NSFW-labelled post, the newest recipe;
--   …027 free, on a post labelled NSFW below.
-- Posts …031–…042 carry the heading's spellings, each under a paid recipe
-- (…051–…062) and each with a word of its own after the heading.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000f5e1-0000-4000-9000-000000000001'::uuid, 'f5e1-public-read-rules@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

update public.profiles
set username = 'nightjar-seller', display_name = 'Nightjar Seller'
where id = '0000f5e1-0000-4000-9000-000000000001'::uuid;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  ('0000f5e1-0000-4000-9000-000000000011'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible', false,
   'Harbour lights at dusk',
   E'Saved generation setup\nModel: Nano Banana 2\nLight: quillfeather glow over the water',
   'showcase/f5e1-011.png', 'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e1-0000-4000-9000-000000000012'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'visible', false,
   null,
   E'Saved generation setup\nModel: Nano Banana 2\nAspect ratio: 4:5\nGrade: tamarisk teal',
   null, 'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e1-0000-4000-9000-000000000013'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'text', 'external', 'text', 'visible', false,
   null,
   E'Saved generation setup\nModel: Nano Banana 2\nGrade: saltmarsh silver',
   null, 'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e1-0000-4000-9000-000000000014'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible', false,
   'Marrow light street',
   E'Saved generation setup\nModel: Kling 3.0\nGrade: marrowlight amber',
   'showcase/f5e1-014.png', 'Kling', 'kling', now(), now()),
  ('0000f5e1-0000-4000-9000-000000000015'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible', false,
   'Larkspur ridge at noon',
   'An ordinary caption about the larkspur ridge at noon.',
   'showcase/f5e1-015.png', 'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e1-0000-4000-9000-000000000016'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible', true,
   'Nightjar moss study',
   'Caption for the nightjar moss study.',
   'showcase/f5e1-016.png', 'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e1-0000-4000-9000-000000000017'::uuid, '0000f5e1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible', false,
   'Cobalt fern study',
   'Caption for the cobalt fern study.',
   'showcase/f5e1-017.png', 'Nano Banana', 'nano-banana', now(), now());

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select
  ('0000f5e1-0000-4000-9000-0000000000' || variant.suffix)::uuid,
  '0000f5e1-0000-4000-9000-000000000001'::uuid,
  'public', 'image', 'magicbooklet', 'media', 'visible', false,
  'Spelling fixture ' || variant.suffix,
  variant.body,
  'showcase/f5e1-' || variant.suffix || '.png', 'Nano Banana', 'nano-banana', now(), now()
from (values
  ('31', E'\n\n  Saved Generation Setup  \r\nModel: Nano Banana 2\r\nGrade: alderwisp'),
  ('32', E' Saved generation setup\nGrade: brackenhue'),
  ('33', E'﻿Saved generation setup\nGrade: cindermoth'),
  ('34', E'Saved generation setup　\nGrade: duskwillow'),
  ('35', E'SAVED GENERATION SETUP\t\nGrade: emberquill'),
  ('36', E'Saved generation setup \nGrade: larchember'),
  ('37', E'Saved generation setup:\nGrade: fernlantern'),
  ('38', E'My caption first\nSaved generation setup\nGrade: gorsefrost'),
  ('39', E'Saved generation setup\rGrade: hollowmere'),
  ('40', E'Saved generation setup Grade: ivorythorn'),
  ('41', E'Saved generation setup\u0085Grade: junipercoil'),
  ('42', E'Saved  generation setup\nGrade: kestrelpine')
) as variant(suffix, body);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
)
select
  ('0000f5e1-0000-4000-9000-0000000000' || recipe.bundle_suffix)::uuid,
  ('0000f5e1-0000-4000-9000-0000000000' || recipe.post_suffix)::uuid,
  '0000f5e1-0000-4000-9000-000000000001'::uuid,
  recipe.access_mode, 'published',
  recipe.title, 'Three steps to the finished picture',
  'A preview long enough to pass the marketplace quality gate.',
  null, '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a buyer unlocks for this picture')),
  '[]'::jsonb,
  case recipe.access_mode when 'paid' then 300 else 0 end, 0, 0,
  now() - recipe.age, now()
from (values
  ('21', '11', 'paid', 'Harbour lights recipe', interval '20 minutes'),
  ('22', '12', 'paid', 'Tamarisk notes recipe', interval '20 minutes'),
  ('23', '13', 'free', 'Saltmarsh notes recipe', interval '20 minutes'),
  ('24', '14', 'free', 'Marrow light recipe', interval '20 minutes'),
  ('25', '15', 'paid', 'Larkspur ridge recipe', interval '20 minutes'),
  ('26', '16', 'free', 'Nightjar moss recipe', interval '1 minute'),
  ('27', '17', 'free', 'Cobalt fern recipe', interval '2 minutes'),
  ('51', '31', 'paid', 'Spelling recipe 31', interval '30 minutes'),
  ('52', '32', 'paid', 'Spelling recipe 32', interval '30 minutes'),
  ('53', '33', 'paid', 'Spelling recipe 33', interval '30 minutes'),
  ('54', '34', 'paid', 'Spelling recipe 34', interval '30 minutes'),
  ('55', '35', 'paid', 'Spelling recipe 35', interval '30 minutes'),
  ('56', '36', 'paid', 'Spelling recipe 36', interval '30 minutes'),
  ('57', '37', 'paid', 'Spelling recipe 37', interval '30 minutes'),
  ('58', '38', 'paid', 'Spelling recipe 38', interval '30 minutes'),
  ('59', '39', 'paid', 'Spelling recipe 39', interval '30 minutes'),
  ('60', '40', 'paid', 'Spelling recipe 40', interval '30 minutes'),
  ('61', '41', 'paid', 'Spelling recipe 41', interval '30 minutes'),
  ('62', '42', 'paid', 'Spelling recipe 42', interval '30 minutes')
) as recipe(bundle_suffix, post_suffix, access_mode, title, age);

-- ─── Listed, so a miss below is the rule under test ─────────────────────────

select ok(pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000021'::uuid),
  'fixture: the paid recipe on a picture with a setup caption is listed');
select ok(pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000024'::uuid),
  'fixture: the free recipe on a picture with a setup caption is listed');
select ok(pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000025'::uuid),
  'fixture: the paid recipe on a picture with an ordinary caption is listed');
select ok(pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000027'::uuid),
  'fixture: the recipe on a post not labelled NSFW is listed');

-- ─── A paid recipe's setup caption ──────────────────────────────────────────

select is(position('quillfeather' in pg_temp.document('0000f5e1-0000-4000-9000-000000000021'::uuid)), 0,
  'a paid recipe''s document does not hold its post''s setup caption');
select ok(not pg_temp.finds('quillfeather glow', '0000f5e1-0000-4000-9000-000000000021'::uuid),
  'a word of that caption does not find the recipe');
select ok(pg_temp.finds('harbour lights at dusk', '0000f5e1-0000-4000-9000-000000000021'::uuid),
  'the post''s title still finds it');
select ok(pg_temp.finds('larkspur ridge at noon.', '0000f5e1-0000-4000-9000-000000000025'::uuid),
  'a paid recipe''s ordinary caption still finds it');
select ok(pg_temp.finds('marrowlight amber', '0000f5e1-0000-4000-9000-000000000024'::uuid),
  'a free recipe''s setup caption still finds it, as public reads show it');

-- The setup is all an untitled text post shows of itself: under a paid recipe
-- nobody sees it, so the post has no public proof and the recipe is not listed.
select ok(not pg_temp.listable('0000f5e1-0000-4000-9000-000000000022'::uuid),
  'a paid recipe whose post shows nothing but its setup caption is not listed');
select ok(pg_temp.listable('0000f5e1-0000-4000-9000-000000000023'::uuid),
  'under a free recipe the same post is listed');
select ok(pg_temp.finds('saltmarsh silver', '0000f5e1-0000-4000-9000-000000000023'::uuid),
  'and its caption finds it');

-- Made paid, then free again.
update public.post_resource_bundles
set access_mode = 'paid', price_usd_cents = 300
where id = '0000f5e1-0000-4000-9000-000000000024'::uuid;

select is(position('marrowlight' in pg_temp.document('0000f5e1-0000-4000-9000-000000000024'::uuid)), 0,
  'a recipe made paid drops its post''s setup caption from its document');
select ok(not pg_temp.finds('marrowlight amber', '0000f5e1-0000-4000-9000-000000000024'::uuid),
  'and a word of it no longer finds the recipe');

update public.post_resource_bundles
set access_mode = 'paid', price_usd_cents = 300
where id = '0000f5e1-0000-4000-9000-000000000023'::uuid;

select ok(not pg_temp.listable('0000f5e1-0000-4000-9000-000000000023'::uuid),
  'a recipe made paid leaves the list when its post shows nothing but its setup caption');

update public.post_resource_bundles
set access_mode = 'free', price_usd_cents = 0
where id in ('0000f5e1-0000-4000-9000-000000000023'::uuid, '0000f5e1-0000-4000-9000-000000000024'::uuid);

select ok(pg_temp.finds('marrowlight amber', '0000f5e1-0000-4000-9000-000000000024'::uuid),
  'made free again, its setup caption finds it');
select ok(pg_temp.listable('0000f5e1-0000-4000-9000-000000000023'::uuid),
  'made free again, the text post''s recipe is listed');

-- The post's own edit: an ordinary caption is public proof under a paid recipe.
update public.posts
set body = 'An ordinary caption long enough to read as the post itself.'
where id = '0000f5e1-0000-4000-9000-000000000012'::uuid;

select ok(pg_temp.listable('0000f5e1-0000-4000-9000-000000000022'::uuid),
  'a paid recipe is listed once its post''s caption is not its setup');

-- ─── The heading as isGeneratedRecipeSetupText reads it ──────────────────────
--
-- The first line of the text with \r\n read as \n and both ends trimmed of what
-- String.prototype.trim removes, itself trimmed and lower-cased, is exactly the
-- heading. src/__tests__/marketplace-list-public-read-rules-migration.test.ts
-- runs the app's function on these same bodies.

select is(position('alderwisp' in pg_temp.document('0000f5e1-0000-4000-9000-000000000051'::uuid)), 0,
  'blank lines, spaces, capitals and \r\n around the heading: dropped');
select is(position('brackenhue' in pg_temp.document('0000f5e1-0000-4000-9000-000000000052'::uuid)), 0,
  'a no-break space before the heading: dropped');
select is(position('cindermoth' in pg_temp.document('0000f5e1-0000-4000-9000-000000000053'::uuid)), 0,
  'a byte-order mark before the heading: dropped');
select is(position('duskwillow' in pg_temp.document('0000f5e1-0000-4000-9000-000000000054'::uuid)), 0,
  'an ideographic space after the heading: dropped');
select is(position('emberquill' in pg_temp.document('0000f5e1-0000-4000-9000-000000000055'::uuid)), 0,
  'the heading in capitals with a tab after it: dropped');
select is(position('larchember' in pg_temp.document('0000f5e1-0000-4000-9000-000000000056'::uuid)), 0,
  'a line separator ending the heading''s line: dropped');
select ok(position('fernlantern' in pg_temp.document('0000f5e1-0000-4000-9000-000000000057'::uuid)) > 0,
  'the heading with a colon: kept');
select ok(position('gorsefrost' in pg_temp.document('0000f5e1-0000-4000-9000-000000000058'::uuid)) > 0,
  'the heading on the second line: kept');
select ok(position('hollowmere' in pg_temp.document('0000f5e1-0000-4000-9000-000000000059'::uuid)) > 0,
  'a lone \r after the heading is not a line break: kept');
select ok(position('ivorythorn' in pg_temp.document('0000f5e1-0000-4000-9000-000000000060'::uuid)) > 0,
  'a line separator inside the first line is not a line break: kept');
select ok(position('junipercoil' in pg_temp.document('0000f5e1-0000-4000-9000-000000000061'::uuid)) > 0,
  'a next-line character is not whitespace to the app: kept');
select ok(position('kestrelpine' in pg_temp.document('0000f5e1-0000-4000-9000-000000000062'::uuid)) > 0,
  'two spaces inside the heading: kept');

-- ─── NSFW-labelled posts ─────────────────────────────────────────────────────

select ok(not pg_temp.listable('0000f5e1-0000-4000-9000-000000000026'::uuid),
  'a recipe on an NSFW-labelled post is not listable');
select ok(not pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000026'::uuid),
  'the list leaves it out');
select ok(not pg_temp.finds('nightjar moss', '0000f5e1-0000-4000-9000-000000000026'::uuid),
  'and its post''s words do not find it');

-- The newest recipe matching "study" is the NSFW one. A one-row page must be
-- the next recipe, not a row the app would drop.
select is(
  (select id from public.list_marketplace_resource_bundles('all', 'all', null, 'study', 'recent', 0, 1)),
  '0000f5e1-0000-4000-9000-000000000027'::uuid,
  'a page of one holds the first recipe a visitor can see'
);

update public.posts
set is_nsfw = true
where id = '0000f5e1-0000-4000-9000-000000000017'::uuid;

select ok(not pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000027'::uuid),
  'labelling a post NSFW takes its recipe off the list at once');

update public.posts
set is_nsfw = false
where id = '0000f5e1-0000-4000-9000-000000000017'::uuid;

select ok(pg_temp.finds(null, '0000f5e1-0000-4000-9000-000000000027'::uuid),
  'removing the label lists it again');

-- An NSFW post's recipe stays its owner's: the label leaves the recipe itself
-- alone, so the creator and its buyers keep reading it on its own pages.
select is(
  (select status from public.post_resource_bundles where id = '0000f5e1-0000-4000-9000-000000000026'::uuid),
  'published',
  'the label does not unpublish the recipe'
);

-- ─── A full refresh repairs what a missed trigger left ──────────────────────

update public.marketplace_bundle_listings
set listable = true
where bundle_id in ('0000f5e1-0000-4000-9000-000000000026'::uuid, '0000f5e1-0000-4000-9000-000000000022'::uuid);

update public.posts
set body = E'Saved generation setup\nModel: Nano Banana 2\nGrade: tamarisk teal'
where id = '0000f5e1-0000-4000-9000-000000000012'::uuid;

update public.marketplace_bundle_listings
set listable = true
where bundle_id = '0000f5e1-0000-4000-9000-000000000022'::uuid;

update public.marketplace_bundle_search_documents
set search_text = 'stale quillfeather'
where bundle_id = '0000f5e1-0000-4000-9000-000000000021'::uuid;

select public.refresh_marketplace_bundle_listings(null);
select public.refresh_marketplace_bundle_search_documents(null);

select ok(not pg_temp.listable('0000f5e1-0000-4000-9000-000000000026'::uuid),
  'a full refresh takes an NSFW post''s recipe off the list');
select ok(not pg_temp.listable('0000f5e1-0000-4000-9000-000000000022'::uuid),
  'a full refresh judges a paid recipe''s post as it is shown');
select is(position('quillfeather' in pg_temp.document('0000f5e1-0000-4000-9000-000000000021'::uuid)), 0,
  'a full refresh projects a paid recipe''s document without its setup caption');
select ok(position('harbour lights at dusk' in pg_temp.document('0000f5e1-0000-4000-9000-000000000021'::uuid)) > 0,
  'and with the rest of what the card shows');

select * from finish();

rollback;
