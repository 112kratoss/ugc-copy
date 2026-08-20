-- State-machine and audit-integrity regressions for admin generation moderation
-- and contact triage.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  (
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'moderation-reviewer-one@example.invalid',
    'authenticated',
    'authenticated',
    '{}'::jsonb,
    '{}'::jsonb
  ),
  (
    'a2000002-1000-4000-8000-000000000002'::uuid,
    'moderation-reviewer-two@example.invalid',
    'authenticated',
    'authenticated',
    '{}'::jsonb,
    '{}'::jsonb
  );

insert into public.generations (id, user_id, status, is_public)
values
  (
    'b2000001-1000-4000-8000-000000000001'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'completed',
    true
  ),
  (
    'b2000002-1000-4000-8000-000000000002'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'completed',
    false
  ),
  (
    'b2000003-1000-4000-8000-000000000003'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'completed',
    true
  );

-- Access control -----------------------------------------------------------

select ok(
  not has_function_privilege(
    'authenticated',
    'public.apply_admin_generation_moderation(uuid, uuid, text, text, text)',
    'EXECUTE'
  ),
  'authenticated cannot moderate generations'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.apply_admin_generation_moderation(uuid, uuid, text, text, text)',
    'EXECUTE'
  ),
  'service role can moderate generations'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.set_contact_message_handled(uuid, uuid, boolean, text)',
    'EXECUTE'
  ),
  'authenticated cannot triage contact messages'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.set_contact_message_handled(uuid, uuid, boolean, text)',
    'EXECUTE'
  ),
  'service role can triage contact messages'
);

-- Generation transitions --------------------------------------------------

select is(
  public.apply_admin_generation_moderation(
    'b2000001-1000-4000-8000-000000000001'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'remove',
    'Confirmed policy violation.',
    'generation-remove-one'
  ) ->> 'status',
  'applied',
  'a legitimate removal applies'
);
select is(
  public.apply_admin_generation_moderation(
    'b2000001-1000-4000-8000-000000000001'::uuid,
    'a2000002-1000-4000-8000-000000000002'::uuid,
    'remove',
    'Stale duplicate removal.',
    'generation-remove-two'
  ) ->> 'status',
  'invalid',
  'a duplicate removal with a new key is rejected'
);
select is(
  (select count(*)::integer
   from public.admin_generation_moderation_actions
   where generation_id = 'b2000001-1000-4000-8000-000000000001'::uuid
     and action = 'remove'),
  1,
  'a duplicate removal writes no second audit row'
);
select is(
  public.apply_admin_generation_moderation(
    'b2000001-1000-4000-8000-000000000001'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'restore',
    'Removal overturned after review.',
    'generation-restore-one'
  ) ->> 'status',
  'applied',
  'a legitimate restore applies'
);
select is(
  (select is_public
   from public.generations
   where id = 'b2000001-1000-4000-8000-000000000001'::uuid),
  true,
  'restore recovers the original public state'
);
select is(
  (select archived_at is null
   from public.generations
   where id = 'b2000001-1000-4000-8000-000000000001'::uuid),
  true,
  'restore recovers the original archive state'
);
select is(
  public.apply_admin_generation_moderation(
    'b2000003-1000-4000-8000-000000000003'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'restore',
    'No removal exists.',
    'generation-invalid-restore'
  ) ->> 'status',
  'invalid',
  'restore without an active removal is rejected'
);
select is(
  (select count(*)::integer
   from public.admin_generation_moderation_actions
   where idempotency_key = 'generation-invalid-restore'),
  0,
  'an invalid restore writes no audit row'
);

-- Historical duplicate recovery ------------------------------------------

update public.generations
set moderation_removed_at = '2026-08-20T00:02:00Z'::timestamptz,
    moderation_removed_by = 'a2000002-1000-4000-8000-000000000002'::uuid,
    archived_at = '2026-08-20T00:01:00Z'::timestamptz,
    archived_by_user_id = 'a2000001-1000-4000-8000-000000000001'::uuid,
    is_public = false
where id = 'b2000002-1000-4000-8000-000000000002'::uuid;

insert into public.admin_generation_moderation_actions (
  id, generation_id, reviewer_id, action, reason,
  previous_archived_at, previous_is_public, idempotency_key, created_at
)
values
  (
    'c1000001-1000-4000-8000-000000000001'::uuid,
    'b2000002-1000-4000-8000-000000000002'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'remove',
    'Earlier completed-cycle removal.',
    null,
    false,
    'historical-earlier-remove',
    '2026-08-19T23:58:00Z'::timestamptz
  ),
  (
    'c1000002-1000-4000-8000-000000000002'::uuid,
    'b2000002-1000-4000-8000-000000000002'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'restore',
    'Earlier cycle completed.',
    null,
    null,
    'historical-earlier-restore',
    '2026-08-19T23:59:00Z'::timestamptz
  ),
  (
    'c2000001-1000-4000-8000-000000000001'::uuid,
    'b2000002-1000-4000-8000-000000000002'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'remove',
    'Original removal.',
    null,
    true,
    'historical-remove-one',
    '2026-08-20T00:01:00Z'::timestamptz
  ),
  (
    'c2000002-1000-4000-8000-000000000002'::uuid,
    'b2000002-1000-4000-8000-000000000002'::uuid,
    'a2000002-1000-4000-8000-000000000002'::uuid,
    'remove',
    'Historical duplicate.',
    '2026-08-20T00:01:00Z'::timestamptz,
    false,
    'historical-remove-two',
    '2026-08-20T00:02:00Z'::timestamptz
  );

select is(
  public.apply_admin_generation_moderation(
    'b2000002-1000-4000-8000-000000000002'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    'restore',
    'Repair historical duplicate.',
    'historical-restore'
  ) ->> 'status',
  'applied',
  'a historical duplicate removal can be restored'
);
select is(
  (select is_public
   from public.generations
   where id = 'b2000002-1000-4000-8000-000000000002'::uuid),
  true,
  'historical recovery uses the original public state'
);
select is(
  (select archived_at is null
   from public.generations
   where id = 'b2000002-1000-4000-8000-000000000002'::uuid),
  true,
  'historical recovery uses the original archive state'
);

-- Contact triage attribution ----------------------------------------------

insert into public.contact_messages (id, name, email, subject, message)
values (
  'd2000001-1000-4000-8000-000000000001'::uuid,
  'Fixture',
  'fixture@example.invalid',
  'Audit check',
  'Verify replay attribution.'
);

select is(
  public.set_contact_message_handled(
    'd2000001-1000-4000-8000-000000000001'::uuid,
    'a2000001-1000-4000-8000-000000000001'::uuid,
    true,
    'First operator note.'
  ) ->> 'status',
  'applied',
  'a legitimate handle applies'
);
select is(
  public.set_contact_message_handled(
    'd2000001-1000-4000-8000-000000000001'::uuid,
    'a2000002-1000-4000-8000-000000000002'::uuid,
    true,
    'Stale operator note.'
  ) ->> 'status',
  'applied',
  'a repeated handle is an inert replay'
);
select is(
  (select handled_by
   from public.contact_messages
   where id = 'd2000001-1000-4000-8000-000000000001'::uuid),
  'a2000001-1000-4000-8000-000000000001'::uuid,
  'a repeated handle preserves the original reviewer'
);
select is(
  (select handled_note
   from public.contact_messages
   where id = 'd2000001-1000-4000-8000-000000000001'::uuid),
  'First operator note.',
  'a repeated handle preserves the original note'
);
select is(
  public.set_contact_message_handled(
    'd2000001-1000-4000-8000-000000000001'::uuid,
    'a2000002-1000-4000-8000-000000000002'::uuid,
    false,
    null
  ) ->> 'status',
  'applied',
  'a legitimate reopen applies'
);
select is(
  (select handled_at is null
   from public.contact_messages
   where id = 'd2000001-1000-4000-8000-000000000001'::uuid),
  true,
  'reopen clears the handled state'
);
select is(
  public.set_contact_message_handled(
    'd2000001-1000-4000-8000-000000000001'::uuid,
    'a2000002-1000-4000-8000-000000000002'::uuid,
    true,
    'Second legitimate cycle.'
  ) ->> 'status',
  'applied',
  'handling after a reopen starts a new cycle'
);
select is(
  (select handled_by
   from public.contact_messages
   where id = 'd2000001-1000-4000-8000-000000000001'::uuid),
  'a2000002-1000-4000-8000-000000000002'::uuid,
  'the new cycle records its reviewer'
);
select is(
  (select handled_note
   from public.contact_messages
   where id = 'd2000001-1000-4000-8000-000000000001'::uuid),
  'Second legitimate cycle.',
  'the new cycle records its note'
);

select * from finish();

rollback;
