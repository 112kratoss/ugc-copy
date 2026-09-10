begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(16);
insert into auth.users(id,email,aud,role,created_at,raw_app_meta_data,raw_user_meta_data)
values('e9100000-0000-4000-8000-000000000001','private-playback@example.invalid','authenticated','authenticated',now(),'{}','{}');
insert into public.generations(id,user_id,prediction_id,model,status,category,prompt,output_url,completed_at,playback_rendition_status)
select ('e9200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,
 'e9100000-0000-4000-8000-000000000001'::uuid,'private-playback-'||n,'fixture',
 case when n=6 then 'processing' else 'succeeded' end,null,'fixture',
 case when n=5 then 'generated_audio/e9100000-0000-4000-8000-000000000001/5.wav'
 when n=7 then 'generated_videos/another-owner/7.mp4'
 when n=8 then 'generated_videos/e9100000-0000-4000-8000-000000000001/../8.mp4'
 else 'generated_videos/e9100000-0000-4000-8000-000000000001/'||n||'.mp4' end,
 now(),case when n=9 then 'skipped' else 'pending' end
from generate_series(1,9) n;
insert into storage.objects(bucket_id,name,metadata)
select 'generated_videos',substr(output_url,length('generated_videos/')+1),
 case when prediction_id='private-playback-2' then '{"size":67108865}'::jsonb
 when prediction_id='private-playback-3' then '{"size":"bad"}'::jsonb else '{"size":33831055}'::jsonb end
from public.generations where prediction_id like 'private-playback-%' and prediction_id not in ('private-playback-4','private-playback-5');
create temporary table claimed as select * from public.claim_generation_playback_rendition('worker-a');
select is((select count(*) from claimed),1::bigint,'only one bounded stored video is admitted');
select is((select id::text from claimed),'e9200000-0000-4000-8000-000000000001','excludes oversized, malformed, missing, audio, running, foreign, traversal and terminal rows');
select is((select source_bytes from claimed),33831055::bigint,'measured large private original fits the 64 MiB budget');
select is((select playback_rendition_attempt_count from public.generations where id=(select id from claimed)),1,'claim consumes attempt before encoding');
select is((select output_url from public.generations where id=(select id from claimed)),'generated_videos/e9100000-0000-4000-8000-000000000001/1.mp4','original remains unchanged');
select is((select count(*) from public.claim_generation_playback_rendition('worker-b')),0::bigint,'active lease excludes another worker');
update public.generations set playback_rendition_locked_at=now()-interval '11 minutes' where id=(select id from claimed);
select is((select count(*) from public.claim_generation_playback_rendition('worker-b')),1::bigint,'expired lease recovers');
update public.generations set playback_rendition_locked_at=now()-interval '11 minutes' where id=(select id from claimed);
select is((select count(*) from public.claim_generation_playback_rendition('worker-c')),1::bigint,'third crash-safe attempt is admitted');
update public.generations set playback_rendition_locked_at=now()-interval '11 minutes' where id=(select id from claimed);
select is((select count(*) from public.claim_generation_playback_rendition('worker-d')),0::bigint,'three crashes exhaust budget');
select is((select count(*) from public.claim_generation_playback_rendition('worker-e',999999999)),0::bigint,'caller cannot enlarge fixed maximum bytes');
select ok(not has_function_privilege('anon','public.claim_generation_playback_rendition(text,bigint)','EXECUTE'),'anonymous cannot claim');
select ok(not has_function_privilege('authenticated','public.claim_generation_playback_rendition(text,bigint)','EXECUTE'),'signed-in users cannot claim');
select ok(has_function_privilege('service_role','public.claim_generation_playback_rendition(text,bigint)','EXECUTE'),'worker can claim');
select ok(not has_column_privilege('authenticated','public.generations','playback_rendition_path','SELECT'),'private path is service-projected only');
select throws_ok($$update public.generations set playback_rendition_status='ready' where id='e9200000-0000-4000-8000-000000000001'$$,'23514',null,'ready requires a stored derivative');
select throws_ok($$update public.generations set playback_rendition_path='generated_videos/foreign/playback/clip.mp4' where id='e9200000-0000-4000-8000-000000000001'$$,'23514',null,'derivative path must belong to the generation owner and id');
select * from finish();
rollback;
