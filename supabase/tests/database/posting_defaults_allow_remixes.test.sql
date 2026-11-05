-- Remix plan, phase 2 (owner, 2026-11-05): a post's own "Allow remixes", on by default and for every
-- post already there, written by the two save RPCs only when a save sends it; a recipe's title needs
-- 3 characters. Migration 20261105152921_posting_defaults_allow_remixes.sql.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(26);

insert into auth.users(id,email,aud,role,created_at,is_anonymous,raw_app_meta_data,raw_user_meta_data)
values ('ab300001-1000-4000-8000-000000000001','remix-switch-owner@example.invalid','authenticated','authenticated',now(),false,'{}','{}');
insert into public.posts(id,user_id,title,body,category,post_format,source_kind,visibility)
values('ab300002-1000-4000-8000-000000000001','ab300001-1000-4000-8000-000000000001','A post from before','Synthetic text','text','text','manual','private');

select col_not_null('public','posts','remixes_allowed','the switch is never unknown');
select col_default_is('public','posts','remixes_allowed','true','a post allows remixes unless its creator turns them off');
select ok((select remixes_allowed from public.posts where id='ab300002-1000-4000-8000-000000000001'),'a post from before allows remixes');

-- The publish's save.
select lives_ok($$select * from public.upsert_post_with_resource_bundle('{"id":"ab300002-1000-4000-8000-000000000002","user_id":"ab300001-1000-4000-8000-000000000001","visibility":"private","category":"text","post_format":"text","source_kind":"manual","title":"Switched off","body":"Synthetic text","remixes_allowed":false}',null,false)$$,'a publish saves the switch it sends');
select ok(not (select remixes_allowed from public.posts where id='ab300002-1000-4000-8000-000000000002'),'and the post keeps it off');
select lives_ok($$select * from public.upsert_post_with_resource_bundle('{"id":"ab300002-1000-4000-8000-000000000003","user_id":"ab300001-1000-4000-8000-000000000001","visibility":"private","category":"text","post_format":"text","source_kind":"manual","title":"From an older app","body":"Synthetic text"}',null,false)$$,'an older app''s publish sends no switch');
select ok((select remixes_allowed from public.posts where id='ab300002-1000-4000-8000-000000000003'),'and its post allows remixes');
select throws_ok($$select * from public.upsert_post_with_resource_bundle('{"id":"ab300002-1000-4000-8000-000000000004","user_id":"ab300001-1000-4000-8000-000000000001","visibility":"private","category":"text","post_format":"text","source_kind":"manual","title":"Not a switch","body":"Synthetic text","remixes_allowed":"no"}',null,false)$$,'P0001','Invalid remix switch','a publish refuses a switch that is no boolean');
select is((select count(*) from public.posts where id='ab300002-1000-4000-8000-000000000004'),0::bigint,'and saves nothing');

-- The edit's save.
select lives_ok($$select * from public.update_post_with_resource_bundle('ab300002-1000-4000-8000-000000000001','ab300001-1000-4000-8000-000000000001','{"remixes_allowed":false}',false,null)$$,'an edit saves the switch it sends');
select ok(not (select remixes_allowed from public.posts where id='ab300002-1000-4000-8000-000000000001'),'and the post keeps it off');
select lives_ok($$select * from public.update_post_with_resource_bundle('ab300002-1000-4000-8000-000000000001','ab300001-1000-4000-8000-000000000001','{"title":"Old client edit"}',false,null)$$,'an older app''s edit sends no switch');
select ok(not (select remixes_allowed from public.posts where id='ab300002-1000-4000-8000-000000000001'),'and leaves the post''s own as it was');
select throws_ok($$select * from public.update_post_with_resource_bundle('ab300002-1000-4000-8000-000000000001','ab300001-1000-4000-8000-000000000001','{"remixes_allowed":1}',false,null)$$,'P0001','Invalid remix switch','an edit refuses a switch that is no boolean');

-- A recipe's title needs 3 characters, as RECIPE_TITLE_MIN_LENGTH says.
select is(public.marketplace_resource_bundle_quality_issue(
  p_title => 'Ox', p_summary => null, p_preview_text => 'The prompt and references behind this still.',
  p_prompt_text => 'A lantern at dusk with warm rim light and fog.', p_notes_markdown => null, p_workflow_share_url => null,
  p_workflow_snapshot => null, p_attachments => '[]'::jsonb, p_allow_remix => false, p_price_usd_cents => 10,
  p_access_mode => 'paid', p_post_title => 'Ox', p_post_body => null, p_post_visibility => 'public',
  p_post_archived_at => null, p_post_review_status => 'visible', p_post_has_media => true,
  p_seller_username => 'remixer', p_seller_display_name => 'Remixer'
), 'Add a clear listing title with at least 3 characters.', 'a title of 2 characters is refused, in the new words');
select isnt(public.marketplace_resource_bundle_quality_issue(
  p_title => 'Cat', p_summary => null, p_preview_text => 'The prompt and references behind this still.',
  p_prompt_text => 'A lantern at dusk with warm rim light and fog.', p_notes_markdown => null, p_workflow_share_url => null,
  p_workflow_snapshot => null, p_attachments => '[]'::jsonb, p_allow_remix => false, p_price_usd_cents => 10,
  p_access_mode => 'paid', p_post_title => 'Cat', p_post_body => null, p_post_visibility => 'public',
  p_post_archived_at => null, p_post_review_status => 'visible', p_post_has_media => true,
  p_seller_username => 'remixer', p_seller_display_name => 'Remixer'
), 'Add a clear listing title with at least 3 characters.', 'a title of 3 characters is long enough');

-- The marketplace sells no Remix with the recipe of a post whose creator turned remixes off (the
-- review of phase 2): its Remix filter and a search for the word leave it out, and both follow the
-- switch back on.
create function pg_temp.lists_under_remix(p_bundle_id uuid, p_search text)
returns boolean
language sql
as $$
  select exists (
    select 1
    from public.list_marketplace_resource_bundles('all', case when p_search is null then 'remix' else 'all' end, null, p_search, 'recent', 0, 100)
    where id = p_bundle_id
  );
$$;

update public.profiles set username = 'switch-seller', display_name = 'Switch Seller'
where id = 'ab300001-1000-4000-8000-000000000001';
insert into public.generations (id, user_id, model, status, is_public, showcase_asset_path)
values ('ab300003-1000-4000-8000-000000000001', 'ab300001-1000-4000-8000-000000000001',
        'nano-banana', 'succeeded', true, 'showcase/ab3-creation.png');
insert into public.posts (
  id, user_id, generation_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  ('ab300002-1000-4000-8000-000000000011', 'ab300001-1000-4000-8000-000000000001', 'ab300003-1000-4000-8000-000000000001',
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Lantern alley post', 'Public caption for the lantern alley at night.', 'showcase/ab3-creation.png',
   'Nano Banana', 'nano-banana', now(), now()),
  ('ab300002-1000-4000-8000-000000000012', 'ab300001-1000-4000-8000-000000000001', null,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Meadow light post', 'Public caption for the meadow at noon.', 'showcase/ab3-two.png',
   'Nano Banana', 'nano-banana', now(), now());
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix,
  resource_items, resource_sections, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values
  -- A creation's recipe, whose Remix comes with it.
  ('ab300004-1000-4000-8000-000000000021', 'ab300002-1000-4000-8000-000000000011', 'ab300001-1000-4000-8000-000000000001',
   'paid', 'published', 'Lantern alley recipe', 'Lantern light down a narrow alley',
   'A preview long enough to pass the marketplace quality gate.', null, null, null, null, '[]'::jsonb, false,
   jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Lantern text',
                                        'textContent', 'Lanterns glowing in a wet alley at night')),
   '[]'::jsonb, 10, 0, 0, now(), now()),
  -- An older recipe with its live hand-over stored on.
  ('ab300004-1000-4000-8000-000000000022', 'ab300002-1000-4000-8000-000000000012', 'ab300001-1000-4000-8000-000000000001',
   'free', 'published', 'Meadow light recipe', 'Meadow light at noon',
   'A preview long enough to pass the marketplace quality gate.', null, null, null, null, '[]'::jsonb, true,
   jsonb_build_array(jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Meadow text',
                                        'textContent', 'A meadow in the noon light, wide and soft')),
   '[]'::jsonb, 0, 0, 0, now(), now());

select ok(
  pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000021', null)
    and pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000022', null),
  'fixture: both recipes are listed under Remix while their posts allow remixes'
);
update public.posts set remixes_allowed = false
where id in ('ab300002-1000-4000-8000-000000000011', 'ab300002-1000-4000-8000-000000000012');
select ok(
  not pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000021', null),
  'a creation''s recipe is no longer listed under Remix once its post''s switch is off'
);
select ok(
  not pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000022', null),
  'nor is a recipe whose live hand-over is stored on'
);
select ok(
  not pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000021', 'remix'),
  'and a search for the word no longer finds it'
);
select ok(
  (select listable from public.marketplace_bundle_listings where bundle_id = 'ab300004-1000-4000-8000-000000000021'),
  'the recipe itself stays listed: it can still be bought'
);
update public.posts set remixes_allowed = true where id = 'ab300002-1000-4000-8000-000000000011';
select ok(
  pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000021', null)
    and pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000021', 'remix'),
  'switched back on, the filter and the search list it under Remix again'
);

-- A Remix link among a recipe's items makes a Remix of its own, without the stored switch or a
-- creation (the review of phase 2, finding 13): it is left out while the post's switch is off too.
insert into public.posts (
  id, user_id, generation_id, visibility, category, source_kind, post_format, review_status,
  title, body, showcase_asset_path, source_tool, source_tool_slug, created_at, updated_at
) values
  ('ab300002-1000-4000-8000-000000000013', 'ab300001-1000-4000-8000-000000000001', null,
   'public', 'image', 'magicbooklet', 'media', 'visible',
   'Harbor fog post', 'Public caption for the harbor in the dawn fog.', 'showcase/ab3-three.png',
   'Nano Banana', 'nano-banana', now(), now());
insert into public.post_resource_bundles (
  id, post_id, owner_user_id, access_mode, status, title, summary, preview_text,
  prompt_text, notes_markdown, workflow_share_url, workflow_snapshot, attachments, allow_remix,
  resource_items, resource_sections, price_usd_cents, sales_count, earnings_usd_cents, created_at, updated_at
) values
  ('ab300004-1000-4000-8000-000000000023', 'ab300002-1000-4000-8000-000000000013', 'ab300001-1000-4000-8000-000000000001',
   'free', 'published', 'Harbor fog recipe', 'Harbor fog at dawn, boats asleep',
   'A preview long enough to pass the marketplace quality gate.', null, null, null, null, '[]'::jsonb, false,
   jsonb_build_array(
     jsonb_build_object('id', 'item-1', 'type', 'prompt', 'title', 'Harbor text',
                        'textContent', 'A harbor in the dawn fog, the boats asleep'),
     jsonb_build_object('id', 'item-2', 'type', 'remix_link', 'title', 'Remix link',
                        'externalUrl', 'https://example.com/harbor')
   ),
   '[]'::jsonb, 0, 0, 0, now(), now());

select ok(
  pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000023', null)
    and pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000023', 'remix'),
  'fixture: a recipe with a Remix link is listed under Remix while its post allows remixes'
);
update public.posts set remixes_allowed = false where id = 'ab300002-1000-4000-8000-000000000013';
select ok(
  not pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000023', null)
    and not pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000023', 'remix'),
  'its Remix link makes no Remix once the post''s switch is off: neither the filter nor a search lists it'
);
select ok(
  (select listable from public.marketplace_bundle_listings where bundle_id = 'ab300004-1000-4000-8000-000000000023'),
  'and the recipe, its link and all, stays listed'
);
update public.posts set remixes_allowed = true where id = 'ab300002-1000-4000-8000-000000000013';
select ok(
  pg_temp.lists_under_remix('ab300004-1000-4000-8000-000000000023', null),
  'switched back on, its Remix link lists it under Remix again'
);

select * from finish();
rollback;
