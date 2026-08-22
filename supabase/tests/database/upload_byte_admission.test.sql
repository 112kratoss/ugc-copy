begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

delete from public.upload_byte_reservations;
delete from public.upload_path_tombstones;
delete from public.blocked_upload_owners;
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('e1000000-0000-4000-8000-000000000003', 'upload-quota@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

select is(
  public.reserve_upload_bytes_v2(
    'f1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000003',
    'uploads', 'e1000000-0000-4000-8000-000000000003/one.png',
    1, 262144000, 'image/png', 1073741824, 107374182400, 7200
  ) ->> 'reason',
  'reserved',
  'the first upload reserves the server-calculated maximum rather than its one-byte declaration'
);
select is(
  (select declared_bytes from public.upload_byte_reservations
   where id = 'f1000000-0000-4000-8000-000000000001'),
  1::bigint,
  'the untrusted declaration remains audit metadata'
);
select is(
  (select reserved_bytes from public.upload_byte_reservations
   where id = 'f1000000-0000-4000-8000-000000000001'),
  262144000::bigint,
  'admission accounting uses the full trusted uploads-surface maximum'
);
select ok(
  (select finalization_status = 'reserved' and issued_at is null
   from public.upload_byte_reservations
   where id = 'f1000000-0000-4000-8000-000000000001'),
  'a reservation remains pre-issue until Storage returns a signed token'
);
select is(
  (select outstanding_bytes from public.upload_byte_global_counters
   where singleton = true),
  262144000::bigint,
  'the singleton admission counter charges the trusted reservation maximum'
);
select is(
  (select outstanding_bytes from public.upload_byte_user_counters
   where user_id = 'e1000000-0000-4000-8000-000000000003'),
  262144000::bigint,
  'the per-user admission counter charges the trusted reservation maximum'
);
select is(
  public.reconcile_upload_byte_admission_counters(false) ->> 'status',
  'ok',
  'the maintained upload counters reconcile with their authoritative rows'
);

select is(
  public.reserve_upload_bytes_v2(
    'f1000000-0000-4000-8000-000000000002',
    'e1000000-0000-4000-8000-000000000003',
    'uploads', 'e1000000-0000-4000-8000-000000000003/two.png',
    1, 262144000, 'image/png', 262144000, 107374182400, 7200
  ) ->> 'reason',
  'user_byte_limit',
  'a dishonest declaration cannot evade the aggregate reserved-byte ceiling'
);
select is(
  (select count(*) from public.upload_byte_reservations),
  1::bigint,
  'a rejected upload creates no reservation'
);
select is(
  public.reserve_upload_bytes_v2(
    'f1000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000003',
    'uploads', 'e1000000-0000-4000-8000-000000000003/one.png',
    1, 262144000, 'image/png', 1073741824, 107374182400, 7200
  ) ->> 'reason',
  'already_reserved',
  'the same opaque upload ID and signed path are idempotent'
);
select throws_ok(
  $$
    select public.reserve_upload_bytes_v2(
      'f1000000-0000-4000-8000-000000000001',
      'e1000000-0000-4000-8000-000000000003',
      'uploads', 'e1000000-0000-4000-8000-000000000003/different.png',
      1, 262144000, 'image/png', 1073741824, 107374182400, 7200
    )
  $$,
  'P0001',
  'Upload reservation identifier or path collision',
  'an opaque upload ID cannot be rebound to another storage object'
);

select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, version, metadata, created_at)
    values ('a1000000-0000-4000-8000-000000000001', 'uploads',
      'e1000000-0000-4000-8000-000000000003/one.png', 'v1',
      '{"size":1,"mimetype":"image/png"}'::jsonb, now())$$,
  'Storage can perform its permission probe while the reservation is pre-issue'
);
select ok(public.mark_upload_byte_reservation_issued(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003', 7200
), 'the server anchors capability expiry only after Storage returns a token');
create temporary table first_issue_expiry as
select expires_at from public.upload_byte_reservations
where id = 'f1000000-0000-4000-8000-000000000001';
select ok(public.mark_upload_byte_reservation_issued(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003', 86400
), 'a lost issuance acknowledgement is idempotent');
select is((select expires_at from public.upload_byte_reservations
  where id = 'f1000000-0000-4000-8000-000000000001'),
  (select expires_at from first_issue_expiry),
  'issuance retry never extends the signed token deadline');
select throws_ok(
  $$select public.reserve_upload_bytes_v2(
      'f1000000-0000-4000-8000-000000000001',
      'e1000000-0000-4000-8000-000000000003',
      'uploads', 'e1000000-0000-4000-8000-000000000003/one.png',
      1, 262144000, 'image/png', 1073741824, 107374182400, 7200)$$,
  'P0001', 'Upload reservation identifier or path collision',
  'an issued reservation cannot mint a fresh token'
);

select lives_ok(
  $$update public.upload_byte_reservations
    set finalization_status = 'finalizing', status_updated_at = now()
    where id = 'f1000000-0000-4000-8000-000000000001';
    update public.upload_byte_reservations
    set actual_bytes = 1, actual_content_type = 'image/png',
        actual_storage_id = 'a1000000-0000-4000-8000-000000000001',
        actual_storage_version = 'v1', finalization_status = 'finalized',
        finalized_at = now(), client_finalized_at = now(), status_updated_at = now()
    where id = 'f1000000-0000-4000-8000-000000000001'$$,
  'trusted exact Storage metadata finalizes the object'
);
select is((select count(*) from public.upload_path_tombstones
  where bucket_id = 'uploads'
    and storage_path = 'e1000000-0000-4000-8000-000000000003/one.png'),
  1::bigint, 'finalization permanently tombstones the signed path');
select is(
  (select outstanding_bytes from public.upload_byte_global_counters
   where singleton = true),
  1::bigint,
  'finalization atomically replaces the worst-case charge with exact bytes'
);
select is(
  (select outstanding_bytes
   from public.get_upload_reclaim_health(now())),
  1::bigint,
  'bounded reclaim health reads the maintained admission total'
);
select throws_ok(
  $$update storage.objects set metadata = '{"size":2}'::jsonb
    where bucket_id = 'uploads'
      and name = 'e1000000-0000-4000-8000-000000000003/one.png'$$,
  '42501', 'Upload path has been permanently revoked',
  'a finalized token cannot overwrite its exact object'
);

select ok(public.claim_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000001', 1800, 'preserve'
), 'consumption acquires an exact durable lease');
select is(public.complete_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000099', 'preserve'
), false, 'a foreign lease cannot complete consumption');
select ok(public.abort_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000001'
), 'the exact pre-commit lease may abort');
select ok(public.claim_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000002', 1800, 'preserve'
), 'a safely aborted object can be claimed again');
select ok(public.complete_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000002', 'preserve'
), 'the exact lease completes after the durable reference commits');
select ok(public.complete_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000002', 'preserve'
), 'a lost completion acknowledgement is idempotent');

select ok(public.claim_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000003', 1800, 'preserve'
), 'a preserved object supports an exact reconciliation lease');
select lives_ok(
  $$update public.upload_byte_reservations
    set finalization_status = 'consumed', consumption_lease_id = null,
        consumption_lease_expires_at = null,
        consumption_outcome_unknown_at = now(), status_updated_at = now()
    where id = 'f1000000-0000-4000-8000-000000000001'$$,
  'an ambiguous commit enters a non-destructive quarantine'
);
select ok(public.claim_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000004', 1800, 'preserve'
), 'the same disposition can retry a quarantined outcome');
select ok((select consumption_outcome_unknown_at is not null
  from public.upload_byte_reservations
  where id = 'f1000000-0000-4000-8000-000000000001'),
  'retry claim does not clear uncertainty before its exact acknowledgement');
select ok(public.complete_upload_byte_reservation_consumption(
  'f1000000-0000-4000-8000-000000000001',
  'e1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000004', 'preserve'
), 'a fresh exact completion settles the quarantine');
select is((select consumption_outcome_unknown_at from public.upload_byte_reservations
  where id = 'f1000000-0000-4000-8000-000000000001'), null::timestamptz,
  'only exact completion clears the uncertain marker');

select ok(
  (
    select pg_get_expr(index_definition.indpred, index_definition.indrelid)
      like '%consumed%'
      and pg_get_expr(index_definition.indpred, index_definition.indrelid)
        like '%deleted%'
    from pg_index as index_definition
    join pg_class as index_relation on index_relation.oid = index_definition.indexrelid
    where index_relation.relname = 'upload_byte_reservations_expired_reclaimable_idx'
  ),
  'the expired-reclaim index covers consumed and deleted replay states'
);
select has_column(
  'public',
  'upload_byte_reservations',
  'reclaim_not_before',
  'reservations persist the second-pass quiescence gate'
);

select is(
  public.reserve_upload_bytes(
    'e1000000-0000-4000-8000-000000000003',
    'uploads', 'e1000000-0000-4000-8000-000000000003/legacy-one.png', 1,
    600::bigint * 1024 * 1024, 2::bigint * 1024 * 1024 * 1024, 60
  ) ->> 'reason',
  'reserved',
  'the rolling v1 compatibility RPC remains available'
);
select is(
  (select reserved_bytes from public.upload_byte_reservations
   where storage_path = 'e1000000-0000-4000-8000-000000000003/legacy-one.png'),
  (250 * 1024 * 1024)::bigint,
  'the v1 compatibility RPC charges the uploads surface maximum'
);
select is(
  (select expected_content_type from public.upload_byte_reservations
   where storage_path = 'e1000000-0000-4000-8000-000000000003/legacy-one.png'),
  'application/octet-stream',
  'the v1 compatibility reservation has a fail-closed expected content type'
);
select is(
  public.reserve_upload_bytes(
    'e1000000-0000-4000-8000-000000000003',
    'uploads', 'e1000000-0000-4000-8000-000000000003/legacy-one.png', 1,
    600::bigint * 1024 * 1024, 2::bigint * 1024 * 1024 * 1024, 60
  ) ->> 'reason',
  'already_issued',
  'a rolling v1 retry cannot mint a token beyond the anchored deadline'
);
select is(
  public.reserve_upload_bytes(
    'e1000000-0000-4000-8000-000000000003',
    'uploads', 'e1000000-0000-4000-8000-000000000003/legacy-two.png', 1,
    250 * 1024 * 1024, 300 * 1024 * 1024, 60
  ) ->> 'reason',
  'user_byte_limit',
  'abandoned v1 URLs still consume their worst-case aggregate allowance'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.reserve_upload_bytes_v2(uuid,uuid,text,text,bigint,bigint,text,bigint,bigint,integer)',
    'EXECUTE'
  ),
  'only the service boundary can supply trusted reserved bytes to v2'
);
select has_index(
  'public',
  'upload_byte_reservations',
  'upload_byte_reservations_active_user_idx',
  'active user byte sums are indexed'
);
select ok(
  public.release_upload_byte_reservation(
    'uploads', 'e1000000-0000-4000-8000-000000000003/legacy-one.png'
  ),
  'the rolling release path permanently revokes its possibly issued token'
);
select is(
  (select released_at from public.upload_byte_reservations
   where storage_path = 'e1000000-0000-4000-8000-000000000003/legacy-one.png'),
  null::timestamptz,
  'a rolling release never frees capacity while a token may still exist'
);
select throws_ok(
  $$insert into storage.objects (id, bucket_id, name, version, metadata, created_at)
    values ('a1000000-0000-4000-8000-000000000099', 'uploads',
      'e1000000-0000-4000-8000-000000000003/legacy-one.png', 'v1', '{}'::jsonb, now())$$,
  '42501', 'Upload path has been permanently revoked',
  'a rolling token cannot replay after conservative release'
);
select ok(not has_table_privilege(
  'service_role', 'public.upload_byte_reservations', 'INSERT'
), 'service role cannot bypass upload admission with a direct insert');
select ok(not has_table_privilege(
  'service_role', 'public.upload_byte_reservations', 'DELETE'
), 'service role cannot erase live capability bookkeeping');

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('e2000000-0000-4000-8000-000000000002', 'upload-delete@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);
select is(public.reserve_upload_bytes_v2(
  'f1000000-0000-4000-8000-000000000020',
  'e2000000-0000-4000-8000-000000000002',
  'profiles', 'e2000000-0000-4000-8000-000000000002/avatar.png',
  1, 5242880, 'image/png', 1073741824, 107374182400, 7200
) ->> 'reason', 'reserved', 'an active owner can reserve before deletion');
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, version, metadata, created_at)
    values ('a1000000-0000-4000-8000-000000000020', 'generation_inputs',
      'e2000000-0000-4000-8000-000000000002/untracked.png', 'v1', '{}'::jsonb, now())$$,
  'service-created owner media can exist without a reservation before deletion'
);
select is(public.mark_account_deleted_upload_reservations(
  array['e2000000-0000-4000-8000-000000000002'::uuid]
) ->> 'status', 'ok', 'account deletion blocks the owner before its Storage sweep');
select is((select finalization_status from public.upload_byte_reservations
  where id = 'f1000000-0000-4000-8000-000000000020'), 'deleted',
  'account deletion revokes every outstanding reservation');
select throws_ok(
  $$select public.reserve_upload_bytes_v2(
      'f1000000-0000-4000-8000-000000000021',
      'e2000000-0000-4000-8000-000000000002',
      'profiles', 'e2000000-0000-4000-8000-000000000002/cover.png',
      1, 5242880, 'image/png', 1073741824, 107374182400, 7200)$$,
  '42501', 'Upload owner is not active',
  'blocked owners cannot reserve during or after account deletion'
);
select throws_ok(
  $$insert into storage.objects (id, bucket_id, name, version, metadata, created_at)
    values ('a1000000-0000-4000-8000-000000000021', 'generation_inputs',
      'E2000000-0000-4000-8000-000000000002/late.png', 'v1', '{}'::jsonb, now())$$,
  '42501', 'Upload owner has been permanently blocked',
  'blocked owner checks compare UUIDs rather than case-sensitive path text'
);
select throws_ok(
  $$update storage.objects
    set name = 'e1000000-0000-4000-8000-000000000003/moved.png'
    where bucket_id = 'generation_inputs'
      and name = 'e2000000-0000-4000-8000-000000000002/untracked.png'$$,
  '42501', 'Upload owner has been permanently blocked',
  'objects cannot escape a blocked old owner through a prefix move'
);
select lives_ok(
  $$insert into storage.objects (id, bucket_id, name, version, metadata, created_at)
    values ('a1000000-0000-4000-8000-000000000030', 'generation_inputs',
      'e1000000-0000-4000-8000-000000000003/legitimate.png', 'v1', '{}'::jsonb, now())$$,
  'ordinary unreserved service output remains available to an active owner'
);

insert into public.upload_byte_reservations (
  id, user_id, bucket_id, storage_path, declared_bytes, reserved_bytes,
  expected_content_type, created_at, expires_at, issued_at,
  finalization_status, status_updated_at, reclaim_not_before,
  legacy_compatibility_mode
) values (
  'f1000000-0000-4000-8000-000000000030',
  'e1000000-0000-4000-8000-000000000003',
  'uploads', 'e1000000-0000-4000-8000-000000000003/reclaim.png',
  1, 262144000, 'image/png', now() - interval '3 hours',
  now() - interval '2 hours', now() - interval '3 hours',
  'reclaiming', now() - interval '20 minutes', now() - interval '1 minute', false
);
insert into storage.objects (id, bucket_id, name, version, metadata, created_at)
values ('a1000000-0000-4000-8000-000000000031', 'uploads',
  'e1000000-0000-4000-8000-000000000003/reclaim.png', 'v1', '{}'::jsonb, now());
insert into public.upload_path_tombstones (
  bucket_id, storage_path, upload_id, owner_user_id, reason
) values (
  'uploads', 'e1000000-0000-4000-8000-000000000003/reclaim.png',
  'f1000000-0000-4000-8000-000000000030',
  'e1000000-0000-4000-8000-000000000003', 'test_reclaim'
);
select throws_ok(
  $$update public.upload_byte_reservations
    set finalization_status = 'deleted', released_at = now(), status_updated_at = now()
    where id = 'f1000000-0000-4000-8000-000000000030'$$,
  '23514',
  'Deleted upload capacity cannot be released while Storage still contains the object',
  'database release fails closed while the staged object still exists'
);
-- The production worker removes this through the Storage API. The local
-- pgTAP fixture disables Storage's direct-delete guard only to model the API's
-- already-confirmed deletion before exercising the reservation transition.
set local session_replication_role = replica;
delete from storage.objects
where bucket_id = 'uploads'
  and name = 'e1000000-0000-4000-8000-000000000003/reclaim.png';
set local session_replication_role = origin;
select lives_ok(
  $$update public.upload_byte_reservations
    set finalization_status = 'deleted', released_at = now(), status_updated_at = now()
    where id = 'f1000000-0000-4000-8000-000000000030'$$,
  'a tombstoned stale reservation releases only after Storage proves absence'
);
select throws_ok(
  $$delete from public.upload_byte_reservations
    where id = 'f1000000-0000-4000-8000-000000000001'$$,
  '23514', 'Unreleased upload reservations cannot be deleted',
  'even database owners cannot erase unreleased capability bookkeeping'
);

select * from finish();
rollback;
