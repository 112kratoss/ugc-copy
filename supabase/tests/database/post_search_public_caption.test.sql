-- Post search holds a post's caption as public reads show it. Under a
-- published paid recipe, a body whose first line is "Saved generation setup"
-- shows as nothing (sanitizePublicPostContent and isGeneratedRecipeSetupText,
-- src/lib/post-public-content.ts), so the post's search document leaves it out
-- and its words do not find the post. A draft recipe sells nothing and public
-- reads show its post's caption, so search finds that one. The rule itself is
-- public.recipe_post_public_body, whose spellings
-- marketplace_list_public_read_rules.test.sql covers.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

create function pg_temp.finds(p_query text, p_post_id uuid)
returns boolean
language sql
as $$
  select exists (
    select 1
    from public.search_public_posts(p_query, null, null, null, 25)
    where post_id = p_post_id
  );
$$;

create function pg_temp.search_text(p_post_id uuid)
returns text
language sql
as $$
  select search_text
  from public.post_search_documents
  where post_id = p_post_id;
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- One creator. Posts …11–…21, recipes …31–…40 (each on the post with the same
-- last digit, but …40, which starts on …20):
--   …11 picture, setup caption, paid published; the most saved post;
--   …12 untitled text post whose only text is its setup, paid published;
--   …13 picture, ordinary caption, paid published;
--   …14 picture, setup caption, free published (made paid below);
--   …15 picture, setup caption, paid draft (published, then deleted, below);
--   …16 picture, setup caption, no recipe (given a paid one below);
--   …17 picture, setup caption after blank lines, in capitals, with CRLF,
--       paid published;
--   …18 picture, the heading with a colon, which is not the setup, paid
--       published;
--   …19 picture, an ordinary caption sharing a word with …11's setup, no recipe;
--   …20 picture, setup caption, paid published (its recipe moves to …21);
--   …21 picture, setup caption, no recipe.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000c5ea-0000-4000-9000-000000000001'::uuid, 'c5ea-post-search-caption@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

update public.profiles
set username = 'quorlith-creator', display_name = 'Quorlith Creator'
where id = '0000c5ea-0000-4000-9000-000000000001'::uuid;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, save_count, created_at, updated_at
)
select
  ('0000c5ea-0000-4000-9000-0000000000' || post.suffix)::uuid,
  '0000c5ea-0000-4000-9000-000000000001'::uuid,
  'public',
  case when post.title is null then 'text' else 'image' end,
  case when post.title is null then 'external' else 'magicbooklet' end,
  case when post.title is null then 'text' else 'media' end,
  'visible', false,
  post.title, post.body,
  case when post.title is null then null else 'showcase/c5ea-' || post.suffix || '.png' end,
  'Nano Banana', 'nano-banana', post.save_count, now(), now()
from (
  values
    ('11', 'Harbour lights at dusk', E'Saved generation setup\nModel: Nano Banana 2\nLight: quorlith glow over the water', 1000),
    ('12', null, E'Saved generation setup\nModel: Nano Banana 2\nGrade: vellmarrow teal', 0),
    ('13', 'Larkspur ridge at noon', 'An ordinary caption about the brindlecove ridge.', 0),
    ('14', 'Saltmarsh study', E'Saved generation setup\nGrade: tessoral silver', 0),
    ('15', 'Cobalt fern study', E'Saved generation setup\nGrade: ombrival amber', 0),
    ('16', 'Reed bank at dawn', E'Saved generation setup\nGrade: kestrimond green', 0),
    ('17', 'Moss wall in rain', E'\n\n  Saved Generation Setup  \r\nModel: Nano Banana 2\r\nGrade: palvinthe', 0),
    ('18', 'Moss wall in sun', E'Saved generation setup:\nGrade: corvalline', 0),
    ('19', 'Spare harbour frame', 'A plain caption that mentions quorlith once.', 0),
    ('20', 'Copper dune study', E'Saved generation setup\nGrade: gildercairn ochre', 0),
    ('21', 'Slate dune study', E'Saved generation setup\nGrade: morrowfen grey', 0)
) as post(suffix, title, body, save_count);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
)
select
  ('0000c5ea-0000-4000-9000-0000000000' || recipe.bundle_suffix)::uuid,
  ('0000c5ea-0000-4000-9000-0000000000' || recipe.post_suffix)::uuid,
  '0000c5ea-0000-4000-9000-000000000001'::uuid,
  recipe.access_mode, recipe.status,
  'Recipe ' || recipe.bundle_suffix, 'Three steps to the finished picture',
  'A preview long enough to pass the marketplace quality gate.',
  null, '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a buyer unlocks for this picture')),
  '[]'::jsonb,
  case recipe.access_mode when 'paid' then 300 else 0 end, 0, 0,
  now(), now()
from (
  values
    ('31', '11', 'paid', 'published'),
    ('32', '12', 'paid', 'published'),
    ('33', '13', 'paid', 'published'),
    ('34', '14', 'free', 'published'),
    ('35', '15', 'paid', 'draft'),
    ('37', '17', 'paid', 'published'),
    ('38', '18', 'paid', 'published'),
    ('40', '20', 'paid', 'published')
) as recipe(bundle_suffix, post_suffix, access_mode, status);

-- ─── Indexed, so a miss below is the rule under test ────────────────────────

select ok(pg_temp.finds('harbour lights at dusk', '0000c5ea-0000-4000-9000-000000000011'::uuid),
  'fixture: a paid recipe''s post is found by its title');
select ok(pg_temp.finds('brindlecove', '0000c5ea-0000-4000-9000-000000000013'::uuid),
  'fixture: a paid recipe''s ordinary caption finds its post');
select ok(pg_temp.search_text('0000c5ea-0000-4000-9000-000000000012'::uuid) is not null,
  'fixture: the untitled text post has a search document');

-- ─── A published paid recipe's setup caption ────────────────────────────────

select is(position('quorlith' in pg_temp.search_text('0000c5ea-0000-4000-9000-000000000011'::uuid)), 0,
  'the post''s search text does not hold its setup caption');
select ok(
  not (select search_vector @@ plainto_tsquery('simple', 'quorlith')
       from public.post_search_documents
       where post_id = '0000c5ea-0000-4000-9000-000000000011'::uuid),
  'nor does its search vector'
);
select ok(not pg_temp.finds('quorlith glow', '0000c5ea-0000-4000-9000-000000000011'::uuid),
  'so words of the caption do not find the post');
select ok(not pg_temp.finds('vellmarrow', '0000c5ea-0000-4000-9000-000000000012'::uuid),
  'nor an untitled text post whose only text is its setup');
-- …11 would rank first on its saves if its caption still matched.
select is(
  array(select post_id from public.search_public_posts('quorlith', null, null, null, 1)),
  array['0000c5ea-0000-4000-9000-000000000019']::uuid[],
  'a page of one holds the post whose caption public reads show'
);
select ok(not pg_temp.finds('palvinthe', '0000c5ea-0000-4000-9000-000000000017'::uuid),
  'the heading is read as the app reads it: after blank lines, in capitals, with CRLF');
select ok(pg_temp.finds('corvalline', '0000c5ea-0000-4000-9000-000000000018'::uuid),
  'a first line that is not exactly the heading is an ordinary caption and finds its post');

-- ─── Captions public reads show ─────────────────────────────────────────────

select ok(pg_temp.finds('tessoral', '0000c5ea-0000-4000-9000-000000000014'::uuid),
  'a free recipe''s setup caption finds its post, as public reads show it');
select ok(pg_temp.finds('ombrival', '0000c5ea-0000-4000-9000-000000000015'::uuid),
  'so does a paid draft''s: a draft sells nothing and public reads show its post''s caption');

-- ─── The recipe changes ─────────────────────────────────────────────────────

update public.post_resource_bundles
set access_mode = 'paid', price_usd_cents = 300
where id = '0000c5ea-0000-4000-9000-000000000034'::uuid;

select ok(not pg_temp.finds('tessoral', '0000c5ea-0000-4000-9000-000000000014'::uuid),
  'a recipe made paid takes its post''s setup caption out of search');

update public.post_resource_bundles
set access_mode = 'free', price_usd_cents = 0
where id = '0000c5ea-0000-4000-9000-000000000034'::uuid;

select ok(pg_temp.finds('tessoral', '0000c5ea-0000-4000-9000-000000000014'::uuid),
  'made free again, the caption finds its post again');

update public.post_resource_bundles
set status = 'published'
where id = '0000c5ea-0000-4000-9000-000000000035'::uuid;

select ok(not pg_temp.finds('ombrival', '0000c5ea-0000-4000-9000-000000000015'::uuid),
  'a paid draft that is published takes its post''s setup caption out of search');

delete from public.post_resource_bundles
where id = '0000c5ea-0000-4000-9000-000000000035'::uuid;

select ok(pg_temp.finds('ombrival', '0000c5ea-0000-4000-9000-000000000015'::uuid),
  'a deleted recipe leaves its post''s caption to find it again');

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '0000c5ea-0000-4000-9000-000000000036'::uuid, '0000c5ea-0000-4000-9000-000000000016'::uuid,
  '0000c5ea-0000-4000-9000-000000000001'::uuid, 'paid', 'published', 'Recipe 36',
  'Three steps to the finished picture', 'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a buyer unlocks for this picture')),
  '[]'::jsonb, 300, 0, 0, now(), now()
);

select ok(not pg_temp.finds('kestrimond', '0000c5ea-0000-4000-9000-000000000016'::uuid),
  'a paid recipe added to a post takes its setup caption out of search');

update public.post_resource_bundles
set status = 'draft'
where id = '0000c5ea-0000-4000-9000-000000000036'::uuid;

select ok(pg_temp.finds('kestrimond', '0000c5ea-0000-4000-9000-000000000016'::uuid),
  'a paid recipe taken back to draft shows its post''s caption to search again');

update public.post_resource_bundles
set post_id = '0000c5ea-0000-4000-9000-000000000021'::uuid
where id = '0000c5ea-0000-4000-9000-000000000040'::uuid;

select ok(not pg_temp.finds('morrowfen', '0000c5ea-0000-4000-9000-000000000021'::uuid),
  'a paid recipe moved to another post takes that post''s setup caption out of search');
select ok(pg_temp.finds('gildercairn', '0000c5ea-0000-4000-9000-000000000020'::uuid),
  'and the post it left is found by its caption again');

-- An edit of what the recipe sells does not touch the post's document.
create temporary table document_before on commit drop as
select ctid::text as row_location from public.post_search_documents
where post_id = '0000c5ea-0000-4000-9000-000000000011'::uuid;

update public.post_resource_bundles
set summary = 'Four steps to the finished picture'
where id = '0000c5ea-0000-4000-9000-000000000031'::uuid;

select is(
  (select ctid::text from public.post_search_documents where post_id = '0000c5ea-0000-4000-9000-000000000011'::uuid),
  (select row_location from document_before),
  'an edit of a recipe''s other columns does not rewrite its post''s search document'
);

-- ─── A full refresh repairs what a missed trigger left ──────────────────────

update public.post_search_documents
set search_text = 'stale quorlith',
    search_vector = to_tsvector('simple', 'stale quorlith')
where post_id = '0000c5ea-0000-4000-9000-000000000011'::uuid;

select public.refresh_post_search_documents(array(
  select id from public.posts where user_id = '0000c5ea-0000-4000-9000-000000000001'::uuid
));

select is(position('quorlith' in pg_temp.search_text('0000c5ea-0000-4000-9000-000000000011'::uuid)), 0,
  'a full refresh projects the post without its setup caption');
select ok(position('harbour lights at dusk' in pg_temp.search_text('0000c5ea-0000-4000-9000-000000000011'::uuid)) > 0,
  'and with its title');

-- ─── Grants ──────────────────────────────────────────────────────────────────

select ok(
  coalesce((
    select fn.prosecdef
      and not has_function_privilege('anon', fn.oid, 'EXECUTE')
      and not has_function_privilege('authenticated', fn.oid, 'EXECUTE')
    from pg_proc as fn
    where fn.oid = to_regprocedure('public.trg_refresh_post_search_document_for_recipe()')
  ), false),
  'the recipe trigger''s function runs as its owner and clients cannot call it'
);
select ok(
  not has_function_privilege('anon', 'public.refresh_post_search_documents(uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.refresh_post_search_documents(uuid[])', 'EXECUTE')
  and has_function_privilege('service_role', 'public.refresh_post_search_documents(uuid[])', 'EXECUTE'),
  'the projection stays callable by the service role only'
);

select * from finish();

rollback;
