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

select plan(138);

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

-- Covers. …12 is the most saved of the amberglow posts, then …13, then …11;
-- of the Lumen Forge posts …28, then …27.
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
  (pg_temp.uid('07'), pg_temp.uid('29'), now() - interval '20 days');
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
  'the pictured posts are kept, the most saved first'
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
  public.search_suggestions('lumen', pg_temp.uid('05')) -> 'entities' -> 0 -> 'thumbnail' ->> 'post_id',
  pg_temp.uid('27')::text,
  'the viewer''s row carries a picture of a post they may see'
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
  $$ select post_count, week_activity, base_activity, picture_post_id
     from public.search_popularity where subject = 'tool' and key = 'lumen-forge' and creator_user_id = pg_temp.uid('02') $$,
  $$ values (1, 2::real, 0::real, pg_temp.uid('28')) $$,
  'another''s: a new post and a save by someone else (their own save counts for nothing)'
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
       'search_related_searches'
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
       'search_related_searches'
     )
     and prosecdef),
  array[
    'rebuild_search_phrases', 'search_entity_picture', 'search_post_picture', 'search_query_picture',
    'search_query_post_floor', 'search_related_searches', 'search_starter', 'search_suggest_completions',
    'search_suggest_creators'
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
