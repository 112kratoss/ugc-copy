-- Search ranking (20261112103547): the match tier decides first and nothing
-- inside a tier crosses it; engagement decays with a post's age; freshness and
-- a follow lift within a tier; pages are scored at one instant; Latest orders
-- the same matches newest first; both sides of a block are left out before
-- the page is cut; creators rank handle, then name, then audience; and the
-- call the app live during the release makes still works.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- …01 is the viewer. …02 and …03 create posts; the viewer follows …03.
-- The viewer has blocked …04, and …05 has blocked the viewer.
-- …11 to …17 are the creators creator search ranks; …21 to …23 follow …12,
-- and the viewer follows …17. …18's display name is written with a
-- full-width letter and three spaces; …19's starts with the same words, and
-- …21 and …22 follow …19.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
select
  ('5c000000-0000-4000-8000-0000000000' || suffix)::uuid,
  'search-ranking-' || suffix || '@example.invalid',
  'authenticated', 'authenticated', now() - interval '200 days', '{}'::jsonb, '{}'::jsonb
from unnest(array['01', '02', '03', '04', '05', '11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '23']) as suffix;

update public.profiles as profiles
set username = named.username, display_name = named.display_name, bio = named.bio
from (values
  ('01', 'quillon-viewer', 'Quillon Viewer', null),
  ('02', 'zelkova-maker', 'Zelkova Maker', null),
  ('03', 'zelkova-followed', 'Zelkova Followed', null),
  ('04', 'zelkova-blocked', 'Zelkova Blocked', null),
  ('05', 'zelkova-blocker', 'Zelkova Blocker', null),
  ('11', 'solenne', 'Plain Handle', null),
  ('12', 'solenne-studio', 'Studio Account', null),
  ('13', 'marek-ives', 'Solenne', null),
  ('14', 'atelier-nine', 'Solenne Dupont', null),
  ('15', 'brightfield', 'Brightfield', 'Lighting notes after solenne and other painters'),
  ('16', 'solenne-labs', 'Labs Account', null),
  ('17', 'solenne-works', 'Works Account', null),
  ('18', 'pim-harrow', 'Ｏrla   Venn', null),
  ('19', 'dax-oriel', 'Orla Venn Studio', null)
) as named(suffix, username, display_name, bio)
where profiles.id = ('5c000000-0000-4000-8000-0000000000' || named.suffix)::uuid;

insert into public.follows (follower_id, following_id)
select
  ('5c000000-0000-4000-8000-0000000000' || pairs.follower)::uuid,
  ('5c000000-0000-4000-8000-0000000000' || pairs.following)::uuid
from (values ('01', '03'), ('21', '12'), ('22', '12'), ('23', '12'), ('01', '17'), ('21', '19'), ('22', '19'))
  as pairs(follower, following);

insert into public.user_blocks (blocker_user_id, blocked_user_id)
values
  ('5c000000-0000-4000-8000-000000000001'::uuid, '5c000000-0000-4000-8000-000000000004'::uuid),
  ('5c000000-0000-4000-8000-000000000005'::uuid, '5c000000-0000-4000-8000-000000000001'::uuid);

create function pg_temp.post(
  p_suffix text, p_creator text, p_title text, p_body text, p_age interval,
  p_saves integer default 0, p_comments integer default 0, p_remixes integer default 0
) returns void language sql as $$
  insert into public.posts (
    id, user_id, visibility, category, source_kind, post_format, review_status,
    title, body, source_tool, source_tool_slug, showcase_asset_path,
    is_nsfw, save_count, comment_count, remix_count, created_at, updated_at
  ) values (
    ('5c100000-0000-4000-8000-0000000000' || p_suffix)::uuid,
    ('5c000000-0000-4000-8000-0000000000' || p_creator)::uuid,
    'public', 'image', 'external', 'media', 'visible',
    p_title, p_body, 'Midjourney', 'midjourney', 'showcase/search-ranking-' || p_suffix || '.png',
    false, p_saves, p_comments, p_remixes, now() - p_age, now()
  );
$$;

-- The tiers, on 'lantern glow'.
select pg_temp.post('11', '02', 'Lantern glow', 'A quiet frame', interval '60 days');
select pg_temp.post('12', '02', 'Lantern glow at dusk', 'A quiet frame', interval '0');
select pg_temp.post('13', '02', 'Paper lantern, soft glow', 'A quiet frame', interval '0');
select pg_temp.post('14', '02', 'Evening walk', repeat('lantern glow ', 30), interval '0', 5000);
select pg_temp.post('15', '02', 'Harbor notes', 'A lantern glow over the water', interval '0');
-- A blocked creator's and a blocking creator's exact titles: first for anyone else.
select pg_temp.post('16', '04', 'Lantern glow', 'A quiet frame', interval '0', 300);
select pg_temp.post('17', '05', 'Lantern glow', 'A quiet frame', interval '0', 300);
-- Engagement and its decay, on 'quartzfinch': the same title and saves a week and two months old.
select pg_temp.post('21', '02', 'Quartzfinch study', 'A quiet frame', interval '7 days', 40);
select pg_temp.post('22', '02', 'Quartzfinch study', 'A quiet frame', interval '60 days', 40);
-- Engagement inside a tier, on 'velmora': the same title and age, saved or not.
select pg_temp.post('31', '02', 'Velmora study', 'A quiet frame', interval '3 days');
select pg_temp.post('32', '02', 'Velmora study', 'A quiet frame', interval '3 days', 200, 10, 5);
-- Freshness, on 'ostrander': the same title, nothing saved, today and 90 days ago.
select pg_temp.post('41', '02', 'Ostrander study', 'A quiet frame', interval '90 days');
select pg_temp.post('42', '02', 'Ostrander study', 'A quiet frame', interval '0');
-- A follow, on 'pellwick': the same post by a stranger and by a creator the viewer follows.
select pg_temp.post('51', '02', 'Pellwick study', 'A quiet frame', interval '1 day');
select pg_temp.post('52', '03', 'Pellwick study', 'A quiet frame', interval '1 day');
-- A word only a blocked creator's post holds.
select pg_temp.post('61', '04', 'Zorblatt study', 'A quiet frame', interval '0');
-- A title that is the query once it is read as the query is, on 'mossgate
-- ridge': a full-width letter, a line break and a double space. …72's title
-- only starts with the query, and has the saves.
select pg_temp.post('71', '02', E'Ｍossgate \n ridge', 'A quiet frame', interval '0');
select pg_temp.post('72', '02', 'Mossgate ridge at dawn', 'A quiet frame', interval '0', 500);

select public.rebuild_search_terms();

create function pg_temp.post_id(p_suffix text) returns uuid language sql immutable as $$
  select ('5c100000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;
create function pg_temp.user_id(p_suffix text) returns uuid language sql immutable as $$
  select ('5c000000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;

-- A search's posts in the order it gives them, as two-digit suffixes.
create function pg_temp.posts_found(
  p_query text, p_viewer uuid default null, p_sort text default 'top', p_limit integer default 25
) returns text[] language sql stable as $$
  select coalesce(array_agg(right(found.post_id::text, 2) order by found.position), '{}')
  from (
    select s.post_id, row_number() over () as position
    from public.search_public_posts(p_query, p_viewer, null, null, p_limit, now(), p_sort) as s
  ) as found;
$$;

create function pg_temp.creators_found(p_query text, p_viewer uuid default null, p_limit integer default 25)
returns text[] language sql stable as $$
  select coalesce(array_agg(found.username order by found.position), '{}')
  from (
    select s.username, row_number() over () as position
    from public.search_public_creators(p_query, p_viewer, null, null, p_limit) as s
  ) as found;
$$;

-- ─── The tiers ───────────────────────────────────────────────────────────────

select is(
  pg_temp.posts_found('lantern glow', pg_temp.user_id('01')),
  array['11', '12', '13', '14', '15'],
  'title is the query, then title starts with it, then title holds its words, then captions: a two-month-old exact title with nothing saved leads, and a caption repeating the query thirty times under 5,000 saves stays below every title match'
);

select cmp_ok(
  (select ts_rank_cd(search_vector, public.search_query_tsquery('lantern glow', true), 1 | 32)
   from public.post_search_documents where post_id = pg_temp.post_id('14')),
  '<', 1.0::real,
  'a caption repeating the query thirty times has a text rank under 1'
);

select cmp_ok(
  (select ts_rank_cd(search_vector, public.search_query_tsquery('lantern glow', true))
   from public.post_search_documents where post_id = pg_temp.post_id('14')),
  '>', 10.0::real,
  'where unnormalised it passed 10, an exact title''s old lift'
);

-- The bound itself: the best a tier's parts can add (rank 1, similarity 1,
-- every counter at its maximum, posted now, followed) against the least the
-- next tier can have (nothing matched beyond the tier, ten years old).
select cmp_ok(
  public.search_post_score(false, false, false, 1, 1, 2147483647, 2147483647, 2147483647, 0, true),
  '<',
  public.search_post_score(false, false, true, 0, 0, 0, 0, 0, 315360000, false),
  'nothing lifts a caption match to a title, model or tool match'
);
select cmp_ok(
  public.search_post_score(false, false, true, 1, 1, 2147483647, 2147483647, 2147483647, 0, true),
  '<',
  public.search_post_score(false, true, false, 0, 0, 0, 0, 0, 315360000, false),
  'nothing lifts a title holding the words to a title starting with the query'
);
select cmp_ok(
  public.search_post_score(false, true, false, 1, 1, 2147483647, 2147483647, 2147483647, 0, true),
  '<',
  public.search_post_score(true, false, false, 0, 0, 0, 0, 0, 315360000, false),
  'nothing lifts a title starting with the query to a title that is the query'
);
select lives_ok(
  $$select public.search_post_score(null, null, null, null, null, null, null, null, 1e18, null),
           public.search_post_score(true, true, true, 5, 5, -4, -4, -4, -1e18, true)$$,
  'the score answers nulls, negative counts and an age of any size'
);

select is(
  pg_temp.posts_found('mossgate ridge'),
  array['71', '72'],
  'a title written with a full-width letter, a line break and a double space is the query once read as the query is, and leads a title that only starts with it'
);

-- ─── Engagement, decayed by age ──────────────────────────────────────────────

select is(
  pg_temp.posts_found('quartzfinch'),
  array['21', '22'],
  'of two posts with the same title and the same 40 saves, the one posted last week outranks the one posted two months ago'
);

select cmp_ok(
  public.search_post_score(false, false, true, 0.5, 0.5, 40, 0, 0, 7 * 86400, false)
    - public.search_post_score(false, false, true, 0.5, 0.5, 0, 0, 0, 7 * 86400, false),
  '>',
  public.search_post_score(false, false, true, 0.5, 0.5, 40, 0, 0, 60 * 86400, false)
    - public.search_post_score(false, false, true, 0.5, 0.5, 0, 0, 0, 60 * 86400, false),
  'and that is the decay, not freshness alone: the same 40 saves add more to a week-old post than to a two-month-old one'
);

select cmp_ok(
  public.search_post_score(false, false, true, 0.5, 0.5, 40, 0, 0, 3650 * 86400, false)
    - public.search_post_score(false, false, true, 0.5, 0.5, 0, 0, 0, 3650 * 86400, false),
  '>', 0.2::double precision,
  'a post ten years old still keeps part of what its saves earned'
);

select is(
  pg_temp.posts_found('velmora'),
  array['32', '31'],
  'inside a tier, of two posts of the same title and age the saved, commented and remixed one leads'
);

select cmp_ok(
  public.search_post_score(false, false, true, 0.5, 0.5, 100000, 0, 0, 0, false),
  '=',
  public.search_post_score(false, false, true, 0.5, 0.5, 2147483647, 0, 0, 0, false),
  'engagement is bounded: past a thousand points more saves add nothing'
);

-- ─── Freshness and a follow ──────────────────────────────────────────────────

select is(
  pg_temp.posts_found('ostrander'),
  array['42', '41'],
  'of two posts of the same title with nothing saved, today''s outranks one 90 days old'
);

select is(
  pg_temp.posts_found('pellwick'),
  array['51', '52'],
  'two posts alike in everything tie, and the smaller id leads'
);
select is(
  pg_temp.posts_found('pellwick', pg_temp.user_id('01')),
  array['52', '51'],
  'for a viewer who follows one of the two creators, that creator''s post leads'
);

-- ─── Pages are scored at one instant ─────────────────────────────────────────

select is(
  (with first_page as (
     select s.post_id, s.search_score
     from public.search_public_posts('lantern glow', null, null, null, 3, now() - interval '5 days') as s
   ),
   last_row as (select * from first_page order by search_score, post_id desc limit 1)
   select array_agg(right(next_page.post_id::text, 2) order by next_page.search_score desc, next_page.post_id)
   from last_row
   cross join lateral public.search_public_posts(
     'lantern glow', null, last_row.search_score, last_row.post_id, 10, now() - interval '5 days'
   ) as next_page),
  (select array_agg(right(whole.post_id::text, 2) order by whole.search_score desc, whole.post_id)
   from (
     select s.post_id, s.search_score
     from public.search_public_posts('lantern glow', null, null, null, 25, now() - interval '5 days') as s
     offset 3
   ) as whole),
  'the second page of a search scored at one instant is exactly what follows the first page in one whole read at that instant'
);

select isnt(
  (select s.search_score from public.search_public_posts('ostrander', null, null, null, 1, now()) as s),
  (select s.search_score from public.search_public_posts('ostrander', null, null, null, 1, now() + interval '3 days') as s),
  'the score moves with the instant, which is why a cursor carries it'
);

-- now() does not move inside this transaction, so the repeat itself is shown
-- by two separate calls (the evidence script of 2026-11-12); what holds here
-- is the instant a call without one is given.
select is(
  (select array_agg(row(s.post_id, s.search_score)::text order by s.search_score desc, s.post_id)
   from public.search_public_posts('lantern glow', null, null, null, 25) as s),
  (select array_agg(row(s.post_id, s.search_score)::text order by s.search_score desc, s.post_id)
   from public.search_public_posts('lantern glow', null, null, null, 25, date_trunc('day', now(), 'UTC')) as s),
  'without an instant a search is scored at the start of the UTC day, the same for every call that day, never at now()'
);

select is(
  (select s.search_score from public.search_public_posts('ostrander', null, null, null, 1) as s),
  (select s.search_score from public.search_public_posts('ostrander', null, null, null, 1,
     (select created_at from public.posts where id = pg_temp.post_id('42'))) as s),
  'a post made after that instant scores as one made at it: its age is zero, never negative'
);

-- ─── A cursor's score goes through text ──────────────────────────────────────

-- The Data API writes a double as this database does, with 15 significant
-- digits (extra_float_digits = 0 in its configuration; set here so the cases
-- say what they depend on), and the app hands that text back as the cursor.
select set_config('extra_float_digits', '0', true);

select isnt(
  (24.581481013499234::double precision::text)::double precision,
  24.581481013499234::double precision,
  'a double written with 15 digits is not always the double it was: an unrounded score did not survive its cursor'
);

select is(
  (select count(*)::integer
   from public.search_public_posts('lantern glow', null, null, null, 25, now()) as s
   where (s.search_score::text)::double precision <> s.search_score
      or s.search_score <> round(s.search_score::numeric, 6)::double precision),
  0,
  'every post score has six decimals at most and reads back from text as itself'
);
select is(
  (select count(*)::integer
   from public.search_public_creators('solenne', null, null, null, 25) as s
   where (s.search_score::text)::double precision <> s.search_score
      or s.search_score <> round(s.search_score::numeric, 6)::double precision),
  0,
  'and every creator score'
);

select is(
  (select count(*)::integer
   from generate_series(1, 6) as cut(size)
   cross join lateral (
     select s.post_id, s.search_score::text as score_text
     from public.search_public_posts('lantern glow', null, null, null, cut.size) as s
     order by s.search_score, s.post_id desc
     limit 1
   ) as last_row
   cross join lateral public.search_public_posts(
     p_query => 'lantern glow',
     p_viewer_user_id => null,
     p_after_score => last_row.score_text::double precision,
     p_after_id => last_row.post_id,
     p_limit => 25
   ) as next_page
   where next_page.post_id = last_row.post_id),
  0,
  'wherever a page of posts is cut, the cursor read back from text opens the next page after its own row, for the call that sends no instant too'
);
select is(
  (select count(*)::integer
   from generate_series(1, 6) as cut(size)
   cross join lateral (
     select s.creator_user_id, s.search_score::text as score_text
     from public.search_public_creators('solenne', null, null, null, cut.size) as s
     order by s.search_score, s.creator_user_id desc
     limit 1
   ) as last_row
   cross join lateral public.search_public_creators(
     'solenne', null, last_row.score_text::double precision, last_row.creator_user_id, 25
   ) as next_page
   where next_page.creator_user_id = last_row.creator_user_id),
  0,
  'and wherever a page of creators is cut'
);

-- ─── The call of the app live during the release ─────────────────────────────

select is(
  (select array_agg(right(s.post_id::text, 2) order by s.search_score desc, s.post_id)
   from public.search_public_posts(
     p_query => 'lantern glow',
     p_viewer_user_id => pg_temp.user_id('01'),
     p_after_score => null,
     p_after_id => null,
     p_limit => 3
   ) as s),
  array['11', '12', '13'],
  'the five-argument named call still resolves, and reads Top'
);

select lives_ok(
  $$select * from public.search_public_posts(
      p_query => 'lantern glow',
      p_viewer_user_id => null,
      p_after_score => 12.6183,
      p_after_id => '5c100000-0000-4000-8000-000000000012'::uuid,
      p_limit => 21
    )$$,
  'a cursor issued before this migration, a score on the old scale and an id, still reads a page'
);

select is(
  (select count(*)::integer from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'search_public_posts'),
  1,
  'there is one search_public_posts, so PostgREST has nothing to choose between'
);
select is(
  (select count(*)::integer from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'search_public_creators'),
  1,
  'and one search_public_creators'
);
select ok(
  to_regprocedure('public.search_public_posts(text,uuid,double precision,uuid,integer)') is null,
  'the five-parameter function is gone'
);

-- ─── Latest ──────────────────────────────────────────────────────────────────

select is(
  pg_temp.posts_found('lantern glow', pg_temp.user_id('01'), 'latest'),
  array['12', '13', '14', '15', '11'],
  'Latest orders the matches newest first, the smaller id first among posts of one instant'
);

select set_eq(
  $$select unnest(pg_temp.posts_found('lantern glow', pg_temp.user_id('01'), 'latest'))$$,
  $$select unnest(pg_temp.posts_found('lantern glow', pg_temp.user_id('01'), 'top'))$$,
  'Latest and Top hold the same posts'
);

select is(
  (with first_page as (
     select s.post_id, s.created_at, row_number() over () as position
     from public.search_public_posts('lantern glow', pg_temp.user_id('01'), null, null, 2, null, 'latest') as s
   ),
   last_row as (select * from first_page order by position desc limit 1),
   next_page as (
     select s.post_id, row_number() over () as position
     from last_row
     cross join lateral public.search_public_posts(
       'lantern glow', pg_temp.user_id('01'), null, last_row.post_id, 10, null, 'latest', last_row.created_at
     ) as s
   )
   select array_agg(right(post_id::text, 2) order by position) from next_page),
  array['14', '15', '11'],
  'the second Latest page continues after the first, inside a run of posts of one instant'
);

select is(
  pg_temp.posts_found('lantern glow', null, null),
  pg_temp.posts_found('lantern glow', null, 'top'),
  'a null sort reads Top'
);

select throws_ok(
  $$select * from public.search_public_posts('lantern glow', null, null, null, 5, null, 'oldest')$$,
  'P0001', 'Post search sort must be top or latest',
  'an unknown sort is refused'
);
select throws_ok(
  $$select * from public.search_public_posts('lantern glow', null, null, null, 5, null, 'latest', now())$$,
  'P0001', 'Post search cursor is incomplete',
  'a Latest cursor without its id is refused'
);

-- ─── Blocks, before the page is cut ──────────────────────────────────────────

select is(
  pg_temp.posts_found('lantern glow', null, 'top', 3),
  array['16', '17', '11'],
  'without a viewer the blocked and the blocking creators'' exact titles lead'
);
select is(
  pg_temp.posts_found('lantern glow', pg_temp.user_id('01'), 'top', 3),
  array['11', '12', '13'],
  'the viewer''s page of three is full without them: a creator the viewer blocked and a creator who blocked the viewer are left out before the limit'
);
select is(
  pg_temp.posts_found('lantern glow', pg_temp.user_id('01'), 'latest', 3),
  array['12', '13', '14'],
  'and so is a Latest page'
);
select is(
  pg_temp.posts_found('lantern glow', pg_temp.user_id('04'), 'top', 2),
  array['16', '17'],
  'the blocked creator, searching, sees their own post and loses only who blocks or is blocked by them'
);
select is(
  pg_temp.posts_found('lantern glow', pg_temp.user_id('05'), 'top', 3),
  array['16', '17', '11'],
  'the blocking creator loses nothing here: the viewer has no post'
);
select is(
  pg_temp.posts_found('zorblatt', pg_temp.user_id('01')),
  '{}'::text[],
  'a word only a blocked creator''s post holds finds nothing for the viewer'
);
select is(
  pg_temp.posts_found('zorblatt'),
  array['61'],
  'and its post for anyone else'
);

select set_eq(
  $$select unnest(pg_temp.creators_found('zelkova'))$$,
  array['zelkova-maker', 'zelkova-followed', 'zelkova-blocked', 'zelkova-blocker'],
  'creator search finds all four accounts for a stranger'
);
select is(
  pg_temp.creators_found('zelkova', pg_temp.user_id('01'), 2),
  array['zelkova-followed', 'zelkova-maker'],
  'the viewer''s page of two is full without the creator they blocked and the creator who blocked them, the followed one first'
);
select is(
  pg_temp.creators_found('zelkova', pg_temp.user_id('01')),
  array['zelkova-followed', 'zelkova-maker'],
  'and the whole search holds neither'
);
select is(
  pg_temp.creators_found('quillon'),
  array['quillon-viewer'],
  'a stranger finds the viewer'
);
select is(
  pg_temp.creators_found('quillon', pg_temp.user_id('05')),
  '{}'::text[],
  'the creator who blocked the viewer does not'
);
select is(
  pg_temp.creators_found('quillon', pg_temp.user_id('04')),
  '{}'::text[],
  'nor does the creator the viewer blocked'
);

-- ─── Creators ────────────────────────────────────────────────────────────────

select is(
  pg_temp.creators_found('solenne'),
  array['solenne', 'solenne-studio', 'solenne-works', 'solenne-labs', 'marek-ives', 'atelier-nine', 'brightfield'],
  'the handle that is the query, then handles starting with it (three followers, one, none), then the display name that is it, then a name starting with it, then a bio word'
);
select is(
  pg_temp.creators_found('solenne', pg_temp.user_id('01')),
  array['solenne', 'solenne-works', 'solenne-studio', 'solenne-labs', 'marek-ives', 'atelier-nine', 'brightfield'],
  'for a viewer who follows one of the handles starting with it, that one leads its tier and no further'
);
select is(
  pg_temp.creators_found('orla venn'),
  array['pim-harrow', 'dax-oriel'],
  'a display name written with a full-width letter and three spaces is the query once read as the query is, and leads a followed creator whose name only starts with it'
);
select cmp_ok(
  public.search_creator_score(false, true, false, false, 1, 1, 2147483647, 2147483647, true),
  '<',
  public.search_creator_score(true, false, false, false, 0, 0, 0, 0, false),
  'nothing lifts a handle starting with the query to the handle that is the query'
);
select cmp_ok(
  public.search_creator_score(false, false, true, false, 1, 1, 2147483647, 2147483647, true),
  '<',
  public.search_creator_score(false, true, false, false, 0, 0, 0, 0, false),
  'nothing lifts a display name to a handle starting with the query'
);
select cmp_ok(
  public.search_creator_score(false, false, false, true, 1, 1, 2147483647, 2147483647, true),
  '<',
  public.search_creator_score(false, false, true, false, 0, 0, 0, 0, false),
  'nothing lifts a name starting with the query to the name that is the query'
);
select cmp_ok(
  public.search_creator_score(false, false, false, false, 1, 1, 2147483647, 2147483647, true),
  '<',
  public.search_creator_score(false, false, false, true, 0, 0, 0, 0, false),
  'nothing lifts a bio word to a name match'
);
select cmp_ok(
  public.search_creator_score(false, true, false, false, 0.5, 0.5, 1000, 0, false),
  '=',
  public.search_creator_score(false, true, false, false, 0.5, 0.5, 2147483647, 0, false),
  'audience is bounded: past a thousand followers more add nothing'
);

-- ─── Who may call what ───────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.search_public_posts(text,uuid,double precision,uuid,integer,timestamptz,text,timestamptz,text,text,boolean,boolean,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_public_posts(text,uuid,double precision,uuid,integer,timestamptz,text,timestamptz,text,text,boolean,boolean,boolean)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_public_posts(text,uuid,double precision,uuid,integer,timestamptz,text,timestamptz,text,text,boolean,boolean,boolean)', 'EXECUTE'),
  'post search is the service role''s alone'
);
select ok(
  (select fn.prosecdef
     and exists (
       select 1 from unnest(fn.proconfig) as entry
       where entry like 'search_path=%public%pg_temp%'
     )
   from pg_proc as fn
   where fn.oid = 'public.search_public_posts(text,uuid,double precision,uuid,integer,timestamptz,text,timestamptz,text,text,boolean,boolean,boolean)'::regprocedure),
  'and keeps definer rights and its pinned search path'
);
select ok(
  not has_function_privilege('anon', 'public.search_public_creators(text,uuid,double precision,uuid,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_public_creators(text,uuid,double precision,uuid,integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_public_creators(text,uuid,double precision,uuid,integer)', 'EXECUTE'),
  'creator search is the service role''s alone'
);
select ok(
  not has_function_privilege('anon', 'public.search_post_score(boolean,boolean,boolean,double precision,double precision,integer,integer,integer,double precision,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_post_score(boolean,boolean,boolean,double precision,double precision,integer,integer,integer,double precision,boolean)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.search_creator_score(boolean,boolean,boolean,boolean,double precision,double precision,integer,integer,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_creator_score(boolean,boolean,boolean,boolean,double precision,double precision,integer,integer,boolean)', 'EXECUTE'),
  'client roles cannot call the score functions'
);

-- ─── The search log's sort ───────────────────────────────────────────────────

select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count)
     values ('lantern glow', 'posts', false, repeat('a', 64), 0, 2, 0) $$,
  'a row without a sort inserts, as the app live during the release writes it'
);
select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, sort)
     values ('lantern glow', 'posts', false, repeat('a', 64), 0, 2, 0, 'latest') $$,
  'a row says latest'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, sort)
     values ('lantern glow', 'posts', false, repeat('a', 64), 0, 2, 0, 'newest') $$,
  '23514', null, 'a sort outside top and latest is refused'
);

select * from finish();
rollback;
