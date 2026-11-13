-- The search screen before anything is typed
-- (20261113100423_search_starter.sql): search_starter's three lists.
--
--   entities  models and tools with the most posts among the newest 2,000 a
--             search may show the viewer, used there by two creators, no
--             withdrawn word in the name, counted as a made-with filter
--             counts them; a template's hidden model is never one.
--   creators  accounts with a post in that window in the last 30 days, by
--             those posts (counted to 10), followers, newest post; never a
--             guest, a suspended or deleting account, either side of a
--             block, someone the viewer follows, or the viewer.
--   searches  the hand-picked terms, in order, each offered only while a post
--             search may show the viewer holds every word of it, and never
--             one holding a withdrawn word.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(80);

create function pg_temp.uid(p_suffix text)
returns uuid
language sql
as $$ select ('0000e5e1-0000-4000-9000-0000000000' || p_suffix)::uuid; $$;

create function pg_temp.entity_ids(p_viewer uuid default null, p_limit integer default 8)
returns text[]
language sql
as $$
  select coalesce(array_agg((entity ->> 'kind') || ':' || (entity ->> 'key') order by position), '{}')
  from jsonb_array_elements(public.search_starter(p_viewer, '{}', p_limit, 0, 0) -> 'entities')
    with ordinality as listed(entity, position);
$$;

create function pg_temp.handles(p_viewer uuid default null, p_limit integer default 10)
returns text[]
language sql
as $$
  select coalesce(array_agg(creator ->> 'username' order by position), '{}')
  from jsonb_array_elements(public.search_starter(p_viewer, '{}', 0, p_limit, 0) -> 'creators')
    with ordinality as listed(creator, position);
$$;

create function pg_temp.searches(p_terms text[], p_viewer uuid default null, p_limit integer default 8)
returns text[]
language sql
as $$
  select coalesce(array_agg(search ->> 'text' order by position), '{}')
  from jsonb_array_elements(public.search_starter(p_viewer, p_terms, 0, 0, p_limit) -> 'searches')
    with ordinality as listed(search, position);
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- People:
--   …01 ada-quill   …02 bea-quill   …03 cyd-quill   …04 dov-quill   posters
--   …05 vera-viewer, the viewer: follows …0e, blocked …06, blocked by …07
--   …06 blocked-one …07 blocker-one                                  posters
--   …08 guest-poster, a guest   …09 banned-poster, suspended
--   …0a deleting-poster, being deleted                                posters
--   …0b old-poster: one post 40 days old
--   …0c labelled-poster: labelled posts only
--   …0d heavy-poster: twelve posts, counted as ten (ada has eleven, also ten)
--   …0e past-ban: a suspension that has ended                        poster
-- Followers: …01 has three (…02, …04, …0b), …04 one (…02), …0e one (…05).
--
-- Tools (posts.source_tool):
--   Alphatool    …01 ×2, …02 ×1                three posts, two creators
--   Epsilontool  …01, …02, …03, …04             four posts, four creators
--   Betatool     …01 ×5                         one creator
--   Gammatool    …01, and …02's labelled post   one creator a visitor can see
--   Deltatool    …01, …02, withdrawn by its name
--   Blocktool    …06, …07                       two creators, both blocked with the viewer
--   Blockertool  …07 (who blocked the viewer), …01, 40 days ago
--   Zq           …03, …04, 40 days ago: a name of two characters, which search cannot search
--   Lumen 2.6    …03, …04, 40 days ago, in the posts' own Made with field only
--   nimbus       "Nimbus Forge" on posts of …03 and …04, and the same slug under
--                another name, "Cirrus Stratus Cumulus", on a post of …01: three
--                posts the made-with filter counts, two the search for its name finds
-- Models: qwen3, the creation model of posts of …01 and …02, 40 days ago, with
-- no Made with row; the catalog names it "Qwen Image 3.0", words its posts'
-- documents do not hold.
-- A template result's hidden model, zorblax-v2, on posts of …01 and …02.
-- Words: quillonword (…01), glassword (…01, with quillonword), labelword
-- (…0c's labelled post only), blockword (…06 only), blockerword (…07 only),
-- privword (a private post),
-- deniedword (…01; withdrawn), hiddenword (a hidden post).

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, is_anonymous, banned_until)
select pg_temp.uid(people.suffix), 'e5e1-' || people.suffix || '@example.invalid', 'authenticated', 'authenticated',
       '{}'::jsonb, '{}'::jsonb, now() - interval '90 days', people.is_guest, people.banned_until
from (
  values
    ('01', false, null::timestamptz), ('02', false, null), ('03', false, null), ('04', false, null),
    ('05', false, null), ('06', false, null), ('07', false, null),
    ('08', true, null),
    ('09', false, now() + interval '30 days'),
    ('0a', false, null), ('0b', false, null), ('0c', false, null), ('0d', false, null),
    ('0e', false, now() - interval '1 day')
) as people(suffix, is_guest, banned_until);

update public.profiles as profiles
set username = named.username, display_name = named.display_name
from (
  values
    ('01', 'ada-quill', 'Ada Quill'), ('02', 'bea-quill', 'Bea Quill'), ('03', 'cyd-quill', 'Cyd Quill'),
    ('04', 'dov-quill', 'Dov Quill'), ('05', 'vera-viewer', 'Vera Viewer'), ('06', 'blocked-one', 'Blocked One'),
    ('07', 'blocker-one', 'Blocker One'), ('08', 'guest-poster', 'Guest Poster'), ('09', 'banned-poster', 'Banned Poster'),
    ('0a', 'deleting-poster', 'Deleting Poster'), ('0b', 'old-poster', 'Old Poster'),
    ('0c', 'labelled-poster', 'Labelled Poster'), ('0d', 'heavy-poster', 'Heavy Poster'),
    ('0e', 'past-ban', 'Past Ban')
) as named(suffix, username, display_name)
where profiles.id = pg_temp.uid(named.suffix);

insert into public.follows (follower_id, following_id) values
  (pg_temp.uid('05'), pg_temp.uid('0e')),
  (pg_temp.uid('02'), pg_temp.uid('01')),
  (pg_temp.uid('04'), pg_temp.uid('01')),
  (pg_temp.uid('0b'), pg_temp.uid('01')),
  (pg_temp.uid('02'), pg_temp.uid('04'));
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
  (pg_temp.uid('05'), pg_temp.uid('06')),
  (pg_temp.uid('07'), pg_temp.uid('05'));

-- The template whose result hides its model.
insert into public.templates (id, name, creator_user_id, status, is_active)
values (pg_temp.uid('e0'), 'Starter fixture', pg_temp.uid('04'), 'draft', true);
insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
) values
  (pg_temp.uid('e1'), pg_temp.uid('e0'), pg_temp.uid('01'), '{"version":1,"nodes":[],"edges":[]}'::jsonb,
   repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'output', 'image', 'collecting_inputs', 10, 10),
  (pg_temp.uid('e2'), pg_temp.uid('e0'), pg_temp.uid('02'), '{"version":1,"nodes":[],"edges":[]}'::jsonb,
   repeat('b', 64), '[]'::jsonb, '{}'::jsonb, 'output', 'image', 'collecting_inputs', 10, 10);
insert into public.generations (id, user_id, model, status, is_public, template_run_id) values
  (pg_temp.uid('e3'), pg_temp.uid('01'), 'zorblax-v2', 'succeeded', true, pg_temp.uid('e1')),
  (pg_temp.uid('e4'), pg_temp.uid('02'), 'zorblax-v2', 'succeeded', true, pg_temp.uid('e2')),
  (pg_temp.uid('e5'), pg_temp.uid('01'), 'qwen3', 'succeeded', true, null),
  (pg_temp.uid('e6'), pg_temp.uid('02'), 'qwen3', 'succeeded', true, null);

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw, archived_at,
  title, body, showcase_asset_path, source_tool, source_tool_slug, generation_id, created_at, updated_at
)
select
  pg_temp.uid(post.suffix), pg_temp.uid(post.owner), post.visibility, 'image',
  case when post.generation is null then 'external' else 'magicbooklet' end, 'media',
  post.review_status, post.is_nsfw, null,
  'Plain title', post.body, 'showcase/e5e1-' || post.suffix || '.png',
  post.tool, lower(post.tool),
  case when post.generation is not null then pg_temp.uid(post.generation) end,
  now() - make_interval(mins => post.age_minutes), now()
from (
  values
    -- suffix, owner, visibility, review, labelled, tool, body, minutes old, creation
    ('11', '01', 'public', 'visible', false, 'Alphatool', 'a quillonword glassword frame', 10, null),
    ('12', '01', 'public', 'visible', false, 'Alphatool', 'a plain frame', 11, null),
    ('13', '02', 'public', 'visible', false, 'Alphatool', 'a plain frame', 12, null),
    ('14', '01', 'public', 'visible', false, 'Epsilontool', 'a plain frame', 20, null),
    ('15', '02', 'public', 'visible', false, 'Epsilontool', 'a plain frame', 21, null),
    ('16', '03', 'public', 'visible', false, 'Epsilontool', 'a plain frame', 22, null),
    ('17', '04', 'public', 'visible', false, 'Epsilontool', 'a plain frame', 23, null),
    ('18', '01', 'public', 'visible', false, 'Betatool', 'a plain frame', 30, null),
    ('19', '01', 'public', 'visible', false, 'Betatool', 'a plain frame', 31, null),
    ('1a', '01', 'public', 'visible', false, 'Betatool', 'a plain frame', 32, null),
    ('1b', '01', 'public', 'visible', false, 'Betatool', 'a plain frame', 33, null),
    ('1c', '01', 'public', 'visible', false, 'Betatool', 'a plain frame', 34, null),
    ('1d', '01', 'public', 'visible', false, 'Gammatool', 'a plain frame', 40, null),
    ('1e', '02', 'public', 'visible', true, 'Gammatool', 'a plain frame', 41, null),
    ('1f', '01', 'public', 'visible', false, 'Deltatool', 'a deniedword frame', 50, null),
    ('20', '02', 'public', 'visible', false, 'Deltatool', 'a plain frame', 51, null),
    ('21', '06', 'public', 'visible', false, 'Blocktool', 'a blockword frame', 60, null),
    ('22', '07', 'public', 'visible', false, 'Blocktool', 'a plain frame', 61, null),
    ('23', '01', 'public', 'visible', false, null, 'a template result', 70, 'e3'),
    ('24', '02', 'public', 'visible', false, null, 'a template result', 71, 'e4'),
    ('25', '08', 'public', 'visible', false, null, 'a guest frame', 80, null),
    ('26', '09', 'public', 'visible', false, null, 'a suspended frame', 81, null),
    ('27', '0a', 'public', 'visible', false, null, 'a deleting frame', 82, null),
    ('28', '0b', 'public', 'visible', false, null, 'an old frame', 40 * 24 * 60, null),
    ('29', '0c', 'public', 'visible', true, null, 'a labelword frame', 90, null),
    ('2a', '01', 'private', 'visible', false, null, 'a privword frame', 91, null),
    ('2b', '01', 'public', 'hidden', false, null, 'a hiddenword frame', 92, null),
    ('2c', '0e', 'public', 'visible', false, null, 'a past ban frame', 93, null),
    ('2d', '07', 'public', 'visible', false, 'Blockertool', 'a blockerword frame', 40 * 24 * 60, null),
    ('2e', '01', 'public', 'visible', false, 'Blockertool', 'a plain frame', 40 * 24 * 60 + 1, null),
    ('2f', '01', 'public', 'visible', false, null, 'a plain frame', 40 * 24 * 60 + 2, 'e5'),
    ('5a', '02', 'public', 'visible', false, null, 'a plain frame', 40 * 24 * 60 + 3, 'e6'),
    ('5b', '03', 'public', 'visible', false, 'Zq', 'a plain frame', 40 * 24 * 60 + 4, null),
    ('5c', '04', 'public', 'visible', false, 'Zq', 'a plain frame', 40 * 24 * 60 + 5, null),
    ('5d', '03', 'public', 'visible', false, 'Lumen 2.6', 'a plain frame', 40 * 24 * 60 + 6, null),
    ('5e', '04', 'public', 'visible', false, 'Lumen 2.6', 'a plain frame', 40 * 24 * 60 + 7, null)
) as post(suffix, owner, visibility, review_status, is_nsfw, tool, body, age_minutes, generation);

-- …0d posts twelve times, an hour ago and before.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, created_at, updated_at
)
select
  pg_temp.uid('3' || to_hex(n)), pg_temp.uid('0d'), 'public', 'image', 'manual', 'media', 'visible', false,
  'Plain title', 'a heavy frame', 'showcase/e5e1-3' || to_hex(n) || '.png',
  now() - make_interval(mins => 100 + n), now()
from generate_series(0, 11) as n;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', 'external', 'media', 'visible', false,
       'Plain title', 'a plain frame', 'showcase/e5e1-' || post.suffix || '.png', post.tool, 'nimbus',
       now() - make_interval(mins => post.age_minutes), now()
from (
  values
    ('5f', '03', 'Nimbus Forge', 40 * 24 * 60 + 8),
    ('6a', '04', 'Nimbus Forge', 40 * 24 * 60 + 9),
    ('6b', '01', 'Cirrus Stratus Cumulus', 40 * 24 * 60 + 10)
) as post(suffix, owner, tool, age_minutes);

update public.profiles set identity_state = 'deleting' where id = pg_temp.uid('0a');

insert into public.search_suggestion_denylist (term, note) values ('deltatool', 'pgTAP: withdrawn tool'), ('deniedword', 'pgTAP: withdrawn word');

-- ─── The function ────────────────────────────────────────────────────────────

select ok(
  (select prosecdef from pg_proc where oid = 'public.search_starter(uuid, text[], integer, integer, integer)'::regprocedure),
  'search_starter runs as its owner'
);
select is(
  (select proconfig from pg_proc where oid = 'public.search_starter(uuid, text[], integer, integer, integer)'::regprocedure),
  array['search_path=""'],
  'with an empty search_path'
);
select ok(
  not has_function_privilege('anon', 'public.search_starter(uuid, text[], integer, integer, integer)', 'execute')
  and not has_function_privilege('authenticated', 'public.search_starter(uuid, text[], integer, integer, integer)', 'execute')
  and has_function_privilege('service_role', 'public.search_starter(uuid, text[], integer, integer, integer)', 'execute'),
  'and only the service role may call it'
);
select ok(
  (select prosecdef from pg_proc where oid = 'public.search_starter_term_finds_post(text, uuid)'::regprocedure),
  'the term check runs as its owner'
);
select is(
  (select proconfig from pg_proc where oid = 'public.search_starter_term_finds_post(text, uuid)'::regprocedure),
  array['search_path=""', 'enable_seqscan=off', 'enable_indexscan=off'],
  'with an empty search_path and steered to the word index'
);
select ok(
  not has_function_privilege('anon', 'public.search_starter_term_finds_post(text, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.search_starter_term_finds_post(text, uuid)', 'execute')
  and has_function_privilege('service_role', 'public.search_starter_term_finds_post(text, uuid)', 'execute'),
  'and only the service role may call it'
);
select is(
  (select array_agg(key order by key) from jsonb_object_keys(public.search_starter()) as key),
  array['creators', 'entities', 'searches'],
  'the answer holds the three lists'
);
select is(
  public.search_starter(null, array['quillonword'], 0, 0, 0),
  '{"entities": [], "creators": [], "searches": []}'::jsonb,
  'a list asked for none of is empty, and nothing else is read for it'
);

-- ─── Entities ────────────────────────────────────────────────────────────────

select is(pg_temp.entity_ids(), array['tool:epsilontool', 'tool:alphatool', 'tool:nimbus', 'model:qwen3', 'tool:blockertool', 'tool:blocktool', 'tool:lumen-2.6'],
  'a visitor is offered the models and tools two creators use, most posts first');
select is(
  public.search_starter(null, '{}', 8, 0, 0) -> 'entities' -> 0,
  (select jsonb_build_object('kind', kind, 'key', key, 'label', label, 'post_count', post_count,
                             'post_count_capped', post_count_capped, 'query', 'epsilontool')
   from public.search_public_entities('epsilontool', null, 10, null) where key = 'epsilontool'),
  'each with the search pressing it runs (the name its posts print, lowercased), counted as search counts an offer for that query'
);
select ok(
  (select bool_and(
     (entity ->> 'post_count')::integer = (
       select count(*)::integer
       from public.search_public_posts(
         p_query => entity ->> 'query', p_viewer_user_id => null, p_limit => 25,
         p_made_with => (entity ->> 'kind') || ':' || (entity ->> 'key'), p_correct => false
       )
     ))
   from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity),
  'for every row, the count is the posts search returns for its query narrowed to it, read as typed'
);

-- The PR #785 review's case: a model whose catalog name holds words its posts do not.
select is((select post_count from public.search_public_entities(null, null, 1, 'model:qwen3')), 2,
  'fixture: two posts are made with qwen3');
select ok(not exists (
    select 1 from public.search_public_entities('qwen image 3.0', null, 10, null) where key = 'qwen3'
  ),
  'and searching the catalog''s name for it, "Qwen Image 3.0", finds neither: a row that searched its name would open nothing');
select is(
  (select entity from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity ->> 'key' = 'qwen3'),
  '{"kind": "model", "key": "qwen3", "label": "qwen3", "post_count": 2, "post_count_capped": false, "query": "qwen3"}'::jsonb,
  'the starter sends the name its posts print, which both hold'
);
select is(
  (select count(*)::integer from public.search_public_posts(
     p_query => 'qwen3', p_viewer_user_id => null, p_limit => 25, p_made_with => 'model:qwen3', p_correct => false)),
  2,
  'and that search, narrowed to it, opens both'
);
select is(
  (select entity ->> 'query' from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity ->> 'key' = 'lumen-2.6'),
  'lumen 2.6',
  'a tool its posts name only in their own Made with field is searched as they write it'
);
select is(
  (select count(*)::integer from public.search_public_posts(
     p_query => 'lumen 2.6', p_viewer_user_id => null, p_limit => 25, p_made_with => 'tool:lumen-2.6', p_correct => false)),
  2,
  'and that search opens both its posts'
);
select is((select post_count from public.search_public_entities(null, null, 1, 'tool:nimbus')), 3,
  'fixture: the made-with filter counts three posts with the nimbus slug');
select is(
  (select entity - 'kind' - 'post_count_capped' from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity ->> 'key' = 'nimbus'),
  '{"key": "nimbus", "label": "Nimbus Forge", "post_count": 2, "query": "nimbus forge"}'::jsonb,
  'the row says two: the search it runs, for the name most of them print, finds two, not the three the filter holds'
);
select is(
  (select count(*)::integer from public.search_public_posts(
     p_query => 'nimbus forge', p_viewer_user_id => null, p_limit => 25, p_made_with => 'tool:nimbus', p_correct => false)),
  2,
  'and pressing it opens those two'
);
select is(
  (select (entity ->> 'post_count')::integer from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity ->> 'key' = 'epsilontool'),
  4,
  'a count stops at 200, so a small one is exact'
);
select ok(not (pg_temp.entity_ids() @> array['tool:zq']),
  'an entity whose search would find nothing (a two-character key, which search does not search) is not offered');
select ok(not (pg_temp.entity_ids(pg_temp.uid('05')) @> array['tool:blockertool']),
  'the viewer is not offered a tool whose second creator blocked them');
select is((public.search_starter(null, '{}', 8, 0, 0) -> 'entities' -> 0 ->> 'post_count')::integer, 4,
  'four posts made with Epsilontool');
select is(public.search_starter(null, '{}', 8, 0, 0) -> 'entities' -> 0 ->> 'label', 'Epsilontool',
  'under the name its posts print');
select is((public.search_starter(null, '{}', 8, 0, 0) -> 'entities' -> 1 ->> 'post_count')::integer, 3,
  'three made with Alphatool');
select ok(not (pg_temp.entity_ids() @> array['tool:betatool']),
  'a tool one creator alone uses is not offered, however many posts it has');
select ok(not (pg_temp.entity_ids() @> array['tool:gammatool']),
  'a labelled post is nobody''s second creator');
select ok(not (pg_temp.entity_ids() @> array['tool:deltatool']),
  'a tool whose name is withdrawn is not offered');
select ok(not exists (
    select 1 from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
    where entity ->> 'kind' = 'model' and entity ->> 'key' like 'zorblax%'
  ),
  'a template result''s hidden model is not offered, though two creators'' results have it');
select is(pg_temp.entity_ids(pg_temp.uid('05')), array['tool:epsilontool', 'tool:alphatool', 'tool:nimbus', 'model:qwen3', 'tool:lumen-2.6'],
  'the viewer is not offered a tool only creators on either side of a block with them use');
select is(pg_temp.entity_ids(null, 1), array['tool:epsilontool'], 'the limit cuts the list');

-- A count passes another: the order follows the count pressing opens.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select pg_temp.uid('4' || to_hex(n)), pg_temp.uid('02'), 'public', 'image', 'external', 'media', 'visible', false,
       'Plain title', 'a plain frame', 'showcase/e5e1-4' || to_hex(n) || '.png', 'Alphatool', 'alphatool',
       now() - make_interval(mins => 300 + n), now()
from generate_series(0, 1) as n;
select is(pg_temp.entity_ids(), array['tool:alphatool', 'tool:epsilontool', 'tool:nimbus', 'model:qwen3', 'tool:blockertool', 'tool:blocktool', 'tool:lumen-2.6'],
  'two more Alphatool posts put it first, at once: nothing is rebuilt');
delete from public.posts where id in (pg_temp.uid('40'), pg_temp.uid('41'));
select is(pg_temp.entity_ids(), array['tool:epsilontool', 'tool:alphatool', 'tool:nimbus', 'model:qwen3', 'tool:blockertool', 'tool:blocktool', 'tool:lumen-2.6'],
  'and deleting them puts it back');

-- A second creator for Betatool, then that post labelled: it counts only while a visitor can see it.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values (pg_temp.uid('50'), pg_temp.uid('03'), 'public', 'image', 'external', 'media', 'visible', false,
          'Plain title', 'a plain frame', 'showcase/e5e1-50.png', 'Betatool', 'betatool', now() - interval '5 minutes', now());
select is(pg_temp.entity_ids(), array['tool:betatool', 'tool:epsilontool', 'tool:alphatool', 'tool:nimbus', 'model:qwen3', 'tool:blockertool', 'tool:blocktool', 'tool:lumen-2.6'],
  'a second creator''s post offers Betatool, with its six posts first');
update public.posts set visibility = 'private' where id = pg_temp.uid('50');
select ok(not (pg_temp.entity_ids() @> array['tool:betatool']),
  'made private, that post no longer counts');
update public.posts set visibility = 'public', review_status = 'hidden' where id = pg_temp.uid('50');
select ok(not (pg_temp.entity_ids() @> array['tool:betatool']), 'nor hidden');
update public.posts set review_status = 'visible', archived_at = now() where id = pg_temp.uid('50');
select ok(not (pg_temp.entity_ids() @> array['tool:betatool']), 'nor archived');
delete from public.posts where id = pg_temp.uid('50');

-- ─── Creators ────────────────────────────────────────────────────────────────

select is(
  pg_temp.handles(),
  array['ada-quill', 'heavy-poster', 'bea-quill', 'dov-quill', 'past-ban', 'cyd-quill', 'blocked-one', 'blocker-one'],
  'a visitor is offered recent posters by their posts (to ten), then followers, then the newest post'
);
select ok(not (pg_temp.handles() @> array['guest-poster']), 'never a guest');
select ok(not (pg_temp.handles() @> array['banned-poster']), 'never a suspended account');
select ok(pg_temp.handles() @> array['past-ban'], 'but one whose suspension has ended');
select ok(not (pg_temp.handles() @> array['deleting-poster']), 'never an account being deleted');
select ok(not (pg_temp.handles() @> array['old-poster']), 'never one whose newest post is older than thirty days');
select ok(not (pg_temp.handles() @> array['labelled-poster']), 'never one with only labelled posts');
select ok(not (pg_temp.handles() @> array['vera-viewer']), 'never one with no post');
select is(
  pg_temp.handles(pg_temp.uid('05')),
  array['ada-quill', 'heavy-poster', 'bea-quill', 'dov-quill', 'cyd-quill'],
  'the viewer is not offered either side of a block, nor someone they follow'
);
select ok(not (pg_temp.handles(pg_temp.uid('01')) @> array['ada-quill']), 'nor themself');
select is(pg_temp.handles(null, 2), array['ada-quill', 'heavy-poster'], 'the limit cuts the list');
select is(
  public.search_starter(null, '{}', 0, 1, 0) -> 'creators' -> 0,
  (select jsonb_build_object(
     'id', documents.creator_user_id, 'username', documents.username, 'display_name', documents.display_name,
     'bio', documents.bio, 'avatar_url', documents.avatar_url, 'public_post_count', documents.public_post_count,
     'is_following', false)
   from public.creator_search_documents as documents where documents.creator_user_id = pg_temp.uid('01')),
  'a creator in the shape a creator search result has, from their search document'
);
select is((public.search_starter(null, '{}', 0, 1, 0) -> 'creators' -> 0 ->> 'public_post_count')::integer, 14,
  'whose post count is all their public posts, not the ten the order counts');

-- ada (eleven recent posts of fourteen, three followers) and heavy (twelve, none) both count ten.
select ok(array_position(pg_temp.handles(), 'ada-quill') < array_position(pg_temp.handles(), 'heavy-poster'),
  'posts count to ten: past that, followers decide');
select ok(array_position(pg_temp.handles(), 'heavy-poster') < array_position(pg_temp.handles(), 'bea-quill'),
  'more recent posts first');
-- dov and cyd have one recent post each; dov has a follower, cyd none, and cyd posted later.
select ok(array_position(pg_temp.handles(), 'dov-quill') < array_position(pg_temp.handles(), 'cyd-quill'),
  'between equals, followers before a newer post');
-- blocked-one and blocker-one: one post each, no followers; blocked-one posted a minute later.
select ok(array_position(pg_temp.handles(), 'blocked-one') < array_position(pg_temp.handles(), 'blocker-one'),
  'between equals with no followers, the newer post first');

-- ─── Searches ────────────────────────────────────────────────────────────────

select is(pg_temp.searches(array['quillonword']), array['quillonword'], 'a term a post holds is offered');
select is(pg_temp.searches(array['zzqmissing']), '{}'::text[], 'a term no post holds is not');
select is(pg_temp.searches(array['Quillonword  Glassword']), array['Quillonword Glassword'],
  'a term of two words one post holds is offered as listed, one space between words');
select is(pg_temp.searches(array['quillonword zzqmissing']), '{}'::text[], 'not when no post holds both words');
select is(pg_temp.searches(array['labelword']), '{}'::text[], 'nor a word only a labelled post holds');
select is(pg_temp.searches(array['privword']), '{}'::text[], 'nor one only a private post holds');
select is(pg_temp.searches(array['hiddenword']), '{}'::text[], 'nor one only a hidden post holds');
select is(pg_temp.searches(array['deniedword']), '{}'::text[], 'nor a withdrawn word, though a visible post holds it');
select is(pg_temp.searches(array['quillonword deniedword']), '{}'::text[], 'nor a term holding one');
select is(pg_temp.searches(array['blockword']), array['blockword'], 'a visitor is offered a word only one creator''s post holds');
select is(pg_temp.searches(array['blockword'], pg_temp.uid('05')), '{}'::text[],
  'the viewer is not, when they blocked that creator');
select is(pg_temp.searches(array['blockerword']), array['blockerword'], 'fixture: a visitor is offered a word only …07''s post holds');
select is(pg_temp.searches(array['blockerword'], pg_temp.uid('05')), '{}'::text[],
  'the viewer is not, when that creator blocked them');
select is(pg_temp.searches(array['ab', '  ', null, 'quillonword']), array['quillonword'],
  'a term under three characters, or of nothing, is passed over');
select is(pg_temp.searches(array['quillonword', 'QUILLONWORD', ' quillonword ']), array['quillonword'],
  'a term listed twice, in any case or spacing, is offered once');
select is(pg_temp.searches(array['glassword', 'zzqmissing', 'quillonword']), array['glassword', 'quillonword'],
  'in the order listed');
select is(pg_temp.searches(array['glassword', 'quillonword', 'frame'], null, 2), array['glassword', 'quillonword'],
  'the limit cuts the list');
select is(pg_temp.searches(array['%%%', '\_', 'a & b | !c']), '{}'::text[], 'punctuation finds nothing and breaks nothing');
select is(
  pg_temp.searches((select array_agg('zz' || n) from generate_series(1, 20) as n) || array['quillonword']),
  '{}'::text[],
  'at most twenty terms are read'
);
select ok(public.search_starter_term_finds_post('quillonword glassword', null), 'the check: every word in one post');
select ok(not public.search_starter_term_finds_post('quillonwor', null), 'whole words only, never a prefix');
select ok(not public.search_starter_term_finds_post('', null), 'nothing finds nothing');

-- ─── The window ──────────────────────────────────────────────────────────────

-- 2,000 newer posts by ada: everyone else's posts leave the window.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, created_at, updated_at
)
select
  ('0000e5e1-0000-4000-9000-1' || lpad(n::text, 11, '0'))::uuid, pg_temp.uid('01'), 'public', 'image', 'manual', 'media',
  'visible', false, 'Plain title', 'a window frame', 'showcase/e5e1-w' || n || '.png',
  now() - make_interval(secs => n / 1000.0), now()
from generate_series(1, 2000) as n;
select is(pg_temp.handles(), array['ada-quill'], 'creators are read from the newest 2,000 posts only');
select is(pg_temp.entity_ids(), '{}'::text[], 'and so are models and tools');
select is(pg_temp.searches(array['quillonword']), array['quillonword'], 'a search is offered for any post a search finds');

select * from finish();
rollback;
