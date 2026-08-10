begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(7);

delete from public.upload_byte_reservations;
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('e1000000-0000-4000-8000-000000000003', 'upload-quota@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

select is(
  public.reserve_upload_bytes('e1000000-0000-4000-8000-000000000003', 'uploads', 'one', 60, 100, 1000, 7200) ->> 'reason',
  'reserved', 'the first upload reserves its declared bytes'
);
select is(
  public.reserve_upload_bytes('e1000000-0000-4000-8000-000000000003', 'uploads', 'two', 41, 100, 1000, 7200) ->> 'reason',
  'user_byte_limit', 'the atomic user ceiling rejects an over-budget upload'
);
select is((select count(*)::text from public.upload_byte_reservations), '1', 'a rejected upload creates no reservation');
select is(
  public.reserve_upload_bytes('e1000000-0000-4000-8000-000000000003', 'uploads', 'one', 60, 100, 1000, 7200) ->> 'reason',
  'already_reserved', 'the same signed path is idempotent'
);
select ok(public.release_upload_byte_reservation('uploads', 'one'), 'a completed or failed sign releases bytes');
select is(
  public.reserve_upload_bytes('e1000000-0000-4000-8000-000000000003', 'uploads', 'two', 100, 100, 1000, 7200) ->> 'reason',
  'reserved', 'released capacity is immediately reusable'
);
select has_index('public', 'upload_byte_reservations', 'upload_byte_reservations_active_user_idx', 'active user byte sums are indexed');

select * from finish();
rollback;
