-- Local generation reservations must not consume provider in-flight capacity.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(5);

delete from public.generations;
delete from public.provider_admission_buckets where scope = 'pgtap-in-flight';
delete from public.provider_circuit_breakers where service = 'pgtap-in-flight';

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'e1000000-0000-4000-8000-000000000001'::uuid,
  'provider-in-flight@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

insert into public.generations (id, user_id, model, status, category, prompt)
select
  ('e2000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'e1000000-0000-4000-8000-000000000001'::uuid,
  'reservation-only',
  'pending',
  'image',
  'local reservation without provider work'
from generate_series(1, 50) AS series;

select is(
  (
    public.admit_provider_submission(
      'pgtap-in-flight', null, 100, 100, null, null, 1, 3600, 60, 60
    ) ->> 'allowed'
  )::boolean,
  true,
  'fifty local reservations do not self-reject a provider submission'
);

select is(
  public.admit_provider_submission(
    'pgtap-in-flight', null, 100, 100, null, null, 1, 3600, 60, 60
  ) ->> 'inFlight',
  '0',
  'plain pending reservations are reported as zero provider work'
);

update public.generations
set prediction_id = 'pgtap-task-attached'
where id = 'e2000000-0000-4000-8000-000000000001'::uuid;

update public.generations
set submission_unknown_at = now()
where id = 'e2000000-0000-4000-8000-000000000002'::uuid;

select is(
  public.admit_provider_submission(
    'pgtap-in-flight', null, 100, 100, null, null, 2, 3600, 60, 60
  ) ->> 'reason',
  'max_in_flight',
  'one attached and one ambiguous submission fill a two-task provider cap'
);

select is(
  public.admit_provider_submission(
    'pgtap-in-flight', null, 100, 100, null, null, 2, 3600, 60, 60
  ) ->> 'inFlight',
  '2',
  'ambiguous submissions are conservatively included with attached tasks'
);

select is(
  (
    public.admit_provider_submission(
      'pgtap-in-flight', null, 100, 100, null, null, 3, 3600, 60, 60
    ) ->> 'allowed'
  )::boolean,
  true,
  'capacity becomes available when the actual/ambiguous count is below the cap'
);

select * from finish();
rollback;
