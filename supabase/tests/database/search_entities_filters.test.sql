-- Search entities, filters and the corrected reading (20261112143757): the
-- models and tools posts are made with are results with a count of the posts
-- a viewer may see; a template result has no model; Posts are filtered before
-- the page is cut; a search says when it read the query as something else and
-- can be told not to; and the call the app live during the release makes
-- still works and reads what it read.
begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select no_plan();

-- …01 is the viewer. …02 and …03 create posts; the viewer follows …03. The
-- viewer has blocked …04, and …05 has blocked the viewer. …06 sells recipes.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
select
  ('5e170000-0000-4000-8000-0000000000' || suffix)::uuid,
  'search-entities-' || suffix || '@example.invalid',
  'authenticated', 'authenticated', now() - interval '200 days', '{}'::jsonb, '{}'::jsonb
from unnest(array['01', '02', '03', '04', '05', '06']) as suffix;

update public.profiles as profiles
set username = named.username, display_name = named.display_name
from (values
  ('01', 'tamsin-viewer', 'Tamsin Viewer'),
  ('02', 'orrin-maker', 'Orrin Maker'),
  ('03', 'orrin-followed', 'Orrin Followed'),
  ('04', 'orrin-blocked', 'Orrin Blocked'),
  ('05', 'orrin-blocker', 'Orrin Blocker'),
  ('06', 'orrin-seller', 'Orrin Seller')
) as named(suffix, username, display_name)
where profiles.id = ('5e170000-0000-4000-8000-0000000000' || named.suffix)::uuid;

insert into public.follows (follower_id, following_id)
values ('5e170000-0000-4000-8000-000000000001'::uuid, '5e170000-0000-4000-8000-000000000003'::uuid);

insert into public.user_blocks (blocker_user_id, blocked_user_id)
values
  ('5e170000-0000-4000-8000-000000000001'::uuid, '5e170000-0000-4000-8000-000000000004'::uuid),
  ('5e170000-0000-4000-8000-000000000005'::uuid, '5e170000-0000-4000-8000-000000000001'::uuid);

create function pg_temp.user_id(p_suffix text) returns uuid language sql immutable as $$
  select ('5e170000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;
create function pg_temp.post_id(p_suffix text) returns uuid language sql immutable as $$
  select ('5e171000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;
create function pg_temp.creation_id(p_suffix text) returns uuid language sql immutable as $$
  select ('5e172000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;

-- A template's run, for the creation a template made.
insert into public.templates (id, name, creator_user_id, status, is_active)
values ('5e173000-0000-4000-8000-000000000001'::uuid, 'Search entities fixture', pg_temp.user_id('03'), 'draft', true);
insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
) values (
  '5e174000-0000-4000-8000-000000000001'::uuid, '5e173000-0000-4000-8000-000000000001'::uuid,
  pg_temp.user_id('02'), '{"version":1,"nodes":[],"edges":[]}'::jsonb,
  repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'output', 'image', 'collecting_inputs', 10, 10
);

-- Creations: …11, …12, …14, …16 and …18 on kling-2.6, …17 on veo-3.1, and …15 a
-- template's result whose own model is kling-3.0.
insert into public.generations (id, user_id, model, status, is_public, template_run_id)
values
  (pg_temp.creation_id('11'), pg_temp.user_id('02'), 'kling-2.6', 'succeeded', true, null),
  (pg_temp.creation_id('12'), pg_temp.user_id('03'), 'kling-2.6', 'succeeded', true, null),
  (pg_temp.creation_id('14'), pg_temp.user_id('02'), 'kling-2.6', 'succeeded', true, null),
  (pg_temp.creation_id('15'), pg_temp.user_id('02'), 'kling-3.0', 'succeeded', true, '5e174000-0000-4000-8000-000000000001'::uuid),
  (pg_temp.creation_id('16'), pg_temp.user_id('04'), 'kling-2.6', 'succeeded', true, null),
  (pg_temp.creation_id('17'), pg_temp.user_id('05'), 'veo-3.1', 'succeeded', true, null),
  (pg_temp.creation_id('18'), pg_temp.user_id('02'), 'kling-2.6', 'succeeded', true, null);

create function pg_temp.post(
  p_suffix text, p_creator text, p_title text, p_body text, p_category text,
  p_tool text, p_tool_slug text, p_age interval,
  p_creation boolean default false, p_nsfw boolean default false, p_visibility text default 'public'
) returns void language sql as $$
  insert into public.posts (
    id, user_id, visibility, category, source_kind, post_format, review_status,
    title, body, source_tool, source_tool_slug, generation_id, showcase_asset_path,
    is_nsfw, created_at, updated_at
  ) values (
    pg_temp.post_id(p_suffix), pg_temp.user_id(p_creator),
    p_visibility, p_category, case when p_creation then 'magicbooklet' else 'external' end,
    case when p_category = 'text' then 'text' else 'media' end, 'visible',
    p_title, p_body, p_tool, p_tool_slug,
    case when p_creation then pg_temp.creation_id(p_suffix) end,
    case when p_category = 'text' then null
         when p_nsfw then 'private-posts/' || pg_temp.post_id(p_suffix) || '/original.jpg'
         else 'showcase/search-entities-' || p_suffix || '.png' end,
    p_nsfw, now() - p_age, now()
  );
$$;

-- 'sunmote' is the word the searches below share, in every title; every
-- caption holds 'verdanthal', which no title does, so a misspelling of it is
-- near no title.
--   …11 a video made here on Kling 2.6, with its Made with row;
--   …12 a picture made here on Kling 2.6 by the creator the viewer follows,
--       stored without a Made with row: only its creation names the model;
--   …13 a picture made elsewhere (Midjourney, Niji 6), with a free recipe;
--   …14 a labelled video on Kling 2.6;
--   …15 a template's result: its creation's model is the template author's,
--       and an old Made with row still names it;
--   …16 a video on Kling 2.6 by the creator the viewer blocked;
--   …17 a video on Veo 3.1 by the creator who blocked the viewer;
--   …18 a private video on Kling 2.6;
--   …19 a labelled picture, the only post made with Secretool;
--   …20 a text post.
select pg_temp.post('11', '02', 'Sunmote reel', 'A quiet clip in verdanthal light', 'video', 'Magicbooklet', 'magicbooklet', interval '1 day', true);
select pg_temp.post('12', '03', 'Sunmote still', 'A quiet frame in verdanthal light', 'image', 'Magicbooklet', 'magicbooklet', interval '2 days', true);
select pg_temp.post('13', '02', 'Sunmote sketch', 'A quiet frame in verdanthal light', 'image', 'Midjourney', 'midjourney', interval '3 days');
select pg_temp.post('14', '02', 'Sunmote after dark', 'A labelled clip in verdanthal light', 'video', 'Magicbooklet', 'magicbooklet', interval '4 days', true, true);
select pg_temp.post('15', '02', 'Sunmote from a template', 'A quiet frame in verdanthal light', 'image', 'Magicbooklet', 'magicbooklet', interval '5 days', true);
select pg_temp.post('16', '04', 'Sunmote by the blocked', 'A quiet clip in verdanthal light', 'video', 'Magicbooklet', 'magicbooklet', interval '6 days', true);
select pg_temp.post('17', '05', 'Sunmote by the blocker', 'A quiet clip in verdanthal light', 'video', 'Magicbooklet', 'magicbooklet', interval '7 days', true);
select pg_temp.post('18', '02', 'Sunmote kept private', 'A quiet clip in verdanthal light', 'video', 'Magicbooklet', 'magicbooklet', interval '8 days', true, false, 'private');
select pg_temp.post('19', '02', 'Sunmote under a label', 'A labelled frame', 'image', 'Secretool', 'secretool', interval '9 days', false, true);
select pg_temp.post('20', '02', 'Sunmote notes', 'Words about the sunmote series and its verdanthal light', 'text', null, null, interval '10 days');

insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
values
  (pg_temp.post_id('11'), 'Magicbooklet', 'magicbooklet', 'Kling 2.6', 'kling-2.6', 0),
  (pg_temp.post_id('13'), 'Midjourney', 'midjourney', 'Niji 6', 'niji-6', 0),
  (pg_temp.post_id('13'), 'Topaz Labs', null, null, null, 1),
  (pg_temp.post_id('15'), 'Magicbooklet', 'magicbooklet', 'Kling 3.0', 'kling-3.0', 0),
  (pg_temp.post_id('16'), 'Magicbooklet', 'magicbooklet', 'Kling 2.6', 'kling-2.6', 0),
  (pg_temp.post_id('17'), 'Magicbooklet', 'magicbooklet', 'Veo 3.1', 'veo-3.1', 0);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '5e175000-0000-4000-8000-000000000013'::uuid, pg_temp.post_id('13'), pg_temp.user_id('02'),
  'free', 'published', 'Sunmote sketch recipe', 'Three steps to the finished picture',
  'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a visitor unlocks for this picture')),
  '[]'::jsonb, 0, 0, 0, now(), now()
);

select public.rebuild_search_terms();

-- A post's entities, as 'kind:key', in order.
create function pg_temp.entities_of(p_suffix text) returns text[] language sql stable as $$
  select coalesce(array_agg(members.kind || ':' || members.key order by members.kind, members.key), '{}')
  from public.post_search_entities as members
  where members.post_id = pg_temp.post_id(p_suffix);
$$;

-- What an entity search returns, as 'kind:key=count', in its order.
create function pg_temp.entities_found(p_query text, p_viewer uuid default null, p_limit integer default 10)
returns text[] language sql stable as $$
  select coalesce(array_agg(found.kind || ':' || found.key || '=' || found.post_count order by found.position), '{}')
  from (
    select e.kind, e.key, e.post_count, row_number() over () as position
    from public.search_public_entities(p_query, p_viewer, p_limit) as e
  ) as found;
$$;

-- A filtered search's posts in the order it gives them, as two-digit suffixes.
create function pg_temp.posts_found(
  p_query text, p_viewer uuid default null, p_sort text default 'top',
  p_made_with text default null, p_media_kind text default null,
  p_has_recipe boolean default false, p_followed_only boolean default false,
  p_correct boolean default true, p_limit integer default 25
) returns text[] language sql stable as $$
  select coalesce(array_agg(right(found.post_id::text, 2) order by found.position), '{}')
  from (
    select s.post_id, row_number() over () as position
    from public.search_public_posts(
      p_query, p_viewer, null, null, p_limit, now(), p_sort, null,
      p_made_with, p_media_kind, p_has_recipe, p_followed_only, p_correct
    ) as s
  ) as found;
$$;

-- ─── What a post's entities are ──────────────────────────────────────────────

select is(pg_temp.entities_of('11'), array['model:kling-2.6', 'tool:magicbooklet'],
  'a creation has its tool and the model its Made with names');
select is(pg_temp.entities_of('12'), array['model:kling-2.6', 'tool:magicbooklet'],
  'a creation stored without a Made with row has the model its creation names');
select is(pg_temp.entities_of('13'), array['model:niji-6', 'tool:midjourney', 'tool:topaz-labs'],
  'a post made elsewhere has every Made with tool and model; a tool with no slug is keyed by its name');
select is(pg_temp.entities_of('15'), array['tool:magicbooklet'],
  'a template''s result has no model, from its creation or from a Made with row: only its tool');
select is(pg_temp.entities_of('18'), '{}'::text[],
  'a private post has no document and so no entities');
select is(pg_temp.entities_of('20'), '{}'::text[],
  'a text post with no tool has none');
select is(
  (select array_agg(distinct members.creator_user_id) from public.post_search_entities as members
   where members.post_id = pg_temp.post_id('16')),
  array[pg_temp.user_id('04')],
  'each row carries its post''s creator'
);
select is(
  (select label from public.post_search_entities
   where post_id = pg_temp.post_id('11') and kind = 'model' and key = 'kling-2.6'),
  'Kling 2.6',
  'a post''s row holds the name that post prints'
);
select is(
  (select label from public.post_search_entities
   where post_id = pg_temp.post_id('12') and kind = 'model' and key = 'kling-2.6'),
  'kling-2.6',
  'the key, for a creation that prints no name'
);
select is(
  (select label from public.post_search_entities
   where post_id = pg_temp.post_id('13') and kind = 'tool' and key = 'topaz-labs'),
  'Topaz Labs',
  'a tool with no slug keeps its name as its label'
);
select hasnt_table('public', 'search_entity_labels',
  'nothing is kept of an entity beside its posts'' rows: no list of names to outlive them');
select is(public.search_entity_key('  Topaz  Labs!! '), 'topaz-labs', 'a key is the name lowercased, other characters a hyphen');
select is(public.search_entity_key('Veo-3.1'), 'veo-3.1', 'a key keeps a dot between digits');
select is(public.search_entity_key('   '), null, 'an empty name has no key');

-- ─── Entities as results ─────────────────────────────────────────────────────

select is(pg_temp.entities_found('kling'), array['model:kling-2.6=3'],
  'a visitor typing kling is offered Kling 2.6 with its three unlabelled public posts: the labelled one and the private one are not counted, and the template''s model is not offered');
select is(pg_temp.entities_found('kling', pg_temp.user_id('01')), array['model:kling-2.6=2'],
  'for a viewer the count leaves out the post of the creator they blocked');
select is(pg_temp.entities_found('veo', pg_temp.user_id('01')), '{}'::text[],
  'an entity whose only post is by a creator who blocked the viewer is not offered to them');
select is(pg_temp.entities_found('veo'), array['model:veo-3.1=1'], 'and is offered to a visitor');
select is(pg_temp.entities_found('kli'), array['model:kling-2.6=3'], 'three letters are enough, as for posts');
select is(pg_temp.entities_found('kl'), '{}'::text[],
  'two letters find none: posts are searched from three, and an offer must lead to posts');
select is(pg_temp.entities_found('k'), '{}'::text[], 'nor does one');
select is(pg_temp.entities_found('kling 2.6'), array['model:kling-2.6=3'], 'the name as printed');
select is(pg_temp.entities_found('kling2.6'), array['model:kling-2.6=3'], 'typed without the space');
select is(pg_temp.entities_found('kling 3'), '{}'::text[],
  'the template author''s model is offered under no spelling');
select is(pg_temp.entities_found('kling sunmote'), '{}'::text[],
  'a query with a word the name does not hold finds no entity');
select is(pg_temp.entities_found('secretool'), '{}'::text[],
  'a tool only a labelled post is made with is never offered');
select ok(
  exists (select 1 from public.post_search_entities where kind = 'tool' and key = 'secretool'),
  'though the labelled post has its row: only posts a viewer may see decide what is offered'
);
select is(pg_temp.entities_found('magicbooklet'), array['tool:magicbooklet=5'],
  'the app is a tool: its unlabelled public posts, the template''s result among them');
select is(pg_temp.entities_found('topaz'), array['tool:topaz-labs=1'], 'a tool beyond a post''s first');
select is(
  (select array_agg(e.kind || ':' || e.key order by e.kind, e.key) from public.search_public_entities('mid', null, 10) as e),
  array['tool:midjourney'],
  'a prefix finds the tools that start with it'
);

select is(
  (select array_agg(e.label || '=' || e.post_count || '=' || e.post_count_capped)
   from public.search_public_entities(null, pg_temp.user_id('01'), 5, 'model:kling-2.6') as e),
  array['Kling 2.6=2=false'],
  'one entity by its key, for a filter''s label: its name and the viewer''s count'
);
select is(
  (select count(*)::integer from public.search_public_entities(null, null, 5, 'tool:secretool')),
  0,
  'an entity no visible post has is not returned by key either'
);
select is(
  (select count(*)::integer from public.search_public_entities(null, null, 5, 'model:no-such-model')),
  0,
  'nor one that does not exist'
);
select throws_ok(
  $$ select * from public.search_public_entities(null, null, 5, 'kling-2.6') $$,
  'P0001', 'Entity must be model:<key> or tool:<key>', 'an entity without a kind is refused'
);
select throws_ok(
  $$ select * from public.search_public_entities('kling', null, 11) $$,
  'P0001', 'Entity search limit must be between 1 and 10', 'a limit above ten is refused'
);

-- The name shown is a visible post's. …34 is labelled and the first post seen
-- with its tool, under a name of its own; …35 prints the same tool otherwise.
select pg_temp.post('34', '02', 'Label first', 'A labelled frame', 'image', 'VELLUM   forge', null, interval '1 day', false, true);
select is(
  (select label from public.post_search_entities where post_id = pg_temp.post_id('34') and kind = 'tool'),
  'VELLUM   forge',
  'fixture: the tool is first seen on a labelled post, under the name that post prints'
);
select is(pg_temp.entities_found('vellum'), '{}'::text[], 'and is not offered while only that post has it');
select pg_temp.post('35', '02', 'Label second', 'A quiet frame', 'image', 'Vellum Forge', null, interval '1 day');
select is(
  (select array_agg(e.label || '=' || e.post_count) from public.search_public_entities('vellum') as e),
  array['Vellum Forge=1'],
  'offered once a visible post has it, under the name the visible post prints, never the labelled post''s'
);
select is(
  (select label from public.post_search_entities where post_id = pg_temp.post_id('35') and kind = 'tool'),
  'Vellum Forge',
  'each post''s row keeps the name that post prints'
);

-- ─── Only a name a visible post prints finds an entity ───────────────────────
--
-- The review's proof (2026-11-12). …71 is labelled and the first post saved
-- with the slug 'hushtool', under words of its own; …72 is visible and prints
-- the same slug as "Hushtool". A save keeps a client's words for a tool the
-- catalog does not know, so the two names share nothing but the key.
select pg_temp.post('71', '02', 'Private frame', 'A labelled frame', 'image', null, null, interval '1 day', false, true);
select pg_temp.post('72', '02', 'Open frame', 'A quiet frame', 'image', null, null, interval '1 day');
insert into public.post_source_tools (post_id, tool_label, tool_slug, sort_order)
values (pg_temp.post_id('71'), 'Hushword Private Studio', 'hushtool', 0);
insert into public.post_source_tools (post_id, tool_label, tool_slug, sort_order)
values (pg_temp.post_id('72'), 'Hushtool', 'hushtool', 0);

select is(pg_temp.entities_found('hushword'), '{}'::text[],
  'a word only a labelled post names a tool by finds no entity');
select is(pg_temp.posts_found('hushword'), '{}'::text[], 'as it finds no post');
select is(pg_temp.entities_found('hushword private'), '{}'::text[], 'nor do two of its words');
select is(
  (select array_agg(e.label || '=' || e.post_count) from public.search_public_entities('hushtool') as e),
  array['Hushtool=1'],
  'the key finds the entity, under the name the visible post prints, counting the visible post'
);
select is(
  (select array_agg(e.label || '=' || e.post_count) from public.search_public_entities(null, null, 1, 'tool:hushtool') as e),
  array['Hushtool=1'],
  'and by its key it is named the same way'
);
select is(pg_temp.posts_found('hushtool', null, 'latest', 'tool:hushtool'), array['72'],
  'pressing it opens the visible post');

-- The labelled post goes: nothing of its words is kept anywhere.
delete from public.posts where id = pg_temp.post_id('71');
select is(pg_temp.entities_found('hushword private'), '{}'::text[], 'after the labelled post is deleted its words still find nothing');
select is(
  (select count(*)::integer from public.post_search_entities
   where label ilike '%hushword%' or name_vector @@ to_tsquery('pg_catalog.simple', 'hushword')),
  0,
  'and no row holds them'
);

-- A name a visible post prints finds its entity while that post can be seen, and not after.
select pg_temp.post('73', '06', 'Works frame', 'A quiet frame', 'image', null, null, interval '1 day');
insert into public.post_source_tools (post_id, tool_label, tool_slug, sort_order)
values (pg_temp.post_id('73'), 'Penumbra Works', 'pnmbr', 0);
select is(pg_temp.entities_found('penumbra works'), array['tool:pnmbr=1'],
  'a name a visible post prints finds the entity, though the key holds none of its words');

create function pg_temp.words_kept(p_word text) returns integer language sql stable as $$
  select count(*)::integer from public.post_search_entities
  where name_vector @@ to_tsquery('pg_catalog.simple', p_word);
$$;

update public.posts set is_nsfw = true where id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra works'), '{}'::text[], 'labelled: its name finds nothing');
select is(
  (select count(*)::integer from public.search_public_entities(null, null, 1, 'tool:pnmbr')),
  0,
  'and names nothing'
);
update public.posts set is_nsfw = false where id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra'), array['tool:pnmbr=1'], 'unlabelled again, it does: nothing waits for a rebuild');

update public.posts set visibility = 'private' where id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra'), '{}'::text[], 'made private: its name finds nothing');
select is(pg_temp.words_kept('penumbra'), 0, 'and no row keeps it');
update public.posts set visibility = 'public' where id = pg_temp.post_id('73');

update public.posts set review_status = 'hidden' where id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra'), '{}'::text[], 'hidden by review: its name finds nothing');
select is(pg_temp.words_kept('penumbra'), 0, 'and no row keeps it');
update public.posts set review_status = 'visible' where id = pg_temp.post_id('73');

update public.posts set archived_at = now() where id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra'), '{}'::text[], 'archived: its name finds nothing');
select is(pg_temp.words_kept('penumbra'), 0, 'and no row keeps it');
update public.posts set archived_at = null where id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra'), array['tool:pnmbr=1'], 'fixture: back in view, it is found again');

-- Its Made with renamed: the old name is gone with the old row.
update public.post_source_tools set tool_label = 'Umbral Works' where post_id = pg_temp.post_id('73');
select is(pg_temp.entities_found('penumbra'), '{}'::text[], 'a name the post no longer prints finds nothing');
select is(pg_temp.words_kept('penumbra'), 0, 'and no row keeps it');
select is(pg_temp.entities_found('umbral'), array['tool:pnmbr=1'], 'the name it prints now does');

-- The creator who blocked the viewer prints a name of their own for a tool
-- the viewer can see elsewhere: for that viewer the name finds nothing.
select pg_temp.post('74', '05', 'Blocker frame', 'A quiet frame', 'image', null, null, interval '1 day');
insert into public.post_source_tools (post_id, tool_label, tool_slug, sort_order)
values (pg_temp.post_id('74'), 'Gloamwright Deluxe', 'hushtool', 0);
select is(pg_temp.entities_found('gloamwright'), array['tool:hushtool=1'],
  'a visitor finds the tool by the name the blocker''s post prints, counting that post');
select is(pg_temp.entities_found('gloamwright', pg_temp.user_id('01')), '{}'::text[],
  'the viewer they blocked does not: no post that viewer may see prints it');
select is(
  (select array_agg(e.label || '=' || e.post_count) from public.search_public_entities('hushtool', pg_temp.user_id('01')) as e),
  array['Hushtool=1'],
  'and by its key that viewer is shown the name the post they can see prints'
);

-- ─── An offer leads to posts, and to as many as it says ──────────────────────
--
-- …75 and …76 share a slug. …75 prints it as "Emberline Studio"; …76 prints
-- it as "Duskloom" and has 'emberline' in its title. …77 is labelled and
-- prints it as "Nightjar Private"; …78 is visible, prints "Duskloom", and
-- has 'nightjar' in its title.
select pg_temp.post('75', '02', 'Plain one', 'A quiet frame', 'image', null, null, interval '1 day');
select pg_temp.post('76', '02', 'Emberline notes', 'A quiet frame', 'image', null, null, interval '2 days');
select pg_temp.post('77', '02', 'Plain three', 'A labelled frame', 'image', null, null, interval '3 days', false, true);
select pg_temp.post('78', '02', 'Nightjar sketch', 'A quiet frame', 'image', null, null, interval '4 days');
insert into public.post_source_tools (post_id, tool_label, tool_slug, sort_order)
values
  (pg_temp.post_id('75'), 'Emberline Studio', 'duskloom', 0),
  (pg_temp.post_id('76'), 'Duskloom', 'duskloom', 0),
  (pg_temp.post_id('77'), 'Nightjar Private', 'duskloom', 0),
  (pg_temp.post_id('78'), 'Duskloom', 'duskloom', 0);

select is(pg_temp.entities_found('emberline'), array['tool:duskloom=2'],
  'an entity found by a name one post prints counts every post the search for that query narrowed to it returns: the post that names it and the post whose title holds the word');
select is(pg_temp.posts_found('emberline', null, 'latest', 'tool:duskloom'), array['75', '76'],
  'which is the list pressing it opens');
select is(pg_temp.entities_found('nightjar'), '{}'::text[],
  'a word only a labelled post names the tool by offers nothing, though a visible post with the tool holds the word in its title');
select is(pg_temp.entities_found('duskloom'), array['tool:duskloom=3'],
  'by its key: the three visible posts, the labelled one left out');
select is(pg_temp.posts_found('duskloom', null, 'latest', 'tool:duskloom'), array['75', '76', '78'],
  'and the list is those three');

-- Every offer, for every query here and both viewers: the Posts search for
-- that query narrowed to the entity returns at least one post, and exactly
-- as many as the offer says.
create function pg_temp.pressed_total(p_query text, p_viewer uuid, p_entity text) returns integer
language sql stable as $$
  select count(*)::integer
  from public.search_public_posts(p_query, p_viewer, null, null, 25, now(), 'top', null, p_entity) as s;
$$;
create function pg_temp.broken_offers(p_viewer uuid) returns text[] language sql stable as $$
  select coalesce(array_agg(
    asked.query || ' -> ' || offered.kind || ':' || offered.key || ' says ' || offered.post_count
      || ', opens ' || pg_temp.pressed_total(asked.query, p_viewer, offered.kind || ':' || offered.key)
    order by asked.query, offered.kind, offered.key
  ), '{}')
  from unnest(array[
    'kling', 'kli', 'kling 2.6', 'kling2.6', 'veo', 'veo 3', 'magicbooklet', 'magic', 'topaz', 'topaz labs',
    'midjourney', 'mid', 'niji', 'hushtool', 'hushword', 'gloamwright', 'umbral', 'umbral works', 'penumbra',
    'emberline', 'emberline studio', 'nightjar', 'duskloom', 'vellum', 'vellum forge', 'secretool',
    'sunmote', 'verdanthal', 'studio', 'works', 'private'
  ]) as asked(query)
  cross join lateral public.search_public_entities(asked.query, p_viewer, 10) as offered
  where pg_temp.pressed_total(asked.query, p_viewer, offered.kind || ':' || offered.key)
    is distinct from offered.post_count
    or offered.post_count < 1;
$$;
select is(pg_temp.broken_offers(null), '{}'::text[],
  'for a visitor every offer opens at least one post, and exactly as many as it says');
select is(pg_temp.broken_offers(pg_temp.user_id('01')), '{}'::text[],
  'and for the viewer with blocks on both sides');
select cmp_ok(
  (select count(*)::integer
   from unnest(array['kling', 'magicbooklet', 'midjourney', 'emberline', 'duskloom', 'hushtool', 'umbral']) as asked(query)
   cross join lateral public.search_public_entities(asked.query, null, 10) as offered),
  '>=', 7,
  'fixture: those queries do offer entities, so the two checks above compared something'
);

-- The order: the entity that is the query first, then by count.
select pg_temp.post('31', '02', 'Brindle one', 'A quiet frame', 'image', 'Brindle Studio', 'brindle-studio', interval '1 day');
select pg_temp.post('32', '02', 'Brindle two', 'A quiet frame', 'image', 'Brindle Studio', 'brindle-studio', interval '1 day');
select pg_temp.post('33', '02', 'Brindle three', 'A quiet frame', 'image', 'Brindle', 'brindle', interval '1 day');
select is(pg_temp.entities_found('brindle'), array['tool:brindle=1', 'tool:brindle-studio=2'],
  'the tool whose name is the query comes before one with more posts');
select is(pg_temp.entities_found('brindle', null, 1), array['tool:brindle=1'], 'and the limit cuts after it');

-- ─── Entities follow the post ────────────────────────────────────────────────

update public.post_source_tools
set model_label = 'Niji 7', model_slug = 'niji-7'
where post_id = pg_temp.post_id('13') and tool_slug = 'midjourney';
select is(pg_temp.entities_of('13'), array['model:niji-7', 'tool:midjourney', 'tool:topaz-labs'],
  'a changed Made with changes the post''s entities');
select is(pg_temp.entities_found('niji'), array['model:niji-7=1'],
  'and the model it no longer has is no longer offered');

-- A model a creation names before its post prints a name for it.
select pg_temp.post('41', '02', 'Wan frame', 'A quiet frame', 'image', 'Magicbooklet', 'magicbooklet', interval '1 day');
insert into public.generations (id, user_id, model, status, is_public)
values (pg_temp.creation_id('41'), pg_temp.user_id('02'), 'wan-2.7', 'succeeded', true);
update public.posts set generation_id = pg_temp.creation_id('41') where id = pg_temp.post_id('41');
select is(
  (select e.label from public.search_public_entities(null, null, 1, 'model:wan-2.7') as e),
  'wan-2.7',
  'a model only a creation names is named by its key'
);
insert into public.post_source_tools (post_id, tool_label, tool_slug, model_label, model_slug, sort_order)
values (pg_temp.post_id('41'), 'Magicbooklet', 'magicbooklet', 'Wan 2.7', 'wan-2.7', 0);
select is(
  (select e.label from public.search_public_entities(null, null, 1, 'model:wan-2.7') as e),
  'Wan 2.7',
  'and takes the name its post prints once it prints one'
);
select is(pg_temp.entities_of('41'), array['model:wan-2.7', 'tool:magicbooklet'],
  'the post still has the model once, under one key');

update public.posts set visibility = 'private' where id = pg_temp.post_id('41');
select is(pg_temp.entities_of('41'), '{}'::text[], 'a post made private loses its entities with its document');
select is(pg_temp.entities_found('wan'), '{}'::text[], 'and its model is no longer offered');
update public.posts set visibility = 'public' where id = pg_temp.post_id('41');
select is(pg_temp.entities_found('wan'), array['model:wan-2.7=1'], 'made public again, it is');
update public.posts set is_nsfw = true where id = pg_temp.post_id('41');
select is(pg_temp.entities_found('wan'), '{}'::text[],
  'a label takes a post out of the count at once: the count is live');
delete from public.posts where id = pg_temp.post_id('41');
select is(
  (select count(*)::integer from public.post_search_entities where post_id = pg_temp.post_id('41')),
  0,
  'a deleted post leaves no rows'
);

-- ─── The count stops at a thousand ───────────────────────────────────────────

insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, source_tool, source_tool_slug, showcase_asset_path, is_nsfw, created_at, updated_at
)
select
  ('5e176000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid, pg_temp.user_id('06'),
  'public', 'image', 'external', 'media', 'visible',
  'Bulk frame ' || series, 'A quiet frame', 'Bulkforge', 'bulkforge',
  'showcase/search-entities-bulk-' || series || '.png', false, now() - interval '30 days', now()
from generate_series(1, 1001) as series;

select is(
  (select array_agg(e.post_count || '=' || e.post_count_capped) from public.search_public_entities('bulkforge') as e),
  array['1000=true'],
  'an entity with more than a thousand posts is counted to a thousand and says there are more'
);

-- ─── Filters ─────────────────────────────────────────────────────────────────

select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest'),
  array['11', '12', '13', '15', '20'],
  'unfiltered, the viewer''s search holds every unlabelled public post of creators neither side has blocked');

select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', 'model:kling-2.6'),
  array['11', '12'],
  'made with a model: the creations on it, one known only by its creation, never the labelled, the private or the blocked creator''s');
select is(pg_temp.posts_found('sunmote', null, 'latest', 'model:kling-2.6'),
  array['11', '12', '16'],
  'a visitor sees the blocked creator''s as well: the three the entity counted');
select is(
  (select array_agg(suffix order by suffix) from unnest(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'top', 'model:kling-2.6')) as suffix),
  array['11', '12'],
  'the ranked order takes the filter too, and holds the same posts as Latest'
);
select is(pg_temp.posts_found('sunmote', null, 'latest', 'model:kling-3.0'), '{}'::text[],
  'the template''s result is not found under its author''s model');
select is(pg_temp.posts_found('sunmote', null, 'latest', 'tool:magicbooklet'),
  array['11', '12', '15', '16', '17'],
  'made with a tool');
select is(pg_temp.posts_found('sunmote', null, 'latest', 'tool:secretool'), '{}'::text[],
  'a tool only a labelled post has finds nothing');
select is(pg_temp.posts_found('sunmote', null, 'latest', 'model:no-such-model'), '{}'::text[],
  'an entity that does not exist finds nothing');

select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', null, 'video'), array['11'],
  'videos only');
select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', null, 'image'), array['12', '13', '15'],
  'pictures only: a text post is neither');
select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', null, null, true), array['13'],
  'with a recipe: the post with a published one');
select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', null, null, false, true), array['12'],
  'from creators the viewer follows');
select is(pg_temp.posts_found('sunmote', null, 'latest', null, null, false, true), '{}'::text[],
  'with no viewer nobody is followed');
select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', 'tool:magicbooklet', 'image'), array['12', '15'],
  'filters combine: pictures made with the app');
select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'top', 'tool:magicbooklet', 'image', false, true), array['12'],
  'and combine with the ranked order and the follow filter');
select is(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', 'model:kling-2.6', 'image', true), '{}'::text[],
  'filters no post passes together find nothing');

-- Before the cut: a page of one is full while a later post passes the filter.
select is(
  pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'latest', null, 'image', false, false, true, 1),
  array['12'],
  'the filter is applied before the limit: the first picture, not an empty page behind a video'
);
select is(
  (select array_agg(right(s.post_id::text, 2))
   from public.search_public_posts(
     'sunmote', pg_temp.user_id('01'), null, pg_temp.post_id('12'), 1, now(), 'latest',
     (select created_at from public.posts where id = pg_temp.post_id('12')),
     null, 'image'
   ) as s),
  array['13'],
  'and the next page continues from its cursor inside the filter'
);
select is(
  (with first_page as (
     select s.post_id, s.search_score
     from public.search_public_posts(
       'sunmote', pg_temp.user_id('01'), null, null, 1, now(), 'top', null, 'tool:magicbooklet', 'image'
     ) as s
   )
   select array_agg(right(s.post_id::text, 2))
   from first_page
   cross join lateral public.search_public_posts(
     'sunmote', pg_temp.user_id('01'), first_page.search_score, first_page.post_id, 5, now(), 'top', null,
     'tool:magicbooklet', 'image'
   ) as s),
  (select array_agg(suffix) from (
     select suffix from unnest(pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'top', 'tool:magicbooklet', 'image')) with ordinality as listed(suffix, position)
     where position > 1 order by position
   ) as rest),
  'a ranked page continues from its cursor inside the filters'
);

select throws_ok(
  $$ select * from public.search_public_posts('sunmote', p_media_kind => 'audio') $$,
  'P0001', 'Post search media kind must be image or video', 'a media kind outside image and video is refused'
);
select throws_ok(
  $$ select * from public.search_public_posts('sunmote', p_made_with => 'kling-2.6') $$,
  'P0001', 'Post search made-with filter must be model:<key> or tool:<key>', 'a made-with filter without a kind is refused'
);
select throws_ok(
  $$ select * from public.search_public_posts('sunmote', p_made_with => 'model:') $$,
  'P0001', 'Post search made-with filter must be model:<key> or tool:<key>', 'and one without a key'
);

-- ─── The reading ─────────────────────────────────────────────────────────────

select is(
  (select array_agg(distinct s.corrected_query) from public.search_public_posts('sunmote') as s),
  array[null::text],
  'a query read as typed says so: no corrected reading'
);
select is(
  (select array_agg(distinct s.corrected_query) from public.search_public_posts('verdanthla') as s),
  array['verdanthal'],
  'a misspelt query says what it was read as, on every row'
);
select is(
  (select array_agg(distinct s.corrected_query) from public.search_public_posts('verdanthla', p_sort => 'latest') as s),
  array['verdanthal'],
  'in either order'
);
select is(
  pg_temp.posts_found('verdanthla', pg_temp.user_id('01'), 'latest'),
  array['11', '12', '13', '15', '20'],
  'and holds the posts of the corrected query'
);
select is(
  pg_temp.posts_found('verdanthla', pg_temp.user_id('01'), 'latest', null, null, false, false, false),
  '{}'::text[],
  'with correction off the query is read as typed and finds nothing'
);
select is(
  pg_temp.posts_found('verdanthla', pg_temp.user_id('01'), 'top', null, null, false, false, false),
  '{}'::text[],
  'in the ranked order too'
);
select is(
  (select array_agg(distinct s.corrected_query)
   from public.search_public_posts(
     'verdanthla', pg_temp.user_id('01'), null, pg_temp.post_id('11'), 5, now(), 'latest',
     (select created_at from public.posts where id = pg_temp.post_id('11'))
   ) as s),
  array['verdanthal'],
  'a later page reads the query the same way: the decision takes no cursor'
);
select is(
  (select array_agg(distinct s.corrected_query)
   from public.search_public_posts('verdanthla', pg_temp.user_id('01'), p_made_with => 'model:kling-2.6', p_media_kind => 'video') as s),
  array['verdanthal'],
  'a filtered search is corrected too'
);

-- The filters are part of the decision. 'harborligth' is close enough to
-- the title "Harborlight" to match it as typed, so an unfiltered search is
-- not corrected; among videos nothing matches it as typed, and it is.
select pg_temp.post('51', '02', 'Harborlight', 'A quiet frame', 'image', 'Midjourney', 'midjourney', interval '1 day');
select pg_temp.post('52', '02', 'Evening walk by the quay', 'One harborlight over the water, far from the boats', 'video', 'Midjourney', 'midjourney', interval '1 day');
select public.rebuild_search_terms();

select is(pg_temp.posts_found('harborligth', null, 'latest'), array['51'],
  'fixture: as typed the query finds the near-miss title');
select is(
  (select array_agg(distinct s.corrected_query) from public.search_public_posts('harborligth') as s),
  array[null::text],
  'and that search is read as typed'
);
select is(pg_temp.posts_found('harborligth', null, 'latest', null, 'video'), array['52'],
  'among videos nothing holds it as typed, so it is read corrected and finds the video');
select is(
  (select array_agg(distinct s.corrected_query) from public.search_public_posts('harborligth', p_media_kind => 'video') as s),
  array['harborlight'],
  'and says so'
);

-- ─── Recipes: the list's reading ─────────────────────────────────────────────

-- A listed recipe, by its own seller.
select pg_temp.post('61', '06', 'Quillfern portrait', 'A face in soft light', 'image', 'Midjourney', 'midjourney', interval '1 day');
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '5e175000-0000-4000-8000-000000000061'::uuid, pg_temp.post_id('61'), pg_temp.user_id('06'),
  'free', 'published', 'Quillfern portrait', 'Three steps to a quillfern portrait',
  'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a visitor unlocks for this picture')),
  '[]'::jsonb, 0, 0, 0, now(), now()
);
select public.rebuild_search_terms();

create function pg_temp.recipes_listed(p_query text) returns integer language sql stable as $$
  select count(*)::integer
  from public.list_marketplace_resource_bundles('all', 'all', null, p_query, 'relevance', 0, 24);
$$;

select cmp_ok(pg_temp.recipes_listed('quillfern'), '>', 0, 'fixture: the recipe is listed and found as typed');
select is(public.search_recipes_corrected_query('quillfern'), null,
  'a recipes search read as typed has no corrected reading');
select cmp_ok(pg_temp.recipes_listed('quillfren'), '>', 0, 'fixture: the list corrects a misspelling');
select is(public.search_recipes_corrected_query('quillfren'), 'quillfern',
  'and the reading says what the list read it as');
select is(public.search_recipes_corrected_query('  Quillfren '), 'quillfern',
  'whatever its case and edges, as the list reads it');
select is(public.search_recipes_corrected_query('zzqqxx'), null,
  'a query with no near word has no corrected reading');
select is(pg_temp.recipes_listed('zzqqxx'), 0, 'and the list finds nothing for it');
select is(public.search_recipes_corrected_query('qu'), null, 'below three characters there is none');
select is(public.search_recipes_corrected_query(null), null, 'nor for no query');

-- ─── The app live during the release ─────────────────────────────────────────
--
-- origin/main's searchPosts (src/lib/public-search-service.ts) calls by name
-- with these eight arguments and reads post_id, creator_user_id, search_score
-- and created_at.

select is(
  (select count(*)::integer from pg_proc as fn
   join pg_namespace as ns on ns.oid = fn.pronamespace
   where ns.nspname = 'public' and fn.proname = 'search_public_posts'),
  1,
  'one function is named search_public_posts: a named call can resolve to no other'
);
select is(
  (select array_agg(right(live.post_id::text, 2) order by live.created_at desc)
   from (
     select s.post_id, s.creator_user_id, s.search_score, s.created_at
     from public.search_public_posts(
       p_query => 'sunmote',
       p_viewer_user_id => pg_temp.user_id('01'),
       p_after_score => null,
       p_after_id => null,
       p_limit => 13,
       p_as_of => now(),
       p_sort => 'latest',
       p_after_created_at => null
     ) as s
   ) as live),
  array['11', '12', '13', '15', '20'],
  'the eight-argument named call the live app makes resolves, unfiltered, and returns the columns it reads'
);
select is(
  (select array_agg(right(live.post_id::text, 2) order by live.search_score desc, live.post_id)
   from (
     select s.post_id, s.creator_user_id, s.search_score, s.created_at
     from public.search_public_posts(
       p_query => 'verdanthla',
       p_viewer_user_id => pg_temp.user_id('01'),
       p_after_score => null,
       p_after_id => null,
       p_limit => 13,
       p_as_of => now(),
       p_sort => 'top',
       p_after_created_at => null
     ) as s
   ) as live),
  pg_temp.posts_found('verdanthal', pg_temp.user_id('01'), 'top'),
  'and is corrected as before: the live app''s misspelt search still finds the posts'
);
select is(
  (select array_agg(right(s.post_id::text, 2))
   from public.search_public_posts(
     p_query => 'sunmote',
     p_viewer_user_id => pg_temp.user_id('01'),
     p_after_score => null,
     p_after_id => null,
     p_limit => 13
   ) as s),
  pg_temp.posts_found('sunmote', pg_temp.user_id('01'), 'top', null, null, false, false, true, 13),
  'the five-argument call of an app from before sorts resolves as well'
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
  not has_function_privilege('anon', 'public.search_public_entities(text,uuid,integer,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_public_entities(text,uuid,integer,text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_public_entities(text,uuid,integer,text)', 'EXECUTE'),
  'entity search is the service role''s alone'
);
select ok(
  not has_function_privilege('anon', 'public.search_recipes_corrected_query(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_recipes_corrected_query(text)', 'EXECUTE')
  and has_function_privilege('service_role', 'public.search_recipes_corrected_query(text)', 'EXECUTE'),
  'the recipes reading is the service role''s alone'
);
select ok(
  not has_function_privilege('anon', 'public.refresh_post_search_entities(uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.refresh_post_search_entities(uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.post_search_entity_rows(uuid[])', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.post_search_entity_rows(uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.search_entity_key(text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.search_entity_key(text)', 'EXECUTE'),
  'client roles cannot call the entity helpers'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.post_search_entities'::regclass),
  'row level security is on for the entity table'
);
select is(
  (select count(*)::integer from pg_policy where polrelid = 'public.post_search_entities'::regclass),
  0,
  'with no policy: the Data API roles see nothing'
);
select ok(
  not has_table_privilege('anon', 'public.post_search_entities', 'SELECT')
  and not has_table_privilege('authenticated', 'public.post_search_entities', 'SELECT'),
  'client roles cannot read the entity table'
);
select ok(
  has_table_privilege('service_role', 'public.post_search_entities', 'SELECT')
  and not has_table_privilege('service_role', 'public.post_search_entities', 'INSERT')
  and not has_table_privilege('service_role', 'public.post_search_entities', 'UPDATE')
  and not has_table_privilege('service_role', 'public.post_search_entities', 'DELETE'),
  'the service role reads it and writes it only through the trigger'
);

-- ─── The search log ──────────────────────────────────────────────────────────

select lives_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, sort)
     values ('sunmote', 'posts', false, repeat('a', 64), 0, 2, 0, 'top') $$,
  'a row without the new columns inserts, as the app live during the release writes it'
);
select lives_ok(
  $$ insert into public.search_query_events (
       query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, sort,
       made_with, media_kind, has_recipe, followed_only, corrected
     ) values ('verdanthla', 'posts', true, repeat('a', 64), 0, 2, 0, 'top', 'model:kling-2.6', 'video', true, true, true) $$,
  'a row says what narrowed the search and that it was read corrected'
);
select throws_ok(
  $$ insert into public.search_query_events (query, search_type, signed_in, visitor_day, creator_count, post_count, recipe_count, media_kind)
     values ('sunmote', 'posts', false, repeat('a', 64), 0, 2, 0, 'audio') $$,
  '23514', null, 'a media kind outside image and video is refused'
);
select lives_ok(
  $$ select * from public.search_query_report(7, 10) $$,
  'the report still runs'
);

select * from finish();
rollback;
