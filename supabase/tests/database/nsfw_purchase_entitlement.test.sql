-- A buyer reads the media of a mature post they unlocked without a reveal and
-- without the mature-content preference; a stranger still cannot, and a
-- retracted purchase grants nothing (20261014092058).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(12);

insert into auth.users(id,email,aud,role,created_at,is_anonymous,raw_app_meta_data,raw_user_meta_data)
values ('ac140001-1000-4000-8000-000000000001','nsfw-seller@example.invalid','authenticated','authenticated',now(),false,'{}','{}'),
('ac140002-1000-4000-8000-000000000002','nsfw-buyer@example.invalid','authenticated','authenticated',now(),false,'{}','{}'),
('ac140003-1000-4000-8000-000000000003','nsfw-stranger@example.invalid','authenticated','authenticated',now(),false,'{}','{}');
insert into public.posts(id,user_id,title,body,category,post_format,source_kind,visibility,is_nsfw,showcase_asset_path)
values('ac140010-1000-4000-8000-000000000001','ac140001-1000-4000-8000-000000000001','A mature recipe post','Synthetic fixture.','image','media','external','public',true,'private-posts/ac140010-1000-4000-8000-000000000001/original.jpg');
insert into public.post_media(post_id,storage_path,preview_storage_path,media_kind,sort_order)
values('ac140010-1000-4000-8000-000000000001','private-posts/ac140010-1000-4000-8000-000000000001/original.jpg','private-posts/ac140010-1000-4000-8000-000000000001/original.preview.webp','image',0);
set constraints all immediate;

insert into public.post_resource_bundles(id,post_id,owner_user_id,access_mode,status,title,summary,preview_text,prompt_text,price_usd_cents)
values('ac140020-1000-4000-8000-000000000001','ac140010-1000-4000-8000-000000000001','ac140001-1000-4000-8000-000000000001','paid','published','Recipe','Summary','Preview','Prompt',500);
insert into public.post_resource_bundle_orders(id,bundle_id,buyer_user_id,razorpay_order_id,razorpay_payment_id,amount_subunits,currency,status,quoted_price_usd_cents,quoted_revision_id,quoted_content_fingerprint,quoted_media)
select 'ac140030-1000-4000-8000-000000000001','ac140020-1000-4000-8000-000000000001','ac140002-1000-4000-8000-000000000002','order_nsfw_1','pay_nsfw_1',500,'USD','created',500,r.id,r.content_fingerprint,'[]'::jsonb
from public.post_resource_bundle_revisions r where r.bundle_id='ac140020-1000-4000-8000-000000000001' order by r.revision_number desc limit 1;
insert into public.post_resource_bundle_purchases(id,bundle_id,buyer_user_id,order_id,price_usd_cents,amount_subunits,currency)
values('ac140040-1000-4000-8000-000000000001','ac140020-1000-4000-8000-000000000001','ac140002-1000-4000-8000-000000000002','ac140030-1000-4000-8000-000000000001',500,500,'USD');

-- The live post's media, read by the buyer with no reveal and no preference row.
select ok(public.can_read_nsfw_post('ac140010-1000-4000-8000-000000000001','ac140002-1000-4000-8000-000000000002'),'the buyer passes the mature gate without a reveal');
select ok(not public.can_read_nsfw_post('ac140010-1000-4000-8000-000000000001','ac140003-1000-4000-8000-000000000003'),'a stranger still needs a reveal');
select ok(not public.can_read_nsfw_post('ac140010-1000-4000-8000-000000000001',null),'anonymous still needs a reveal');
select ok(public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/original.preview.webp','ac140002-1000-4000-8000-000000000002'),'the buyer reads the live preview (the unlock cover)');
select ok(public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/original.jpg','ac140002-1000-4000-8000-000000000002'),'the buyer reads the live original');
select ok(not public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/original.preview.webp','ac140003-1000-4000-8000-000000000003'),'a stranger is refused the preview');

-- The purchase snapshot (what the library thumbnail prefers), flagged mature.
insert into public.post_resource_purchase_media(purchase_id,media_key,storage_path,preview_storage_path,media_kind,sort_order,is_nsfw)
values('ac140040-1000-4000-8000-000000000001','cover','private-posts/ac140010-1000-4000-8000-000000000001/snapshot.jpg','private-posts/ac140010-1000-4000-8000-000000000001/snapshot.preview.webp','image',0,true);
select ok(public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/snapshot.preview.webp','ac140002-1000-4000-8000-000000000002'),'the buyer reads their snapshot preview');
select ok(not public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/snapshot.preview.webp','ac140003-1000-4000-8000-000000000003'),'a stranger is refused the snapshot');

-- A block still closes the live post; the snapshot stays the buyer's.
insert into public.user_blocks(blocker_user_id,blocked_user_id) values('ac140001-1000-4000-8000-000000000001','ac140002-1000-4000-8000-000000000002');
select ok(not public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/original.preview.webp','ac140002-1000-4000-8000-000000000002'),'a block still refuses the live preview');
select ok(public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/snapshot.preview.webp','ac140002-1000-4000-8000-000000000002'),'the snapshot survives a block');
delete from public.user_blocks where blocker_user_id='ac140001-1000-4000-8000-000000000001';

-- A retracted purchase grants nothing.
update public.post_resource_bundle_purchases set moderation_retracted_at=now() where id='ac140040-1000-4000-8000-000000000001';
select ok(not public.can_read_nsfw_post('ac140010-1000-4000-8000-000000000001','ac140002-1000-4000-8000-000000000002'),'a retracted purchase does not pass the gate');
select ok(not public.can_read_private_post_media('private-posts/ac140010-1000-4000-8000-000000000001/snapshot.preview.webp','ac140002-1000-4000-8000-000000000002'),'a retracted purchase loses the snapshot');

select * from finish();
rollback;
