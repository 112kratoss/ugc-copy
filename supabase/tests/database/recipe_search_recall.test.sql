-- Recipe search reads a query as post search does
-- (20261111224010_search_recall_models_prefixes_stems_typos.sql): every word
-- in any order, the last one a prefix, a plural as its singular, a tool's name
-- split or joined, and a misspelling read as its nearest known word when
-- nothing matches as typed. It matches only what a visitor who has not
-- unlocked a recipe sees: its search document, never its items, cards or a
-- paid recipe's setup caption. Unified search orders recipes by relevance.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(69);

create function pg_temp.page(p_query text, p_sort text, p_offset integer, p_limit integer)
returns uuid[]
language sql
as $$
  select coalesce(array_agg(id order by position), '{}')
  from public.list_marketplace_resource_bundles('all', 'all', null, p_query, p_sort, p_offset, p_limit)
    with ordinality as listed(
      id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text,
      prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix,
      resource_sections, resource_items, price_usd_cents, sales_count, free_unlock_count,
      earnings_usd_cents, created_at, updated_at, position
    );
$$;

create function pg_temp.finds(p_query text, p_bundle_suffix text)
returns boolean
language sql
as $$
  select ('0000e5c1-0000-4000-9000-0000000000' || p_bundle_suffix)::uuid
    = any (pg_temp.page(p_query, 'recent', 0, 100));
$$;

create function pg_temp.bundle(p_suffix text)
returns uuid
language sql
as $$ select ('0000e5c1-0000-4000-9000-0000000000' || p_suffix)::uuid; $$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- One seller. Posts …11–…17 and their recipes …21–…27:
--   …21 free: "Neon dancer portrait", made with Nano-Banana-Pro;
--   …22 paid: "Rainy street at night", made with Veo-3.1, its caption the
--       setup it sells (with the word quorvantel), its prompt item holding
--       zephyrcoil, its summary chromaflare;
--   …23 free: "Golden hour portraits", the oldest;
--   …24 free, on an NSFW-labelled post (velvetmoss);
--   …25 free: a kite study whose summary mentions golden hour, the newest;
--   …26 a draft (draftlark);
--   …27 free: a pottery study, to page past, whose public caption also shows
--       quorvantel, so the word is in the dictionary;
--   …28 free: titled exactly "Lantern glow";
--   …29 free: a newer street study whose caption repeats "lantern glow"
--       thirty times, to stuff the rank.
-- And post …1a with no recipe, the only place the word brindlewick shows.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000e5c1-0000-4000-9000-000000000001'::uuid, 'e5c1-recipe-search@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

update public.profiles
set username = 'reva-lindqvist', display_name = 'Reva Lindqvist'
where id = '0000e5c1-0000-4000-9000-000000000001'::uuid;

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status, is_nsfw,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  ('0000e5c1-0000-4000-9000-000000000011'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Neon dancer portrait', 'A dancer lit by tubes of light.',
   'showcase/e5c1-011.png', 'Nano-Banana-Pro', 'nano-banana-pro', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000012'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'video', 'external', 'media', 'visible', false,
   'Rainy street at night',
   E'Saved generation setup\nModel: Veo 3.1\nGrade: quorvantel blue',
   'showcase/e5c1-012.png', 'Veo-3.1', 'veo-3-1', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000013'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Portraits in golden hour', 'Warm light across a face.',
   'showcase/e5c1-013.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000014'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', true,
   'Velvetmoss study', 'A labelled picture.',
   'showcase/e5c1-014.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000015'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Kite over the dunes', 'Wind and sand.',
   'showcase/e5c1-015.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000016'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Draft lantern scene', 'Not listed yet.',
   'showcase/e5c1-016.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000017'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Pottery wheel study', 'Clay in motion under golden hour light, a quorvantel glaze.',
   'showcase/e5c1-017.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000018'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Lantern glow', 'A paper lamp at dusk.',
   'showcase/e5c1-018.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-000000000019'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Evening street study', btrim(repeat('lantern glow ', 30)),
   'showcase/e5c1-019.png', 'Midjourney', 'midjourney', now(), now()),
  ('0000e5c1-0000-4000-9000-00000000001a'::uuid, '0000e5c1-0000-4000-9000-000000000001'::uuid,
   'public', 'image', 'external', 'media', 'visible', false,
   'Brindlewick meadow', 'A post with no recipe.',
   'showcase/e5c1-01a.png', 'Midjourney', 'midjourney', now(), now());

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
)
select
  pg_temp.bundle(recipe.bundle_suffix),
  ('0000e5c1-0000-4000-9000-0000000000' || recipe.post_suffix)::uuid,
  '0000e5c1-0000-4000-9000-000000000001'::uuid,
  recipe.access_mode, recipe.status,
  recipe.title, recipe.summary,
  'A preview long enough to pass the marketplace quality gate.',
  null, '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', recipe.item_text)),
  '[]'::jsonb,
  case recipe.access_mode when 'paid' then 300 else 0 end, 0, 0,
  now() - recipe.age, now()
from (
  values
    ('21', '11', 'free', 'published', 'Neon dancer portrait', 'Three steps to a neon portrait',
     'The prompt a buyer unlocks for this picture', interval '30 minutes'),
    ('22', '12', 'paid', 'published', 'Rainy street at night', 'Cinematic rain grading with chromaflare',
     'The zephyrcoil prompt a buyer unlocks for this clip', interval '20 minutes'),
    ('23', '13', 'free', 'published', 'Golden hour portraits', 'Warm golden hour light on a face',
     'The prompt a buyer unlocks for this picture', interval '50 minutes'),
    ('24', '14', 'free', 'published', 'Velvetmoss study recipe', 'A velvetmoss recipe on a labelled post',
     'The prompt a buyer unlocks for this picture', interval '10 minutes'),
    ('25', '15', 'free', 'published', 'Seaside kite study', 'Shot just after golden hour fades',
     'The prompt a buyer unlocks for this picture', interval '1 minute'),
    ('26', '16', 'free', 'draft', 'Draft lantern recipe', 'A draftlark recipe nobody sees yet',
     'The prompt a buyer unlocks for this picture', interval '5 minutes'),
    ('27', '17', 'free', 'published', 'Pottery wheel study', 'Clay shaping in three passes',
     'The prompt a buyer unlocks for this picture', interval '40 minutes'),
    ('28', '18', 'free', 'published', 'Lantern glow', 'A warm paper lamp, step by step',
     'The prompt a buyer unlocks for this picture', interval '45 minutes'),
    ('29', '19', 'free', 'published', 'Evening street study', 'Streetlights after rain',
     'The prompt a buyer unlocks for this picture', interval '2 minutes')
) as recipe(bundle_suffix, post_suffix, access_mode, status, title, summary, item_text, age);

-- ─── Listed, so a miss below is the reading under test ──────────────────────

-- The dictionary is filled by the search-dictionary job, not by saves. The
-- rebuild runs in its own statement: a statement does not see what a
-- function it calls has just changed.
select ok((select added > 0 from public.rebuild_search_terms()),
  'fixture: a rebuild fills the dictionary');

select ok(pg_temp.finds(null, '21') and pg_temp.finds(null, '22') and pg_temp.finds(null, '23')
          and pg_temp.finds(null, '25') and pg_temp.finds(null, '27'),
  'fixture: the published recipes on visible posts are listed');
select ok(not pg_temp.finds(null, '24') and not pg_temp.finds(null, '26'),
  'fixture: the recipe on a labelled post and the draft are not');

-- ─── Words, in any order, the last one a prefix ─────────────────────────────

select ok(pg_temp.finds('dancer neon', '21'), 'every word finds the recipe in any order');
select ok(pg_temp.finds('neon danc', '21'), 'the last word may still be being typed');
select ok(pg_temp.finds('portr', '21'), 'a single word still being typed finds it');
select ok(pg_temp.finds('portraits', '21'), 'a plural finds the singular');
select ok(pg_temp.finds('dancers', '21'), 'in a later word of the title too');
select ok(pg_temp.finds('steps neon reva', '21'), 'words from the summary, title and seller together');
select ok(not pg_temp.finds('dancer rainy', '21'), 'every word is required');
select ok(not pg_temp.finds('portraits', '22'), 'a word finds only the recipes that hold it');

-- ─── A tool's name, split and joined ────────────────────────────────────────

select ok(pg_temp.finds('veo3', '22'), 'a tool typed without its space');
select ok(pg_temp.finds('veo 3', '22'), 'a tool while its version is still being typed');
select ok(pg_temp.finds('veo-3.1', '22'), 'a tool as its name is written');
select ok(pg_temp.finds('nano-ban', '21'), 'a hyphenated tool while it is still being typed');
select ok(pg_temp.finds('nano banana', '21'), 'the words of a hyphenated tool');
select ok(pg_temp.finds('nanobanana', '21'), 'a hyphenated tool typed as one word');

-- ─── What matched before still matches ──────────────────────────────────────

select ok(pg_temp.finds('eet at nig', '22'), 'a run of characters inside the text still finds the recipe');
select ok(pg_temp.finds('larkspur', '21') is false, 'and a word nowhere in the text finds nothing');
select is(pg_temp.page('%%%', 'recent', 0, 100), '{}'::uuid[], 'a query''s % still matches only itself');
select is(pg_temp.page('ab', 'recent', 0, 100), '{}'::uuid[], 'a query under three characters still finds nothing');

-- ─── Misspellings ───────────────────────────────────────────────────────────

select ok(pg_temp.finds('rainny street', '22'), 'a misspelt word is read as its nearest known word');
select ok(pg_temp.finds('cinematic chromaflre', '22'),
  'a misspelt word of a listed recipe''s summary is corrected too');
select ok(not pg_temp.finds('rainny street', '21'), 'a corrected query finds only the recipes that hold it');
select is(pg_temp.page('xqzvbnmw', 'recent', 0, 100), '{}'::uuid[], 'a query no word is near finds nothing');

-- ─── The paywall ────────────────────────────────────────────────────────────

select ok(not pg_temp.finds('zephyrcoil', '22'), 'a word of a recipe''s items does not find it');
select ok(not pg_temp.finds('zephyrcoi', '22'), 'nor the start of one');
select ok(not pg_temp.finds('quorvantel', '22'), 'a word of a paid recipe''s setup caption does not find it');
select ok(pg_temp.finds('quorvantell', '27') and not pg_temp.finds('quorvantell', '22'),
  'nor that word misspelt: corrected to it, the query finds only the recipe that shows it');
select ok(not pg_temp.finds('velvetmoss', '24'), 'a recipe on a labelled post is not found');
select ok(not pg_temp.finds('draftlark', '26'), 'nor a draft');

-- ─── Relevance ──────────────────────────────────────────────────────────────

select is(pg_temp.page('golden hour', 'recent', 0, 100),
  array[pg_temp.bundle('25'), pg_temp.bundle('27'), pg_temp.bundle('23')],
  'the list''s own sort still orders a search newest first');
select is(pg_temp.page('golden hour', 'relevance', 0, 100),
  array[pg_temp.bundle('23'), pg_temp.bundle('25'), pg_temp.bundle('27')],
  'relevance puts the recipe whose title holds the words first, then the newest');
select is(pg_temp.page('golden hour', 'bogus', 0, 100), pg_temp.page('golden hour', 'recent', 0, 100),
  'a sort the list does not know still reads as newest first');
select is(pg_temp.page(null, 'relevance', 0, 100), pg_temp.page(null, 'recent', 0, 100),
  'relevance without a query reads as newest first');
select is(
  pg_temp.page('golden hour', 'relevance', 0, 1) || pg_temp.page('golden hour', 'relevance', 1, 1)
    || pg_temp.page('golden hour', 'relevance', 2, 1),
  pg_temp.page('golden hour', 'relevance', 0, 100),
  'relevance pages one row at a time in the same order'
);
select is(
  pg_temp.page('goldn hour', 'relevance', 0, 1) || pg_temp.page('goldn hour', 'relevance', 1, 1)
    || pg_temp.page('goldn hour', 'relevance', 2, 1),
  array[pg_temp.bundle('23'), pg_temp.bundle('25'), pg_temp.bundle('27')],
  'every page of a misspelt search reads its corrected query, offset or not'
);
select is(pg_temp.page('lantern glow', 'relevance', 0, 100),
  array[pg_temp.bundle('28'), pg_temp.bundle('29')],
  'a caption repeating the words thirty times does not outrank the recipe titled with them');
select is(pg_temp.page('lantern glow', 'recent', 0, 100),
  array[pg_temp.bundle('29'), pg_temp.bundle('28')],
  'fixture: the repetitive recipe is the newer one');

-- ─── The document's vector ──────────────────────────────────────────────────

select is(
  (select attgenerated::text from pg_attribute
   where attrelid = 'public.marketplace_bundle_search_documents'::regclass and attname = 'search_vector'),
  's',
  'the document''s search vector is generated from its text, so it holds nothing else'
);
select ok(
  not exists (
    select 1 from public.marketplace_bundle_search_documents
    where search_vector is distinct from public.marketplace_search_vector(search_text)
  ),
  'every document''s vector is its text''s'
);
select ok(
  exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'marketplace_bundle_search_documents'
      and indexdef ilike '%using gin (search_vector)%'
  ),
  'the vector is indexed'
);

-- ─── The dictionary ─────────────────────────────────────────────────────────

select ok(exists (select 1 from public.search_terms where term = 'chromaflare'),
  'after a rebuild a listed recipe''s visible words are in the dictionary');
select ok(not exists (select 1 from public.search_terms where term in ('velvetmoss', 'draftlark')),
  'a recipe that is not listed adds none: on a labelled post, or a draft');
select ok(not exists (select 1 from public.search_terms where term = 'zephyrcoil'),
  'a recipe''s item text never does');
select ok(
  not exists (
    select 1
    from pg_trigger as triggers
    join pg_proc as functions on functions.oid = triggers.tgfoid
    where not triggers.tgisinternal
      and (functions.prosrc ilike '%search_terms%'
           or triggers.tgrelid = 'public.search_terms'::regclass)
  ),
  'no save writes the dictionary: no trigger function names it, and none sits on it'
);

-- One dictionary per surface: a search is corrected only to a word its own
-- results can show.
select is(
  (select array[in_posts, in_recipes] from public.search_terms where term = 'chromaflare'),
  array[false, true],
  'a word only a recipe shows is a recipe word, not a post word'
);
select is(
  (select array[in_posts, in_recipes] from public.search_terms where term = 'brindlewick'),
  array[true, false],
  'a word only a post shows is a post word, not a recipe word'
);
select is(
  (select array[in_posts, in_recipes] from public.search_terms where term = 'rainy'),
  array[true, true],
  'a word both show is both'
);
select is(public.search_corrected_query('chromaflre'), 'chromaflre',
  'a post search is not corrected to a word only a recipe shows');
select is(public.search_corrected_query('brindlewik'), 'brindlewick',
  'a post search is still corrected to a post''s word');
select is(public.search_corrected_query('brindlewik', true), 'brindlewik',
  'a recipe search is not corrected to a word only a post shows');
select is(public.search_corrected_query('chromaflre', true), 'chromaflare',
  'a recipe search is corrected to a recipe''s word');
select is(pg_temp.page('brindlewik', 'recent', 0, 100), '{}'::uuid[],
  'so the list finds nothing through a post''s word');

-- ─── The app's recheck reads the query the same way ─────────────────────────

select is(
  public.marketplace_search_texts_match(
    array['neon dancer portrait reva lindqvist', 'rainy street at night', 'golden hour portraits'],
    'dancer neon'
  ),
  array[true, false, false],
  'the recheck finds the words in any order'
);
select is(
  public.marketplace_search_texts_match(array['rainy street at night veo-3.1', 'neon dancer'], 'veo3'),
  array[true, false],
  'and a tool typed without its space'
);
select is(
  public.marketplace_search_texts_match(array['rainy street at night', 'neon dancer'], 'rainny street'),
  array[true, false],
  'and a misspelt query as the list corrects it'
);
select is(
  public.marketplace_search_texts_match(array['rainy street at night', 'the zephyrcoil prompt'], 'zephyrcoil'),
  array[false, true],
  'and only the text it is given'
);
select is(public.marketplace_search_texts_match(array['abc'], 'ab'), array[false],
  'and nothing under three characters');
select is(
  public.marketplace_search_texts_match(array['brindlewick meadow', 'cinematic rain grading with chromaflare'], 'brindlewik'),
  array[false, false],
  'and corrects as the list does, to a recipe''s word only'
);

-- ─── As the app calls them: the service role ────────────────────────────────

set local role service_role;
select is(
  public.marketplace_search_texts_match(array['rainy street at night', 'neon dancer'], 'rainny street'),
  array[true, false],
  'the service role runs the recheck, its correction included'
);
select is(
  (select array_agg(id order by position)
   from public.list_marketplace_resource_bundles('all', 'all', null, 'lantern glow', 'relevance', 0, 100)
     with ordinality as listed(
       id, post_id, owner_user_id, legacy_asset_id, access_mode, status, title, summary, preview_text,
       prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix,
       resource_sections, resource_items, price_usd_cents, sales_count, free_unlock_count,
       earnings_usd_cents, created_at, updated_at, position
     )),
  array['0000e5c1-0000-4000-9000-000000000028'::uuid, '0000e5c1-0000-4000-9000-000000000029'::uuid],
  'and the list by relevance'
);
select ok(
  (select count(*) from public.list_marketplace_resource_bundles('all', 'all', null, 'chromaflre', 'relevance', 0, 100)) = 1,
  'and the list''s correction'
);
reset role;

-- ─── Grants ─────────────────────────────────────────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.marketplace_search_texts_match(text[], text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.marketplace_search_texts_match(text[], text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.marketplace_search_texts_match(text[], text)', 'EXECUTE'),
  'only the service role runs the recheck'
);
select ok(
  not has_function_privilege('anon', 'public.marketplace_search_vector(text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.marketplace_search_vector(text)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.rebuild_search_terms()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.rebuild_search_terms()', 'EXECUTE')
    and has_function_privilege('service_role', 'public.rebuild_search_terms()', 'EXECUTE'),
  'nor the vector, and the rebuild keeps its grants'
);
select ok(
  not has_function_privilege('anon', 'public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)', 'EXECUTE'),
  'the list keeps its grants'
);

-- ─── A recipe taken off the list ────────────────────────────────────────────

update public.post_resource_bundles set status = 'draft' where id = pg_temp.bundle('22');
select ok((select removed > 0 from public.rebuild_search_terms()),
  'the next rebuild removes the words only an unlisted recipe showed');
select ok(not exists (select 1 from public.search_terms where term = 'chromaflare')
            and exists (select 1 from public.search_terms where term = 'rainy'),
  'its summary''s word is gone, its post''s title stays');
select is(
  (select array[in_posts, in_recipes] from public.search_terms where term = 'rainy'),
  array[true, false],
  'and that title''s word is now a post word only'
);

select * from finish();
rollback;
