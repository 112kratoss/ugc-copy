begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(77);

-- 5e3a…01 creates most posts; …02 is another creator (a template's author, and
-- the one a viewer blocks); …03 is the viewer; …04 blocked the viewer.
insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
values
  ('5e3a0000-0000-4000-8000-000000000001'::uuid, 'search-related-creator@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb),
  ('5e3a0000-0000-4000-8000-000000000002'::uuid, 'search-related-other@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb),
  ('5e3a0000-0000-4000-8000-000000000003'::uuid, 'search-related-viewer@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb),
  ('5e3a0000-0000-4000-8000-000000000004'::uuid, 'search-related-blocker@example.invalid',
   'authenticated', 'authenticated', now(), '{}'::jsonb, '{}'::jsonb);

-- A template's result (…16): its model is the template author's.
insert into public.templates (id, name, creator_user_id, status, is_active)
values ('5e3a3000-0000-4000-8000-000000000001'::uuid, 'Search related fixture',
        '5e3a0000-0000-4000-8000-000000000002'::uuid, 'draft', true);

insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
) values (
  '5e3a4000-0000-4000-8000-000000000001'::uuid, '5e3a3000-0000-4000-8000-000000000001'::uuid,
  '5e3a0000-0000-4000-8000-000000000001'::uuid, '{"version":1,"nodes":[],"edges":[]}'::jsonb,
  repeat('a', 64), '[]'::jsonb, '{}'::jsonb, 'output', 'image', 'collecting_inputs', 10, 10
);

insert into public.generations (id, user_id, model, status, is_public, template_run_id)
values
  ('5e3a1000-0000-4000-8000-000000000001'::uuid, '5e3a0000-0000-4000-8000-000000000001'::uuid,
   'veo-3.1', 'succeeded', true, null),
  ('5e3a1000-0000-4000-8000-000000000005'::uuid, '5e3a0000-0000-4000-8000-000000000001'::uuid,
   'kling-2.1-master', 'succeeded', true, '5e3a4000-0000-4000-8000-000000000001'::uuid);

-- The cases search phase 1 tests its documents with (search_recall.test.sql,
-- post_search_public_caption.test.sql):
--   …11 a creation made in the app            …12 a plain upload
--   …13 another creator's                     …14 labelled
--   …16 a template's result                   …18 sold: setup caption + prompt
--   …19 private   …20 hidden by review   …21 archived
--   …22 free recipe over a stored prompt      …23 a caption past 2,000 characters
--   …24 the creator who blocked the viewer    …25 no words of its own (blank title)
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, prompt, source_tool, source_tool_slug, generation_id, showcase_asset_path,
  is_nsfw, archived_at, created_at, updated_at
)
select
  ('5e3a2000-0000-4000-8000-0000000000' || fixture.suffix)::uuid,
  ('5e3a0000-0000-4000-8000-00000000000' || fixture.creator)::uuid,
  fixture.visibility, 'image', fixture.source_kind, 'media', fixture.review_status,
  fixture.title, fixture.body, fixture.prompt, fixture.tool, lower(fixture.tool),
  fixture.generation_id,
  case when fixture.is_nsfw then 'private-posts/5e3a2000-0000-4000-8000-0000000000' || fixture.suffix || '/original.jpg'
       else 'showcase/search-related-' || fixture.suffix || '.png' end,
  fixture.is_nsfw, fixture.archived_at,
  now() - (fixture.suffix::integer || ' minutes')::interval, now()
from (values
  ('11', '1', 'public', 'magicbooklet', 'visible', 'Sea after sunset', 'Waves under a violet sky', null::text,
   'Magicbooklet', '5e3a1000-0000-4000-8000-000000000001'::uuid, false, null::timestamptz),
  ('12', '1', 'public', 'external', 'visible', 'Studio portrait of a dancer', 'Soft key light from the left', null,
   'Midjourney', null, false, null),
  ('13', '2', 'public', 'external', 'visible', 'Harbor at dawn', 'Boats under fog', null,
   'Midjourney', null, false, null),
  ('14', '1', 'public', 'external', 'visible', 'Labelled frame', 'A labelled picture of velvetmoth', null,
   'Midjourney', null, true, null),
  ('16', '1', 'public', 'magicbooklet', 'visible', 'Garden walk at noon', 'Hedges and gravel', null,
   'Magicbooklet', '5e3a1000-0000-4000-8000-000000000005'::uuid, false, null),
  ('18', '1', 'public', 'external', 'visible', 'Tarn study', E'Saved generation setup\nGrade: tarnwhistle', 'quokkaprompt for buyers',
   'Midjourney', null, false, null),
  ('19', '1', 'private', 'external', 'visible', 'Private glade', 'Only for me: fernhollow', null,
   'Midjourney', null, false, null),
  ('20', '1', 'public', 'external', 'hidden', 'Hidden by review', 'Taken down: ashgrove', null,
   'Midjourney', null, false, null),
  ('21', '1', 'public', 'external', 'visible', 'Archived dune', 'Put away: saltmarsh', null,
   'Midjourney', null, false, now()),
  ('22', '1', 'public', 'external', 'visible', 'Lantern alley', 'Paper lanterns in the rain', 'wombatprompt before the recipe',
   'Midjourney', null, false, null),
  ('23', '1', 'public', 'external', 'visible', 'Long caption', repeat('meadow ', 400), null,
   'Midjourney', null, false, null),
  ('24', '4', 'public', 'external', 'visible', 'Cliffs in mist', 'From the creator who blocked the viewer', null,
   'Midjourney', null, false, null),
  ('25', '1', 'public', 'external', 'visible', '', null, null,
   '', null, false, null)
) as fixture(suffix, creator, visibility, source_kind, review_status, title, body, prompt, tool, generation_id, is_nsfw, archived_at);

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '5e3a5000-0000-4000-8000-000000000018'::uuid, '5e3a2000-0000-4000-8000-000000000018'::uuid,
  '5e3a0000-0000-4000-8000-000000000001'::uuid, 'paid', 'published', 'Tarn recipe',
  'Three steps to the finished picture', 'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt a buyer unlocks for this picture')),
  '[]'::jsonb, 300, 0, 0, now(), now()
);

insert into public.user_blocks (blocker_user_id, blocked_user_id)
values
  ('5e3a0000-0000-4000-8000-000000000003'::uuid, '5e3a0000-0000-4000-8000-000000000002'::uuid),
  ('5e3a0000-0000-4000-8000-000000000004'::uuid, '5e3a0000-0000-4000-8000-000000000003'::uuid);

create function pg_temp.post(p_suffix text) returns uuid
language sql immutable as $$
  select ('5e3a2000-0000-4000-8000-0000000000' || p_suffix)::uuid;
$$;

-- A unit vector at cosine similarity p_similarity to pg_temp.vec(1).
create function pg_temp.vec(p_similarity double precision) returns extensions.vector
language sql immutable as $$
  select ('[' || p_similarity || ',' || sqrt(1 - p_similarity * p_similarity) || repeat(',0', 382) || ']')::extensions.vector;
$$;

-- What embed-post reads for a post, or null when it is given nothing.
create function pg_temp.embedding_text(p_suffix text) returns text
language sql as $$
  select embedding_text
  from public.post_search_embedding_texts(array[pg_temp.post(p_suffix)], 'gte-small');
$$;

-- Stores a vector as embed-post does: under the hash of the text it was just
-- given. Returns how many rows were kept.
create function pg_temp.embed(p_suffix text, p_similarity double precision) returns integer
language sql as $$
  select count(*)::integer
  from public.store_post_search_embeddings(
    (
      select jsonb_build_array(jsonb_build_object(
        'post_id', texts.post_id, 'content_hash', texts.content_hash, 'embedding', pg_temp.vec(p_similarity)::text
      ))
      from public.post_search_embedding_texts(array[pg_temp.post(p_suffix)], 'gte-small') as texts
    ),
    'gte-small'
  );
$$;

create function pg_temp.related(
  p_viewer uuid default null,
  p_exclude uuid[] default null,
  p_limit integer default 12
) returns text[]
language sql as $$
  select coalesce(array_agg(right(post_id::text, 2) order by ordinality), '{}')
  from public.search_related_posts(pg_temp.vec(1), p_viewer, p_exclude, p_limit) with ordinality;
$$;

create function pg_temp.pending() returns text[]
language sql as $$
  select coalesce(array_agg(right(post_id::text, 2) order by right(post_id::text, 2)), '{}')
  from public.list_posts_pending_search_embedding('gte-small', 500)
  where post_id::text like '5e3a2000-%';
$$;

-- ─── The text that is embedded is the public text, and no other ─────────────

select is(
  pg_temp.embedding_text('12'),
  (select search_text from public.post_search_documents where post_id = pg_temp.post('12')),
  'a post is embedded from its search document''s text, as it stands'
);
select ok(
  pg_temp.embedding_text('12') like '%studio portrait of a dancer%'
    and pg_temp.embedding_text('12') like '%soft key light%',
  'which holds its title and its caption'
);
select is(
  (select content_hash from public.post_search_embedding_texts(array[pg_temp.post('12')], 'gte-small')),
  (select encode(sha256(convert_to(search_text, 'UTF8')), 'hex')
   from public.post_search_documents where post_id = pg_temp.post('12')),
  'its hash is the sha256 of that text'
);
select ok(
  pg_temp.embedding_text('18') like '%tarn study%'
    and pg_temp.embedding_text('18') not like '%tarnwhistle%'
    and pg_temp.embedding_text('18') not like '%saved generation setup%'
    and pg_temp.embedding_text('18') not like '%quokkaprompt%'
    and pg_temp.embedding_text('18') not like '%buyer unlocks%',
  'a sold recipe''s post is embedded from its title: never its setup caption, its prompt or the recipe''s items'
);
select ok(
  pg_temp.embedding_text('16') like '%template-workflow%'
    and pg_temp.embedding_text('16') not like '%kling%',
  'a template''s result is embedded under the name public reads give its model, never its author''s model'
);
select ok(
  pg_temp.embedding_text('22') like '%wombatprompt%',
  'a prompt with no recipe over it is public, and embedded'
);
select is(pg_temp.embedding_text('14'), null, 'a labelled post is given no text to embed');
select is(pg_temp.embedding_text('19'), null, 'nor a private one');
select is(pg_temp.embedding_text('20'), null, 'nor one hidden by review');
select is(pg_temp.embedding_text('21'), null, 'nor an archived one');
select is(pg_temp.embedding_text('25'), null, 'nor one with no words to show');
select ok(
  not exists (
    select 1
    from public.post_search_embedding_texts(
      array(select id from public.posts where id::text like '5e3a2000-%'), 'gte-small'
    )
    where embedding_text ~ 'velvetmoth|fernhollow|ashgrove|saltmarsh|tarnwhistle|quokkaprompt'
  ),
  'no text handed to the embedder holds a word only a labelled, private, hidden, archived or sold post has'
);
select is(
  (select char_length(embedding_text) from public.post_search_embedding_texts(array[pg_temp.post('23')], 'gte-small')),
  2000,
  'a long text is cut to its first 2,000 characters'
);
select is(
  (select content_hash from public.post_search_embedding_texts(array[pg_temp.post('23')], 'gte-small')),
  (select encode(sha256(convert_to(search_text, 'UTF8')), 'hex')
   from public.post_search_documents where post_id = pg_temp.post('23')),
  'and hashed whole, so a change past the cut is still a change'
);
select is(
  pg_temp.pending(),
  array['11', '12', '13', '16', '18', '22', '23', '24'],
  'the posts waiting for an embedding are the ones search could return'
);
select is(
  (select array_agg(right(post_id::text, 2)) from (
    select post_id from public.list_posts_pending_search_embedding('gte-small', 3)
    where post_id::text like '5e3a2000-%'
  ) as newest),
  array['11', '12', '13'],
  'newest first'
);

-- ─── Storing ────────────────────────────────────────────────────────────────

select is(pg_temp.embed('11', 0.99), 1, 'a vector made from the text a post shows is stored');
select is(pg_temp.embed('12', 0.95), 1, 'and another');
select is(pg_temp.embed('13', 0.97), 1, 'another creator''s');
select is(pg_temp.embed('16', 0.50), 1, 'one far from the query');
select is(pg_temp.embed('18', 0.93), 1, 'the sold post''s, of its public text');
select is(pg_temp.embed('22', 0.92), 1, 'the post with a public prompt');
select is(pg_temp.embed('24', 0.98), 1, 'the blocker''s');
select is(
  (select count(*)::integer from public.store_post_search_embeddings(
    jsonb_build_array(jsonb_build_object(
      'post_id', pg_temp.post('23'), 'content_hash', repeat('0', 64), 'embedding', pg_temp.vec(0.99)::text
    )), 'gte-small')),
  0,
  'a vector made from a text the post no longer shows is not stored'
);
select is(
  (select count(*)::integer from public.store_post_search_embeddings(
    jsonb_build_array(jsonb_build_object(
      'post_id', pg_temp.post('14'),
      'content_hash', (select encode(sha256(convert_to(search_text, 'UTF8')), 'hex')
                       from public.post_search_documents where post_id = pg_temp.post('14')),
      'embedding', pg_temp.vec(0.99)::text
    )), 'gte-small')),
  0,
  'nor one for a labelled post, whatever its hash'
);
select is(pg_temp.pending(), array['23'], 'a stored post is no longer waiting');
select ok(
  (select unchanged from public.post_search_embedding_texts(array[pg_temp.post('11')], 'gte-small'))
    and not (select unchanged from public.post_search_embedding_texts(array[pg_temp.post('23')], 'gte-small')),
  'and embed-post is told its text is unchanged'
);
select ok(
  not (select unchanged from public.post_search_embedding_texts(array[pg_temp.post('11')], 'another-model')),
  'under another model every post is to be embedded again'
);
select throws_ok(
  $$select * from public.store_post_search_embeddings(
    jsonb_build_array(jsonb_build_object('post_id', pg_temp.post('23'),
      'content_hash', (select content_hash from public.post_search_embedding_texts(array[pg_temp.post('23')], 'gte-small')),
      'embedding', '[1,0,0]')), 'gte-small')$$,
  '22000', null,
  'a vector of another width is refused'
);

-- ─── Related posts ──────────────────────────────────────────────────────────

select is(
  pg_temp.related(),
  array['11', '24', '13', '12', '18', '22'],
  'a visitor gets the posts above the bar, nearest first, and none below it'
);
select is(
  (select array_agg(similarity order by similarity desc) from public.search_related_posts(pg_temp.vec(1), null, null, 3)),
  array[0.99, 0.98, 0.97]::double precision[],
  'each with its cosine similarity'
);
select is(pg_temp.related(null, null, 2), array['11', '24'], 'the limit takes the nearest');
select is(
  pg_temp.related(null, array[pg_temp.post('11'), pg_temp.post('13')]),
  array['24', '12', '18', '22'],
  'the posts an answer already shows are left out'
);
select is(
  pg_temp.related('5e3a0000-0000-4000-8000-000000000003'::uuid),
  array['11', '12', '18', '22'],
  'a viewer gets neither a creator they blocked nor one who blocked them'
);
select is(
  pg_temp.related('5e3a0000-0000-4000-8000-000000000003'::uuid, null, 2),
  array['11', '12'],
  'and both are left out before the limit'
);
select is(
  (select count(*)::integer from public.search_related_posts(pg_temp.vec(1), null, null, 12, 'another-model')),
  0,
  'a vector of another model is not read'
);
select throws_ok(
  $$select * from public.search_related_posts(pg_temp.vec(1), null, null, 13)$$,
  'P0001', 'Related post search limit must be between 1 and 12',
  'the limit is capped'
);
select throws_ok(
  $$select * from public.search_related_posts('[1,0,0]'::extensions.vector, null, null, 8)$$,
  'P0001', 'Related post search needs a query embedding of 384 dimensions',
  'a query vector of another width is refused'
);

-- ─── A vector is read only while it is true ─────────────────────────────────

-- Labelled after it was embedded.
update public.posts set is_nsfw = true where id = pg_temp.post('13');
select ok(not ('13' = any (pg_temp.related())), 'a post labelled after it was embedded is not related to anything');
update public.posts set is_nsfw = false where id = pg_temp.post('13');
select ok('13' = any (pg_temp.related()), 'unlabelled again, with its text unchanged, it is');

-- Its public text changes.
update public.posts set title = 'Sea before sunrise' where id = pg_temp.post('11');
select ok(not ('11' = any (pg_temp.related())), 'a post whose title changed is not matched on its old vector');
select is(pg_temp.pending(), array['11', '23'], 'and waits to be embedded again');
select is(pg_temp.embed('11', 0.99), 1, 'embedded again');
select ok('11' = any (pg_temp.related()), 'it is related once more');

-- A recipe is published over a post with a public prompt: the prompt leaves
-- the public text.
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  attachments, allow_remix, resource_items, resource_sections,
  price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values (
  '5e3a5000-0000-4000-8000-000000000022'::uuid, pg_temp.post('22'),
  '5e3a0000-0000-4000-8000-000000000001'::uuid, 'free', 'published', 'Lantern recipe',
  'How the lanterns were lit', 'A preview long enough to pass the marketplace quality gate.',
  '[]'::jsonb, false,
  jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                       'textContent', 'The prompt this recipe shares')),
  '[]'::jsonb, 0, 0, 0, now(), now()
);
select ok(
  not ('22' = any (pg_temp.related())),
  'a post is not matched on a vector made while its prompt was public, once a recipe covers the prompt'
);
select ok(
  pg_temp.embedding_text('22') not like '%wombatprompt%' and '22' = any (pg_temp.pending()),
  'it waits to be embedded from the text without the prompt'
);
select is(pg_temp.embed('22', 0.92), 1, 'embedded from that');

-- A recipe's access changes what the caption shows.
update public.posts set body = E'Saved generation setup\nGrade: larkspurgrade' where id = pg_temp.post('22');
select ok(
  pg_temp.embedding_text('22') like '%larkspurgrade%',
  'under a free recipe a setup caption is public'
);
select is(pg_temp.embed('22', 0.92), 1, 'and embedded');
update public.post_resource_bundles
set access_mode = 'paid', price_usd_cents = 300
where id = '5e3a5000-0000-4000-8000-000000000022'::uuid;
select ok(
  not ('22' = any (pg_temp.related())),
  'the recipe made paid, the post is not matched on the vector that held its setup caption'
);
select ok(
  pg_temp.embedding_text('22') not like '%larkspurgrade%',
  'and is embedded next from a text without it'
);

-- It stops being searchable.
update public.posts set visibility = 'private' where id = pg_temp.post('12');
select ok(not ('12' = any (pg_temp.related())), 'a post made private is not related to anything');
update public.posts set archived_at = now() where id = pg_temp.post('18');
select ok(not ('18' = any (pg_temp.related())), 'nor one archived');
update public.posts set review_status = 'hidden' where id = pg_temp.post('24');
select ok(not ('24' = any (pg_temp.related())), 'nor one hidden by review');
update public.posts set is_nsfw = true where id = pg_temp.post('16');

select ok(
  (select prunable from public.search_embedding_backlog('gte-small')),
  'the job is told there is something to prune'
);
select is(
  (select post_embeddings_deleted from public.prune_search_embeddings(1000)),
  4,
  'the prune deletes the vectors of the private, archived, hidden and labelled posts'
);
select is(
  (select array_agg(right(post_id::text, 2) order by post_id) from public.post_search_embeddings
   where post_id::text like '5e3a2000-%'),
  array['11', '13', '22'],
  'and leaves the rest, a vector waiting to be re-made included'
);
delete from public.posts where id = pg_temp.post('13');
select ok(
  not exists (select 1 from public.post_search_embeddings where post_id = pg_temp.post('13')),
  'a deleted post takes its vector with it'
);

-- ─── Posts that may not be shown never cost the viewer a result ─────────────

-- 210 posts by the creator the viewer blocked, every one nearer the query
-- than post …11: more than any nearest-rows-first cut would hold (an HNSW
-- scan returns 40, the first draft of this function read 200).
insert into public.posts (
  id, user_id, visibility, category, source_kind, post_format, review_status,
  title, body, source_tool, source_tool_slug, showcase_asset_path, is_nsfw, created_at, updated_at
)
select
  ('5e3a6000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  '5e3a0000-0000-4000-8000-000000000002'::uuid,
  'public', 'image', 'external', 'media', 'visible',
  'Crowd ' || n, 'One of many', 'Midjourney', 'midjourney', 'showcase/search-related-crowd-' || n || '.png',
  false, now(), now()
from generate_series(1, 210) as n;

insert into public.post_search_embeddings (post_id, embedding_model, content_hash, embedding)
select documents.post_id, 'gte-small',
       encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex'),
       pg_temp.vec(0.995)
from public.post_search_documents as documents
where documents.post_id::text like '5e3a6000-%';

select is(
  pg_temp.related('5e3a0000-0000-4000-8000-000000000003'::uuid),
  array['11'],
  'a viewer who blocked the creator of the 210 nearest posts still gets the post behind them'
);
select is(
  cardinality(pg_temp.related(null, null, 12)),
  12,
  'while a visitor gets the nearest of them'
);
update public.posts set is_nsfw = true where id::text like '5e3a6000-%';
select is(
  pg_temp.related(),
  array['11'],
  'and 210 labelled posts nearer the query hide no post from a visitor'
);

-- ─── Query vectors: a cache and a daily count ───────────────────────────────

select is(
  (select row(embedding is null, reserved)::text
   from public.search_query_embedding_lookup(repeat('a', 64), 'gte-small', 2)),
  '(t,t)',
  'a query never embedded is a miss, and may be embedded'
);
select is(
  (select reserved from public.search_query_embedding_lookup(repeat('b', 64), 'gte-small', 2)),
  true,
  'a second one too'
);
select is(
  (select reserved from public.search_query_embedding_lookup(repeat('c', 64), 'gte-small', 2)),
  false,
  'past the day''s cap a miss may not be embedded'
);
select is(
  (select requested from public.search_query_embedding_days where day = (now() at time zone 'UTC')::date),
  2,
  'and the day''s count stops at the cap'
);
select is(
  (select reserved from public.search_query_embedding_lookup(repeat('c', 64), 'gte-small', 1000000)),
  true,
  'a higher cap lets one more through'
);
update public.search_query_embedding_days set requested = 5000 where day = (now() at time zone 'UTC')::date;
select is(
  (select reserved from public.search_query_embedding_lookup(repeat('d', 64), 'gte-small', 1000000)),
  false,
  'but never past 5,000 a day, whatever cap is asked for'
);
select lives_ok(
  $$select public.store_search_query_embedding(repeat('a', 64), 'gte-small', pg_temp.vec(0.5))$$,
  'a query''s vector is kept under its hash'
);
update public.search_query_embedding_days set requested = 0 where day = (now() at time zone 'UTC')::date;
select is(
  (select row(embedding = pg_temp.vec(0.5), reserved)::text
   from public.search_query_embedding_lookup(repeat('a', 64), 'gte-small', 2)),
  '(t,f)',
  'the next search for it reads the vector and asks for nothing'
);
select is(
  (select requested from public.search_query_embedding_days where day = (now() at time zone 'UTC')::date),
  0,
  'and is not counted'
);
update public.search_query_embeddings set created_at = now() - interval '31 days' where query_hash = repeat('a', 64);
select is(
  (select embedding is null from public.search_query_embedding_lookup(repeat('a', 64), 'gte-small', 0)),
  true,
  'a vector older than 30 days is not read'
);
insert into public.search_query_embedding_days (day, requested) values ((now() at time zone 'UTC')::date - 8, 5);
select is(
  (select row(query_embeddings_deleted, query_days_deleted)::text from public.prune_search_embeddings(1000)),
  '(1,1)',
  'the prune deletes it, and a daily count older than a week'
);

-- ─── Who may call what ──────────────────────────────────────────────────────

select ok(
  (
    select bool_and(
      not has_function_privilege('anon', signature, 'EXECUTE')
      and not has_function_privilege('authenticated', signature, 'EXECUTE')
      and has_function_privilege('service_role', signature, 'EXECUTE')
    )
    from unnest(array[
      'public.search_related_posts(extensions.vector,uuid,uuid[],integer,text)',
      'public.list_posts_pending_search_embedding(text,integer)',
      'public.post_search_embedding_texts(uuid[],text)',
      'public.store_post_search_embeddings(jsonb,text)',
      'public.search_query_embedding_lookup(text,text,integer)',
      'public.store_search_query_embedding(text,text,extensions.vector)',
      'public.prune_search_embeddings(integer)',
      'public.search_embedding_backlog(text)'
    ]) as signature
  ),
  'every function of the file is the service role''s alone'
);
select ok(
  (
    select bool_and(
      not has_table_privilege('anon', relation, 'SELECT')
      and not has_table_privilege('authenticated', relation, 'SELECT')
      and has_table_privilege('service_role', relation, 'SELECT')
      and not has_table_privilege('service_role', relation, 'INSERT')
      and not has_table_privilege('service_role', relation, 'UPDATE')
      and not has_table_privilege('service_role', relation, 'DELETE')
    )
    from unnest(array[
      'public.post_search_embeddings',
      'public.search_query_embeddings',
      'public.search_query_embedding_days'
    ]) as relation
  ),
  'its tables are read by the service role and written only through those functions'
);
select is(
  (select count(*)::integer from pg_class
   where oid in ('public.post_search_embeddings'::regclass, 'public.search_query_embeddings'::regclass,
                 'public.search_query_embedding_days'::regclass)
     and relrowsecurity),
  3,
  'with row level security on, and no policy'
);

-- ─── The search log ─────────────────────────────────────────────────────────

select col_is_null('public', 'search_query_events', 'related_count',
  'the search log''s related_count is nullable: a row written before it, or by the app live during the release, has none');
select throws_ok(
  $$insert into public.search_query_events (query, search_type, signed_in, visitor_day,
      creator_count, post_count, recipe_count, related_count)
    values ('sea', 'top', false, repeat('a', 64), 0, 0, 0, 25)$$,
  '23514', null,
  'and holds at most the 24 a page can'
);

select * from finish();
rollback;
