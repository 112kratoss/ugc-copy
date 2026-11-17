-- Whole words first (20261116200234_search_whole_words_first.sql): a post that
-- holds the query's words whole ranks before every post that holds them only
-- inside longer words, whatever its age and saves; partial matches keep their
-- order among themselves; nothing is found or lost; and related searches are
-- read from the posts about the search, a phrase holding the query first.
--
-- The fixture is the defect of 2026-11-17: "cat" put posts about no cat
-- ("Monsoon girl — a chibi sticker…", "Minnal Vanitha in the rain") among its
-- first four, and offered "minnal murali" and "cinematic lighting".
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

create function pg_temp.uid(p_suffix text) returns uuid language sql immutable as $$
  select ('5c2a0000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;

insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
select pg_temp.uid(suffix), 'whole-words-' || suffix || '@example.invalid',
       'authenticated', 'authenticated', now() - interval '200 days', '{}'::jsonb, '{}'::jsonb
from unnest(array['01', '02', '03']) as suffix;

-- Three posts about a cat, months old and never saved; five about no cat,
-- new, two of them saved by thousands, each holding "cat" inside another
-- word: catching and category start a title with its letters, cathedral is a
-- word of a title, delicate, intricate and scattered hold it in a caption.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, source_tool, source_tool_slug, showcase_asset_path,
  is_nsfw, save_count, created_at, updated_at
)
select
  pg_temp.uid(post.suffix), pg_temp.uid(post.creator), 'public', 'image', 'external', 'media', 'visible',
  post.title, post.body, 'Midjourney', 'midjourney', 'showcase/whole-words-' || post.suffix || '.png',
  false, post.saves, now() - post.age, now()
from (values
  ('11', '01', 'Cat on a windowsill', 'A black cat in soft window light', 0, interval '60 days'),
  ('12', '02', 'Chibi cat cafe', 'A black cat serving tiny cakes', 0, interval '60 days'),
  ('13', '03', 'Persian portrait', 'A fluffy white cat on velvet, soft window light', 0, interval '90 days'),
  ('21', '01', 'Catching raindrops', 'Minnal murali poster, cinematic lighting', 500, interval '0'),
  ('22', '02', 'Category winners', 'Minnal murali fan art, cinematic lighting', 0, interval '0'),
  ('23', '03', 'Gothic cathedral', 'Stained glass, cinematic lighting', 0, interval '0'),
  ('24', '01', 'Monsoon girl sticker', 'A delicate paper umbrella, minnal murali style', 5000, interval '0'),
  ('25', '02', 'Minnal Vanitha in the rain', 'Intricate suit, scattered sparks, cinematic lighting', 0, interval '0'),
  -- A title that starts with a hyphenated compound of the word, new and
  -- saved, and an older one that starts with the word itself (review of #839).
  ('26', '02', 'Dog-ear notebook', 'Pages folded at the corners', 500, interval '0'),
  ('27', '03', 'Dog on a porch', 'A sleepy hound in the afternoon', 0, interval '60 days'),
  -- The same with the hyphens of Unicode an assistant or an editor writes:
  -- U+2011, the non-breaking hyphen (which NFKC makes U+2010), and U+2010
  -- itself (second review of #839).
  ('28', '01', 'Fish' || chr(8209) || 'eye lens portrait', 'A wide round frame', 500, interval '0'),
  ('29', '02', 'Fish in a glass bowl', 'A goldfish in clear water', 0, interval '60 days'),
  ('30', '03', 'Star' || chr(8208) || 'shaped cookies', 'Sugar dusted biscuits', 500, interval '0'),
  ('31', '01', 'Star over the desert', 'A bright night sky', 0, interval '60 days')
) as post(suffix, creator, title, body, saves, age);

select public.rebuild_search_terms();
select public.rebuild_search_phrases();

-- A search's posts in the order it gives them, as two-digit suffixes.
create function pg_temp.posts_found(p_query text, p_sort text default 'top') returns text[] language sql stable as $$
  select coalesce(array_agg(right(found.post_id::text, 2) order by found.position), '{}')
  from (
    select s.post_id, row_number() over () as position
    from public.search_public_posts(p_query, null, null, null, 25, now(), p_sort) as s
  ) as found;
$$;

create function pg_temp.related(p_query text, p_posts text[], p_corrected text default null) returns text[] language sql stable as $$
  select coalesce(array_agg(related order by position), '{}')
  from public.search_related_searches(
    p_query, null, array(select pg_temp.uid(suffix) from unnest(p_posts) as suffix), p_corrected, 6
  ) with ordinality as offered(related, position);
$$;

-- ─── The query read whole ────────────────────────────────────────────────────

select ok(to_tsvector('simple', 'a cat') @@ public.search_query_whole_tsquery('cat'), 'a word holds itself');
select ok(to_tsvector('english', 'two cats') @@ public.search_query_whole_tsquery('cat'), 'a plural holds its singular');
select ok(to_tsvector('english', 'a cat') @@ public.search_query_whole_tsquery('cats'), 'and a singular its plural');
select ok(not (to_tsvector('simple', 'catwalk category cathedral delicate') @@ public.search_query_whole_tsquery('cat')),
  'no word that only starts with the letters, or holds them, holds the word');
select ok(to_tsvector('simple', public.search_term_variants('veo-3.1')) @@ public.search_query_whole_tsquery('veo 3'),
  'a model''s name split as search_query_tsquery splits it');
select ok(not (to_tsvector('simple', 'black cat') @@ public.search_query_whole_tsquery('black cats window')),
  'every word is required');
-- Malayalam and Tamil words are read whole as the parser reads them (no
-- stemmer: an inflected form is another word).
select ok(to_tsvector('simple', 'മിന്നൽ മുരളി') @@ public.search_query_whole_tsquery('മിന്നൽ'),
  'a Malayalam word holds itself');
select ok(to_tsvector('simple', 'பூனை படம்') @@ public.search_query_whole_tsquery('பூனை'),
  'and a Tamil one');

-- ─── Whole words first ───────────────────────────────────────────────────────

select is(
  pg_temp.posts_found('cat'),
  array['11', '12', '13', '21', '22', '23', '24', '25'],
  'the three posts about a cat lead, months old and unsaved, in their tiers (a title starting with the word, a title holding it, a caption); then the title that starts with its letters, the title word that does, and the captions that hold them inside other words, new and saved by thousands'
);

select is(
  (select array_agg(found.post_id order by found.post_id) from public.search_public_posts('cat', null, null, null, 25, now(), 'top') as found),
  (select array_agg(found.post_id order by found.post_id) from public.search_public_posts('cat', null, null, null, 25, now(), 'latest') as found),
  'nothing is found or lost: Latest, which is not scored, holds the same posts'
);

select is(
  (select array_agg(found order by found) from unnest(pg_temp.posts_found('cats')) with ordinality as listed(found, position) where position <= 3),
  array['11', '12', '13'],
  'a plural finds the posts about its singular first too'
);

select is(pg_temp.posts_found('catc'), array['21'], 'a word still being typed finds what holds it as a prefix, as before');
select is(pg_temp.posts_found('cath'), array['23'], 'and a title word that starts with it');

-- A hyphen goes on with the word: 'dog-ear' is no title starting with 'dog'.
-- It still holds 'dog' among its words, as the parser splits the compound.
select is(
  pg_temp.posts_found('dog'),
  array['27', '26'],
  'a title that starts with the word leads one that starts with a hyphenated compound of it, new and saved as that one is'
);
select is(
  pg_temp.posts_found('fish'),
  array['29', '28'],
  'and one whose compound is joined by a non-breaking hyphen (U+2011)'
);
select is(
  pg_temp.posts_found('star'),
  array['31', '30'],
  'and one whose compound is joined by the hyphen U+2010'
);

-- Among posts that hold the query only inside longer words, the tiers keep
-- their order (title starts with it, a title word starts with it, the rest).
select is((pg_temp.posts_found('minn'))[1], '25', 'a word still being typed: the title that starts with it first');
select is(
  (select array_agg(found order by found) from unnest(pg_temp.posts_found('minn')) with ordinality as listed(found, position) where position > 1),
  array['21', '22', '24'],
  'then the captions that hold it'
);

-- The bounds: the best a partial match can score against the least a whole
-- match can, and the partial tiers against each other.
select cmp_ok(
  public.search_post_score(false, true, false, 1, 1, 2147483647, 2147483647, 2147483647, 0, true, false),
  '<',
  public.search_post_score(false, false, false, 0, 0, 0, 0, 0, 315360000, false, true),
  'nothing lifts a title that starts with the letters over a caption that holds the word'
);
select cmp_ok(
  public.search_post_score(false, false, true, 1, 1, 2147483647, 2147483647, 2147483647, 0, true, false),
  '<',
  public.search_post_score(false, true, false, 0, 0, 0, 0, 0, 315360000, false, false),
  'partial tiers keep their order: a title word that starts with the letters under a title that does'
);
select cmp_ok(
  public.search_post_score(false, false, false, 1, 1, 2147483647, 2147483647, 2147483647, 0, true, false),
  '<',
  public.search_post_score(false, false, true, 0, 0, 0, 0, 0, 315360000, false, false),
  'and the rest under a title word'
);
select is(
  public.search_post_score(true, false, false, 0.5, 0.5, 10, 0, 0, 86400, false, false),
  public.search_post_score(true, false, false, 0.5, 0.5, 10, 0, 0, 86400, false, true),
  'a title that is the query holds its words whole, whatever the caller says'
);
select is(
  public.search_post_score(false, true, false, 0.5, 0.5, 10, 0, 0, 86400, false),
  public.search_post_score(false, true, false, 0.5, 0.5, 10, 0, 0, 86400, false, true),
  'a call of ten arguments scores as before: as whole words'
);
select cmp_ok(
  public.search_post_score(false, true, false, 1, 1, 2147483647, 2147483647, 2147483647, 0, true, true),
  '<',
  30::double precision,
  'nothing but a title that is the query scores 30, search_blended_posts'' pin (c_exact_title_score)'
);

-- ─── Related searches ────────────────────────────────────────────────────────

select is(
  (pg_temp.related('cat', array['11', '12', '13', '21', '22', '23', '24', '25']))[1],
  'black cat',
  'a phrase that holds the query leads the related searches'
);
select ok(
  not (pg_temp.related('cat', array['11', '12', '13', '21', '22', '23', '24', '25']) && array['minnal murali', 'cinematic lighting']),
  'and none comes from a post that holds the query only inside longer words'
);
select ok(
  'soft window light' = any (pg_temp.related('cat', array['11', '12', '13', '21', '22', '23', '24', '25']))
    or 'window light' = any (pg_temp.related('cat', array['11', '12', '13', '21', '22', '23', '24', '25'])),
  'a phrase two posts about the search hold, that leads away from it, still comes'
);
select ok(
  'minnal murali' = any (pg_temp.related('minn', array['21', '22', '24', '25'])),
  'while no post of the page holds the query whole (a word still being typed), every post of the page is read'
);
-- A blended answer: one post holds the words whole, the others match none of
-- them and were found by meaning (review of #839: they were dropped too, and
-- a page of one whole-word post had no related search).
select ok(
  'black cat' = any (pg_temp.related('white cat', array['13', '11', '12'])),
  'beside a post that holds the words whole, the posts found by meaning alone are read'
);
select is(
  pg_temp.related('cat', array['11', '21', '22', '23', '24', '25']),
  '{}'::text[],
  'one post about the search is not two: the posts that hold it inside longer words never stand in for the second'
);
select ok(
  'black cat' = any (pg_temp.related('kitty', array['11', '12', '13'])),
  'a page none of whose posts holds the query (posts found by meaning) is read whole, as before'
);

-- ─── Grants ──────────────────────────────────────────────────────────────────

select ok(
  has_function_privilege('service_role', 'public.search_query_whole_tsquery(text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.search_query_whole_tsquery(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_query_whole_tsquery(text)', 'EXECUTE'),
  'the whole reading is the service role''s alone'
);
select ok(
  has_function_privilege('service_role', 'public.search_post_score(boolean,boolean,boolean,double precision,double precision,integer,integer,integer,double precision,boolean,boolean)', 'EXECUTE'),
  'the service role scores posts'
);
select is(
  (select count(*)::integer from pg_proc where proname = 'search_post_score' and pronamespace = 'public'::regnamespace),
  1,
  'one score function: a call of ten arguments is never ambiguous'
);

select * from finish();
rollback;
