-- Mandatory rationale on subject-report decisions, plus the exact per-user
-- spend aggregate the admin console relies on.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

-- Ids must differ in their FIRST 8 hex characters: handle_new_user() derives a
-- username as `creator-<left(uuid without dashes, 8)>`.
insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('c1000001-1000-4000-8000-000000000001'::uuid, 'note-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('c1000002-1000-4000-8000-000000000002'::uuid, 'note-reviewer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.moderation_reports (id, reporter_user_id, target_type, reported_user_id, reason, source_surface)
values (
  'c1000003-1000-4000-8000-000000000003'::uuid,
  'c1000001-1000-4000-8000-000000000001'::uuid,
  'user',
  'c1000002-1000-4000-8000-000000000002'::uuid,
  'harassment',
  'creator-profile'
);

-- A decision without a rationale is refused -------------------------------

select throws_ok(
  $$select public.resolve_subject_report_for_ops(
      'c1000003-1000-4000-8000-000000000003'::uuid,
      'c1000002-1000-4000-8000-000000000002'::uuid,
      'resolve',
      null
    )$$,
  '22023',
  null,
  'a null rationale is rejected'
);

select throws_ok(
  $$select public.resolve_subject_report_for_ops(
      'c1000003-1000-4000-8000-000000000003'::uuid,
      'c1000002-1000-4000-8000-000000000002'::uuid,
      'resolve',
      '   '
    )$$,
  '22023',
  null,
  'a whitespace-only rationale is rejected'
);

select is(
  (select status from public.moderation_reports
   where id = 'c1000003-1000-4000-8000-000000000003'::uuid),
  'open',
  'a rejected decision leaves the report open'
);

-- The three-argument overload must be gone --------------------------------

select is(
  (select count(*)::integer from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'resolve_subject_report_for_ops'),
  1,
  'exactly one resolver signature exists, so no caller can skip the note'
);
-- Matched on the parameter rather than the full signature string:
-- pg_get_function_identity_arguments includes parameter names, so an exact
-- comparison breaks on a rename that changes nothing about the contract.
select ok(
  (select pg_get_function_identity_arguments(p.oid) from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_subject_report_for_ops')
  like '%p_resolution_note text%',
  'the surviving resolver takes a resolution note'
);

-- A valid decision persists the rationale ---------------------------------

select is(
  public.resolve_subject_report_for_ops(
    'c1000003-1000-4000-8000-000000000003'::uuid,
    'c1000002-1000-4000-8000-000000000002'::uuid,
    'resolve',
    'Confirmed harassment under policy 4.2; account restricted.'
  ) ->> 'status',
  'resolved',
  'a decision with a rationale resolves'
);
select is(
  (select resolution_note from public.moderation_reports
   where id = 'c1000003-1000-4000-8000-000000000003'::uuid),
  'Confirmed harassment under policy 4.2; account restricted.',
  'the rationale is stored on the report'
);
select is(
  (select reviewed_by from public.moderation_reports
   where id = 'c1000003-1000-4000-8000-000000000003'::uuid),
  'c1000002-1000-4000-8000-000000000002'::uuid,
  'the reviewer is recorded alongside the rationale'
);

-- Re-deciding a closed report is inert ------------------------------------

select is(
  public.resolve_subject_report_for_ops(
    'c1000003-1000-4000-8000-000000000003'::uuid,
    'c1000002-1000-4000-8000-000000000002'::uuid,
    'dismiss',
    'Second look, different call.'
  ) ->> 'status',
  'already_resolved',
  'an already-resolved report is not re-decided'
);
select is(
  (select resolution_note from public.moderation_reports
   where id = 'c1000003-1000-4000-8000-000000000003'::uuid),
  'Confirmed harassment under policy 4.2; account restricted.',
  'the original rationale is not overwritten'
);

-- Access control -----------------------------------------------------------

select ok(
  not has_function_privilege(
    'authenticated',
    'public.resolve_subject_report_for_ops(uuid, uuid, text, text)',
    'EXECUTE'
  ),
  'authenticated cannot resolve subject reports'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'public.get_user_ai_usage_cost_total(uuid)',
    'EXECUTE'
  ),
  'authenticated cannot read another user spend total'
);

-- Exact spend aggregate ----------------------------------------------------

insert into public.ai_usage_events (user_id, feature, provider, model, medium, cost, status, refunded)
select
  'c1000001-1000-4000-8000-000000000001'::uuid,
  'image', 'kie', 'test-model', 'image',
  10,
  'succeeded',
  false
from generate_series(1, 25);

insert into public.ai_usage_events (user_id, feature, provider, model, medium, cost, status, refunded)
values (
  'c1000001-1000-4000-8000-000000000001'::uuid,
  'image', 'kie', 'test-model', 'image', 999, 'succeeded', true
);

select is(
  (public.get_user_ai_usage_cost_total('c1000001-1000-4000-8000-000000000001'::uuid) ->> 'total_cost')::bigint,
  250::bigint,
  'spend sums every non-refunded event exactly'
);
select is(
  (public.get_user_ai_usage_cost_total('c1000001-1000-4000-8000-000000000001'::uuid) ->> 'refunded_count')::bigint,
  1::bigint,
  'refunded events are reported separately, not counted as spend'
);

select * from finish();

rollback;
