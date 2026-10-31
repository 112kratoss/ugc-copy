-- Marketplace search matches only what a visitor who has not unlocked a
-- recipe can see: the fields marketplaceItemMatchesQuery reads
-- (src/lib/post-resource-bundles-server.ts), the recipe's kinds among them.
-- A recipe's items, their titles, descriptions and text, and its cards are
-- what an unlock gives, so the search document never holds them.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(33);

create function pg_temp.finds(p_query text, p_bundle_id uuid)
returns boolean
language sql
as $$
  select exists (
    select 1
    from public.list_marketplace_resource_bundles('all', 'all', null, p_query, 'recent', 0, 100)
    where id = p_bundle_id
  );
$$;

create function pg_temp.document(p_bundle_id uuid)
returns text
language sql
as $$
  select search_text
  from public.marketplace_bundle_search_documents
  where bundle_id = p_bundle_id;
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- Three recipes by one seller:
--   …021 paid, two items (a prompt and a note) and a card, a legacy prompt
--        column, no Remix;
--   …022 free, legacy columns only (prompt, notes, workflow link, a file link),
--        Remix stored on;
--   …023 paid, one prompt item, a legacy notes column, on a post made from a
--        creation, Remix stored off.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000f5d0-0000-4000-9000-000000000001'::uuid, 'f5d-public-search@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

update public.profiles
set username = 'aurora-seller', display_name = 'Aurora Seller'
where id = '0000f5d0-0000-4000-9000-000000000001'::uuid;

insert into public.generations (id, user_id, model, status, is_public, showcase_asset_path)
values ('0000f5d0-0000-4000-9000-000000000030'::uuid,
        '0000f5d0-0000-4000-9000-000000000001'::uuid,
        'nano-banana', 'succeeded', true, 'showcase/f5d-creation.png');

insert into public.posts (
  id, user_id, generation_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  ('0000f5d0-0000-4000-9000-000000000011'::uuid, '0000f5d0-0000-4000-9000-000000000001'::uuid, null,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Aurora portrait post', 'Public caption for the aurora portrait.', 'showcase/f5d-one.png',
   'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5d0-0000-4000-9000-000000000012'::uuid, '0000f5d0-0000-4000-9000-000000000001'::uuid, null,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Harbour dusk post', 'Public caption for the harbour at dusk.', 'showcase/f5d-two.png',
   'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5d0-0000-4000-9000-000000000013'::uuid, '0000f5d0-0000-4000-9000-000000000001'::uuid,
   '0000f5d0-0000-4000-9000-000000000030'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Lantern alley post', 'Public caption for the lantern alley.', 'showcase/f5d-creation.png',
   'Nano Banana', 'nano-banana', now(), now());

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, notes_markdown, workflow_share_url, attachments, allow_remix,
  resource_items, resource_sections, price_usd_cents, sales_count, earnings_usd_cents,
  created_at, updated_at
) values
  ('0000f5d0-0000-4000-9000-000000000021'::uuid, '0000f5d0-0000-4000-9000-000000000011'::uuid,
   '0000f5d0-0000-4000-9000-000000000001'::uuid, 'paid', 'published',
   'Aurora portrait recipe', 'Golden portrait lighting in three steps',
   'A preview long enough to pass the marketplace quality gate.',
   'Legacy column text with obsidianfern detail for the gate.', null, null, '[]'::jsonb, false,
   jsonb_build_array(
     jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Vellichor lighting setup',
                        'description', 'Uses the quillwort grading pass',
                        'textContent', 'A golden-hour portrait lit through amberglass kaleidoscope prisms',
                        'sectionId', 'card-1'),
     jsonb_build_object('id', 'item-2', 'type', 'note', 'title', 'Finishing',
                        'textContent', 'Upscale twice, then add zephyrine grain')
   ),
   jsonb_build_array(
     jsonb_build_object('id', 'card-1', 'title', 'Marrowgate scene', 'kind', 'scene',
                        'description', 'Thistledown framing guide', 'sortOrder', 0)
   ),
   200, 0, 0, now(), now()),
  ('0000f5d0-0000-4000-9000-000000000022'::uuid, '0000f5d0-0000-4000-9000-000000000012'::uuid,
   '0000f5d0-0000-4000-9000-000000000001'::uuid, 'free', 'published',
   'Harbour dusk recipe', 'Harbour lights at dusk, step by step',
   'A preview long enough to pass the marketplace quality gate.',
   'Legacy prompt column long enough for the gate.', 'Legacy brindlewick grading guide.',
   'https://example.invalid/harbour-graph',
   jsonb_build_array(jsonb_build_object('label', 'Saffronveil LUT pack', 'kind', 'link',
                                        'url', 'https://example.invalid/lut')),
   true, '[]'::jsonb, '[]'::jsonb, 0, 0, 0, now(), now()),
  ('0000f5d0-0000-4000-9000-000000000023'::uuid, '0000f5d0-0000-4000-9000-000000000013'::uuid,
   '0000f5d0-0000-4000-9000-000000000001'::uuid, 'paid', 'published',
   'Lantern alley recipe', 'Lantern light down a narrow alley',
   'A preview long enough to pass the marketplace quality gate.',
   null, 'Legacy column text for the lantern grade.', null, '[]'::jsonb, false,
   jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Prompt',
                                        'textContent', 'Lanterns glowing in a wet alley at night')),
   '[]'::jsonb, 300, 0, 0, now(), now());

-- ─── All three are listed, so a miss below is the search, not the gate ──────

select ok(pg_temp.finds(null, '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'fixture: the paid recipe with items is listed');
select ok(pg_temp.finds(null, '0000f5d0-0000-4000-9000-000000000022'::uuid),
  'fixture: the free legacy recipe is listed');
select ok(pg_temp.finds(null, '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'fixture: the paid creation recipe is listed');

-- ─── What a visitor sees is searchable ──────────────────────────────────────

select ok(pg_temp.finds('golden portrait lighting', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'the recipe''s summary finds it');
select ok(pg_temp.finds('pass the marketplace quality', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'its preview finds it');
select ok(pg_temp.finds('aurora seller', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'its seller''s name finds it');
select ok(pg_temp.finds('caption for the aurora', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'its post''s caption finds it');
select ok(pg_temp.finds('nano banana', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'its post''s tool finds it');

-- ─── What an unlock gives is not ─────────────────────────────────────────────

select ok(not pg_temp.finds('amberglass', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'a paid recipe''s prompt text does not find it');
select ok(not pg_temp.finds('zephyrine', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor does its note''s text');
select ok(not pg_temp.finds('vellichor', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor an item''s title');
select ok(not pg_temp.finds('quillwort', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor an item''s description');
select ok(not pg_temp.finds('marrowgate', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor a card''s title');
select ok(not pg_temp.finds('thistledown', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor a card''s description');
select ok(not pg_temp.finds('obsidianfern', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor its legacy prompt column');
select ok(not pg_temp.finds('brindlewick', '0000f5d0-0000-4000-9000-000000000022'::uuid),
  'nor a free recipe''s legacy notes');
select ok(not pg_temp.finds('saffronveil', '0000f5d0-0000-4000-9000-000000000022'::uuid),
  'nor a file''s label');

-- The search document is exactly the visible fields, in the order the app's
-- check joins them, then the kinds the recipe card shows.
select is(
  pg_temp.document('0000f5d0-0000-4000-9000-000000000021'::uuid),
  'aurora portrait recipe golden portrait lighting in three steps '
    || 'a preview long enough to pass the marketplace quality gate. '
    || 'aurora-seller aurora seller aurora portrait post public caption for the aurora portrait. '
    || 'nano banana prompt notes',
  'the paid recipe''s search document holds its visible fields and its kinds, nothing more'
);

-- ─── Kinds, as getPostResourceKinds reads the stored recipe ─────────────────

select ok(pg_temp.finds('prompt', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'a prompt item makes the recipe a prompt recipe');
select ok(pg_temp.finds('notes', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'a note item makes it hold notes');
select ok(not pg_temp.finds('remix', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'a recipe without Remix is not found by it');
select ok(not pg_temp.finds('files', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'nor one without files by files');
select is(
  substring(pg_temp.document('0000f5d0-0000-4000-9000-000000000022'::uuid) from 'nano banana .*$'),
  'nano banana prompt workflow files notes remix',
  'a recipe without items takes its kinds from its legacy columns and its stored Remix'
);
select ok(pg_temp.finds('remix', '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'a published recipe on a creation includes Remix whatever its stored switch says');
select ok(not pg_temp.finds('notes', '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'a recipe with items ignores its legacy columns');

-- ─── The document follows every column it reads ─────────────────────────────

update public.post_resource_bundles set allow_remix = true
where id = '0000f5d0-0000-4000-9000-000000000021'::uuid;
select ok(pg_temp.finds('remix', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'turning Remix on refreshes the document');

update public.post_resource_bundles set notes_markdown = null
where id = '0000f5d0-0000-4000-9000-000000000022'::uuid;
select is(
  substring(pg_temp.document('0000f5d0-0000-4000-9000-000000000022'::uuid) from 'nano banana .*$'),
  'nano banana prompt workflow files remix',
  'clearing a legacy column refreshes the document'
);

update public.post_resource_bundles set status = 'draft'
where id = '0000f5d0-0000-4000-9000-000000000023'::uuid;
select ok(
  pg_temp.document('0000f5d0-0000-4000-9000-000000000023'::uuid) like '%nano banana prompt',
  'a creation recipe moved to draft no longer includes Remix'
);

update public.post_resource_bundles set status = 'published'
where id = '0000f5d0-0000-4000-9000-000000000023'::uuid;
select ok(pg_temp.finds('remix', '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'published again, it does');

update public.posts set generation_id = null
where id = '0000f5d0-0000-4000-9000-000000000013'::uuid;
select ok(not pg_temp.finds('remix', '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'a post that loses its creation refreshes its recipe''s document');

update public.post_resource_bundles
set resource_items = resource_items || jsonb_build_array(
  jsonb_build_object('id', 'item-3', 'type', 'external_link', 'title', 'Reference',
                     'externalUrl', 'https://example.invalid/reference'))
where id = '0000f5d0-0000-4000-9000-000000000023'::uuid;
select ok(pg_temp.finds('files', '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'a link item makes the recipe hold files');

update public.post_resource_bundles
set resource_sections = jsonb_build_array(
  jsonb_build_object('id', 'card-2', 'title', 'Wintergreen hollow', 'kind', 'scene', 'sortOrder', 0))
where id = '0000f5d0-0000-4000-9000-000000000023'::uuid;
select ok(not pg_temp.finds('wintergreen', '0000f5d0-0000-4000-9000-000000000023'::uuid),
  'a card added later is not searchable either');

-- ─── Re-projection ──────────────────────────────────────────────────────────

update public.marketplace_bundle_search_documents
set search_text = 'stale document amberglass'
where bundle_id = '0000f5d0-0000-4000-9000-000000000021'::uuid;
select public.refresh_marketplace_bundle_search_documents(null);
select ok(not pg_temp.finds('amberglass', '0000f5d0-0000-4000-9000-000000000021'::uuid),
  'a full refresh rewrites a document projected before this rule');

select * from finish();
rollback;
