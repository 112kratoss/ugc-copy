begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(48);

-- 5ea0…01 creates the posts; 5ea0…02 is another creator with nothing posted.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
values
  ('5ea00000-0000-4000-8000-000000000001'::uuid, 'search-recall-creator@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb),
  ('5ea00000-0000-4000-8000-000000000002'::uuid, 'search-recall-other@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb);

update public.profiles
set username = 'mira-okafor', display_name = 'Mira Okafor', bio = 'Editorial lighting studies'
where id = '5ea00000-0000-4000-8000-000000000001'::uuid;

insert into public.generations (id, user_id, model, status, is_public)
values
  ('5ea10000-0000-4000-8000-000000000001'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'veo-3.1', 'succeeded', true),
  ('5ea10000-0000-4000-8000-000000000002'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'nano-banana-pro', 'succeeded', true),
  ('5ea10000-0000-4000-8000-000000000003'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'seedream-4.5', 'succeeded', true),
  ('5ea10000-0000-4000-8000-000000000004'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
   'veo-3.1', 'succeeded', true);

-- …11 and …12 are creations made in the app: their posts name the app as the
-- tool, and only the creation knows the model. …13 was made elsewhere. …14 is
-- a labelled creation on the same model as …11. …15 gets its creation later.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, source_tool, source_tool_slug, generation_id, showcase_asset_path,
  is_nsfw, created_at, updated_at
) values
  (
    '5ea20000-0000-4000-8000-000000000011'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'video', 'magicbooklet', 'media', 'visible',
    'Rainy street at night', 'Neon reflections on wet asphalt', 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000001'::uuid, 'showcase/search-recall-11.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000012'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'visible',
    'Studio portrait of a dancer', 'Soft key light from the left', 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000002'::uuid, 'showcase/search-recall-12.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000013'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'external', 'media', 'visible',
    'Harbor at dawn', 'Boats under fog', 'Midjourney', 'midjourney',
    null, 'showcase/search-recall-13.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000014'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'video', 'magicbooklet', 'media', 'visible',
    'Labelled frame', 'A labelled clip', 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000004'::uuid,
    'private-posts/5ea20000-0000-4000-8000-000000000014/original.jpg',
    true, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000015'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'visible',
    'Quiet orchard', 'Rows of trees in mist', 'Magicbooklet', 'magicbooklet',
    null, 'showcase/search-recall-15.png',
    false, now(), now()
  );

-- …16 is a template's result: its model is the template author's, and every
-- public read names it 'template-workflow' (src/lib/template-result.ts).
insert into public.templates (id, name, creator_user_id, status, is_active)
values ('5ea30000-0000-4000-8000-000000000001'::uuid, 'Search recall fixture',
        '5ea00000-0000-4000-8000-000000000002'::uuid, 'draft', true);

insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
) values (
  '5ea40000-0000-4000-8000-000000000001'::uuid, '5ea30000-0000-4000-8000-000000000001'::uuid,
  '5ea00000-0000-4000-8000-000000000001'::uuid, '{"version":1,"nodes":[],"edges":[]}'::jsonb,
  repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'output', 'image', 'collecting_inputs', 10, 10
);

insert into public.generations (id, user_id, model, status, is_public, template_run_id)
values ('5ea10000-0000-4000-8000-000000000005'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
        'kling-2.1-master', 'succeeded', true, '5ea40000-0000-4000-8000-000000000001'::uuid);

-- …17 holds 'portrait' too, so a corrected query has a second page. …18 is
-- sold: its caption is the saved setup and its prompt the recipe's, and
-- neither is public.
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, prompt, source_tool, source_tool_slug, generation_id, showcase_asset_path,
  is_nsfw, created_at, updated_at
) values
  (
    '5ea20000-0000-4000-8000-000000000016'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'magicbooklet', 'media', 'visible',
    'Garden walk at noon', 'Hedges and gravel', null, 'Magicbooklet', 'magicbooklet',
    '5ea10000-0000-4000-8000-000000000005'::uuid, 'showcase/search-recall-16.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000017'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'external', 'media', 'visible',
    'Portrait in window light', 'A quiet face', null, 'Midjourney', 'midjourney',
    null, 'showcase/search-recall-17.png',
    false, now(), now()
  ),
  (
    '5ea20000-0000-4000-8000-000000000018'::uuid, '5ea00000-0000-4000-8000-000000000001'::uuid,
    'public', 'image', 'external', 'media', 'visible',
    'Tarn study', E'Saved generation setup\nGrade: tarnwhistle', 'quokkaprompt for buyers', 'Midjourney', 'midjourney',
    null, 'showcase/search-recall-18.png',
    false, now(), now()
  );

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '5ea50000-0000-4000-8000-000000000018'::uuid, '5ea20000-0000-4000-8000-000000000018'::uuid,
  '5ea00000-0000-4000-8000-000000000001'::uuid, 'paid', 'published', 'Tarn recipe',
  'Three steps to the finished picture', 'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a buyer unlocks for this picture')),
  '[]'::jsonb, 300, 0, 0, now(), now()
);

create function pg_temp.finds(p_query text, p_post_suffix text) returns boolean
language sql as $$
  select exists (
    select 1 from public.search_public_posts(p_query, null, null, null, 25)
    where post_id = ('5ea20000-0000-4000-8000-0000000000' || p_post_suffix)::uuid
  );
$$;

create function pg_temp.finds_creator(p_query text) returns boolean
language sql as $$
  select exists (
    select 1 from public.search_public_creators(p_query, null, null, null, 25)
    where creator_user_id = '5ea00000-0000-4000-8000-000000000001'::uuid
  );
$$;

-- Every input a person can type must be answered, never raised on.
create function pg_temp.survives(p_search text) returns void
language plpgsql as $$
declare
  v_input text;
begin
  foreach v_input in array array[
    '''''''', 'it''s', E'\\', E'a\\b', ':*', 'foo:*', '&|!()', 'a & b | !c', '<->', '"quoted"',
    U&'\+01F600\+01F600\+01F600', 'the and of', '...!!!', '-3.1', 'foo-bar baz', '%_%',
    repeat('x', 100), repeat('ab ', 33), 'a', ''
  ] loop
    execute format('select count(*) from public.%I(%L, null, null, null, 25)', p_search, v_input);
  end loop;
end;
$$;

-- ─── A creation is found by its model ───────────────────────────────────────

select ok(pg_temp.finds('veo', '11'), 'a creation is found by the first word of its model');
select ok(pg_temp.finds('veo 3.1', '11'), 'by its model as its name reads');
select ok(pg_temp.finds('veo-3.1', '11'), 'by its model as its id is written');
select ok(pg_temp.finds('veo3', '11'), 'by its model typed without the space');
select ok(pg_temp.finds('veo 3', '11'), 'by its model while its version is still being typed');
select ok(pg_temp.finds('nano banana', '12'), 'by the words of a hyphenated model id');
select ok(pg_temp.finds('nanobanana', '12'), 'by a hyphenated model id typed as one word');
select ok(pg_temp.finds('nano-ban', '12'), 'by a hyphenated model id while it is still being typed');

select ok(not pg_temp.finds('veo', '14'), 'a labelled creation is not found by its model');
select ok(not pg_temp.finds('veo', '12'), 'a model finds only the posts made with it');
select ok(not pg_temp.finds('veo', '13'), 'and none made elsewhere');
select ok(not pg_temp.finds('kling', '16'), 'a template''s result is not found by its author''s model');
select ok(pg_temp.finds('template workflow', '16'), 'it is found by the name public reads give that model');

-- ─── The dictionary ─────────────────────────────────────────────────────────

select ok(
  (select added > 0 and removed = 0 from public.rebuild_search_terms()),
  'a rebuild adds the words the posts show'
);
select is(
  (select added + removed from public.rebuild_search_terms()),
  0,
  'a second rebuild finds nothing to do'
);
select ok(
  not exists (
    select 1 from public.search_terms
    where term in ('quokkaprompt', 'tarnwhistle', 'kling', 'master')
  ),
  'the dictionary holds no word of a sold recipe''s prompt or setup, nor of a template author''s model'
);

-- ─── Words match as people type them ────────────────────────────────────────

select ok(pg_temp.finds('portr', '12'), 'a word still being typed finds the post');
select ok(pg_temp.finds('studio danc', '12'), 'the last of several words may still be being typed, wherever the words sit');
select ok(pg_temp.finds('portraits', '12'), 'a plural finds the singular');
select ok(pg_temp.finds('dancers', '12'), 'in the title''s later words too');
select ok(pg_temp.finds('portriat', '12'), 'a misspelt word finds the post');
select ok(pg_temp.finds('reflektions', '11'), 'a misspelt word of the caption too');
select ok(pg_temp.finds('studio portriat', '12'), 'one misspelt word among several is read as its nearest known word');
select ok(not pg_temp.finds('portriat', '11'), 'a corrected word finds only the posts that hold it');
select is(
  public.search_corrected_query('studio portriat veo3 danc xqzvk'),
  'studio portrait veo 3 danc xqzvk',
  'a word is corrected only when it is letters, no known word starts with it, and a near one exists'
);
select ok(
  exists (select 1 from public.search_terms where term = 'reflections')
    and not exists (select 1 from public.search_terms where term = 'labelled'),
  'the dictionary holds the words unlabelled posts show, and none a labelled post alone shows'
);
select ok(not pg_temp.finds('portrait', '11'), 'a word finds only the posts that hold it');
select ok(not pg_temp.finds('zebra crossing', '12'), 'and words no post holds find nothing');

select is(
  (
    with first_page as (
      select * from public.search_public_posts('portriat', null, null, null, 1)
    ), second_page as (
      select next_page.*
      from first_page
      cross join lateral public.search_public_posts(
        'portriat', null, first_page.search_score, first_page.post_id, 1
      ) as next_page
    )
    select array(
      select post_id from (select post_id from first_page union all select post_id from second_page) as pages
      order by post_id
    )
  ),
  array['5ea20000-0000-4000-8000-000000000012', '5ea20000-0000-4000-8000-000000000017']::uuid[],
  'the pages of a corrected query hold each post once'
);

select lives_ok($$select pg_temp.survives('search_public_posts')$$, 'post search answers every input a person can type');
select lives_ok($$select pg_temp.survives('search_public_creators')$$, 'creator search does too');
select is(
  (select count(*)::integer from public.search_public_posts('ab', null, null, null, 25)),
  0,
  'a post query under three characters finds nothing, and does not raise'
);
select is(
  (select count(*)::integer from public.search_public_creators('m', null, null, null, 25)),
  0,
  'a creator query under two characters finds nothing, and does not raise'
);

select is(
  (select post_id from public.search_public_posts('studio portrait', null, null, null, 25) limit 1),
  '5ea20000-0000-4000-8000-000000000012'::uuid,
  'the post that holds the words as typed comes first'
);

-- ─── Made with: every listed tool and model, kept current ───────────────────

insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
values
  ('5ea20000-0000-4000-8000-000000000013'::uuid, 'Midjourney', 'midjourney', 'Niji 6', 'niji-6', 0),
  ('5ea20000-0000-4000-8000-000000000013'::uuid, 'Topaz Labs', 'topaz-labs', null, null, 1);

select ok(pg_temp.finds('niji', '13'), 'a post is found by the model its Made with lists');
select ok(pg_temp.finds('niji6', '13'), 'typed without the space');
select ok(pg_temp.finds('topaz', '13'), 'and by a tool beyond the first');

update public.post_source_tools
set model_label = 'Niji 7', model_slug = 'niji-7'
where post_id = '5ea20000-0000-4000-8000-000000000013'::uuid and tool_slug = 'midjourney';

select ok(
  (select search_text like '%niji 7%' and search_text not like '%niji 6%'
   from public.post_search_documents
   where post_id = '5ea20000-0000-4000-8000-000000000013'::uuid),
  'a changed Made with re-projects the post''s document'
);

delete from public.post_source_tools
where post_id = '5ea20000-0000-4000-8000-000000000013'::uuid;

select ok(not pg_temp.finds('niji', '13'), 'a removed Made with is no longer searched');
select ok(pg_temp.finds('midjourney', '13'), 'the post''s own tool still is');

update public.posts
set generation_id = '5ea10000-0000-4000-8000-000000000003'::uuid
where id = '5ea20000-0000-4000-8000-000000000015'::uuid;

select ok(pg_temp.finds('seedream 4.5', '15'), 'a post given its creation is found by that creation''s model');

-- ─── Creators ───────────────────────────────────────────────────────────────

select ok(pg_temp.finds_creator('okaf'), 'a creator is found by a later word of their name, still being typed');
select ok(pg_temp.finds_creator('mira oka'), 'by their name with its last word still being typed');
select ok(pg_temp.finds_creator('mirra okafor'), 'by their name misspelt');
select ok(not pg_temp.finds_creator('zebra'), 'and not by a word they do not have');

-- ─── A deleted post takes its Made with, its document and its words ─────────

insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
values ('5ea20000-0000-4000-8000-000000000015'::uuid, 'Magicbooklet', 'magicbooklet', 'Seedream 4.5', 'seedream-4.5', 0);

select lives_ok(
  $$delete from public.posts where id = '5ea20000-0000-4000-8000-000000000015'::uuid$$,
  'a post with Made with rows is deleted, its rows'' trigger finding it gone'
);
-- The rebuild and the read of what it left are two statements: a statement
-- does not see what a function it calls has just removed.
select ok(
  (select removed > 0 from public.rebuild_search_terms()),
  'the next rebuild removes words'
);
select ok(
  not exists (select 1 from public.post_search_documents
              where post_id = '5ea20000-0000-4000-8000-000000000015'::uuid)
    and not exists (select 1 from public.search_terms where term = 'orchard')
    and exists (select 1 from public.search_terms where term = 'quiet'),
  'no document is left for it, the words only it showed are gone, and a word another post shows stays'
);

select * from finish();
rollback;
