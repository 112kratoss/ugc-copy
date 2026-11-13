-- Search starter after its first day live
-- (20261113152020_search_starter_own_app_and_best_query.sql):
--   - the app's own tool ('magicbooklet', 'emptybooklet', 'Magic Booklet') is
--     never a popular model or tool, while search itself still offers it to
--     someone who types its name;
--   - a row's query is, of its printed name and its key, the one whose search
--     opens more of its posts (the printed name on a tie), and its count is
--     exactly that search's, for a visitor and for a viewer with blocks.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

create function pg_temp.uid(p_suffix text)
returns uuid
language sql
as $$ select ('0000e5e2-0000-4000-9000-0000000000' || p_suffix)::uuid; $$;

create function pg_temp.entity_ids(p_viewer uuid default null)
returns text[]
language sql
as $$
  select coalesce(array_agg((entity ->> 'kind') || ':' || (entity ->> 'key') order by position), '{}')
  from jsonb_array_elements(public.search_starter(p_viewer, '{}', 10, 0, 0) -> 'entities')
    with ordinality as listed(entity, position);
$$;

create function pg_temp.row_of(p_key text, p_viewer uuid default null)
returns jsonb
language sql
as $$
  select entity - 'kind' - 'post_count_capped'
  from jsonb_array_elements(public.search_starter(p_viewer, '{}', 10, 0, 0) -> 'entities') as entity
  where entity ->> 'key' = p_key;
$$;

create function pg_temp.opened(p_query text, p_made_with text, p_viewer uuid default null)
returns integer
language sql
as $$
  select count(*)::integer
  from public.search_public_posts(
    p_query => p_query, p_viewer_user_id => p_viewer, p_limit => 25,
    p_made_with => p_made_with, p_correct => false
  );
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- Creators …01 to …04 and …06; …05 is the viewer, who blocked …06.
-- The app's own tool on posts of two creators each, under its three names:
--   magicbooklet (…01, …02), emptybooklet (…01, …02), "Magic Booklet" (…03, …04).
-- nanomodel-2: two posts with a Made with row naming it "Nanomodel 2.0" (…01,
--   …02), and four creations made with it and no such row (…03, …04, …01, …06),
--   which, like every creation, name the app as their tool.
-- "Sun Forge" (slug sun-forge) on posts of …03 and …04: its name and its key
--   open the same two posts.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
select pg_temp.uid(suffix), 'e5e2-' || suffix || '@example.invalid', 'authenticated', 'authenticated',
       '{}'::jsonb, '{}'::jsonb, now() - interval '90 days'
from unnest(array['01', '02', '03', '04', '05', '06']) as suffix;

update public.profiles
set username = 'e5e2-creator-' || right(id::text, 2), display_name = 'Creator ' || right(id::text, 2)
where id::text like '0000e5e2-%';

insert into public.user_blocks (blocker_user_id, blocked_user_id) values (pg_temp.uid('05'), pg_temp.uid('06'));

insert into public.generations (id, user_id, model, status, is_public)
select pg_temp.uid('a' || suffix), pg_temp.uid(owner), 'nanomodel-2', 'succeeded', true
from (values ('3', '03'), ('4', '04'), ('5', '01'), ('6', '06')) as made(suffix, owner);

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, generation_id, created_at, updated_at
)
select
  pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', post.kind, 'media', 'visible', false,
  'Plain title', 'a plain frame', 'showcase/e5e2-' || post.suffix || '.png', post.tool, post.slug,
  case when post.generation is not null then pg_temp.uid(post.generation) end,
  now() - make_interval(mins => post.age_minutes), now()
from (
  values
    -- suffix, owner, source kind, tool, slug, creation, minutes old
    ('11', '01', 'external', 'magicbooklet', 'magicbooklet', null, 10),
    ('12', '02', 'external', 'magicbooklet', 'magicbooklet', null, 11),
    ('13', '01', 'external', 'emptybooklet', 'emptybooklet', null, 12),
    ('14', '02', 'external', 'emptybooklet', 'emptybooklet', null, 13),
    ('15', '03', 'external', 'Magic Booklet', null, null, 14),
    ('16', '04', 'external', 'Magic Booklet', null, null, 15),
    ('21', '01', 'external', 'Studiotool', 'studiotool', null, 20),
    ('22', '02', 'external', 'Studiotool', 'studiotool', null, 21),
    ('23', '03', 'magicbooklet', 'magicbooklet', 'magicbooklet', 'a3', 22),
    ('24', '04', 'magicbooklet', 'magicbooklet', 'magicbooklet', 'a4', 23),
    ('25', '01', 'magicbooklet', 'magicbooklet', 'magicbooklet', 'a5', 24),
    ('26', '06', 'magicbooklet', 'magicbooklet', 'magicbooklet', 'a6', 25),
    ('31', '03', 'external', 'Sun Forge', 'sun-forge', null, 30),
    ('32', '04', 'external', 'Sun Forge', 'sun-forge', null, 31)
) as post(suffix, owner, kind, tool, slug, generation, age_minutes);

-- The Made with rows naming the model by the catalog's name, on …01's and …02's Studiotool posts.
insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug)
values
  (pg_temp.uid('21'), 'Studiotool', 'studiotool', 'Nanomodel 2.0', 'nanomodel-2'),
  (pg_temp.uid('22'), 'Studiotool', 'studiotool', 'Nanomodel 2.0', 'nanomodel-2');

-- ─── The app is not a tool to try ────────────────────────────────────────────

select ok(
  (select count(distinct creator_user_id) >= 2 from public.post_search_entities where kind = 'tool' and key = 'magicbooklet'),
  'fixture: two creators'' posts name the app as their tool'
);
select ok(not (pg_temp.entity_ids() && array['tool:magicbooklet', 'tool:emptybooklet', 'tool:magic-booklet']),
  'the starter never offers the app as a popular tool, under any of its names');
select ok(not (pg_temp.entity_ids(pg_temp.uid('05')) && array['tool:magicbooklet', 'tool:emptybooklet', 'tool:magic-booklet']),
  'nor to a signed-in viewer');
select ok(
  exists (select 1 from public.search_public_entities('magicbooklet', null, 10, null) where kind = 'tool' and key = 'magicbooklet'),
  'search itself still offers it to someone who types its name'
);
select is(pg_temp.entity_ids(), array['model:nanomodel-2', 'tool:studiotool', 'tool:sun-forge'],
  'the other models and tools are offered as before, the app taking no place among them');

-- ─── The query that opens more ───────────────────────────────────────────────

select is((select post_count from public.search_public_entities(null, null, 1, 'model:nanomodel-2')), 6,
  'fixture: six posts are made with nanomodel-2');
select is(pg_temp.opened('nanomodel 2.0', 'model:nanomodel-2'), 2,
  'its printed name, "Nanomodel 2.0", opens only the two posts with a Made with row: the creations do not hold "2.0"');
select is(pg_temp.opened('nanomodel-2', 'model:nanomodel-2'), 6,
  'its key opens all six');
select is(pg_temp.row_of('nanomodel-2'),
  '{"key": "nanomodel-2", "label": "Nanomodel 2.0", "post_count": 6, "query": "nanomodel-2"}'::jsonb,
  'so the row is searched by its key, drawn under its name, and counts six');
select is(pg_temp.row_of('nanomodel-2', pg_temp.uid('05')),
  '{"key": "nanomodel-2", "label": "Nanomodel 2.0", "post_count": 5, "query": "nanomodel-2"}'::jsonb,
  'the viewer''s leaves out the post of the creator they blocked');
select is(pg_temp.opened('nanomodel-2', 'model:nanomodel-2', pg_temp.uid('05')), 5,
  'which is what that search opens for them');
select is(pg_temp.row_of('sun-forge') ->> 'query', 'sun forge',
  'when the name and the key open the same posts, the name is sent');
select ok(
  (select bool_and((entity ->> 'post_count')::integer = pg_temp.opened(entity ->> 'query', (entity ->> 'kind') || ':' || (entity ->> 'key')))
   from jsonb_array_elements(public.search_starter(null, '{}', 10, 0, 0) -> 'entities') as entity),
  'for every row, a visitor''s count is what its search opens'
);
select ok(
  (select bool_and((entity ->> 'post_count')::integer = pg_temp.opened(entity ->> 'query', (entity ->> 'kind') || ':' || (entity ->> 'key'), pg_temp.uid('05')))
   from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 10, 0, 0) -> 'entities') as entity),
  'and the viewer''s'
);

select * from finish();
rollback;
