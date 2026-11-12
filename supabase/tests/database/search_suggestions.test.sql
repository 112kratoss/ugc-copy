-- Typeahead (20261112144018_search_suggestions_typeahead.sql): what a search
-- box shows while a person types. Creators by handle or name in the order
-- Creators search gives them, never a guest, a suspended or deleting account,
-- or either side of a block; and completions of the word being typed, only
-- words that unlabelled public posts of two different creators write, never
-- a word that only a labelled post, a private or hidden post, a paid
-- recipe's caption, prompt or items, or a tool's name holds.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(84);

create function pg_temp.uid(p_suffix text)
returns uuid
language sql
as $$ select ('0000e5d7-0000-4000-9000-0000000000' || p_suffix)::uuid; $$;

-- The handles search_suggest_creators offers, in its order.
create function pg_temp.handles(p_query text, p_viewer uuid default null, p_handles_only boolean default false, p_limit integer default 10)
returns text[]
language sql
as $$
  select coalesce(array_agg(username order by position), '{}')
  from public.search_suggest_creators(p_query, p_viewer, p_handles_only, p_limit)
    with ordinality as offered(creator_user_id, username, display_name, avatar_url, is_following, position);
$$;

-- The completions search_suggest_completions offers, in its order.
create function pg_temp.completions(p_query text, p_limit integer default 10)
returns text[]
language sql
as $$
  select coalesce(array_agg(completion order by position), '{}')
  from public.search_suggest_completions(p_query, p_limit) with ordinality as offered(completion, position);
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- Creators, every handle or name starting 'ar':
--   …01 aria-fennick / Aria Fennick          …02 arlo-quist / Arlo Quist
--   …03 brisa-tolland / Aria of the North    (the name alone starts 'aria')
--   …04 aria / Solo Aria                     (the handle is 'aria')
--   …05 vesper-lund, the viewer: follows …02 and …03, blocked …06, blocked by …07
--   …06 arden-blocked                        …07 arwen-blocker   (both follow …01)
--   …08 arguest-anon, a guest (auth.users.is_anonymous)
--   …09 arbanned-one, suspended              …0a ardeleting-one, being deleted
--   …0b arpast-ban, whose suspension has ended
-- Posts carry made-up words, one fact each:
--   quillonbright  captions of …01 and …02: two creators write it
--   quillonsolo    three posts of …01 alone
--   quillonlabel   NSFW-labelled posts of …01 and …02
--   quillondraft   private posts of …01 and …02
--   quillonhidden  hidden posts of …01 and …02
--   quillonarchiv  archived posts of …01 and …02
--   quillonlocked  the "Saved generation setup" captions under paid recipes of …01 and …02
--   quillonprompt  the prompts of those posts, which a recipe keeps
--   quillonitem    those recipes' items
--   quillontool    the tool's name on posts of …01 and …02, and …03's caption
--   glassharbor    with quillonbright in one post each of …01 and …02
--   amberline      with quillonbright in a post of …01 only; alone in a post of …02

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, is_anonymous, banned_until)
select pg_temp.uid(people.suffix), 'e5d7-' || people.suffix || '@example.invalid', 'authenticated', 'authenticated',
       '{}'::jsonb, '{}'::jsonb, now() - interval '90 days', people.is_guest, people.banned_until
from (
  values
    ('01', false, null::timestamptz), ('02', false, null), ('03', false, null), ('04', false, null),
    ('05', false, null), ('06', false, null), ('07', false, null),
    ('08', true, null),
    ('09', false, now() + interval '30 days'),
    ('0a', false, null),
    ('0b', false, now() - interval '1 day')
) as people(suffix, is_guest, banned_until);

update public.profiles as profiles
set username = named.username, display_name = named.display_name
from (
  values
    ('01', 'aria-fennick', 'Aria Fennick'), ('02', 'arlo-quist', 'Arlo Quist'),
    ('03', 'brisa-tolland', 'Aria of the North'), ('04', 'aria', 'Solo Aria'),
    ('05', 'vesper-lund', 'Vesper Lund'), ('06', 'arden-blocked', 'Arden Blocked'),
    ('07', 'arwen-blocker', 'Arwen Blocker'), ('08', 'arguest-anon', 'Arguest Anon'),
    ('09', 'arbanned-one', 'Arbanned One'), ('0a', 'ardeleting-one', 'Ardeleting One'),
    ('0b', 'arpast-ban', 'Arpast Ban')
) as named(suffix, username, display_name)
where profiles.id = pg_temp.uid(named.suffix);

update public.profiles set identity_state = 'deleting' where id = pg_temp.uid('0a');

insert into public.follows (follower_id, following_id) values
  (pg_temp.uid('05'), pg_temp.uid('02')),
  (pg_temp.uid('05'), pg_temp.uid('03')),
  (pg_temp.uid('06'), pg_temp.uid('01')),
  (pg_temp.uid('07'), pg_temp.uid('01'));
insert into public.user_blocks (blocker_user_id, blocked_user_id) values
  (pg_temp.uid('05'), pg_temp.uid('06')),
  (pg_temp.uid('07'), pg_temp.uid('05'));

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw, archived_at,
  title, body, prompt, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select
  pg_temp.uid(post.suffix), pg_temp.uid(post.owner), post.visibility, 'image', 'external', 'media',
  post.review_status, post.is_nsfw, case when post.archived then now() end,
  post.title, post.body, post.prompt, 'showcase/e5d7-' || post.suffix || '.png',
  post.tool, lower(post.tool), now(), now()
from (
  values
    ('11', '01', 'public', 'visible', false, false, 'Harbour at dusk', 'A quillonbright sky over a glassharbor pier.', null, 'Midjourney'),
    ('12', '02', 'public', 'visible', false, false, 'Pier study', 'Glassharbor reflections, quillonbright again.', null, 'Midjourney'),
    ('13', '01', 'public', 'visible', false, false, 'First solo', 'A quillonsolo frame.', null, 'Midjourney'),
    ('14', '01', 'public', 'visible', false, false, 'Second solo', 'More quillonsolo.', null, 'Midjourney'),
    ('15', '01', 'public', 'visible', false, false, 'Third solo', 'Quillonsolo once more.', null, 'Midjourney'),
    ('16', '01', 'public', 'visible', true, false, 'Labelled one', 'A quillonlabel picture.', null, 'Midjourney'),
    ('17', '02', 'public', 'visible', true, false, 'Labelled two', 'Another quillonlabel picture.', null, 'Midjourney'),
    ('18', '01', 'private', 'visible', false, false, 'Draft one', 'A quillondraft idea.', null, 'Midjourney'),
    ('19', '02', 'private', 'visible', false, false, 'Draft two', 'Another quillondraft idea.', null, 'Midjourney'),
    ('1a', '01', 'public', 'hidden', false, false, 'Hidden one', 'A quillonhidden post.', null, 'Midjourney'),
    ('1b', '02', 'public', 'hidden', false, false, 'Hidden two', 'Another quillonhidden post.', null, 'Midjourney'),
    ('1c', '01', 'public', 'visible', false, true, 'Archived one', 'A quillonarchiv post.', null, 'Midjourney'),
    ('1d', '02', 'public', 'visible', false, true, 'Archived two', 'Another quillonarchiv post.', null, 'Midjourney'),
    ('1e', '01', 'public', 'visible', false, false, 'Paid setup one',
     E'Saved generation setup\nGrade: quillonlocked blue', 'the quillonprompt words', 'Midjourney'),
    ('1f', '02', 'public', 'visible', false, false, 'Paid setup two',
     E'Saved generation setup\nGrade: quillonlocked red', 'more quillonprompt words', 'Midjourney'),
    ('20', '01', 'public', 'visible', false, false, 'Made with a named tool', 'A plain caption.', null, 'Quillontool'),
    ('21', '02', 'public', 'visible', false, false, 'Also made with it', 'Another plain caption.', null, 'Quillontool'),
    ('22', '03', 'public', 'visible', false, false, 'Writes the tool name', 'I tried quillontool today.', null, 'Midjourney'),
    ('23', '01', 'public', 'visible', false, false, 'Amber study', 'An amberline wash under quillonbright light.', null, 'Midjourney'),
    ('24', '02', 'public', 'visible', false, false, 'Amber alone', 'Only amberline here.', null, 'Midjourney')
) as post(suffix, owner, visibility, review_status, is_nsfw, archived, title, body, prompt, tool);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
)
select
  pg_temp.uid(recipe.suffix), pg_temp.uid(recipe.post_suffix), pg_temp.uid(recipe.owner),
  'paid', 'published', recipe.title, 'A setup sold as a recipe',
  'A preview long enough to pass the marketplace quality gate.',
  null, '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'the quillonitem text a buyer unlocks')),
  '[]'::jsonb, 300, 0, 0, now(), now()
from (
  values ('31', '1e', '01', 'Paid setup one'), ('32', '1f', '02', 'Paid setup two')
) as recipe(suffix, post_suffix, owner, title);

-- The rebuild in its own statement: a statement does not see what a function
-- it calls has just changed.
select ok((select added > 0 from public.rebuild_search_terms()),
  'fixture: a rebuild fills the dictionary');

-- ─── The dictionary's counts ────────────────────────────────────────────────

select results_eq(
  $$ select added, removed from public.rebuild_search_terms() $$,
  $$ values (0, 0) $$,
  'a second rebuild finds nothing to add or remove, in the (added, removed) shape the job reads'
);
select results_eq(
  $$ select post_count, creator_count, in_posts from public.search_terms where term = 'quillonbright' $$,
  $$ values (3, 2, true) $$,
  'a word counts the posts that write it and the different creators among them'
);
select results_eq(
  $$ select post_count, creator_count from public.search_terms where term = 'quillonsolo' $$,
  $$ values (3, 1) $$,
  'three posts of one creator are one creator'
);
select results_eq(
  $$ select post_count, creator_count, in_posts from public.search_terms where term = 'quillontool' $$,
  $$ values (1, 1, true) $$,
  'a post whose tool is named the word is not counted; the one that writes it is'
);
select results_eq(
  $$ select post_count, creator_count, in_posts from public.search_terms where term = 'midjourney' $$,
  $$ values (0, 0, true) $$,
  'a word only tool names show stays in the dictionary, for spelling, with nothing counted'
);
select is(
  (select count(*) from public.search_terms
   where term in ('quillonlabel', 'quillondraft', 'quillonhidden', 'quillonarchiv', 'quillonlocked', 'quillonprompt', 'quillonitem')),
  0::bigint,
  'no word of a labelled, private, hidden or archived post, a paid recipe''s caption, a recipe post''s prompt or a recipe''s items is in the dictionary'
);
select is(
  (select count(*) from public.search_terms where creator_count > post_count or post_count < 0 or (not in_posts and post_count > 0)),
  0::bigint,
  'no word counts more creators than posts, or posts on a surface it is not on'
);
select is(public.search_corrected_query('quillonbrigt'), 'quillonbright',
  'spelling correction reads the dictionary as before');
select is(public.search_corrected_query('quillontol'), 'quillontool',
  'and still corrects to a word only a tool''s name shows');

-- ─── Completions: one word ──────────────────────────────────────────────────

select is(pg_temp.completions('quil'), array['quillonbright'],
  'a word two creators write completes what is typed; one creator''s word, a tool''s name and every hidden word do not');
select ok('quillonbright' = any (pg_temp.completions('qu')), 'from two letters');
select is(pg_temp.completions('q'), '{}'::text[], 'not from one');
select is(pg_temp.completions('QUIL'), array['quillonbright'], 'whatever the case typed');
select is(pg_temp.completions('  quil  '), array['quillonbright'], 'and whatever the space around it');
select is(pg_temp.completions('quillonbright'), '{}'::text[], 'a word typed in full is not offered back');
select is(pg_temp.completions('quillonso'), '{}'::text[], 'a word only one creator writes is never offered, however many posts hold it');
select is(pg_temp.completions('quillonla'), '{}'::text[], 'nor a word only labelled posts hold');
select is(pg_temp.completions('quillondr'), '{}'::text[], 'nor a word only private posts hold');
select is(pg_temp.completions('quillonhi'), '{}'::text[], 'nor a word only hidden posts hold');
select is(pg_temp.completions('quillonar'), '{}'::text[], 'nor a word only archived posts hold');
select is(pg_temp.completions('quillonlo'), '{}'::text[], 'nor a word only a paid recipe''s setup caption holds');
select is(pg_temp.completions('quillonpr'), '{}'::text[], 'nor a word only a recipe post''s prompt holds');
select is(pg_temp.completions('quillonit'), '{}'::text[], 'nor a word only a recipe''s items hold');
select is(pg_temp.completions('quillonto'), '{}'::text[], 'nor a tool''s name one creator writes');
select is(pg_temp.completions('midj'), '{}'::text[], 'nor a tool''s name nobody writes');
select is(pg_temp.completions('glass'), array['glassharbor'], 'another word two creators write');
select is(pg_temp.completions('amber'), array['amberline'], 'and another');

-- The most-shown word first: three posts write quillonbright, two glassharbor.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  (pg_temp.uid('25'), pg_temp.uid('01'), 'public', 'image', 'external', 'media', 'visible', false,
   'Pier study', 'Quillonquay.', 'showcase/e5d7-25.png', 'Midjourney', 'midjourney', now(), now()),
  (pg_temp.uid('26'), pg_temp.uid('02'), 'public', 'image', 'external', 'media', 'visible', false,
   'Pier study', 'Quillonquay.', 'showcase/e5d7-26.png', 'Midjourney', 'midjourney', now(), now());
select is(pg_temp.completions('quillonq'), '{}'::text[], 'a word posted since the last rebuild is not offered yet');
select results_eq(
  $$ select added, removed from public.rebuild_search_terms() $$,
  $$ values (1, 0) $$,
  'the next rebuild adds it'
);
select is(pg_temp.completions('quil'), array['quillonbright', 'quillonquay'],
  'the word more posts write comes first');
select is(pg_temp.completions('quil', 1), array['quillonbright'], 'the limit cuts the list from its end');
select is(cardinality(pg_temp.completions('quil', 0)), 0, 'a limit of none offers none');
select ok(cardinality(pg_temp.completions('quil', 1000)) <= 10, 'a limit past ten is held to ten');

-- A word leaves with its second creator.
update public.posts set visibility = 'private' where id = pg_temp.uid('26');
select results_eq(
  $$ select added, removed from public.rebuild_search_terms() $$,
  $$ values (0, 0) $$,
  'a post made private removes no word another post still shows'
);
select is(pg_temp.completions('quillonq'), '{}'::text[],
  'but the word is no longer offered: one creator writes it now');
select results_eq(
  $$ select post_count, creator_count from public.search_terms where term = 'quillonquay' $$,
  $$ values (1, 1) $$,
  'its counts follow'
);

-- ─── Completions: the last of several words ─────────────────────────────────

select is(pg_temp.completions('glassharbor quil'), array['glassharbor quillonbright'],
  'the last word is completed when posts of two creators hold the whole phrase');
select is(pg_temp.completions('Glassharbor   QUIL'), array['glassharbor quillonbright'],
  'read lower-cased with one space between words');
select is(pg_temp.completions('amberline quil'), '{}'::text[],
  'a phrase only one creator''s post holds is not offered, though two creators write each word');
select is(pg_temp.completions('nowhereword quil'), '{}'::text[],
  'nor a phrase no post holds: a completion never leads to an empty search');
select is(pg_temp.completions('glassharbor q'), '{}'::text[], 'the last word needs two letters');
select ok(
  (select count(*) > 0 from public.search_public_posts('glassharbor quillonbright')),
  'the phrase offered is one post search finds a post for'
);

-- ─── Creators ───────────────────────────────────────────────────────────────

select is(pg_temp.handles('aria'), array['aria', 'aria-fennick', 'brisa-tolland'],
  'the handle that is the query, then the handle that starts with it, then the name that does');
select is(pg_temp.handles('ARIA'), array['aria', 'aria-fennick', 'brisa-tolland'], 'whatever the case typed');
select is(pg_temp.handles('aria', null, true), array['aria', 'aria-fennick'],
  'a query typed as a handle is matched against handles alone');
select ok('vesper-lund' = any (pg_temp.handles('v')), 'one letter is enough for a handle');
select is(pg_temp.handles('fennick'), '{}'::text[], 'a word inside a name or handle is search''s to find, not a suggestion');
select is(pg_temp.handles('ar', null, false, 2), (pg_temp.handles('ar'))[1:2],
  'the limit cuts the list from its end');
select is(cardinality(pg_temp.handles('ar', null, false, 2)), 2, 'to as many as asked for');
select is(cardinality(pg_temp.handles('ar', null, false, 0)), 0, 'a limit of none offers none');
select ok(cardinality(pg_temp.handles('a', null, false, 1000)) <= 10, 'a limit past ten is held to ten');

select ok(not 'arguest-anon' = any (pg_temp.handles('ar')), 'a guest is never offered, whatever handle its profile holds');
select ok(not 'arbanned-one' = any (pg_temp.handles('ar')), 'nor a suspended account');
select ok(not 'ardeleting-one' = any (pg_temp.handles('ar')), 'nor an account being deleted');
select ok('arpast-ban' = any (pg_temp.handles('ar')), 'an account whose suspension has ended is');
select ok('arden-blocked' = any (pg_temp.handles('ar')) and 'arwen-blocker' = any (pg_temp.handles('ar')),
  'with no viewer, nobody is blocked');
select ok(not 'arden-blocked' = any (pg_temp.handles('ar', pg_temp.uid('05'))),
  'a creator the viewer blocked is never offered to that viewer');
select ok(not 'arwen-blocker' = any (pg_temp.handles('ar', pg_temp.uid('05'))),
  'nor a creator who blocked the viewer');
select ok(not 'arden-blocked' = any (pg_temp.handles('arden-blocked', pg_temp.uid('05'))),
  'not even by the whole handle');

select is(
  (select is_following from public.search_suggest_creators('arlo', pg_temp.uid('05'))),
  true,
  'a creator the viewer follows is marked'
);
select is(
  (select is_following from public.search_suggest_creators('arlo', null)),
  false,
  'and not for a visitor'
);
-- The handles starting 'ar' are one tier: the one more people follow leads, until the viewer's own follow lifts another.
select is((pg_temp.handles('ar'))[1], 'aria-fennick', 'inside a tier the creator with the larger audience leads');
select is((pg_temp.handles('ar', pg_temp.uid('05')))[1], 'arlo-quist', 'and a follow lifts a creator to the head of its tier');
select is(pg_temp.handles('aria', pg_temp.uid('05')), array['aria', 'aria-fennick', 'brisa-tolland'],
  'but never past a stronger tier: the followed name match stays behind both handles');
-- The order is Creators search's order over the same people.
select is(
  pg_temp.handles('ar', pg_temp.uid('05')),
  (select array_agg(found.username order by found.position)
   from public.search_public_creators('ar', pg_temp.uid('05'), null, null, 25)
     with ordinality as found(creator_user_id, username, display_name, bio, avatar_url, public_post_count, is_following, search_score, position)
   where (lower(found.username) like 'ar%' or lower(found.display_name) like 'ar%')
     and found.username not in ('arguest-anon', 'arbanned-one', 'ardeleting-one')),
  'creators come in the order Creators search gives the same people'
);

-- ─── Odd input ──────────────────────────────────────────────────────────────

select is(pg_temp.handles('%'), '{}'::text[], 'a % is not every creator');
select is(pg_temp.handles('ar%'), '{}'::text[], 'nor a wildcard after letters');
select is(pg_temp.handles('ar_a'), '{}'::text[], 'an _ is not any letter');
select is(pg_temp.handles('aria\'), '{}'::text[], 'a backslash escapes nothing');
select is(pg_temp.completions('quil%'), '{}'::text[], 'a % completes nothing');
select is(pg_temp.completions('qu_l'), '{}'::text[], 'an _ is not any letter in a word');
select is(pg_temp.completions('quil\'), '{}'::text[], 'nor is a backslash');
select is(pg_temp.completions('glassharbor% quil'), array['glassharbor% quillonbright'],
  'a % among the earlier words is a character, and the phrase is read as post search reads it');

create function pg_temp.answers(p_query text)
returns boolean
language plpgsql
as $$
declare
  v_answer jsonb;
begin
  v_answer := public.search_suggestions(p_query, pg_temp.uid('05'));
  return jsonb_typeof(v_answer -> 'creators') = 'array' and jsonb_typeof(v_answer -> 'completions') = 'array';
end;
$$;

select ok(
  (select bool_and(pg_temp.answers(odd.query))
   from unnest(array[
     '''', '"', '''''''', '"quil"', '%', '%%%', '_', '__', '\', '\\', 'ar\', '\%',
     'a & b', 'a | b', '!a', 'a:*', 'quil:*', '(a', 'a)', '<->', 'a <2> b', '&', '|', ':', '*',
     '🔥', '🔥🔥', 'ar🔥', 'quil 🔥', '🔥 quil', 'é', 'ça va', '日本', '日本語 quil',
     repeat('a', 200), repeat('quil ', 40), repeat('%', 200), repeat('🔥', 100),
     '', ' ', null, E'\t', E'a\nb', '@', '@@ar'
   ]) as odd(query)),
  'quotes, wildcards, backslashes, tsquery syntax, emoji, other scripts, 200 characters, nothing at all: each is answered with two lists'
);
select is(
  (select jsonb_array_length(public.search_suggestions(repeat('a', 200)) -> 'creators')),
  0,
  'a query past 100 characters offers nobody'
);

-- ─── The one call ───────────────────────────────────────────────────────────

select is(
  (select array_agg(key order by key) from jsonb_object_keys(public.search_suggestions('ar')) as key),
  array['completions', 'creators'],
  'the answer holds creators and completions, and nothing else yet'
);
select is(
  public.search_suggestions('aria', null, false, 1, 6) -> 'creators',
  jsonb_build_array(jsonb_build_object(
    'id', pg_temp.uid('04'), 'username', 'aria', 'display_name', 'Solo Aria', 'avatar_url', null, 'is_following', false
  )),
  'a creator is what a row draws: id, handle, name, avatar, the viewer''s follow'
);
select is(
  public.search_suggestions('quil') -> 'completions',
  '[{"text": "quillonbright"}]'::jsonb,
  'a completion is its text'
);
select is(
  public.search_suggestions('glass', null, true) -> 'completions',
  '[]'::jsonb,
  'a query typed as a handle is offered no words'
);

-- ─── Whose they are ─────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.search_suggestions(text, uuid, boolean, integer, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_suggestions(text, uuid, boolean, integer, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.search_suggest_creators(text, uuid, boolean, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_suggest_creators(text, uuid, boolean, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.search_suggest_completions(text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_suggest_completions(text, integer)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.rebuild_search_terms()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.rebuild_search_terms()', 'EXECUTE'),
  'no client role may call the suggestion functions or the rebuild'
);
select ok(
  has_function_privilege('service_role', 'public.search_suggestions(text, uuid, boolean, integer, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_suggest_creators(text, uuid, boolean, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_suggest_completions(text, integer)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.rebuild_search_terms()', 'EXECUTE'),
  'the service role may'
);

-- As the route calls it: the service role, with only its own grants.
set local role service_role;
select is(
  (select public.search_suggestions('aria', '0000e5d7-0000-4000-9000-000000000005'::uuid) -> 'creators' -> 0 ->> 'username'),
  'aria',
  'the service role reads creators through the call, guests and suspensions included in what it leaves out'
);
select is(
  (select public.search_suggestions('glassharbor quil') -> 'completions' -> 0 ->> 'text'),
  'glassharbor quillonbright',
  'and completions, the phrase check included'
);
reset role;

select * from finish();
rollback;
