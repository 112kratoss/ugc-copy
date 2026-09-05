begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(5);

insert into auth.users (id, email, aud, role, created_at, raw_app_meta_data, raw_user_meta_data)
values ('e8100000-0000-4000-8000-000000000001', 'legacy-preview@example.invalid',
  'authenticated', 'authenticated', now(), '{}', '{}');

insert into public.generations (
  id, user_id, prediction_id, model, status, category, prompt, output_url,
  preview_status, preview_attempt_count, completed_at
)
select ('e8200000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'e8100000-0000-4000-8000-000000000001'::uuid, 'legacy-preview-' || n,
  'fixture-model', 'succeeded', null, 'fixture', path, 'pending', 0, now()
from (values
  (1, 'generated_videos/e8100000/legacy.mp4'),
  (2, 'generated_images/e8100000/legacy.png'),
  (3, 'generated_audio/e8100000/legacy.wav'),
  (4, 'https://provider.example/unknown'),
  (5, 'generatedXvideos/e8100000/invalid.mp4')
) as fixture(n, path);

create temporary table claimed as select * from public.claim_generation_preview_repairs(100, 'legacy-audit', 300, 3);
select is((select count(*) from claimed), 2::bigint, 'legacy stored visual media is admitted without a category');
select is((select count(*) from claimed where id in (
  'e8200000-0000-4000-8000-000000000001', 'e8200000-0000-4000-8000-000000000002'
)), 2::bigint, 'only canonical image and video buckets are admitted');
select is((select count(*) from public.claim_generation_preview_repairs(100, 'other-worker', 300, 3)),
  0::bigint, 'live legacy leases are not claimed twice');
update public.generations set preview_locked_at = now() - interval '10 minutes'
where id = 'e8200000-0000-4000-8000-000000000001';
select is((select count(*) from public.claim_generation_preview_repairs(100, 'recovery-worker', 300, 3)),
  1::bigint, 'legacy work remains recoverable after a worker lease expires');
select ok(not has_function_privilege('authenticated',
  'public.claim_generation_preview_repairs(integer,text,integer,integer)', 'EXECUTE'),
  'legacy admission does not expose the internal claim to clients');
select * from finish();
rollback;
