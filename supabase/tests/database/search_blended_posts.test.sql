begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(64);

-- …01 creates most posts; …02 is the creator the viewer blocked; …03 is the
-- viewer; …04 blocked the viewer; …05 is a creator the viewer follows.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
select
  ('5eb00000-0000-4000-8000-00000000000' || account.suffix)::uuid,
  'search-blend-' || account.suffix || '@example.invalid',
  'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb
from (values ('1'), ('2'), ('3'), ('4'), ('5')) as account(suffix);

insert into public.user_blocks (blocker_user_id, blocked_user_id)
values
  ('5eb00000-0000-4000-8000-000000000003'::uuid, '5eb00000-0000-4000-8000-000000000002'::uuid),
  ('5eb00000-0000-4000-8000-000000000004'::uuid, '5eb00000-0000-4000-8000-000000000003'::uuid);

insert into public.follows (follower_id, following_id)
values ('5eb00000-0000-4000-8000-000000000003'::uuid, '5eb00000-0000-4000-8000-000000000005'::uuid);

create function pg_temp.viewer() returns uuid language sql immutable as $$
  select '5eb00000-0000-4000-8000-000000000003'::uuid;
$$;

create function pg_temp.post_id(p_suffix text) returns uuid language sql immutable as $$
  select ('5eb02000-0000-4000-8000-' || lpad(p_suffix, 12, '0'))::uuid;
$$;

create function pg_temp.add_post(
  p_suffix text, p_creator text, p_title text, p_body text, p_age interval,
  p_category text default 'image', p_tool text default 'Midjourney',
  p_visibility text default 'public', p_review text default 'visible',
  p_nsfw boolean default false, p_archived boolean default false
) returns void language sql as $$
  insert into public.posts (
    id, user_id, visibility, category, source_kind, post_format, review_status,
    title, body, source_tool, source_tool_slug, showcase_asset_path,
    is_nsfw, archived_at, created_at, updated_at
  ) values (
    pg_temp.post_id(p_suffix),
    ('5eb00000-0000-4000-8000-00000000000' || p_creator)::uuid,
    p_visibility, p_category, 'external', 'media', p_review,
    p_title, p_body, p_tool, lower(p_tool),
    case when p_nsfw then 'private-posts/' || pg_temp.post_id(p_suffix) || '/original.jpg'
         else 'showcase/search-blend-' || p_suffix || '.png' end,
    p_nsfw, case when p_archived then now() end, now() - p_age, now()
  );
$$;

-- A unit vector at cosine similarity p_similarity to the query's, pg_temp.vec(1).
create function pg_temp.vec(p_similarity double precision) returns extensions.vector
language sql immutable as $$
  select ('[' || p_similarity || ',' || sqrt(1 - p_similarity * p_similarity) || repeat(',0', 382) || ']')::extensions.vector;
$$;

-- Stores a post's vector as embed-post does: under the hash of the text it was just given.
create function pg_temp.embed(p_suffix text, p_similarity double precision) returns integer
language sql as $$
  select count(*)::integer
  from public.store_post_search_embeddings(
    (
      select jsonb_build_array(jsonb_build_object(
        'post_id', texts.post_id, 'content_hash', texts.content_hash, 'embedding', pg_temp.vec(p_similarity)::text
      ))
      from public.post_search_embedding_texts(array[pg_temp.post_id(p_suffix)], 'gte-small') as texts
    ),
    'gte-small'
  );
$$;

-- The word order: search_public_posts, as the blend reads it.
create function pg_temp.words(p_query text, p_viewer uuid default null) returns text[]
language sql as $$
  select coalesce(array_agg(right(post_id::text, 2) order by ordinality), '{}')
  from public.search_public_posts(p_query, p_viewer, null, null, 25, now(), 'top') with ordinality;
$$;

-- The blended order with the query's vector handed over: 'NN:how it matched'.
create function pg_temp.blend(
  p_query text,
  p_viewer uuid default null,
  p_made_with text default null,
  p_media_kind text default null,
  p_has_recipe boolean default false,
  p_followed_only boolean default false
) returns text[]
language sql as $$
  select coalesce(array_agg(right(post_id::text, 2) || ':' || matched_by order by blend_position), '{}')
  from public.search_blended_posts(
    p_query, null, pg_temp.vec(1), p_viewer, now(), 0, 25, p_made_with, p_media_kind, p_has_recipe, p_followed_only
  );
$$;

-- ─── The worked example ─────────────────────────────────────────────────────
--
-- The query 'amber lantern'. By words: …11 (its title is the query), …12 (its
-- title starts with it), …13 and …14 (their captions hold both words). By
-- meaning, nearest first: …13 0.95, …15 0.90, …12 0.83, …17 0.825; …16 at
-- 0.815 is under the floor. …11 has no vector at all.
select pg_temp.add_post('11', '1', 'Amber lantern', 'Hanging in the doorway', interval '40 days');
select pg_temp.add_post('12', '1', 'Amber lantern at the pier', 'Boards and rope', interval '2 hours');
select pg_temp.add_post('13', '1', 'Night walk', 'An amber lantern on every step', interval '3 hours', 'video');
select pg_temp.add_post('14', '1', 'Paper boats', 'A slow river in amber light, one lantern far away, and reeds on both banks', interval '30 days');
select pg_temp.add_post('15', '1', 'Glowing lamp at dusk', 'Warm orange light in the dark', interval '5 hours', 'video', 'Flux');
select pg_temp.add_post('16', '1', 'Harbor fog', 'A grey morning', interval '6 hours');
select pg_temp.add_post('17', '1', 'Candle in a jar', 'A small flame on the sill', interval '7 hours');

select is(pg_temp.embed('12', 0.83) + pg_temp.embed('13', 0.95) + pg_temp.embed('15', 0.90)
            + pg_temp.embed('16', 0.815) + pg_temp.embed('17', 0.825), 5, 'the fixture''s vectors are stored');

select is(pg_temp.words('amber lantern'), array['11', '12', '13', '14'], 'the word order of the example');

-- k = 50, word weight 1, meaning weight 0.9:
--   …11 its title is the query: first, whatever the lists say
--   …13 words 3rd, meaning 1st   1/53 + 0.9/51 = 0.036515
--   …12 words 2nd, meaning 3rd   1/52 + 0.9/53 = 0.036212
--   …14 words 4th                1/54          = 0.018519
--   …15 meaning 2nd              0.9/52        = 0.017308
--   …17 meaning 4th              0.9/54        = 0.016667
select is(
  pg_temp.blend('amber lantern'),
  array['11:words', '13:both', '12:both', '14:words', '15:meaning', '17:meaning'],
  'the lists are merged by reciprocal rank fusion, a post in both rising, a post under the floor left out'
);

select is(
  (select array_agg(right(floor_post_id::text, 2) order by blend_position)
   from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 25)),
  array['11', '13', '13', '14', '14', '14'],
  'each row names its floor: the furthest row of the word order shown up to it'
);

select ok(
  (select bool_and(blend_state = 'fused' and in_window and corrected_query is null)
   from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 25)),
  'a blended page says so, and every row of it is inside the window'
);

select ok(
  (select search_score is null from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 25)
   where post_id = pg_temp.post_id('15'))
  and (select search_score >= 30 from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 25)
       where post_id = pg_temp.post_id('11')),
  'a post only the meaning list holds has no word score; a word match keeps its own'
);

select is(
  (select array_agg(right(post_id::text, 2) order by blend_position)
   from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 2, 3)),
  array['12', '14', '15'],
  'a later page starts after the place it is given'
);

select is(
  pg_temp.blend('amber lantern'),
  pg_temp.blend('amber lantern'),
  'the same search read twice is the same list'
);

-- ─── The first place of a title match ───────────────────────────────────────

select ok(
  public.search_post_score(true, false, false, 0, 0, 0, 0, 0, 315360000, false) >= 30.0
    and public.search_post_score(false, true, true, 1, 1, 100000, 100000, 100000, 0, true) < 30.0,
  'a word score of 30 or more is a title that is the query, and nothing else reaches it'
);

-- A second post whose title is the query, nearer in meaning than any other:
-- the two keep the word order between them, ahead of everything.
select pg_temp.add_post('18', '5', 'Amber Lantern', 'A second one of the same name', interval '50 days');
select is(pg_temp.embed('18', 0.99), 1, 'the second title match has a vector');
select is(
  (pg_temp.blend('amber lantern'))[1:3],
  (select array[w[1] || ':words', w[2] || ':both', '13:both'] from (select pg_temp.words('amber lantern') as w) as listed),
  'posts whose title is the query stay first, in the word order, whichever is nearer in meaning'
);
delete from public.posts where id = pg_temp.post_id('18');

-- ─── Nothing a viewer cannot see is returned, or moves a rank ───────────────

select pg_temp.add_post('21', '1', 'Amber lantern study', 'A labelled picture', interval '1 hour', p_nsfw => true);
select pg_temp.add_post('22', '1', 'Amber lantern alone', 'Only for me', interval '1 hour', p_visibility => 'private');
select pg_temp.add_post('23', '2', 'Keeper of the flame', 'By the creator the viewer blocked', interval '1 hour');
select pg_temp.add_post('24', '4', 'Amber lantern row', 'By the creator who blocked the viewer', interval '1 hour');
select pg_temp.add_post('25', '1', 'Amber lantern taken down', 'Hidden by review', interval '1 hour', p_review => 'hidden');
select pg_temp.add_post('26', '1', 'Amber lantern put away', 'Archived', interval '1 hour', p_archived => true);

select is(pg_temp.embed('23', 0.97) + pg_temp.embed('24', 0.96), 2, 'the blocked pair''s posts have vectors');
select is(
  (select count(*)::integer from public.post_search_embedding_texts(array[pg_temp.post_id('21'), pg_temp.post_id('22')], 'gte-small')),
  0,
  'a labelled post and a private one are given no text to embed'
);

-- Vectors that should not exist, written past the functions: a labelled
-- post's under the hash of its own text, a private post's under any hash.
insert into public.post_search_embeddings (post_id, embedding_model, content_hash, embedding)
select
  documents.post_id, 'gte-small', encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex'), pg_temp.vec(0.98)
from public.post_search_documents as documents
where documents.post_id = pg_temp.post_id('21');
insert into public.post_search_embeddings (post_id, embedding_model, content_hash, embedding)
values (pg_temp.post_id('22'), 'gte-small', repeat('a', 64), pg_temp.vec(0.98));

select is(
  pg_temp.blend('amber lantern', pg_temp.viewer()),
  array['11:words', '13:both', '12:both', '14:words', '15:meaning', '17:meaning'],
  'a viewer''s list has neither side of a block, no labelled, private, hidden or archived post, and no rank moved by one'
);

select is(
  pg_temp.blend('amber lantern'),
  array['11:words', '24:both', '13:both', '12:both', '14:words', '23:meaning', '15:meaning', '17:meaning'],
  'a visitor sees the two creators'' posts, and still none that are labelled, private, hidden or archived'
);

select ok(
  not exists (
    select 1
    from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), '5eb00000-0000-4000-8000-000000000004'::uuid, now(), 0, 25)
    where creator_user_id = pg_temp.viewer()
  ),
  'the block holds the other way round too'
);

-- ─── A vector is read only while it is of the text the post shows ───────────

update public.posts set body = 'A cold blue light at noon' where id = pg_temp.post_id('15');
select is(
  pg_temp.blend('amber lantern', pg_temp.viewer()),
  -- …12 is now 2nd by meaning: 1/52 + 0.9/52 = 0.036538, ahead of …13's 0.036515.
  array['11:words', '12:both', '13:both', '14:words', '17:meaning'],
  'a post whose public text changed matches nothing by its old vector, and the ranks close over it'
);
select is(pg_temp.embed('15', 0.90), 1, 'the changed post is embedded again');
select is(
  pg_temp.blend('amber lantern', pg_temp.viewer()),
  array['11:words', '13:both', '12:both', '14:words', '15:meaning', '17:meaning'],
  'and is back with the vector of its new text'
);

select is(
  (select array_agg(right(post_id::text, 2) order by blend_position)
   from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), pg_temp.viewer(), now(), 0, 25, null, null, false, false, 'another-model')),
  array['11', '12', '13', '14'],
  'vectors of another model are not read: the list is the word order'
);

-- ─── Filters narrow both lists ──────────────────────────────────────────────

select is(
  pg_temp.blend('amber lantern', pg_temp.viewer(), p_media_kind => 'video'),
  array['13:both', '15:meaning'],
  'a media kind keeps the videos of both lists'
);
select is(
  pg_temp.blend('amber lantern', pg_temp.viewer(), p_made_with => 'tool:flux'),
  array['15:meaning'],
  'made-with keeps the posts made with it, of both lists'
);
select is(
  pg_temp.blend('amber lantern', pg_temp.viewer(), p_made_with => 'tool:midjourney'),
  array['11:words', '12:both', '13:both', '14:words', '17:meaning'],
  'and leaves out a meaning match made with something else'
);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
)
select
  ('5eb05000-0000-4000-8000-0000000000' || recipe.suffix)::uuid, pg_temp.post_id(recipe.suffix),
  '5eb00000-0000-4000-8000-000000000001'::uuid, 'free', 'published', 'Lamp recipe ' || recipe.suffix,
  'Three steps to the finished picture', 'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a reader unlocks for this picture')),
  '[]'::jsonb, 0, 0, 0, now(), now()
from (values ('12'), ('17')) as recipe(suffix);
-- A recipe changes what a post's public text is: the two are embedded again.
select is(pg_temp.embed('12', 0.83) + pg_temp.embed('17', 0.825), 2, 'the posts with a recipe are embedded from their text as it now reads');

select is(
  pg_temp.blend('amber lantern', pg_temp.viewer(), p_has_recipe => true),
  array['12:both', '17:meaning'],
  'the recipe filter keeps the posts with a published recipe, of both lists'
);

select pg_temp.add_post('31', '5', 'Soft glow shelf', 'By a creator the viewer follows', interval '2 hours');
select pg_temp.add_post('32', '5', 'Amber lantern shelf', 'By a creator the viewer follows', interval '2 hours');
select is(pg_temp.embed('31', 0.88), 1, 'the followed creator''s post has a vector');
select is(
  pg_temp.blend('amber lantern', pg_temp.viewer(), p_followed_only => true),
  array['32:words', '31:meaning'],
  'the following filter keeps the followed creators'' posts, of both lists'
);
select is(
  pg_temp.blend('amber lantern', null, p_followed_only => true),
  '{}'::text[],
  'and with no viewer nothing is followed'
);
delete from public.posts where id in (pg_temp.post_id('31'), pg_temp.post_id('32'));

-- ─── Without a vector the answer is today's order ───────────────────────────

select is(
  (select array_agg(right(post_id::text, 2) || ':' || blend_state || ':' || matched_by || ':' || in_window order by blend_position)
   from public.search_blended_posts('amber lantern', null, null, pg_temp.viewer(), now(), 0, 25)),
  (select array_agg(suffix || ':no_vector:words:false' order by ordinality)
   from unnest(pg_temp.words('amber lantern', pg_temp.viewer())) with ordinality as listed(suffix, ordinality)),
  'with no vector the rows are search_public_posts''s own, in its order, and say so'
);
select ok(
  (select bool_and(floor_post_id = post_id and floor_score = search_score)
   from public.search_blended_posts('amber lantern', null, null, pg_temp.viewer(), now(), 0, 25)),
  'each of them is its own floor: the word order continues from it'
);
select is(
  (select count(*)::integer from public.search_blended_posts('amber lantern', null, null, pg_temp.viewer(), now(), 3, 25)),
  0,
  'and a later page has nothing to give: its caller pages the word order from the floor'
);

-- The vector by its cache key.
select public.store_search_query_embedding(repeat('b', 64), 'gte-small', pg_temp.vec(1));
select is(
  (select array_agg(right(post_id::text, 2) || ':' || matched_by order by blend_position)
   from public.search_blended_posts('amber lantern', repeat('b', 64), null, pg_temp.viewer(), now(), 0, 25)),
  pg_temp.blend('amber lantern', pg_temp.viewer()),
  'a cached vector is read by its hash, and blends as the same vector handed over'
);
select is(
  (select max(blend_state) from public.search_blended_posts('amber lantern', repeat('c', 64), null, pg_temp.viewer(), now(), 0, 25)),
  'no_vector',
  'a hash the cache does not hold is no vector'
);
update public.search_query_embeddings set created_at = now() - interval '8 days' where query_hash = repeat('b', 64);
select is(
  (select max(blend_state) from public.search_blended_posts('amber lantern', repeat('b', 64), null, pg_temp.viewer(), now(), 0, 25)),
  'no_vector',
  'nor is a cached vector past its seven days'
);

-- ─── A query read corrected is not blended ──────────────────────────────────

select ok((select added > 0 from public.rebuild_search_terms()), 'the dictionary knows the fixture''s words');
select is(
  (select array_agg(right(post_id::text, 2) || ':' || blend_state || ':' || matched_by || ':' || corrected_query order by blend_position)
   from public.search_blended_posts('slow rivr', null, pg_temp.vec(1), pg_temp.viewer(), now(), 0, 25)),
  array['14:corrected:words:slow river'],
  'a misspelt query no post holds as typed is read corrected, in the word order, with no post added for a vector of other words'
);
select is(
  pg_temp.words('slow rivr', pg_temp.viewer()),
  array['14'],
  'which is the word order of the corrected words'
);
select is(
  (select count(*)::integer from public.search_blended_posts('slow rivr', null, pg_temp.vec(1), pg_temp.viewer(), now(), 1, 25)),
  0,
  'and has no later page here'
);

-- ─── A long list: the window, and the word order after it ───────────────────
--
-- 58 posts whose title starts with the query 'zephyr kite', newest first in
-- the word order, and 6 that hold none of its words and are near it in
-- meaning. Of the word matches, the 40th is nearest of all in meaning, and
-- the 55th, past the 50 the window reads, is near it too.
-- The example's vectors are put away: the long list is measured against its own.
delete from public.post_search_embeddings where post_id::text like '5eb02000-%';

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, source_tool, source_tool_slug, showcase_asset_path, is_nsfw, created_at, updated_at
)
select
  ('5eb03000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '5eb00000-0000-4000-8000-000000000001'::uuid, 'public', 'image', 'external', 'media', 'visible',
  case when n <= 58 then 'Zephyr kite ' || lpad(n::text, 2, '0') else 'Windy afternoon ' || n end,
  case when n <= 58 then 'On the hill' else 'String and sky' end,
  'Midjourney', 'midjourney', 'showcase/search-blend-kite-' || n || '.png', false,
  now() - (n || ' hours')::interval, now()
from generate_series(1, 64) as n;

create function pg_temp.kite(p_n integer) returns uuid language sql immutable as $$
  select ('5eb03000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid;
$$;

select is(
  (select count(*)::integer
   from public.store_post_search_embeddings(
     (select jsonb_agg(jsonb_build_object('post_id', texts.post_id, 'content_hash', texts.content_hash,
                                          'embedding', pg_temp.vec(kites.similarity)::text))
      from (values (40, 0.97), (55, 0.96), (59, 0.95), (60, 0.94), (61, 0.93), (62, 0.92), (63, 0.91), (64, 0.90))
        as kites(n, similarity)
      cross join lateral public.post_search_embedding_texts(array[pg_temp.kite(kites.n)], 'gte-small') as texts),
     'gte-small'
   )),
  8,
  'the long list''s vectors are stored'
);

-- The word order, all of it, as a caller pages it.
create function pg_temp.kite_words() returns integer[] language plpgsql as $$
declare
  v_order integer[] := '{}';
  v_score double precision;
  v_id uuid;
  v_row record;
  v_rows integer;
begin
  loop
    v_rows := 0;
    for v_row in
      select post_id, search_score
      from public.search_public_posts('zephyr kite', null, v_score, v_id, 25, now(), 'top')
    loop
      v_rows := v_rows + 1;
      v_order := v_order || right(v_row.post_id::text, 2)::integer;
      v_score := v_row.search_score;
      v_id := v_row.post_id;
    end loop;
    exit when v_rows < 25;
  end loop;
  return v_order;
end;
$$;

-- The blended list, all of it, paged as the service pages it: a page and one
-- row more are read; the cursor after a page is the last shown row's floor,
-- with its place while the row after it is still inside the window; without
-- a place the next page is search_public_posts from that floor.
create function pg_temp.kite_paged(p_page integer, p_with_vector boolean default true) returns integer[]
language plpgsql as $$
declare
  v_order integer[] := '{}';
  v_after integer := 0;
  v_in_window boolean := true;
  v_score double precision;
  v_id uuid;
  v_rows record;
begin
  for v_guard in 1..200 loop
    if v_in_window then
      select
        array_agg(right(page.post_id::text, 2)::integer order by page.blend_position) as suffixes,
        array_agg(page.blend_position order by page.blend_position) as places,
        array_agg(page.in_window order by page.blend_position) as inside,
        array_agg(page.floor_score order by page.blend_position) as floor_scores,
        array_agg(page.floor_post_id order by page.blend_position) as floor_ids
      into v_rows
      from public.search_blended_posts(
        'zephyr kite', null, case when p_with_vector or v_after = 0 then pg_temp.vec(1) end, null, now(), v_after, p_page + 1
      ) as page;
      if v_rows.suffixes is null then
        -- No vector for a later page: the word order, from the floor.
        v_in_window := false;
        continue;
      end if;
    else
      select
        array_agg(right(page.post_id::text, 2)::integer order by page.ordinality) as suffixes,
        null::integer[] as places,
        array_agg(false order by page.ordinality) as inside,
        array_agg(page.search_score order by page.ordinality) as floor_scores,
        array_agg(page.post_id order by page.ordinality) as floor_ids
      into v_rows
      from public.search_public_posts('zephyr kite', null, v_score, v_id, p_page + 1, now(), 'top')
        with ordinality as page;
      if v_rows.suffixes is null then
        return v_order;
      end if;
    end if;
    v_order := v_order || v_rows.suffixes[1:p_page];
    if cardinality(v_rows.suffixes) <= p_page then
      return v_order;
    end if;
    v_score := v_rows.floor_scores[p_page];
    v_id := v_rows.floor_ids[p_page];
    if v_in_window and v_rows.inside[p_page + 1] then
      v_after := v_rows.places[p_page];
    else
      v_in_window := false;
    end if;
  end loop;
  raise exception 'the list did not end';
end;
$$;

select is(
  pg_temp.kite_words(),
  (select array_agg(n order by n) from generate_series(1, 58) as n),
  'the long word order: 58 posts, newest first'
);

select is(
  (select array_agg(right(post_id::text, 2)::integer || ':' || matched_by order by blend_position)
   from public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 0, 8)),
  -- …40: words 40th, meaning 1st  1/90 + 0.9/51 = 0.028758, ahead of the 1st word row's 1/51 = 0.019608
  -- …59: meaning 2nd              0.9/52 = 0.017308, between the 7th word row (1/57) and the 8th (1/58)
  array['40:both', '1:words', '2:words', '3:words', '4:words', '5:words', '6:words', '7:words'],
  'a post in both lists rises; the first six word rows stay ahead of any post that is in the meaning list alone'
);
select is(
  (select right(post_id::text, 2)::integer || ':' || matched_by
   from public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 8, 1)),
  '59:meaning',
  'the nearest meaning-only post comes in after them'
);

select is(cardinality(pg_temp.kite_paged(24)), 64, 'paged to its end the list holds every post');
select is(
  (select count(distinct suffix)::integer from unnest(pg_temp.kite_paged(24)) as listed(suffix)),
  64,
  'each of them once'
);
select is(pg_temp.kite_paged(1), pg_temp.kite_paged(24), 'pages of one post give the same list');
select is(pg_temp.kite_paged(3), pg_temp.kite_paged(24), 'pages of three posts give the same list');

select is(
  (pg_temp.kite_paged(24))[57:64],
  array[51, 52, 53, 54, 55, 56, 57, 58],
  'past the window the list is the rest of the word order'
);
select ok(
  (select bool_and(listed.suffix between 1 and 50 or listed.suffix between 59 and 64)
   from unnest((pg_temp.kite_paged(24))[1:56]) as listed(suffix)),
  'the window is the first 50 word rows and the 6 meaning-only posts'
);
select is(
  (select matched_by || ':' || in_window
   from public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 56, 25)
   where post_id = pg_temp.kite(55)),
  'words:false',
  'a post near in meaning that holds the words past the window keeps its place in the word order, once, as a word match'
);
select is(
  (select array_agg(blend_position order by blend_position)
   from public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 54, 5)),
  array[55, 56, 57, 58, 59],
  'a page that reaches the window''s end is filled from the word order after it'
);

-- The vector gone after the first page (the cache emptied, the lookup
-- switched off): the list goes on in the word order from the floor.
select is(
  (select count(distinct suffix)::integer from unnest(pg_temp.kite_paged(3, false)) as listed(suffix)),
  cardinality(pg_temp.kite_paged(3, false)),
  'without the vector on later pages no post is repeated'
);
select ok(
  pg_temp.kite_paged(3, false) @> array[51, 52, 53, 54, 55, 56, 57, 58],
  'and the word order is read to its end'
);

-- From any row of the window, the word order after its floor holds nothing shown up to it.
select ok(
  not exists (
    select 1
    from public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 0, 25) as shown
    cross join lateral public.search_public_posts('zephyr kite', null, shown.floor_score, shown.floor_post_id, 25, now(), 'top') as later
    join public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 0, 25) as earlier
      on earlier.post_id = later.post_id and earlier.blend_position <= shown.blend_position
    where shown.floor_post_id is not null
  ),
  'from any row''s floor the word order holds no post shown up to that row'
);

-- A place past the window (it was longer when the cursor was issued).
select is(
  (select min(blend_position) from public.search_blended_posts('zephyr kite', null, pg_temp.vec(1), null, now(), 70, 5)),
  57,
  'a place past the window continues from the window''s end'
);

-- No word match at all: the meaning list alone, with no floor.
select is(
  (select array_agg(right(post_id::text, 2) || ':' || matched_by || ':' || coalesce(floor_post_id::text, 'none') order by blend_position)
   from public.search_blended_posts('quartz meridian', null, pg_temp.vec(1), pg_temp.viewer(), now(), 0, 3)),
  array['40:meaning:none', '55:meaning:none', '59:meaning:none'],
  'a query no post holds is answered by meaning alone, and its rows have no floor'
);

-- ─── What a call may ask ────────────────────────────────────────────────────

select throws_ok(
  $$select * from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 26)$$,
  'Blended post search limit must be between 1 and 25'
);
select throws_ok(
  $$select * from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 81, 5)$$,
  'Blended post search position must be between 0 and 80'
);
select throws_ok(
  $$select * from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), -1, 5)$$,
  'Blended post search position must be between 0 and 80'
);
select throws_ok(
  $$select * from public.search_blended_posts('amber lantern', null, '[1,0,0]'::extensions.vector, null, now(), 0, 5)$$,
  'Blended post search needs a query embedding of 384 dimensions'
);
select throws_ok(
  $$select * from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 5, 'kling')$$,
  'Post search made-with filter must be model:<key> or tool:<key>'
);
select throws_ok(
  $$select * from public.search_blended_posts('amber lantern', null, pg_temp.vec(1), null, now(), 0, 5, null, 'audio')$$,
  'Post search media kind must be image or video'
);
select is(
  (select count(*)::integer from public.search_blended_posts('am', null, pg_temp.vec(1), null, now(), 0, 5)),
  0,
  'a query under three characters finds nothing, by words or by meaning'
);

select ok(
  (select prosecdef and provolatile = 's' and proconfig = array['search_path=""']
   from pg_proc
   where oid = 'public.search_blended_posts(text, text, extensions.vector, uuid, timestamptz, integer, integer, text, text, boolean, boolean, text)'::regprocedure),
  'the function is a security definer with an empty search path, and writes nothing'
);
select ok(
  (select not has_function_privilege('anon', signature, 'EXECUTE')
     and not has_function_privilege('authenticated', signature, 'EXECUTE')
     and has_function_privilege('service_role', signature, 'EXECUTE')
   from (select 'public.search_blended_posts(text, text, extensions.vector, uuid, timestamptz, integer, integer, text, text, boolean, boolean, text)' as signature) as named),
  'only the service role may call it'
);

select * from finish();
rollback;
