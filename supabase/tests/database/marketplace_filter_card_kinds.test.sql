-- The marketplace's resource filter (?resource=prompt|workflow|files|notes|
-- remix) lists a recipe under the kinds its card reads from what the recipe
-- stores: getPostResourceKinds on its items, with Remix as hydrateBundleRows
-- resolves it (resolveRecipeAllowRemix). The marketplace route serves what
-- list_marketplace_resource_bundles returns without checking the kind again,
-- so a filter that reads anything else lists recipes the card contradicts.
-- (Files an unlock adds from a creation's shared inputs are counted onto the
-- tile after the list and are no stored kind; the migration's header says
-- so.)
--
-- The search document holds the same kinds as words (since
-- 20261031100330_marketplace_search_indexes_public_text.sql), so each recipe
-- is checked twice: against the kinds its card shows, and against what a
-- search for each kind's word finds. No fixture text holds a kind's word.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

-- The kinds whose filter lists the recipe, in the app's order.
create function pg_temp.filter_kinds(p_bundle_id uuid)
returns text[]
language sql
as $$
  select coalesce(array_agg(kinds.kind order by kinds.position), '{}')
  from unnest(array['prompt', 'workflow', 'files', 'notes', 'remix']) with ordinality as kinds(kind, position)
  where exists (
    select 1
    from public.list_marketplace_resource_bundles('all', kinds.kind, null, null, 'recent', 0, 100)
    where id = p_bundle_id
  );
$$;

-- The kinds whose word, searched for, finds the recipe.
create function pg_temp.search_kinds(p_bundle_id uuid)
returns text[]
language sql
as $$
  select coalesce(array_agg(kinds.kind order by kinds.position), '{}')
  from unnest(array['prompt', 'workflow', 'files', 'notes', 'remix']) with ordinality as kinds(kind, position)
  where exists (
    select 1
    from public.list_marketplace_resource_bundles('all', 'all', null, kinds.kind, 'recent', 0, 100)
    where id = p_bundle_id
  );
$$;

create function pg_temp.listed(p_bundle_id uuid)
returns boolean
language sql
as $$
  select exists (
    select 1
    from public.list_marketplace_resource_bundles('all', 'all', null, null, 'recent', 0, 100)
    where id = p_bundle_id
  );
$$;

-- ─── Fixture ─────────────────────────────────────────────────────────────────
--
-- Three published recipes by one seller:
--   …021 paid, on a post made from a creation: one prompt item, a legacy
--        notes column, a JSON null workflow snapshot (which IS NOT NULL
--        reads as present: 13 of production's 17 recipes stored one on
--        2026-11-01), Remix stored off (every creation recipe published
--        since 2026-10-27 stores it so);
--   …022 free, on a post without one: one settings item, and legacy prompt,
--        workflow and attachment columns, Remix stored off;
--   …023 free, on a post without one: a workflow item and a video item,
--        Remix stored on.

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values ('0000f5e0-0000-4000-9000-000000000001'::uuid, 'f5e-filter-kinds@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

update public.profiles
set username = 'lumen-seller', display_name = 'Lumen Seller'
where id = '0000f5e0-0000-4000-9000-000000000001'::uuid;

insert into public.generations (id, user_id, model, status, is_public, showcase_asset_path)
values ('0000f5e0-0000-4000-9000-000000000030'::uuid,
        '0000f5e0-0000-4000-9000-000000000001'::uuid,
        'nano-banana', 'succeeded', true, 'showcase/f5e-creation.png');

insert into public.posts (
  id, user_id, generation_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  ('0000f5e0-0000-4000-9000-000000000011'::uuid, '0000f5e0-0000-4000-9000-000000000001'::uuid,
   '0000f5e0-0000-4000-9000-000000000030'::uuid,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Lantern alley post', 'Public caption for the lantern alley at night.', 'showcase/f5e-creation.png',
   'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e0-0000-4000-9000-000000000012'::uuid, '0000f5e0-0000-4000-9000-000000000001'::uuid, null,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Harbour dusk post', 'Public caption for the harbour at dusk.', 'showcase/f5e-two.png',
   'Nano Banana', 'nano-banana', now(), now()),
  ('0000f5e0-0000-4000-9000-000000000013'::uuid, '0000f5e0-0000-4000-9000-000000000001'::uuid, null,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Meadow light post', 'Public caption for the meadow at noon.', 'showcase/f5e-three.png',
   'Nano Banana', 'nano-banana', now(), now());

insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix,
  resource_items, resource_sections, price_usd_cents, sales_count, earnings_usd_cents,
  created_at, updated_at
) values
  ('0000f5e0-0000-4000-9000-000000000021'::uuid, '0000f5e0-0000-4000-9000-000000000011'::uuid,
   '0000f5e0-0000-4000-9000-000000000001'::uuid, 'paid', 'published',
   'Lantern alley recipe', 'Lantern light down a narrow alley',
   'A preview long enough to pass the marketplace quality gate.',
   null, 'Legacy column text for the lantern grade.', null, 'null'::jsonb, '[]'::jsonb, false,
   jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Lantern text',
                                        'textContent', 'Lanterns glowing in a wet alley at night')),
   '[]'::jsonb, 300, 0, 0, now(), now()),
  ('0000f5e0-0000-4000-9000-000000000022'::uuid, '0000f5e0-0000-4000-9000-000000000012'::uuid,
   '0000f5e0-0000-4000-9000-000000000001'::uuid, 'free', 'published',
   'Harbour dusk recipe', 'Harbour light at dusk',
   'A preview long enough to pass the marketplace quality gate.',
   'Legacy column text long enough for the gate.', null, 'https://example.invalid/harbour-graph', null,
   jsonb_build_array(jsonb_build_object('label', 'Saffron LUT pack', 'kind', 'link',
                                        'url', 'https://example.invalid/lut')),
   false,
   jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'settings', 'title', 'Camera setup',
                                        'textContent', 'Aperture f/2, shutter 1/250')),
   '[]'::jsonb, 0, 0, 0, now(), now()),
  ('0000f5e0-0000-4000-9000-000000000023'::uuid, '0000f5e0-0000-4000-9000-000000000013'::uuid,
   '0000f5e0-0000-4000-9000-000000000001'::uuid, 'free', 'published',
   'Meadow light recipe', 'Meadow light at noon',
   'A preview long enough to pass the marketplace quality gate.',
   null, null, null, null, '[]'::jsonb, true,
   jsonb_build_array(
     jsonb_build_object('id', 'item-1', 'type', 'workflow', 'title', 'Graph',
                        'externalUrl', 'https://example.invalid/meadow-graph'),
     jsonb_build_object('id', 'item-2', 'type', 'reference_video', 'title', 'Meadow clip',
                        'storagePath', '0000f5e0-0000-4000-9000-000000000001/meadow.mp4')
   ),
   '[]'::jsonb, 0, 0, 0, now(), now());

-- ─── All three are listed, so a miss below is the filter, not the gate ──────

select ok(
  pg_temp.listed('0000f5e0-0000-4000-9000-000000000021'::uuid)
    and pg_temp.listed('0000f5e0-0000-4000-9000-000000000022'::uuid)
    and pg_temp.listed('0000f5e0-0000-4000-9000-000000000023'::uuid),
  'fixture: all three recipes are listed'
);

-- ─── Each filter lists the recipes whose card shows its kind ────────────────

select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000021'::uuid),
  array['prompt', 'remix'],
  'a published creation recipe with Remix stored off is listed under Remix, and its legacy notes and JSON null workflow snapshot add no kind'
);
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000022'::uuid),
  array['notes'],
  'a settings item lists a recipe under notes, and its legacy prompt, workflow and attachment columns add no kind'
);
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000023'::uuid),
  array['workflow', 'files', 'remix'],
  'a workflow item, a video item and the stored Remix switch list a recipe under workflow, files and Remix'
);

-- ─── The filter and the search document hold the same kinds ─────────────────

select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000021'::uuid),
  pg_temp.search_kinds('0000f5e0-0000-4000-9000-000000000021'::uuid),
  'the creation recipe: what the filters list is what a search for each kind finds'
);
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000022'::uuid),
  pg_temp.search_kinds('0000f5e0-0000-4000-9000-000000000022'::uuid),
  'the recipe with legacy columns: the same'
);
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000023'::uuid),
  pg_temp.search_kinds('0000f5e0-0000-4000-9000-000000000023'::uuid),
  'the recipe with Remix stored on: the same'
);

-- ─── The filter follows every column the kinds read ─────────────────────────

update public.post_resource_bundles set status = 'draft'
where id = '0000f5e0-0000-4000-9000-000000000021'::uuid;
select ok(
  (select not has_remix and not listable from public.marketplace_bundle_listings
   where bundle_id = '0000f5e0-0000-4000-9000-000000000021'::uuid),
  'a creation recipe moved to draft no longer includes Remix'
);

update public.post_resource_bundles set status = 'published'
where id = '0000f5e0-0000-4000-9000-000000000021'::uuid;
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000021'::uuid),
  array['prompt', 'remix'],
  'published again, it does'
);

update public.posts set generation_id = null
where id = '0000f5e0-0000-4000-9000-000000000011'::uuid;
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000021'::uuid),
  array['prompt'],
  'a post that loses its creation takes its recipe out of the Remix filter'
);

update public.posts set generation_id = '0000f5e0-0000-4000-9000-000000000030'::uuid
where id = '0000f5e0-0000-4000-9000-000000000012'::uuid;
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000022'::uuid),
  array['notes', 'remix'],
  'a post that gains a creation puts its published recipe in the Remix filter'
);

update public.post_resource_bundles
set resource_items = resource_items || jsonb_build_array(
  jsonb_build_object('id', 'item-2', 'type', 'remix_link', 'title', 'Open in the creator'))
where id = '0000f5e0-0000-4000-9000-000000000021'::uuid;
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000021'::uuid),
  array['prompt', 'remix'],
  'a Remix item lists a recipe under Remix'
);

update public.post_resource_bundles set allow_remix = false
where id = '0000f5e0-0000-4000-9000-000000000023'::uuid;
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000023'::uuid),
  array['workflow', 'files'],
  'turning the stored Remix switch off on a recipe without a creation takes it out of the Remix filter'
);

-- ─── Re-projection ──────────────────────────────────────────────────────────

update public.marketplace_bundle_listings
set has_notes = true, has_prompt = true, has_workflow = true, has_files = true, has_remix = false
where bundle_id = '0000f5e0-0000-4000-9000-000000000022'::uuid;
select public.refresh_marketplace_bundle_listings(null);
select is(
  pg_temp.filter_kinds('0000f5e0-0000-4000-9000-000000000022'::uuid),
  array['notes', 'remix'],
  'a full refresh rewrites a listing row projected before this rule'
);

select * from finish();
rollback;
