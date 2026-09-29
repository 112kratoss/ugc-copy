begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select no_plan();

insert into auth.users(id,email,aud,role,created_at,is_anonymous,raw_app_meta_data,raw_user_meta_data)
values ('ab290001-1000-4000-8000-000000000001','nsfw-owner@example.invalid','authenticated','authenticated',now(),false,'{}','{}'),
('ab290003-1000-4000-8000-000000000002','nsfw-viewer@example.invalid','authenticated','authenticated',now(),false,'{}','{}');
insert into public.posts(id,user_id,title,body,category,post_format,source_kind,visibility,is_nsfw,showcase_asset_path)
values('ab290002-1000-4000-8000-000000000001','ab290001-1000-4000-8000-000000000001','A mature post','A synthetic test fixture for a warning.','image','media','external','public',true,'private-posts/ab290002-1000-4000-8000-000000000001/original.jpg');
set constraints all immediate;

select ok(not has_function_privilege('authenticated','public.reveal_nsfw_post(uuid,uuid)','EXECUTE'),'clients cannot mint reveal grants');
select ok(not has_table_privilege('authenticated','public.content_preferences','UPDATE'),'clients cannot bypass website opt-in');
select ok(not public.can_read_private_post_media('private-posts/ab290002-1000-4000-8000-000000000001/original.jpg',null),'anonymous original is denied');
select ok(not public.can_read_private_post_media('private-posts/ab290002-1000-4000-8000-000000000001/original.jpg','ab290003-1000-4000-8000-000000000002'),'signed-in original before reveal is denied');
select ok(not public.reveal_nsfw_post('ab290002-1000-4000-8000-000000000001','ab290003-1000-4000-8000-000000000002'),'reveal without opt-in is denied');
insert into public.content_preferences(user_id,show_mature,adult_confirmed_at)
values('ab290003-1000-4000-8000-000000000002',true,now());
select ok(public.reveal_nsfw_post('ab290002-1000-4000-8000-000000000001','ab290003-1000-4000-8000-000000000002'),'eligible viewer can deliberately reveal');
select ok(public.can_read_private_post_media('private-posts/ab290002-1000-4000-8000-000000000001/original.jpg','ab290003-1000-4000-8000-000000000002'),'original becomes available after reveal');
update public.posts set body='A changed revision must be revealed again.' where id='ab290002-1000-4000-8000-000000000001';
select ok(not public.has_nsfw_reveal('ab290002-1000-4000-8000-000000000001','ab290003-1000-4000-8000-000000000002'),'editing invalidates a prior reveal');
select ok(public.reveal_nsfw_post('ab290002-1000-4000-8000-000000000001','ab290003-1000-4000-8000-000000000002'),'changed revision can be revealed again');
update public.content_preferences set show_mature=false where user_id='ab290003-1000-4000-8000-000000000002';
select ok(not public.has_nsfw_reveal('ab290002-1000-4000-8000-000000000001','ab290003-1000-4000-8000-000000000002'),'disabling preference revokes access immediately');
select throws_ok($$update public.posts set showcase_asset_path='posts/ab290002-1000-4000-8000-000000000001/public.jpg' where id='ab290002-1000-4000-8000-000000000001'$$,'P0001','NSFW_PRIVATE_MEDIA_REQUIRED','mature original cannot become a public object');
select lives_ok($$select * from public.upsert_post_with_resource_bundle('{"id":"ab290002-1000-4000-8000-000000000002","user_id":"ab290001-1000-4000-8000-000000000001","visibility":"private","category":"text","post_format":"text","source_kind":"manual","title":"Manual warning","body":"Synthetic text","is_nsfw":true}',null,false)$$,'create RPC persists a manual warning atomically');
select ok((select is_nsfw from public.posts where id='ab290002-1000-4000-8000-000000000002'),'created post is labeled');
select lives_ok($$select * from public.update_post_with_resource_bundle('ab290002-1000-4000-8000-000000000002','ab290001-1000-4000-8000-000000000001','{"title":"Old client edit"}',false,null)$$,'old client can edit without sending a label');
select ok((select is_nsfw from public.posts where id='ab290002-1000-4000-8000-000000000002'),'old client cannot silently clear the warning');
-- A public object's descriptor is never changed without a verified private copy.
insert into public.posts(id,user_id,visibility,category,post_format,source_kind,showcase_asset_path)
values('ab290002-1000-4000-8000-000000000003','ab290001-1000-4000-8000-000000000001','public','image','media','manual','posts/ab290002-1000-4000-8000-000000000003/test.jpg');
insert into storage.objects(bucket_id,name,metadata) values
('showcase_media','posts/ab290002-1000-4000-8000-000000000003/test.jpg','{"size":100}');
select throws_ok($$select public.commit_nsfw_media_private_copy('ab290002-1000-4000-8000-000000000003','ab290001-1000-4000-8000-000000000001','posts/ab290002-1000-4000-8000-000000000003/test.jpg','private-posts/ab290002-1000-4000-8000-000000000003/test.jpg')$$,'P0001','Private copy has not been verified','missing copy cannot replace public descriptor');
insert into storage.objects(bucket_id,name,metadata) values
('post_media','private-posts/ab290002-1000-4000-8000-000000000003/test.jpg','{"size":100}');
select lives_ok($$select public.commit_nsfw_media_private_copy('ab290002-1000-4000-8000-000000000003','ab290001-1000-4000-8000-000000000001','posts/ab290002-1000-4000-8000-000000000003/test.jpg','private-posts/ab290002-1000-4000-8000-000000000003/test.jpg')$$,'verified descriptor and retry ledger commit together');
select throws_ok($$update public.posts set is_nsfw=true where id='ab290002-1000-4000-8000-000000000003'$$,'P0001','NSFW_PRIVATE_MEDIA_REQUIRED','label waits for public revocation');
update public.uploaded_media_private_copies set revoked_at=now() where public_path='posts/ab290002-1000-4000-8000-000000000003/test.jpg';
select lives_ok($$update public.posts set is_nsfw=true where id='ab290002-1000-4000-8000-000000000003'$$,'label commits after revocation');
select is(public.resolve_post_media_read('posts/ab290002-1000-4000-8000-000000000003/test.jpg',null),null,'old aliases cannot bypass a warning');
select ok(not has_function_privilege('authenticated','public.can_read_nsfw_post(uuid,uuid)','EXECUTE'),'client cannot probe arbitrary viewer reveal grants');
-- Direct Data API reads do not expose originals, even though the app can show a covered projection.
set local role anon;
select throws_ok($$select * from public.posts where id='ab290002-1000-4000-8000-000000000001'$$,'42501',null,'anonymous direct post read is denied');
reset role;
select * from finish();
rollback;
