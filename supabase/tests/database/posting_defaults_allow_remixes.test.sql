-- Remix plan, phase 2 (owner, 2026-11-05): a post's own "Allow remixes", on by default and for every
-- post already there, written by the two save RPCs only when a save sends it; a recipe's title needs
-- 3 characters. Migration 20261105152921_posting_defaults_allow_remixes.sql.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(16);

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

select * from finish();
rollback;
