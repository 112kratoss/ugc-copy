-- Suggestions and popular lists made from content
-- (20261115105944_search_content_suggestions.sql).
--
-- search_phrases holds the phrases and names unlabelled public posts of two
-- creators show, and nothing a visitor cannot see: no phrase of a labelled,
-- private, hidden or archived post, of a paid recipe's caption or prompt, or
-- of a template result's hidden model. Completions offer them by any word, a
-- start first, and the corrected reading when nothing completes what was
-- typed; a viewer with a block is offered only what two posts they may see
-- hold. A picture is of a post the row opens for that viewer, never a
-- labelled one, checked at the read. search_popularity counts each model's,
-- tool's and creator's week per creator, the starter orders by it without
-- the creators blocked with the viewer and says which period each list is
-- of, and related searches come from the posts of a result page.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(264);

create function pg_temp.uid(p_suffix text)
returns uuid
language sql
as $$ select ('0000c5e6-0000-4000-9000-0000000000' || p_suffix)::uuid; $$;

create function pg_temp.completions(p_query text, p_viewer uuid default null, p_limit integer default 10)
returns text[]
language sql
as $$
  select coalesce(array_agg(completion order by position), '{}')
  from public.search_suggest_completions(p_query, p_limit, p_viewer) with ordinality as offered(completion, position);
$$;

create function pg_temp.phrases(p_text text)
returns text[]
language sql
as $$ select coalesce(array_agg(phrase order by phrase), '{}') from public.search_text_phrases(p_text); $$;

create function pg_temp.related(p_query text, p_posts text[], p_viewer uuid default null, p_corrected text default null)
returns text[]
language sql
as $$
  select coalesce(array_agg(related order by position), '{}')
  from public.search_related_searches(
    p_query, p_viewer, array(select pg_temp.uid(suffix) from unnest(p_posts) as suffix), p_corrected, 6
  ) with ordinality as offered(related, position);
$$;

-- How many posts a search opens for a viewer, read as typed.
create function pg_temp.opened(p_query text, p_viewer uuid default null, p_made_with text default null)
returns integer
language sql
as $$
  select count(*)::integer
  from public.search_public_posts(
    p_query => p_query, p_viewer_user_id => p_viewer, p_limit => 25, p_made_with => p_made_with, p_correct => false
  );
$$;

-- ─── How a text is read ─────────────────────────────────────────────────────

select is(pg_temp.phrases('Cinematic portrait lighting'),
  array['cinematic portrait', 'cinematic portrait lighting', 'portrait lighting'],
  'words next to each other make phrases of two and of three');
select is(pg_temp.phrases('Queen of Hearts'), array['queen of hearts'],
  'a phrase neither starts nor ends on a stop word; one may sit in the middle of three');
select is(pg_temp.phrases('a portrait of the queen'), '{}'::text[],
  'so a word and its stop words are no phrase');
select is(pg_temp.phrases('Marble, staircase study. Evening light'), array['evening light', 'staircase study'],
  'no phrase crosses a comma or a full stop');
select is(pg_temp.phrases(E'neon city\nrain street'), array['neon city', 'rain street'],
  'nor a line break');
select is(pg_temp.phrases('orbit 2049 skyline in 8k detail'), '{}'::text[],
  'a number is no word of a phrase, and ends one');
select is(pg_temp.phrases('hyper-realistic close-up'), array['hyper realistic', 'hyper realistic close', 'realistic close'],
  'a hyphen parts words');
select is(pg_temp.phrases('the queen''s gambit board'), array['gambit board', 'queens gambit', 'queens gambit board'],
  'an apostrophe is part of its word');
select is(pg_temp.phrases('very very very'), '{}'::text[], 'a word repeated is no phrase');
select is(pg_temp.phrases(repeat('filler ', 80) || 'amber lantern'), '{}'::text[],
  'only the first 500 characters are read');
select is(pg_temp.phrases(null), '{}'::text[], 'no text, no phrase');

select is(public.search_entity_phrase('tool', 'lumen-forge', 'Lumen  Forge'), 'lumen forge',
  'a name is offered as its post prints it, lowercased, one space between words');
select is(public.search_entity_phrase('model', 'kling-2.6', 'Kling 2.6'), 'kling 2.6', 'digits and dots stay');
select is(public.search_entity_phrase('model', 'nano-banana-pro', 'nano-banana-pro'), 'nano banana pro',
  'a post that prints only the key is read by the key''s words');
select is(public.search_entity_phrase('model', 'veo-3.1', 'veo-3.1'), null,
  'unless the key holds a number');
select is(public.search_entity_phrase('tool', 'magicbooklet', 'Magicbooklet'), null, 'never the app');
select is(public.search_entity_phrase('tool', 'magic-booklet', 'Magic Booklet'), null, 'however it is spelt');
select is(public.search_entity_phrase('tool', 'x', 'A tool with far too many words in its name'), null,
  'nor a name of more than four words');

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- …01 ada-lark, …02 bo-finch, …03 cy-wren, …04 dee-rook: creators.
-- …05 vi-heron, the viewer: blocked …02, and is blocked by …06 (eb-crane).
-- …07 and …08: readers who save and comment.
-- Posts, one fact each (the words are made up so nothing else holds them):
--   amberglow lanterns  titles of …01, …02 and …03
--   velvet harbor       titles of …02 and …06: the viewer may see neither
--   copper meadow       titles of …01 and …02: the viewer may see one
--   solitary beacon     three posts of …01 alone
--   veiled orchard      labelled posts of …01 and …02
--   hushed draft        private posts; muted hollow, hidden; faded archive, archived
--   sealed cipher       the prompts, and lockedgrade ember the captions, under paid recipes of …01 and …02
--   queen of hearts     titles of …01 and …03
--   Lumen Forge         the tool of posts of …01 and …02
--   veltrix-nova        the model of creations of …01 and …03
--   zorblax-prime       the hidden model of template results of …01 and …02

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at, is_anonymous)
select pg_temp.uid(suffix), 'c5e6-' || suffix || '@example.invalid', 'authenticated', 'authenticated',
       '{}'::jsonb, '{}'::jsonb, now() - interval '90 days', false
from unnest(array['01', '02', '03', '04', '05', '06', '07', '08']) as suffix;

update public.profiles as profiles
set username = named.username, display_name = named.display_name
from (
  values
    ('01', 'ada-lark', 'Ada Lark'), ('02', 'bo-finch', 'Bo Finch'), ('03', 'cy-wren', 'Cy Wren'),
    ('04', 'dee-rook', 'Dee Rook'), ('05', 'vi-heron', 'Vi Heron'), ('06', 'eb-crane', 'Eb Crane'),
    ('07', 'fay-swift', 'Fay Swift'), ('08', 'gus-plover', 'Gus Plover')
) as named(suffix, username, display_name)
where profiles.id = pg_temp.uid(named.suffix);

insert into public.user_blocks (blocker_user_id, blocked_user_id) values
  (pg_temp.uid('05'), pg_temp.uid('02')),
  (pg_temp.uid('06'), pg_temp.uid('05'));

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw, archived_at,
  title, body, prompt, showcase_asset_path, source_tool, source_tool_slug, save_count, created_at, updated_at
)
select
  pg_temp.uid(post.suffix), pg_temp.uid(post.owner), post.visibility, 'image', 'external', 'media',
  post.review_status, post.is_nsfw, case when post.archived then now() end,
  post.title, post.body, post.prompt, 'showcase/c5e6-' || post.suffix || '.png',
  post.tool, lower(replace(post.tool, ' ', '-')), post.saves,
  now() - post.age, now() - post.age
from (
  values
    ('11', '01', 'public', 'visible', false, false, 'Amberglow lanterns at dusk', 'First pier.', null, 'Midjourney', 1, interval '1 hour'),
    ('12', '02', 'public', 'visible', false, false, 'Amberglow lanterns again', 'Second pier.', null, 'Midjourney', 9, interval '2 hours'),
    ('13', '03', 'public', 'visible', false, false, 'Amberglow lanterns over water', 'Third pier.', null, 'Midjourney', 5, interval '3 hours'),
    ('14', '02', 'public', 'visible', false, false, 'Velvet harbor one', 'Fourth pier.', null, 'Midjourney', 0, interval '1 hour'),
    ('15', '06', 'public', 'visible', false, false, 'Velvet harbor two', 'Fifth pier.', null, 'Midjourney', 0, interval '1 hour'),
    ('16', '01', 'public', 'visible', false, false, 'Copper meadow one', 'Sixth pier.', null, 'Midjourney', 0, interval '1 hour'),
    ('17', '02', 'public', 'visible', false, false, 'Copper meadow two', 'Seventh pier.', null, 'Midjourney', 0, interval '1 hour'),
    ('18', '01', 'public', 'visible', false, false, 'Solitary beacon one', null, null, 'Midjourney', 0, interval '1 hour'),
    ('19', '01', 'public', 'visible', false, false, 'Solitary beacon two', null, null, 'Midjourney', 0, interval '1 hour'),
    ('1a', '01', 'public', 'visible', false, false, 'Solitary beacon three', null, null, 'Midjourney', 0, interval '1 hour'),
    ('1b', '01', 'public', 'visible', true, false, 'Veiled orchard one', null, null, 'Midjourney', 50, interval '1 hour'),
    ('1c', '02', 'public', 'visible', true, false, 'Veiled orchard two', null, null, 'Midjourney', 50, interval '1 hour'),
    ('1d', '01', 'private', 'visible', false, false, 'Hushed draft one', null, null, 'Midjourney', 0, interval '1 hour'),
    ('1e', '02', 'private', 'visible', false, false, 'Hushed draft two', null, null, 'Midjourney', 0, interval '1 hour'),
    ('1f', '01', 'public', 'hidden', false, false, 'Muted hollow one', null, null, 'Midjourney', 0, interval '1 hour'),
    ('20', '02', 'public', 'hidden', false, false, 'Muted hollow two', null, null, 'Midjourney', 0, interval '1 hour'),
    ('21', '01', 'public', 'visible', false, true, 'Faded archive one', null, null, 'Midjourney', 0, interval '1 hour'),
    ('22', '02', 'public', 'visible', false, true, 'Faded archive two', null, null, 'Midjourney', 0, interval '1 hour'),
    ('23', '01', 'public', 'visible', false, false, 'Recipe post alpha',
     E'Saved generation setup\nGrade: lockedgrade ember', 'the sealed cipher words', 'Midjourney', 0, interval '1 hour'),
    ('24', '02', 'public', 'visible', false, false, 'Recipe post beta',
     E'Saved generation setup\nGrade: lockedgrade ember', 'more sealed cipher words', 'Midjourney', 0, interval '1 hour'),
    ('25', '01', 'public', 'visible', false, false, 'Queen of hearts', null, null, 'Midjourney', 0, interval '1 hour'),
    ('26', '03', 'public', 'visible', false, false, 'Queen of hearts', null, null, 'Midjourney', 0, interval '1 hour'),
    ('27', '01', 'public', 'visible', false, false, 'Workshop bench alpha', 'Made with lumen forge today.', null, 'Lumen Forge', 2, interval '1 hour'),
    ('28', '02', 'public', 'visible', false, false, 'Workshop bench beta', 'Made with lumen forge today.', null, 'Lumen Forge', 7, interval '1 hour'),
    -- Twenty days old: a week of the three before this one.
    ('29', '01', 'public', 'visible', false, false, 'Older bench', null, null, 'Lumen Forge', 0, interval '20 days'),
    ('2a', '04', 'public', 'visible', false, false, 'Runway reel one', null, null, 'Runway', 0, interval '1 hour'),
    ('2b', '03', 'public', 'visible', false, false, 'Runway reel two', null, null, 'Runway', 0, interval '1 hour')
) as post(suffix, owner, visibility, review_status, is_nsfw, archived, title, body, prompt, tool, saves, age);

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
                                       'textContent', 'the sealed cipher item a buyer unlocks')),
  '[]'::jsonb, 300, 0, 0, now(), now()
from (
  values ('31', '23', '01', 'Recipe post alpha'), ('32', '24', '02', 'Recipe post beta')
) as recipe(suffix, post_suffix, owner, title);

-- Creations: veltrix-nova of …01 and …03, shown; zorblax-prime of …01 and
-- …02, a template's, shown nowhere.
insert into public.templates (id, name, creator_user_id, status, is_active)
values (pg_temp.uid('41'), 'Content suggestions fixture', pg_temp.uid('04'), 'draft', true);
insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
)
select pg_temp.uid(run.suffix), pg_temp.uid('41'), pg_temp.uid(run.owner), '{"version":1,"nodes":[],"edges":[]}'::jsonb,
       repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'output', 'image', 'collecting_inputs', 10, 10
from (values ('42', '01'), ('43', '02')) as run(suffix, owner);
insert into public.generations (id, user_id, model, status, is_public, template_run_id) values
  (pg_temp.uid('51'), pg_temp.uid('01'), 'veltrix-nova', 'succeeded', true, null),
  (pg_temp.uid('52'), pg_temp.uid('03'), 'veltrix-nova', 'succeeded', true, null),
  (pg_temp.uid('53'), pg_temp.uid('01'), 'zorblax-prime', 'succeeded', true, pg_temp.uid('42')),
  (pg_temp.uid('54'), pg_temp.uid('02'), 'zorblax-prime', 'succeeded', true, pg_temp.uid('43'));
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, showcase_asset_path, source_tool, source_tool_slug, generation_id, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', 'magicbooklet', 'media', 'visible', false,
       post.title, 'showcase/c5e6-' || post.suffix || '.png', 'Magicbooklet', 'magicbooklet', pg_temp.uid(post.generation), now(), now()
from (
  values
    ('2c', '01', 'Creation one', '51'), ('2d', '03', 'Creation two', '52'),
    ('2e', '01', 'Result one', '53'), ('2f', '02', 'Result two', '54')
) as post(suffix, owner, title, generation);

-- Covers. Readers saved …12 most of the amberglow posts, then …13, then …11
-- not at all; of the Lumen Forge posts …28 most, then …27. The save_count a
-- post carries says otherwise for none of them, and decides nothing.
insert into public.post_media (post_id, storage_path, media_kind, content_type, width, height, sort_order,
  preview_storage_path, preview_thumbhash, preview_status)
select pg_temp.uid(cover.suffix), 'c5e6/' || cover.suffix || '/source.png', cover.kind, 'image/png', 800, 1200, 0,
       'c5e6/' || cover.suffix || '/preview.webp', 'hash-' || cover.suffix, 'ready'
from (
  values ('11', 'image'), ('12', 'image'), ('13', 'video'), ('27', 'image'), ('28', 'image'), ('2a', 'image'), ('2b', 'image')
) as cover(suffix, kind);

-- What the posts received. …07 and …08 comment on …27 this week (…07 twice,
-- and once more in a removed comment), …07 saves …28 this week, …02 saves
-- its own …28, and …07 saved …29 twenty days ago.
insert into public.post_saves (user_id, post_id, created_at) values
  (pg_temp.uid('07'), pg_temp.uid('28'), now() - interval '1 day'),
  (pg_temp.uid('02'), pg_temp.uid('28'), now() - interval '1 day'),
  (pg_temp.uid('07'), pg_temp.uid('29'), now() - interval '20 days'),
  -- Ten days ago, so no week count moves: what orders the pictures.
  (pg_temp.uid('08'), pg_temp.uid('28'), now() - interval '10 days'),
  (pg_temp.uid('04'), pg_temp.uid('28'), now() - interval '10 days'),
  (pg_temp.uid('07'), pg_temp.uid('12'), now() - interval '10 days'),
  (pg_temp.uid('08'), pg_temp.uid('12'), now() - interval '10 days'),
  (pg_temp.uid('07'), pg_temp.uid('13'), now() - interval '10 days');
insert into public.post_comments (post_id, user_id, body, status, created_at) values
  (pg_temp.uid('27'), pg_temp.uid('07'), 'Lovely', 'active', now() - interval '2 days'),
  (pg_temp.uid('27'), pg_temp.uid('07'), 'Again', 'active', now() - interval '1 day'),
  (pg_temp.uid('27'), pg_temp.uid('08'), 'Nice', 'active', now() - interval '1 day'),
  (pg_temp.uid('27'), pg_temp.uid('04'), 'Removed', 'removed_by_author', now() - interval '1 day'),
  (pg_temp.uid('27'), pg_temp.uid('01'), 'My own', 'active', now() - interval '1 day');

-- The rebuilds, each in its own statement: a statement does not see what a
-- function it calls has just changed.
select ok((select added > 0 from public.rebuild_search_terms()), 'fixture: a rebuild fills the dictionary');
select ok((select phrases > 0 and subjects > 0 from public.rebuild_search_phrases()),
  'a rebuild fills the phrases and the popularity, and says how many rows each holds');
select results_eq(
  $$ select phrases, subjects from public.rebuild_search_phrases() $$,
  $$ select (select count(*)::integer from public.search_phrases), (select count(*)::integer from public.search_popularity) $$,
  'a second rebuild answers the same counts'
);

-- ─── The phrases a rebuild keeps ────────────────────────────────────────────

select results_eq(
  $$ select post_count, creator_count, in_text, is_name, core from public.search_phrases where phrase = 'amberglow lanterns' $$,
  $$ values (3, 3, true, false, 'amberglow lanterns') $$,
  'a phrase counts the posts that hold it and the different creators among them'
);
select results_eq(
  $$ select post_count, creator_count, core from public.search_phrases where phrase = 'queen of hearts' $$,
  $$ values (2, 2, 'queen hearts') $$,
  'a phrase''s core is the phrase less its stop words'
);
select is((select count(*) from public.search_phrases where phrase like 'solitary%'), 0::bigint,
  'three posts of one creator make no phrase');
select is(
  (select count(*) from public.search_phrases
   where phrase ~ 'veiled|orchard|hushed|draft|muted|hollow|faded|archive|sealed|cipher|lockedgrade|ember'),
  0::bigint,
  'no phrase of a labelled, private, hidden or archived post, a paid recipe''s caption, its prompt or its items is kept'
);
select results_eq(
  $$ select post_count, creator_count, in_text, is_name from public.search_phrases where phrase = 'lumen forge' $$,
  $$ values (3, 2, false, true) $$,
  'a tool two creators'' posts are made with is kept by its name, and not as a phrase of the captions that write it'
);
select is((select count(*) from public.search_phrases where phrase like '%forge today%' or phrase like 'made lumen%'), 0::bigint,
  'a phrase with one of the post''s own tool names in it is not counted');
select results_eq(
  $$ select creator_count, is_name from public.search_phrases where phrase = 'veltrix nova' $$,
  $$ values (2, true) $$,
  'a creation''s model is kept by its key''s words'
);
select is((select count(*) from public.search_phrases where phrase ~ 'zorblax|template|workflow'), 0::bigint,
  'a template result''s hidden model is no phrase, nor is the name that stands in for it');
select is((select count(*) from public.search_phrases where phrase ~ 'magicbooklet'), 0::bigint,
  'the app''s own name is no phrase');
select is((select count(*) from public.search_phrases where creator_count < 2 or post_count < creator_count), 0::bigint,
  'every phrase is held by posts of two creators or more');
select ok(
  (select recent_weight between 2.9 and 3.0 and week_activity = 3
   from public.search_phrases where phrase = 'amberglow lanterns'),
  'recent_weight counts today''s posts whole, and week_activity what they gained this week'
);
select is(
  (select picture_post_ids from public.search_phrases where phrase = 'amberglow lanterns'),
  array[pg_temp.uid('12'), pg_temp.uid('13'), pg_temp.uid('11')],
  'the pictured posts are kept, the one other accounts saved and commented on most first'
);
select is(
  (select picture_post_ids from public.search_phrases where phrase = 'copper meadow'),
  '{}'::uuid[],
  'a phrase whose posts have no ready cover keeps none'
);

-- ─── Completions ─────────────────────────────────────────────────────────────

select is(pg_temp.completions('amb'), array['amberglow', 'amberglow lanterns'],
  'a prefix offers the word and the phrase it starts');
select is(pg_temp.completions('lant'), array['lanterns', 'amberglow lanterns'],
  'and a phrase by a later word of it, after what the text starts');
select is(pg_temp.completions('amberglow la'), array['amberglow lanterns'],
  'of several words, the phrase that holds the earlier ones, once');
select is(pg_temp.completions('lanterns amb'), array['amberglow lanterns'],
  'in whatever order they were typed');
select is(pg_temp.completions('amberglow lanterns'), '{}'::text[], 'a phrase typed in full is not offered back');
select is(pg_temp.completions('queen o'), array['queen of hearts'], 'one letter of the next word is enough');
select is(pg_temp.completions('hea'), array['hearts', 'queen of hearts'], 'a phrase is found by its last word too');
select is(pg_temp.completions('lum'), array['lumen forge'], 'a tool''s name completes what is typed');
select is(pg_temp.completions('forg'), array['lumen forge'], 'by any word of it');
select is(pg_temp.completions('veltrix n'), array['veltrix nova'], 'a model''s name too');
select is(pg_temp.completions('zorb'), '{}'::text[], 'never a template result''s hidden model');
select is(pg_temp.completions('magic'), '{}'::text[], 'never the app');
select is(pg_temp.completions('soli'), '{}'::text[], 'nothing one creator alone writes');
select is(pg_temp.completions('veil'), '{}'::text[], 'nothing only labelled posts hold');
select is(pg_temp.completions('seal'), '{}'::text[], 'nothing only a recipe post''s prompt holds');
select is(pg_temp.completions('lockedg'), '{}'::text[], 'nothing only a paid recipe''s caption holds');
select is(pg_temp.completions('amb%'), '{}'::text[], 'a % is not a wildcard');
select is(pg_temp.completions('amb', null, 1), array['amberglow'], 'the limit cuts the list from its end');
select ok(cardinality(pg_temp.completions('a', null, 1000)) <= 10, 'a limit past ten is held to ten');

-- The corrected reading, only when nothing completes the text as typed.
select is(pg_temp.completions('ambergliw'), array['amberglow', 'amberglow lanterns'],
  'a misspelling that completes nothing is read as search reads it, and that reading is offered and completed');
select is(pg_temp.completions('ambergliw lant'), array['amberglow lanterns'],
  'of several words too');
select is(pg_temp.completions('zzzzqqqq'), '{}'::text[], 'a text with no near word is offered nothing');

-- Every completion opens a page of two posts or more.
select is(
  (select count(*) from unnest(pg_temp.completions('amb') || pg_temp.completions('lum') || pg_temp.completions('queen o')
     || pg_temp.completions('veltrix n') || pg_temp.completions('hea')) as offered(text)
   where pg_temp.opened(offered.text) < 2),
  0::bigint,
  'pressing a completion finds at least two posts'
);

-- A viewer with a block.
select is(pg_temp.completions('velv'), array['velvet', 'velvet harbor'],
  'fixture: a visitor is offered a word and a phrase of two creators');
select is(pg_temp.completions('velv', pg_temp.uid('05')), '{}'::text[],
  'the viewer is not: one of the two creators they blocked, the other blocked them');
select is(pg_temp.completions('copp', pg_temp.uid('05')), '{}'::text[],
  'nor what one post they may see holds: it would open a page of one');
select is(pg_temp.completions('amb', pg_temp.uid('05')), array['amberglow', 'amberglow lanterns'],
  'what two posts they may see hold is still offered');
select is(pg_temp.completions('velv', pg_temp.uid('07')), array['velvet', 'velvet harbor'],
  'an account with no block is offered what a visitor is');

-- A withdrawn word.
insert into public.search_suggestion_denylist (term, note) values ('lanterns', 'test');
select is(pg_temp.completions('amb'), array['amberglow'], 'a phrase that holds a withdrawn word is not offered');
select is(pg_temp.completions('lant'), '{}'::text[], 'nor the word');
select is(pg_temp.completions('lanterns amb'), '{}'::text[], 'and a query that holds it is offered no phrase');
delete from public.search_suggestion_denylist where term = 'lanterns';
insert into public.search_suggestion_denylist (term, note) values ('forge', 'test');
select is(pg_temp.completions('lum'), '{}'::text[], 'a name that holds a withdrawn word is not offered');
delete from public.search_suggestion_denylist where term = 'forge';

-- ─── Pictures ────────────────────────────────────────────────────────────────

select is(
  public.search_post_picture(pg_temp.uid('13')),
  jsonb_build_object('post_id', pg_temp.uid('13'), 'path', 'c5e6/13/preview.webp', 'thumbhash', 'hash-13',
                     'width', 800, 'height', 1200, 'media_kind', 'video'),
  'a post''s picture is its cover''s stored preview: path, thumbhash, size and kind (a video''s is its poster)'
);
select is(public.search_post_picture(pg_temp.uid('16')), null, 'a post with no cover has none');
select is(public.search_post_picture(pg_temp.uid('12'), pg_temp.uid('05')), null,
  'nor has the post of a creator the viewer blocked, for that viewer');
select is(public.search_query_picture('amberglow lanterns') ->> 'post_id', pg_temp.uid('12')::text,
  'a phrase is pictured by the most saved post that holds it');
select is(public.search_query_picture('amberglow lanterns', pg_temp.uid('05')) ->> 'post_id', pg_temp.uid('13')::text,
  'for the viewer, by the best one they may see');
select is(public.search_query_picture('copper meadow'), null, 'a phrase with no pictured post has no picture');
select is(public.search_query_picture('amberglow'), null, 'a text that is no kept phrase is not looked for unless asked');
select is(public.search_query_picture('amberglow', null, true) ->> 'post_id', pg_temp.uid('12')::text,
  'asked, it is pictured by the most saved post that holds its words');
select is(public.search_entity_picture('tool', 'lumen-forge') ->> 'post_id', pg_temp.uid('28')::text,
  'a tool is pictured by the most saved pictured post made with it');
select is(public.search_entity_picture('tool', 'lumen-forge', pg_temp.uid('05')) ->> 'post_id', pg_temp.uid('27')::text,
  'for the viewer, by one of a creator they have not blocked');
select is(public.search_entity_picture('tool', 'lumen-forge', null, 'workshop bench alpha') ->> 'post_id', pg_temp.uid('27')::text,
  'with a query, by a post that query''s search finds');
select is(public.search_entity_picture('model', 'veltrix-nova'), null, 'a model none of whose posts has a cover has none');

-- Checked at the read, not only at the rebuild. No rebuild runs from here on.
update public.post_media set preview_status = 'processing' where post_id = pg_temp.uid('12');
select is(public.search_query_picture('amberglow lanterns') ->> 'post_id', pg_temp.uid('13')::text,
  'a cover whose preview is not ready is passed over');
update public.post_media set preview_status = 'ready', preview_storage_path = 'private-posts/c5e6/12/preview.webp'
where post_id = pg_temp.uid('12');
select is(public.search_query_picture('amberglow lanterns') ->> 'post_id', pg_temp.uid('13')::text,
  'nothing of the private bucket is a picture');
update public.post_media set preview_storage_path = 'c5e6/12/preview.webp' where post_id = pg_temp.uid('12');
update public.posts set title = 'Something else entirely' where id = pg_temp.uid('12');
select is(public.search_query_picture('amberglow lanterns') ->> 'post_id', pg_temp.uid('13')::text,
  'a post that no longer holds the phrase no longer pictures it');
update public.posts set title = 'Amberglow lanterns again' where id = pg_temp.uid('12');
select is(public.search_query_picture('amberglow lanterns') ->> 'post_id', pg_temp.uid('12')::text,
  'fixture: the post is the phrase''s picture again');
update public.posts set review_status = 'hidden' where id = pg_temp.uid('12');
select is(public.search_query_picture('amberglow lanterns') ->> 'post_id', pg_temp.uid('13')::text,
  'a post hidden since the rebuild is never a picture');
update public.posts set review_status = 'visible' where id = pg_temp.uid('12');

select is(
  public.search_suggestions('lumen') -> 'entities' -> 0 -> 'thumbnail' ->> 'post_id',
  pg_temp.uid('28')::text,
  'the typeahead''s entity row carries its picture'
);
select is(
  public.search_suggestions('lumen', pg_temp.uid('05')) -> 'entities',
  '[]'::jsonb,
  'the viewer is not offered a tool whose second creator they blocked: for them one creator posts with it'
);
select is(
  public.search_suggestions('midj', pg_temp.uid('05')) -> 'entities' -> 0 -> 'thumbnail' ->> 'post_id',
  pg_temp.uid('13')::text,
  'a row the viewer is offered carries a picture of a post they may see'
);

-- A labelled post: its media moves to the private bucket with the label.
update public.post_media set
  storage_path = 'private-posts/c5e6/28/source.png',
  preview_storage_path = 'private-posts/c5e6/28/preview.webp'
where post_id = pg_temp.uid('28');
update public.posts set is_nsfw = true where id = pg_temp.uid('28');
select is(public.search_entity_picture('tool', 'lumen-forge') ->> 'post_id', pg_temp.uid('27')::text,
  'a post labelled since the rebuild is never a picture');
select is(public.search_post_picture(pg_temp.uid('28')), null, 'asked for by itself or not');
select is(
  public.search_suggestions('lumen') -> 'entities',
  '[]'::jsonb,
  'and with one creator''s unlabelled posts left, the typeahead does not offer the tool'
);
update public.posts set is_nsfw = false where id = pg_temp.uid('28');
update public.post_media set
  storage_path = 'c5e6/28/source.png',
  preview_storage_path = 'c5e6/28/preview.webp'
where post_id = pg_temp.uid('28');

-- ─── Popularity ──────────────────────────────────────────────────────────────

select results_eq(
  $$ select post_count, week_activity, round(base_activity::numeric, 2), picture_post_id
     from public.search_popularity where subject = 'tool' and key = 'lumen-forge' and creator_user_id = pg_temp.uid('01') $$,
  $$ values (2, 3::real, 0.67, pg_temp.uid('27')) $$,
  'a creator''s week for a tool: a new post and two commenters (their own comment, a removed one and a second comment by the same reader count for nothing); the weeks before: a post and a save, over three'
);
select results_eq(
  $$ select post_count, week_activity, round(base_activity::numeric, 2), picture_post_id
     from public.search_popularity where subject = 'tool' and key = 'lumen-forge' and creator_user_id = pg_temp.uid('02') $$,
  $$ values (1, 2::real, 0.67, pg_temp.uid('28')) $$,
  'another''s: a new post and a save by someone else (their own save counts for nothing); the weeks before: two saves, over three'
);
select results_eq(
  $$ select post_count from public.search_popularity where subject = 'creator' and key = '*' and creator_user_id = pg_temp.uid('02') $$,
  $$ select count(*)::integer from public.post_search_documents as documents
     join public.posts as posts on posts.id = documents.post_id
     where documents.creator_user_id = pg_temp.uid('02') and posts.is_nsfw = false $$,
  'a creator''s own row counts their unlabelled public posts'
);
select is(
  (select count(*) from public.search_popularity where key ~ 'zorblax|template'),
  0::bigint,
  'a template result''s hidden model has no row'
);
select is(public.search_week_score(10, 10) < public.search_week_score(10, 0), true,
  'a week above the subject''s own average scores over the same week at its average');
select is(public.search_week_score(0, 5), 0::double precision, 'a week of nothing scores nothing');

-- ─── The starter ─────────────────────────────────────────────────────────────

select is(
  public.search_starter(null, '{}') -> 'periods',
  '{"entities": "week", "creators": "week", "searches": "week"}'::jsonb,
  'with three models and tools, three creators and six phrases active this week, every list is this week''s'
);
select is(
  (select array_agg(entity ->> 'key' order by position)
   from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') with ordinality as offered(entity, position)),
  array['midjourney', 'lumen-forge', 'veltrix-nova', 'runway'],
  'models and tools in the order of their week, never the app'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where (entity ->> 'post_count')::integer
     <> pg_temp.opened(entity ->> 'query', null, (entity ->> 'kind') || ':' || (entity ->> 'key'))),
  0::bigint,
  'for every row, the count is the posts search returns for its query narrowed to it'
);
select is(
  (select entity -> 'thumbnail' ->> 'post_id'
   from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity ->> 'key' = 'lumen-forge'),
  pg_temp.uid('28')::text,
  'each with a picture of a post it opens'
);
select is(
  (select array_agg(entity ->> 'key' order by position)
   from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 8, 0, 0) -> 'entities') with ordinality as offered(entity, position)),
  array['midjourney', 'veltrix-nova', 'runway'],
  'the viewer''s list leaves out a tool only one creator they may see uses'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 8, 0, 0) -> 'entities') as entity
   where (entity ->> 'post_count')::integer
     <> pg_temp.opened(entity ->> 'query', pg_temp.uid('05'), (entity ->> 'kind') || ':' || (entity ->> 'key'))),
  0::bigint,
  'and counts each as search counts it for them'
);
select ok(
  (select bool_and(creator ->> 'username' not in ('bo-finch', 'eb-crane', 'vi-heron'))
     and count(*) >= 3
   from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 0, 6, 0) -> 'creators') as creator),
  'this week''s creators never hold the viewer, a creator they blocked or one who blocked them'
);
select is(
  (select creator ->> 'username'
   from jsonb_array_elements(public.search_starter(null, '{}', 0, 6, 0) -> 'creators') with ordinality as offered(creator, position)
   order by position limit 1),
  'ada-lark',
  'the most active this week first'
);

-- Searches: what posts write, then the hand-picked terms until there are six.
select is(
  (select array_agg(search ->> 'text' order by position)
   from jsonb_array_elements(public.search_starter(null, array['Runway'], 0, 0, 8) -> 'searches') with ordinality as offered(search, position)),
  array['workshop bench', 'amberglow lanterns', 'copper meadow', 'queen of hearts', 'recipe post', 'velvet harbor'],
  'the phrases posts write, the most active this week first, never a model''s or tool''s name; six of them, so no hand-picked term'
);
select is(
  (select jsonb_agg(search -> 'thumbnail' -> 'post_id' order by position)
   from jsonb_array_elements(public.search_starter(null, '{}', 0, 0, 8) -> 'searches') with ordinality as offered(search, position)),
  jsonb_build_array(pg_temp.uid('28'), pg_temp.uid('12'), null, null, null, null),
  'each carries a picture of a post it finds, or null'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_starter(null, '{}', 0, 0, 8) -> 'searches') as search
   where pg_temp.opened(search ->> 'text') < 2),
  0::bigint,
  'and each opens two posts or more'
);
select is(
  (select array_agg(search ->> 'text' order by position)
   from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 0, 0, 8) -> 'searches') with ordinality as offered(search, position)),
  array['amberglow lanterns', 'queen of hearts'],
  'the viewer is offered only the phrases two posts they may see hold'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 0, 0, 8) -> 'searches') as search
   where pg_temp.opened(search ->> 'text', pg_temp.uid('05')) < 2),
  0::bigint,
  'and each opens two posts or more for them'
);
select is(
  public.search_starter(pg_temp.uid('05'), '{}', 0, 0, 8) -> 'periods' ->> 'searches',
  'all',
  'two phrases are not a week''s list'
);
-- A withdrawn word leaves five phrases: the hand-picked terms fill the list.
insert into public.search_suggestion_denylist (term, note) values ('amberglow', 'test');
select is(
  (select array_agg(search ->> 'text' order by position)
   from jsonb_array_elements(public.search_starter(null, array['nothingholdsthis', 'copper meadow', 'Runway', 'Solitary'], 0, 0, 8) -> 'searches')
     with ordinality as offered(search, position)),
  array['workshop bench', 'copper meadow', 'queen of hearts', 'recipe post', 'velvet harbor', 'Runway'],
  'a phrase that holds a withdrawn word is not offered; with fewer than six, the hand-picked terms follow until there are six: not one that finds no post, nor one offered already'
);
select is(
  public.search_starter(null, array['Runway'], 0, 0, 8) -> 'periods' ->> 'searches',
  'all',
  'a list with a hand-picked term in it is not this week''s'
);
select is(
  (select search -> 'thumbnail' ->> 'post_id'
   from jsonb_array_elements(public.search_starter(null, array['Runway'], 0, 0, 8) -> 'searches') as search
   where search ->> 'text' = 'Runway'),
  pg_temp.uid('2a')::text,
  'a hand-picked term carries the picture of a post that holds its words'
);
select is(
  (select array_agg(search ->> 'text' order by position)
   from jsonb_array_elements(public.search_starter(null, array['Workshop', 'Hearts queen', 'Runway'], 0, 0, 8) -> 'searches')
     with ordinality as offered(search, position)),
  array['workshop bench', 'copper meadow', 'queen of hearts', 'recipe post', 'velvet harbor', 'Runway'],
  'a hand-picked term that shares a word with a phrase already offered is the same subject again, and is not offered'
);
delete from public.search_suggestion_denylist where term = 'amberglow';

-- No two searches share a word.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', 'external', 'media', 'visible', false,
       post.title, 'showcase/c5e6-' || post.suffix || '.png', 'Midjourney', 'midjourney', now(), now()
from (
  values ('61', '01', 'Indigo terrace'), ('62', '03', 'Indigo terrace'), ('63', '01', 'Indigo garden'), ('64', '04', 'Indigo garden')
) as post(suffix, owner, title);
select ok((select phrases > 0 from public.rebuild_search_phrases()), 'fixture: a rebuild reads the new posts');
select is(
  (select array_agg(search ->> 'text' order by position)
   from jsonb_array_elements(public.search_starter(null, array['Runway'], 0, 0, 8) -> 'searches') with ordinality as offered(search, position)),
  array['workshop bench', 'amberglow lanterns', 'copper meadow', 'indigo garden', 'queen of hearts', 'recipe post', 'velvet harbor'],
  'of two phrases that share a word, one is offered'
);
select is(
  public.search_starter(null, array['Runway'], 0, 0, 8) -> 'periods' ->> 'searches',
  'week',
  'and the list is this week''s'
);

-- A quiet week: the lists fall back to the all-time ones, and say so.
update public.search_popularity set week_activity = 0 where subject in ('model', 'tool') and key <> 'midjourney';
update public.search_popularity set week_activity = 0 where subject = 'creator' and creator_user_id <> pg_temp.uid('01');
select is(
  public.search_starter(null, '{}') -> 'periods',
  '{"entities": "all", "creators": "all", "searches": "week"}'::jsonb,
  'with fewer than three rows active this week a list is the all-time one, and its period says so'
);
select is(
  (select array_agg(entity ->> 'key' order by entity ->> 'key')
   from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity),
  array['lumen-forge', 'midjourney', 'runway', 'veltrix-nova'],
  'the all-time list still holds every model and tool two creators use'
);
select ok(
  (select count(*) >= 3 from jsonb_array_elements(public.search_starter(null, '{}', 0, 6, 0) -> 'creators') as creator),
  'and the all-time creators are offered'
);
select is(
  (select entity -> 'thumbnail' ->> 'post_id'
   from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity ->> 'key' = 'lumen-forge'),
  pg_temp.uid('28')::text,
  'an all-time row carries its picture too'
);

-- ─── Related searches ────────────────────────────────────────────────────────

select is(pg_temp.related('amberglow', array['11', '12', '13']), array['amberglow lanterns', 'midjourney'],
  'a phrase two posts of the result page hold is a related search, and after it the name of the tool they are made with');
select is(pg_temp.related('amberglow lanterns', array['11', '12', '13']), array['midjourney'],
  'never the query itself');
select is(pg_temp.related('amberglw lanterns', array['11', '12', '13'], null, 'amberglow lanterns'), array['midjourney'],
  'nor its corrected reading');
select is(pg_temp.related('lanterns amberglow', array['11', '12', '13']), array['midjourney'],
  'nor a phrase whose every word the query says');
select is(pg_temp.related('midjourney', array['11', '12', '13']), array['amberglow lanterns'],
  'a name the query says is not offered back');
select is(pg_temp.related('bench', array['27', '28', '29']), array['workshop bench', 'lumen forge'],
  'what the posts write comes before what they are made with');
select is(pg_temp.related('amberglow', array['11']), '{}'::text[], 'one post is not two');
select is(pg_temp.related('amberglow', array['11', '12'], pg_temp.uid('05')), '{}'::text[],
  'a post the viewer may not see counts for nothing');
select is(pg_temp.related('amberglow', array['11', '12', '13'], pg_temp.uid('05')), array['amberglow lanterns', 'midjourney'],
  'two they may see are enough');
select is(pg_temp.related('orchard', array['1b', '1c']), '{}'::text[], 'labelled posts are not read');
select is(pg_temp.related('draft', array['1d', '1e', '1f', '20', '21', '22']), '{}'::text[],
  'nor private, hidden or archived ones');
select is(pg_temp.related('recipe', array['23', '24']), array['recipe post', 'midjourney'],
  'of a recipe post, only what its public text shows');
select is(pg_temp.related('amberglow', '{}'), '{}'::text[], 'no posts, no related searches');
select is(
  (select count(*) from unnest(pg_temp.related('bench', array['27', '28', '29']) || pg_temp.related('amberglow', array['11', '12', '13']))
     as offered(text)
   where pg_temp.opened(offered.text) < 2),
  0::bigint,
  'each related search finds at least two posts'
);
insert into public.search_suggestion_denylist (term, note) values ('lanterns', 'test');
select is(pg_temp.related('amberglow', array['11', '12', '13']), array['midjourney'],
  'a phrase that holds a withdrawn word is not related');
delete from public.search_suggestion_denylist where term = 'lanterns';

-- ─── Review of PR #826 ───────────────────────────────────────────────────────

-- 1. A three-word phrase longer than the table holds (60 characters) is not
-- read at all: before, the rebuild raised the table's check and every later
-- rebuild with it.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, showcase_asset_path, source_tool, source_tool_slug, save_count, comment_count, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', 'external', 'media', 'visible', false,
       post.title, 'showcase/c5e6-' || post.suffix || '.png', post.tool, lower(post.tool), post.counted, post.counted,
       now() - post.age, now() - post.age
from (
  values
    ('65', '01', 'Abcdefghijklmnopqrstuv bcdefghijklmnopqrstuvw cdefghijklmnopqrstuvwx', 'Midjourney', 0, interval '1 hour'),
    ('66', '02', 'Abcdefghijklmnopqrstuv bcdefghijklmnopqrstuvw cdefghijklmnopqrstuvwx', 'Midjourney', 0, interval '1 hour'),
    -- 10. Twelve posts of one creator this week, and one of another's two months ago.
    ('a0', '01', 'Saffron canyon', 'Canyonkit', 50, interval '0 hours'),
    ('a1', '01', 'Saffron canyon', 'Canyonkit', 0, interval '1 hour'),
    ('a2', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a3', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a4', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a5', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a6', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a7', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a8', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('a9', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('aa', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('ab', '01', 'Saffron canyon', 'Canyonkit', 0, interval '2 hours'),
    ('ac', '03', 'Saffron canyon', 'Canyonkit', 0, interval '60 days'),
    -- 12. Two posts of one creator and one of a creator the viewer blocked.
    ('b0', '01', 'Tidal ledger', 'Midjourney', 0, interval '1 hour'),
    ('b1', '01', 'Tidal ledger', 'Midjourney', 0, interval '1 hour'),
    ('b2', '02', 'Tidal ledger', 'Midjourney', 0, interval '1 hour')
) as post(suffix, owner, title, tool, counted, age);
-- 10, the order of completions. Two phrases that start with one word: "opal
-- garden", thirty posts of one creator today and one of another's; "opal
-- river", one post each of five creators.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', 'external', 'media', 'visible', false,
       post.title, 'showcase/c5e6-' || post.suffix || '.png', 'Canyonkit', 'canyonkit', now(), now()
from (
  select to_hex(192 + n) as suffix, '01' as owner, 'Opal garden' as title from generate_series(0, 29) as n
  union all
  values ('de', '02', 'Opal garden'),
         ('e3', '03', 'Opal river'), ('e4', '04', 'Opal river'), ('e5', '06', 'Opal river'),
         ('e6', '07', 'Opal river'), ('e7', '08', 'Opal river')
) as post(suffix, owner, title);
insert into public.post_media (post_id, storage_path, media_kind, content_type, width, height, sort_order,
  preview_storage_path, preview_thumbhash, preview_status)
select pg_temp.uid(cover.suffix), 'c5e6/' || cover.suffix || '/source.png', 'image', 'image/png', 800, 1200, 0,
       'c5e6/' || cover.suffix || '/preview.webp', 'hash-' || cover.suffix, 'ready'
from (values ('a0'), ('a1'), ('ac')) as cover(suffix);
-- 6. …a0 carries a save_count and a comment_count of 50, and five comments
-- of its own creator: counters and comments a creator can raise alone. One
-- reader saved …ac.
insert into public.post_comments (post_id, user_id, body, status, created_at)
select pg_temp.uid('a0'), pg_temp.uid('01'), 'Mine ' || n, 'active', now() from generate_series(1, 5) as n;
insert into public.post_saves (user_id, post_id, created_at) values
  (pg_temp.uid('07'), pg_temp.uid('ac'), now() - interval '3 days');

select lives_ok(
  $$ select * from public.rebuild_search_phrases() $$,
  'a rebuild survives posts of two creators that share three words too long to keep as a phrase'
);
select is(
  (select count(*) from public.search_phrases where char_length(phrase) > 60 or char_length(core) > 60),
  0::bigint,
  'and keeps no phrase over 60 characters'
);
select is(
  pg_temp.phrases('Abcdefghijklmnopqrstuv bcdefghijklmnopqrstuvw cdefghijklmnopqrstuvwx'),
  array['abcdefghijklmnopqrstuv bcdefghijklmnopqrstuvw', 'bcdefghijklmnopqrstuvw cdefghijklmnopqrstuvwx'],
  'three long words are read as their two-word halves: the three together are dropped where they are read'
);
select ok(
  exists (select 1 from public.search_phrases where phrase = 'abcdefghijklmnopqrstuv bcdefghijklmnopqrstuvw'),
  'and those are kept'
);

-- 10. One creator's volume.
select is(
  (select week_activity from public.search_phrases where phrase = 'saffron canyon'),
  11::real,
  'a creator''s new posts count toward a phrase''s week up to ten, as they do toward a model''s: twelve posts and one reader''s save count 11'
);

-- 10, second half. recent_weight orders the completions, so one creator's
-- volume must not decide it either: a creator's posts count toward it by
-- their square root, to ten posts.
select results_eq(
  $$ select phrase, post_count, creator_count from public.search_phrases where phrase like 'opal %' order by phrase $$,
  $$ values ('opal garden', 31, 2), ('opal river', 5, 5) $$,
  'fixture: a phrase one creator writes thirty times and another once, and a phrase five creators write once each'
);
select is(pg_temp.completions('opal'), array['opal river', 'opal garden'],
  'the phrase five creators write is completed before the one a single creator writes thirty times');
select results_eq(
  $$ select phrase, recent_weight from public.search_phrases where phrase like 'opal %' order by phrase $$,
  $$ values ('opal garden', 4.16::real), ('opal river', 5::real) $$,
  'one creator''s thirty posts weigh the square root of ten, 3.16, beside the other creator''s one; five creators'' posts weigh five'
);

-- 6. Pictures are ordered by what other accounts gave, never by a counter or
-- a comment the creator can add alone; ties by the newest.
select is(
  (select picture_post_ids from public.search_phrases where phrase = 'saffron canyon'),
  array[pg_temp.uid('ac'), pg_temp.uid('a0'), pg_temp.uid('a1')],
  'a phrase''s pictures: the post a reader saved first, then the newest; a creator''s own comments and the counters they raise lift nothing'
);
select is(public.search_entity_picture('tool', 'canyonkit') ->> 'post_id', pg_temp.uid('ac')::text,
  'a tool''s picture too');
select is(
  (select picture_post_id from public.search_popularity
   where subject = 'tool' and key = 'canyonkit' and creator_user_id = pg_temp.uid('01')),
  pg_temp.uid('a0'),
  'and of one creator''s equally unsaved posts, the newest'
);
select is(public.search_query_picture('saffron', null, true) ->> 'post_id', pg_temp.uid('ac')::text,
  'a hand-picked search''s picture, read from the posts as they are, is the one other accounts saved most');

-- 12. A creator on either side of a block with the viewer is not the second
-- creator of anything the viewer is offered.
select is(pg_temp.completions('tida'), array['tidal ledger'],
  'fixture: a visitor is offered a phrase two creators write');
select is(pg_temp.completions('tida', pg_temp.uid('05')), '{}'::text[],
  'the viewer is not, though two posts they may see hold it: both are one creator''s, the other creator they blocked');
select is(pg_temp.completions('amb', pg_temp.uid('05')), array['amberglow', 'amberglow lanterns'],
  'what two creators they may see write is still offered');
select ok(
  not exists (
    select 1 from jsonb_array_elements(public.search_starter(pg_temp.uid('05'), '{}', 0, 0, 8) -> 'searches') as search
    where search ->> 'text' = 'tidal ledger'
  )
  and exists (
    select 1 from jsonb_array_elements(public.search_starter(null, '{}', 0, 0, 8) -> 'searches') as search
    where search ->> 'text' = 'tidal ledger'
  ),
  'nor is it a search on their start screen, as it is on a visitor''s'
);

-- 7. Both tables are as old as their last rebuild. Past three hours (a job
-- that stopped, code rolled back without the migration, the hours between
-- the migration and the first run of the new job) nothing reads them, and
-- every answer is what it was before them.
select is(public.search_phrases_are_fresh(), true, 'a rebuild stamps the tables: they are fresh');
select is((select rebuilt_at from public.search_phrases_state), now(), 'with the time of the rebuild');
update public.search_phrases_state set rebuilt_at = now() - interval '2 hours 59 minutes';
select is(public.search_phrases_are_fresh(), true, 'for three hours');
update public.search_phrases_state set rebuilt_at = now() - interval '3 hours 1 minute';
select is(public.search_phrases_are_fresh(), false, 'and no longer');
select is(pg_temp.completions('amb'), array['amberglow'],
  'stale: a completion is a word of the dictionary, as before the phrases');
select is(pg_temp.completions('amberglow la'), array['amberglow lanterns'],
  'and the word that continues what was typed, read from the posts themselves');
select is(pg_temp.completions('lum'), '{}'::text[], 'no name, which only the phrases held');
select is(
  public.search_starter(null, array['Runway'], 8, 6, 8) -> 'periods',
  '{"entities": "all", "creators": "all", "searches": "all"}'::jsonb,
  'stale: every list of the start screen is the all-time one'
);
select is(
  (select array_agg(search ->> 'text' order by position)
   from jsonb_array_elements(public.search_starter(null, array['Runway', 'Workshop'], 0, 0, 8) -> 'searches') with ordinality as offered(search, position)),
  array['Runway', 'Workshop'],
  'its searches are the hand-picked terms alone'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_starter(null, '{}', 8, 0, 0) -> 'entities') as entity
   where entity -> 'thumbnail' <> 'null'::jsonb),
  0::bigint,
  'no model or tool carries a picture picked at a rebuild that old'
);
select is(public.search_suggestions('lumen') -> 'entities' -> 0 -> 'thumbnail', 'null'::jsonb,
  'nor does a typeahead row, which is still offered');
select is(public.search_query_picture('amberglow lanterns'), null, 'nor a phrase');
select is(pg_temp.related('amberglow', array['11', '12', '13']), '{}'::text[], 'and no related search is offered');
select ok((select phrases > 0 from public.rebuild_search_phrases()), 'the next rebuild');
select is(pg_temp.completions('amb'), array['amberglow', 'amberglow lanterns'], 'makes them read again');
select is(public.search_starter(null, '{}') -> 'periods' ->> 'searches', 'week', 'the start screen too');

-- ─── Catalog models in the typeahead ─────────────────────────────────────────
--
-- The product's own catalog, as a release of this test's: the release live
-- until now is retired, so only these models are public.
--   zephyrmodel-2     "Zephyr Motion 2"   creations of …01 and …02
--   zephyrmodel-lite  "Zephyr Lite"       no post anyone may see: a template
--                                         result of …02 and a labelled post of …03
--   zephyrmodel-web   "Lumen Zephyr Web"  on the web alone, no post; its name starts as
--                                         the tool Lumen Forge's does
--   zephyrmodel-off   "Zephyr Off"        switched off on both; a creation of …01
--   zephyrmodel-old   "Zephyr Old"        of no live release; a creation of …01
--   Zephyrtool        an outside tool one creator, …03, names
--   quillprime-1      "Quill Prime"       no post (for the known names below)
--   zephyrmodel-next  "Zephyr Next"       needs a newer catalog transport than the
--                                         one served: no client has it yet

create function pg_temp.entity_rows(p_query text, p_catalog boolean default false, p_viewer uuid default null)
returns text[]
language sql
as $$
  select coalesce(array_agg((entity ->> 'kind') || ':' || (entity ->> 'key') || '=' || (entity ->> 'post_count') order by position), '{}')
  from jsonb_array_elements(public.search_suggestions(p_query, p_viewer, false, 5, 6, p_catalog) -> 'entities')
    with ordinality as offered(entity, position);
$$;

insert into public.generation_models (model_id, kind) values
  ('zephyrmodel-2', 'video'), ('zephyrmodel-lite', 'image'), ('zephyrmodel-web', 'image'),
  ('zephyrmodel-off', 'image'), ('zephyrmodel-old', 'image'), ('quillprime-1', 'image'), ('zephyrmodel-next', 'image');
insert into public.generation_model_catalog_releases (revision, schema_version, status, defaults, created_by)
values ('c5e6-typeahead-catalog', 2, 'draft',
  '{"web":{"image":null,"video":null,"motion":null},"mobile":{"image":null,"video":null,"motion":null}}', 'database-test');
insert into public.generation_model_catalog_entries (
  release_id, model_id, public_descriptor, adapter_key, provider_model_map, pricing_strategy, pricing_config,
  validation_strategy, web_enabled, mobile_enabled
)
select releases.id, model.id,
  jsonb_build_object('id', model.id, 'kind', model.kind, 'displayName', model.name, 'description', 'A model',
                     'badge', null, 'recommended', false, 'sortOrder', 1, 'minClientSchemaVersion', model.min_version),
  model.kind || '-v1', '{"private":"zephyr-provider-secret"}', model.kind || '-v1', '{"private":"zephyr-price-secret"}',
  model.kind || '-v1', model.web, model.mobile
from public.generation_model_catalog_releases as releases
cross join (
  values
    ('zephyrmodel-2', 'video', 'Zephyr Motion 2', true, true, 1),
    ('zephyrmodel-lite', 'image', 'Zephyr Lite', true, true, 2),
    ('zephyrmodel-web', 'image', 'Lumen Zephyr Web', true, false, 3),
    ('zephyrmodel-off', 'image', 'Zephyr Off', false, false, 1),
    ('quillprime-1', 'image', 'Quill Prime', true, true, 1),
    -- For a transport newer than the one the catalog reads serve (3).
    ('zephyrmodel-next', 'image', 'Zephyr Next', true, true, 4)
) as model(id, kind, name, web, mobile, min_version)
where releases.revision = 'c5e6-typeahead-catalog';
update public.generation_model_catalog_releases set status = 'retired', retired_at = now() where status = 'active';
update public.generation_model_catalog_releases set status = 'active', activated_at = now() where revision = 'c5e6-typeahead-catalog';

insert into public.generations (id, user_id, model, status, is_public, template_run_id) values
  (pg_temp.uid('71'), pg_temp.uid('01'), 'zephyrmodel-2', 'succeeded', true, null),
  (pg_temp.uid('72'), pg_temp.uid('02'), 'zephyrmodel-2', 'succeeded', true, null),
  (pg_temp.uid('73'), pg_temp.uid('02'), 'zephyrmodel-lite', 'succeeded', true, pg_temp.uid('43')),
  (pg_temp.uid('74'), pg_temp.uid('03'), 'zephyrmodel-lite', 'succeeded', true, null),
  (pg_temp.uid('75'), pg_temp.uid('01'), 'zephyrmodel-off', 'succeeded', true, null),
  (pg_temp.uid('76'), pg_temp.uid('01'), 'zephyrmodel-old', 'succeeded', true, null);
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, showcase_asset_path, source_tool, source_tool_slug, generation_id, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', post.source, 'media', 'visible', post.is_nsfw,
       post.title, 'showcase/c5e6-' || post.suffix || '.png', post.tool, lower(post.tool),
       case when post.generation is not null then pg_temp.uid(post.generation) end, now(), now()
from (
  values
    ('81', '01', 'magicbooklet', false, 'Kite field one', 'Magicbooklet', '71'),
    ('82', '02', 'magicbooklet', false, 'Kite field two', 'Magicbooklet', '72'),
    ('83', '02', 'magicbooklet', false, 'A template result', 'Magicbooklet', '73'),
    ('84', '03', 'magicbooklet', true, 'A labelled creation', 'Magicbooklet', '74'),
    ('85', '01', 'magicbooklet', false, 'Made with a model switched off', 'Magicbooklet', '75'),
    ('86', '01', 'magicbooklet', false, 'Made with a model of no live release', 'Magicbooklet', '76'),
    ('87', '03', 'external', false, 'Made with an outside tool', 'Zephyrtool', null)
) as post(suffix, owner, source, is_nsfw, title, tool, generation);
insert into public.post_media (post_id, storage_path, media_kind, content_type, width, height, sort_order,
  preview_storage_path, preview_thumbhash, preview_status)
values (pg_temp.uid('81'), 'c5e6/81/source.png', 'image', 'image/png', 800, 800, 0, 'c5e6/81/preview.webp', 'hash-81', 'ready');
select ok((select phrases > 0 from public.rebuild_search_phrases()), 'fixture: a rebuild reads the creations');

create function pg_temp.named_models(p_query text, p_one_mistake boolean default false)
returns text[]
language sql
as $$
  select coalesce(array_agg(model_id order by model_id), '{}')
  from public.search_suggest_known_names(p_query, p_one_mistake)
  where matches and model_id is not null;
$$;

select is(pg_temp.named_models('zeph'), array['zephyrmodel-2', 'zephyrmodel-lite', 'zephyrmodel-web'],
  'the catalog''s models a text names are those of the live release that are on the web or in the app: never one switched off on both, never one of no live release');
select is(pg_temp.named_models('lite'), array['zephyrmodel-lite'], 'by any word of the name or the id');
select is(pg_temp.named_models('zephyr next'), '{}'::text[],
  'a model whose descriptor needs a newer transport than the catalog reads serve is not known: no client could open it');
select is(pg_temp.named_models('motion 2'), array['zephyrmodel-2'], 'every typed word, the last a prefix');
select is(pg_temp.named_models('z'), '{}'::text[], 'not from one character');
select results_eq(
  $$ select key, model_kind, label, web, mobile, starts from public.search_suggest_known_names('zephyr web') where matches $$,
  $$ values ('zephyrmodel-web', 'image', 'Lumen Zephyr Web', true, false, false) $$,
  'each with its search key, its kind, its public name and where it is offered'
);
select is(
  (select array_agg(model_id || '=' || starts order by model_id) from public.search_suggest_known_names('lumen z') where matches),
  array['zephyrmodel-web=true'],
  'and whether its name or its id starts with the text'
);

-- The code and the apps live today (no p_catalog): a row still opens posts.
select is(pg_temp.entity_rows('zeph'), array['model:zephyrmodel-2=2'],
  'a catalog model with posts is offered; one with none is not, nor a tool one creator names');
update public.posts set visibility = 'private' where id = pg_temp.uid('82');
select is(pg_temp.entity_rows('zeph'), array['model:zephyrmodel-2=1'],
  'a catalog model one creator alone uses is still offered: the two-creator rule is for names an account could make up');
select is(pg_temp.entity_rows('zephyrtool'), '{}'::text[],
  'an outside tool one creator names is still not offered');
select is(pg_temp.entity_rows('zephyrmodel-off'), '{}'::text[],
  'nor a model switched off on both platforms that one creator used');
select is(pg_temp.entity_rows('zephyrmodel-old'), '{}'::text[],
  'nor a model of no live release that one creator used');
select is(pg_temp.entity_rows('ze'), '{}'::text[], 'nothing under three characters, where posts are not searched');
update public.posts set visibility = 'public' where id = pg_temp.uid('82');
select is(
  public.search_suggestions('zeph') -> 'entities' -> 0,
  jsonb_build_object(
    'kind', 'model', 'key', 'zephyrmodel-2', 'label', 'Zephyr Motion 2', 'post_count', 2, 'post_count_capped', false,
    'thumbnail', public.search_post_picture(pg_temp.uid('81')),
    'in_catalog', true,
    'catalog_model', jsonb_build_object('id', 'zephyrmodel-2', 'kind', 'video', 'web', true, 'mobile', true),
    'query', null
  ),
  'the row is named by the catalog and says it is a catalog model: its id, its kind and where it is offered'
);
select is(
  (select jsonb_agg(jsonb_build_object('in_catalog', entity -> 'in_catalog', 'catalog_model', entity -> 'catalog_model', 'query', entity -> 'query'))
   from jsonb_array_elements(public.search_suggestions('lumen') -> 'entities') as entity),
  '[{"in_catalog": false, "catalog_model": null, "query": null}]'::jsonb,
  'a tool, or a model of no catalog, says it is none'
);

-- A client that asked (p_catalog): every catalog model the text names.
select is(pg_temp.entity_rows('zeph', true),
  array['model:zephyrmodel-2=2', 'model:zephyrmodel-lite=0', 'model:zephyrmodel-web=0'],
  'with p_catalog, a catalog model with no post is offered too, after the ones with posts');
select is(pg_temp.entity_rows('ze', true),
  array['model:zephyrmodel-2=2', 'model:zephyrmodel-lite=0', 'model:zephyrmodel-web=0'],
  'from two characters');
select is(pg_temp.entity_rows('z', true), '{}'::text[], 'not from one');
select is(pg_temp.entity_rows('lite', true), array['model:zephyrmodel-lite=0'],
  'a template result''s hidden model and a labelled post count for nothing: the row says 0');
select is(
  (select entity - 'label' from jsonb_array_elements(public.search_suggestions('lite', null, false, 5, 6, true) -> 'entities') as entity),
  jsonb_build_object(
    'kind', 'model', 'key', 'zephyrmodel-lite', 'post_count', 0, 'post_count_capped', false, 'thumbnail', null,
    'in_catalog', true,
    'catalog_model', jsonb_build_object('id', 'zephyrmodel-lite', 'kind', 'image', 'web', true, 'mobile', true),
    'query', null
  ),
  'a row with no post has no picture and no search to run: it is there to open the creator with that model'
);
select is(
  (select entity -> 'catalog_model' from jsonb_array_elements(public.search_suggestions('web', null, false, 5, 6, true) -> 'entities') as entity),
  jsonb_build_object('id', 'zephyrmodel-web', 'kind', 'image', 'web', true, 'mobile', false),
  'a model on the web alone says so'
);
select is(pg_temp.entity_rows('zephyrmodel-off', true), '{}'::text[], 'a model switched off on both is not offered, asked or not');
select is(pg_temp.entity_rows('zephyrmodel-old', true), '{}'::text[], 'nor one of no live release');
select is(pg_temp.entity_rows('zephyrtool', true), '{}'::text[], 'nor an outside tool one creator names');
select is(
  (select array_agg((entity ->> 'key') || '=' || (entity ->> 'post_count') || '/' || (entity ->> 'query'))
   from jsonb_array_elements(public.search_suggestions('ze', null, false, 5, 6, true) -> 'entities') as entity
   where (entity ->> 'post_count')::integer > 0),
  array['zephyrmodel-2=2/zephyrmodel-2'],
  'a row added for a text too short to search posts by carries the search that opens its posts'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_suggestions('ze', null, false, 5, 6, true) -> 'entities') as entity
   where entity ->> 'query' is not null
     and (entity ->> 'post_count')::integer <> pg_temp.opened(entity ->> 'query', null, 'model:' || (entity ->> 'key'))),
  0::bigint,
  'and its count is what that search, narrowed to it, opens'
);
select is(
  (select count(*) from jsonb_array_elements(public.search_suggestions('zeph', null, false, 5, 6, true) -> 'entities') as entity
   where entity ->> 'query' is null and (entity ->> 'post_count')::integer > 0
     and (entity ->> 'post_count')::integer <> pg_temp.opened('zeph', null, 'model:' || (entity ->> 'key'))),
  0::bigint,
  'a row search itself answered counts what the typed text, narrowed to it, opens'
);
select is(pg_temp.entity_rows('zeph', true, pg_temp.uid('05')),
  array['model:zephyrmodel-2=1', 'model:zephyrmodel-lite=0', 'model:zephyrmodel-web=0'],
  'the viewer''s count leaves out the creator they blocked');
select is(pg_temp.entity_rows('ze', true, pg_temp.uid('05')),
  array['model:zephyrmodel-2=1', 'model:zephyrmodel-lite=0', 'model:zephyrmodel-web=0'],
  'in a row added for a short text too');
select is(
  (select array_agg(entity ->> 'key' order by position)
   from jsonb_array_elements(public.search_suggestions('motion', null, false, 5, 6, true) -> 'entities') with ordinality as offered(entity, position)),
  array['zephyrmodel-2'],
  'a later word of a catalog name finds its model'
);
select is(
  public.search_suggestions('zeph', null, true, 5, 6, true) -> 'entities',
  '[]'::jsonb,
  'a query typed as a handle is offered no model'
);
insert into public.search_suggestion_denylist (term, note) values ('lite', 'test');
select is(pg_temp.entity_rows('zeph', true), array['model:zephyrmodel-2=2', 'model:zephyrmodel-web=0'],
  'a catalog model whose name holds a withdrawn word is not offered');
delete from public.search_suggestion_denylist where term = 'lite';
-- A catalog model the text starts stands ahead of a tool with more posts.
select is(pg_temp.entity_rows('lumen', true), array['model:zephyrmodel-web=0', 'tool:lumen-forge=3'],
  'a catalog model the text starts stands first, though a tool it also names has more posts');
select is(pg_temp.entity_rows('lumen'), array['tool:lumen-forge=3'],
  'and is not offered at all to a client that did not ask: it has no post to open');
select is(
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'search_suggestions'),
  1::bigint,
  'one search_suggestions: the five-parameter one is gone, and its named call resolves to this one'
);
select is(
  (select jsonb_object_keys(answer) from public.search_suggestions(p_query => 'zeph', p_viewer_user_id => null, p_handles_only => false, p_creator_limit => 5, p_completion_limit => 6) as answer
   order by 1 limit 1),
  'completions',
  'the call the live route makes, by its five names, is answered'
);

-- ─── Known names: every model and tool we maintain ──────────────────────────
--
-- The rule is for every name, not one: each known name is answered for every
-- prefix, from two characters, of every word of its label and of the label
-- written as one word, and for the label written with spaces and with
-- hyphens. Known: the live catalog's models, and the tools and tools' models
-- of the source-tools catalog an operator keeps. Fixture, all Made with rows
-- of one creator, …01, alone:
--   quillforge      "Quill Forge"     tool, alias "QF Studio"; posts 90 to 96
--   quill-gen-4.5   "Quill Gen-4.5"   its model; posts 90, 91, 92
--   quill-v8.1      "Quill V8.1"      its model; posts 93, 94
--   quillmax        "QuillMax 3"      its model; post 95
--   quill-idle      "Quill Idle"      its model; no post
--   quill-retired   "Quill Retired"   its model, switched off; post 96
--   quill-planted   "Quill Planted"   its model, added by the creator …03; post 99
--   quillidle       "Quillidle Studio" tool, no post
--   quillgone       "Quillgone Lab"   tool, switched off; post 97 of …03
--   quillmine       "Quillmine"       tool added by the creator …03; post 98
--   quillorphan     "Quillorphan"     tool a deleted account added (no creator,
--                                     never verified); post 9a of …03
--   kytelabs        "Kyte Labs"       tool; post 9b. One letter from "kite",
--                                     which two creators write.

create function pg_temp.name_prefixes()
returns table(kind text, key text, own boolean, typed text)
language sql
as $$
  with names as (
    select known.kind, known.key, known.model_id is not null as own, lower(known.label) as label
    from public.search_suggest_known_names('zz') as known
  ),
  forms as (
    select names.kind, names.key, names.own, word.form
    from names
    cross join lateral regexp_split_to_table(names.label, '[^[:alnum:]]+') as word(form)
    union
    select names.kind, names.key, names.own, regexp_replace(names.label, '[^[:alnum:]]+', '', 'g')
    from names
  )
  select forms.kind, forms.key, forms.own, left(forms.form, size.length)
  from forms
  cross join lateral generate_series(2, char_length(forms.form)) as size(length)
  union
  select names.kind, names.key, names.own, btrim(regexp_replace(names.label, '[^[:alnum:]]+', ' ', 'g'))
  from names
  where char_length(names.label) >= 2
  union
  select names.kind, names.key, names.own, btrim(regexp_replace(names.label, '[^[:alnum:]]+', '-', 'g'), '-')
  from names
  where char_length(names.label) >= 2;
$$;

-- The prefixes of known names the matcher does not answer with their name.
create function pg_temp.unanswered_names()
returns table(kind text, key text, typed text)
language sql
as $$
  with wanted as materialized (select prefixes.kind, prefixes.key, prefixes.typed from pg_temp.name_prefixes() as prefixes),
  answered as materialized (
    select texts.typed, known.kind, known.key
    from (select distinct wanted.typed from wanted) as texts
    cross join lateral public.search_suggest_known_names(texts.typed) as known
    where known.matches
  )
  select wanted.kind, wanted.key, wanted.typed
  from wanted
  where not exists (
    select 1 from answered
    where answered.typed = wanted.typed and answered.kind = wanted.kind and answered.key = wanted.key
  );
$$;

-- The prefixes of known names that have something to open (a model of the
-- product's own, or a name a post a guest may see is made with) for which the
-- typeahead's candidates, before the cap, lack the name.
create function pg_temp.unoffered_names()
returns table(kind text, key text, typed text)
language sql
as $$
  with wanted as materialized (
    select prefixes.kind, prefixes.key, prefixes.typed
    from pg_temp.name_prefixes() as prefixes
    where prefixes.own or exists (
      select 1
      from public.post_search_entities as members
      join public.posts as posts on posts.id = members.post_id
      where members.kind = prefixes.kind and members.key = prefixes.key and posts.is_nsfw = false
    )
  ),
  offered as materialized (
    select texts.typed, entity ->> 'kind' as kind, entity ->> 'key' as key
    from (select distinct wanted.typed from wanted) as texts
    cross join lateral jsonb_array_elements(public.search_suggest_entities(texts.typed, null, true, false, 50)) as entity
  )
  select wanted.kind, wanted.key, wanted.typed
  from wanted
  where not exists (
    select 1 from offered
    where offered.typed = wanted.typed and offered.kind = wanted.kind and offered.key = wanted.key
  );
$$;

create function pg_temp.candidates(p_query text, p_catalog boolean default true, p_one_mistake boolean default false)
returns text[]
language sql
as $$
  select coalesce(array_agg((entity ->> 'kind') || ':' || (entity ->> 'key') || '=' || (entity ->> 'post_count') order by position), '{}')
  from jsonb_array_elements(public.search_suggest_entities(p_query, null, p_catalog, p_one_mistake, 50))
    with ordinality as offered(entity, position);
$$;

-- The names the migrations themselves ship: the source-tools catalog as
-- seeded (the catalog's own models are this test's release by now; the
-- seeded release's are read below, with it live again).
select ok(
  (select count(*) from public.search_suggest_known_names('zz') where kind = 'tool') >= 50
  and (select count(*) from public.search_suggest_known_names('zz') where kind = 'model' and model_id is null) >= 50,
  'fixture: the seeded source-tools catalog is known, tools and models'
);
select is_empty(
  $$ select * from pg_temp.unanswered_names() $$,
  'every seeded tool and tool''s model is named by every prefix of every word of its label, by the label as one word, and by it split with spaces or hyphens'
);

insert into public.source_tools (slug, label, is_active, last_verified_at, aliases, created_by_user_id) values
  ('quillforge', 'Quill Forge', true, current_date, array['QF Studio'], null),
  ('quillidle', 'Quillidle Studio', true, current_date, '{}', null),
  ('quillgone', 'Quillgone Lab', false, current_date, '{}', null),
  ('quillmine', 'Quillmine', true, null, '{}', pg_temp.uid('03')),
  ('quillorphan', 'Quillorphan', true, null, '{}', null),
  ('kytelabs', 'Kyte Labs', true, current_date, '{}', null);
insert into public.source_tool_models (source_tool_id, slug, label, is_active, last_verified_at, created_by_user_id)
select tools.id, model.slug, model.label, model.is_active, model.verified, model.maker
from public.source_tools as tools
cross join (
  values
    ('quill-gen-4.5', 'Quill Gen-4.5', true, current_date, null::uuid),
    ('quill-v8.1', 'Quill V8.1', true, current_date, null),
    ('quillmax', 'QuillMax 3', true, current_date, null),
    ('quill-idle', 'Quill Idle', true, current_date, null),
    ('quill-retired', 'Quill Retired', false, current_date, null),
    ('quill-planted', 'Quill Planted', true, null, pg_temp.uid('03'))
) as model(slug, label, is_active, verified, maker)
where tools.slug = 'quillforge';

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
)
select pg_temp.uid(post.suffix), pg_temp.uid(post.owner), 'public', 'image', 'external', 'media', 'visible', false,
       'Paper crane ' || post.suffix, 'showcase/c5e6-' || post.suffix || '.png', post.tool, post.tool_slug, now(), now()
from (
  values
    -- The first prints the tool's name its own way: the row is named by the catalog.
    ('90', '01', 'QUILL forge!', 'quillforge'),
    ('91', '01', 'Quill Forge', 'quillforge'),
    ('92', '01', 'Quill Forge', 'quillforge'),
    ('93', '01', 'Quill Forge', 'quillforge'),
    ('94', '01', 'Quill Forge', 'quillforge'),
    ('95', '01', 'Quill Forge', 'quillforge'),
    ('96', '01', 'Quill Forge', 'quillforge'),
    ('97', '03', 'Quillgone Lab', 'quillgone'),
    ('98', '03', 'Quillmine', 'quillmine'),
    ('99', '03', 'Quill Forge', 'quillforge'),
    ('9a', '03', 'Quillorphan', 'quillorphan'),
    ('9b', '01', 'Kyte Labs', 'kytelabs')
) as post(suffix, owner, tool, tool_slug);
insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug)
select pg_temp.uid(made.suffix), 'Quill Forge', 'quillforge', made.model_label, made.model_slug
from (
  values
    ('90', 'Quill Gen-4.5', 'quill-gen-4.5'), ('91', 'Quill Gen-4.5', 'quill-gen-4.5'), ('92', 'Quill Gen-4.5', 'quill-gen-4.5'),
    ('93', 'Quill V8.1', 'quill-v8.1'), ('94', 'Quill V8.1', 'quill-v8.1'),
    ('95', 'QuillMax 3', 'quillmax'),
    ('96', 'Quill Retired', 'quill-retired'),
    ('99', 'Quill Planted', 'quill-planted')
) as made(suffix, model_label, model_slug);

select is(
  (select array_agg(kind || ':' || key order by kind, key) from public.search_suggest_known_names('quill') where matches),
  array['model:quill-gen-4.5', 'model:quill-idle', 'model:quill-v8.1', 'model:quillmax', 'model:quillprime-1', 'tool:quillforge', 'tool:quillidle'],
  'known: the catalog''s model and the tools and models an operator keeps. Never one switched off, never one a creator added, never one a deleted account left'
);
select is_empty(
  $$ select * from pg_temp.unanswered_names() $$,
  'every known name of this test, the catalog''s models with them, is named by every prefix of every word and of its name as one word'
);
select is_empty(
  $$ select * from pg_temp.unoffered_names() $$,
  'and each that has something to open is among the typeahead''s candidates for every one of those prefixes, before the cap'
);
select ok(
  (select count(distinct key) from pg_temp.name_prefixes() where key in (
     'zephyrmodel-2', 'zephyrmodel-lite', 'zephyrmodel-web', 'quillprime-1', 'quillforge', 'quill-gen-4.5', 'quill-v8.1', 'quillmax', 'midjourney', 'runway'
   )) = 10
  and (select count(*) from pg_temp.name_prefixes()) > 1000,
  'fixture: that was asked of the catalog''s models with and without posts, the fixture''s tools and models, and seeded tools posts are made with'
);
select is(
  (select count(*) from pg_temp.name_prefixes() as prefixes
   cross join lateral jsonb_array_elements(
     public.search_suggest_entities(prefixes.typed, null, true, false, 50) || public.search_suggest_entities(prefixes.typed, null, true, true, 50)
   ) as entity
   where prefixes.key in ('quillforge', 'quill-gen-4.5', 'zephyrmodel-2')
     and entity ->> 'key' in (
       'zephyrmodel-off', 'zephyrmodel-old', 'quill-retired', 'quill-planted', 'quillgone', 'quillmine', 'quillorphan',
       'quill-idle', 'quillidle', 'magicbooklet'
     )),
  0::bigint,
  'no prefix, as typed or with a mistake allowed, is answered with a retired model, a row switched off, a row a creator added, a name with nothing to open, or the app''s own tool'
);

-- One creator's post is enough for a known name; a made-up one keeps the rule.
select is(pg_temp.entity_rows('quillforge'), array['tool:quillforge=8'],
  'a known tool one creator alone posts with is offered, to a client that did not ask too');
select is(pg_temp.entity_rows('quillmax'), array['model:quillmax=1'], 'and a known tool''s model');
select is(pg_temp.entity_rows('quillmine'), '{}'::text[],
  'a tool a creator added to the catalog by naming it is a made-up name: one creator is not enough');
select is(pg_temp.entity_rows('quillorphan'), '{}'::text[],
  'nor is it known once its account is gone and the row has no creator: it was never verified');
select is(pg_temp.entity_rows('quill planted'), '{}'::text[], 'nor a model a creator added under a known tool');
select is(pg_temp.entity_rows('quillgone'), '{}'::text[], 'nor a tool switched off');
select is(pg_temp.entity_rows('quill retired'), '{}'::text[], 'nor a tool''s model switched off');
select is(pg_temp.entity_rows('quillidle', true), '{}'::text[],
  'a known tool nobody posted with is not offered, asked or not: it has nothing to open');
select is(
  (select jsonb_build_object('label', entity -> 'label', 'in_catalog', entity -> 'in_catalog', 'catalog_model', entity -> 'catalog_model')
   from jsonb_array_elements(public.search_suggestions('quillforge') -> 'entities') as entity),
  '{"label": "Quill Forge", "in_catalog": false, "catalog_model": null}'::jsonb,
  'a known tool is named as the catalog names it, whatever a post prints, and is no catalog model'
);

-- The forms search understands, for a client that asked.
select is(pg_temp.candidates('quillgen'), array['model:quill-gen-4.5=3'], 'a name written as one word');
select is(pg_temp.candidates('quill-gen'), array['model:quill-gen-4.5=3'], 'with a hyphen');
select is(pg_temp.candidates('quill gen 4'), array['model:quill-gen-4.5=3'], 'with spaces, the version started');
select is(pg_temp.candidates('gen-4.5'), array['model:quill-gen-4.5=3'], 'a later word, as written');
select is(pg_temp.candidates('quillv8'), array['model:quill-v8.1=2'], 'letters and digits run together');
select is(pg_temp.candidates('quill v 8'), array['model:quill-v8.1=2'], 'or apart');
select is(pg_temp.candidates('quillmax3'), array['model:quillmax=1'], 'a name and its number run together');
select is(pg_temp.candidates('qf'), array['tool:quillforge=8'], 'an alias an operator gave the tool, from two characters');
select is(pg_temp.candidates('qf stu'), array['tool:quillforge=8'], 'and its later word');
select is(pg_temp.candidates('q'), '{}'::text[], 'nothing from one character');
select is(pg_temp.candidates('qu%ll'), '{}'::text[], 'a typed % is no wildcard');
select is(pg_temp.candidates('qu_ll'), '{}'::text[], 'nor a typed _');
select is(
  (select count(*) from jsonb_array_elements(public.search_suggest_entities('qu', null, true, false, 50)) as entity
   where entity ->> 'key' like 'quill%'
     and (entity ->> 'post_count')::integer <> pg_temp.opened(entity ->> 'query', null, (entity ->> 'kind') || ':' || (entity ->> 'key'))
     and (entity ->> 'post_count')::integer > 0),
  0::bigint,
  'a tool or a tool''s model added for a short text carries the search that opens its posts, and counts them'
);

-- More names than the cap holds: the order decides.
select is(pg_temp.candidates('quill'),
  array['tool:quillforge=8', 'model:quill-gen-4.5=3', 'model:quill-v8.1=2', 'model:quillmax=1', 'model:quillprime-1=0'],
  'the candidates for a family: the names the text starts, the most posts first');
select is(pg_temp.entity_rows('quill', true),
  array['tool:quillforge=8', 'model:quill-gen-4.5=3', 'model:quill-v8.1=2', 'model:quillmax=1'],
  'the answer holds four: the first four of that order');
select is(pg_temp.entity_rows('quill forge', true), array['tool:quillforge=8'],
  'the name that is the text alone, when only it is named');
select is(pg_temp.entity_rows('prime', true), array['model:quillprime-1=0'],
  'a catalog model with no post still opens its creator');

-- One mistake: only for a client that asked, from four characters, and only
-- when nothing else answers.
select is(pg_temp.entity_rows('quilforge', true), array['tool:quillforge=8'], 'a letter left out');
select is(pg_temp.entity_rows('quillfroge', true), array['tool:quillforge=8'], 'two neighbours swapped');
select is(pg_temp.entity_rows('quillforhe', true), array['tool:quillforge=8'], 'a letter wrong');
select is(pg_temp.entity_rows('quillfforge', true), array['tool:quillforge=8'], 'a letter added');
select is(pg_temp.entity_rows('quillmxa', true), array['model:quillmax=1'], 'in a model''s name');
select is(pg_temp.entity_rows('zephir', true), array['model:zephyrmodel-2=2', 'model:zephyrmodel-lite=0', 'model:zephyrmodel-web=0'],
  'in a catalog model''s, the ones with posts first');
select is(
  (select array_agg((entity ->> 'key') || '/' || (entity ->> 'query') order by entity ->> 'key')
   from jsonb_array_elements(public.search_suggestions('quilforge', null, false, 5, 6, true) -> 'entities') as entity),
  array['quillforge/' || (select query from public.search_starter_entity_offer('tool', 'quillforge', null))],
  'a row found by a mistake carries the search that opens its posts: the typed text opens none'
);
select is(pg_temp.entity_rows('quilforge'), '{}'::text[], 'not for a client that did not ask: it would open the misspelt search');
select is(pg_temp.entity_rows('quillfrgoe', true), '{}'::text[], 'not with two mistakes');
select is(pg_temp.entity_rows('wuillforge', true), '{}'::text[], 'not in the first letter');
select is(pg_temp.entity_rows('qul', true), '{}'::text[], 'not under four characters');
select is(pg_temp.candidates('quilforge', true, true) && array['model:quill-retired=1', 'tool:quillgone=1', 'tool:quillmine=1'], false,
  'a mistake finds no name that is not known');
select ok(
  (select count(*) from public.search_suggest_completions('kite', 6, null)) > 0
  and exists (select 1 from public.search_suggest_known_names('kite', true) where matches and key = 'kytelabs')
  and not exists (
    select 1 from jsonb_array_elements(public.search_suggestions('kite', null, false, 5, 6, true) -> 'entities') as entity
    where entity ->> 'key' = 'kytelabs'
  ),
  'no mistake is looked for when the text as typed has an answer: "kite" completes, so Kyte Labs is not offered'
);
select ok(public.search_one_mistake_prefix('seedence', 'seedance')
  and public.search_one_mistake_prefix('seedanc', 'seedance')
  and public.search_one_mistake_prefix('klnig', 'kling')
  and public.search_one_mistake_prefix('seeda', 'seedance')
  and public.search_one_mistake_prefix('sedan', 'seedance')
  and public.search_one_mistake_prefix('seeedan', 'seedance'),
  'one mistake: a letter wrong, left out, added or swapped with its neighbour, in a whole word or its start');
select ok(not public.search_one_mistake_prefix('see', 'seedance')
  and not public.search_one_mistake_prefix('xeedance', 'seedance')
  and not public.search_one_mistake_prefix('sadence', 'seedance')
  and not public.search_one_mistake_prefix('kling', '')
  and not public.search_one_mistake_prefix('seedancers', 'seedance'),
  'never under four characters, in the first letter, with two mistakes, or past the word''s end by more than a letter');
select is(public.search_name_words('Gen-4.5 Turbo'), array['4', '4.5', '5', 'gen', 'turbo'],
  'a name''s words: as written, a dot kept inside one, and with letters and digits apart');
select is(public.search_name_squashes('Nano Banana Pro'), array['bananapro', 'nanobananapro', 'pro'],
  'a name as one word, from each of its words on');

-- The models the migrations ship, with their release live again.
update public.generation_model_catalog_releases set status = 'retired', retired_at = now() where revision = 'c5e6-typeahead-catalog';
update public.generation_model_catalog_releases as releases
set status = 'active', retired_at = null, activated_at = now()
where releases.id = (
  select previous.id from public.generation_model_catalog_releases as previous
  where previous.revision <> 'c5e6-typeahead-catalog'
  order by previous.schema_version desc, previous.activated_at desc
  limit 1
);
select ok(
  (select count(*) from public.search_suggest_known_names('zz') where model_id is not null) >= 20
  and not exists (select 1 from public.search_suggest_known_names('zz') where model_id like 'zephyrmodel%'),
  'fixture: the seeded release is live, this test''s is retired and its models are known no more'
);
select is_empty(
  $$ select * from pg_temp.unanswered_names() $$,
  'every model of the seeded catalog is named by every prefix of every word of its name and of its name as one word'
);
select is_empty(
  $$ select unoffered.* from pg_temp.unoffered_names() as unoffered
     join public.search_suggest_known_names('zz') as known on known.kind = unoffered.kind and known.key = unoffered.key
     where known.model_id is not null $$,
  'and is among the typeahead''s candidates for each of them, with or without a post'
);
select is(pg_temp.entity_rows('zeph', true), array['model:zephyrmodel-2=2'],
  'a retired release''s models are known no more: the ones with no post are not answered, and the one two creators'' posts are made with is offered as any model is');
select is(
  (select entity -> 'in_catalog' from jsonb_array_elements(public.search_suggestions('zeph', null, false, 5, 6, true) -> 'entities') as entity),
  'false'::jsonb,
  'and says it is no catalog model'
);

-- ─── Who may read what ───────────────────────────────────────────────────────

select ok(
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.search_phrases'::regclass, 'public.search_popularity'::regclass))
  and not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename in ('search_phrases', 'search_popularity')
  ),
  'both tables are row-secured with no policy'
);
select ok(
  not has_table_privilege('anon', 'public.search_phrases', 'SELECT')
  and not has_table_privilege('authenticated', 'public.search_phrases', 'SELECT')
  and not has_table_privilege('anon', 'public.search_popularity', 'SELECT')
  and not has_table_privilege('authenticated', 'public.search_popularity', 'SELECT')
  and has_table_privilege('service_role', 'public.search_phrases', 'SELECT')
  and has_table_privilege('service_role', 'public.search_popularity', 'SELECT')
  and not has_table_privilege('service_role', 'public.search_phrases', 'INSERT')
  and not has_table_privilege('service_role', 'public.search_phrases', 'UPDATE')
  and not has_table_privilege('service_role', 'public.search_phrases', 'DELETE')
  and not has_table_privilege('service_role', 'public.search_popularity', 'INSERT')
  and not has_table_privilege('service_role', 'public.search_popularity', 'UPDATE')
  and not has_table_privilege('service_role', 'public.search_popularity', 'DELETE'),
  'the Data API roles read neither, and the service role only reads them: the rebuild alone writes'
);
select is(
  (select count(*)
   from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in (
       'rebuild_search_phrases', 'search_text_phrases', 'search_entity_phrase', 'search_post_picture',
       'search_entity_picture', 'search_query_picture', 'search_query_post_floor', 'search_week_score',
       'search_suggest_completions', 'search_suggest_creators', 'search_suggestions', 'search_starter',
       'search_related_searches', 'search_suggest_known_names', 'search_suggest_entities',
       'search_name_words', 'search_name_squashes', 'search_one_mistake_prefix'
     )
     and (
       has_function_privilege('anon', oid, 'EXECUTE')
       or has_function_privilege('authenticated', oid, 'EXECUTE')
       or not has_function_privilege('service_role', oid, 'EXECUTE')
       or not coalesce(proconfig, '{}') @> array['search_path=""']
     )),
  0::bigint,
  'every function of this file is the service role''s alone, with an empty search_path'
);
select is(
  (select array_agg(proname::text order by proname)
   from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in (
       'rebuild_search_phrases', 'search_post_picture', 'search_entity_picture', 'search_query_picture',
       'search_query_post_floor', 'search_suggest_completions', 'search_suggest_creators', 'search_starter',
       'search_related_searches', 'search_suggest_known_names', 'search_suggest_entities'
     )
     and prosecdef),
  array[
    'rebuild_search_phrases', 'search_entity_picture', 'search_post_picture', 'search_query_picture',
    'search_query_post_floor', 'search_related_searches', 'search_starter', 'search_suggest_completions',
    'search_suggest_creators', 'search_suggest_entities', 'search_suggest_known_names'
  ],
  'the ones that read posts run with their owner''s rights'
);
select is(
  (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'search_suggest_completions'),
  1::bigint,
  'one search_suggest_completions: the two-parameter one is gone'
);

select * from finish();
rollback;
