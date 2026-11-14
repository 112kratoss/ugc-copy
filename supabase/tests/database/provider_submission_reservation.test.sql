begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

delete from public.generations;
delete from public.provider_admission_buckets where scope like 'pgtap-reservation%';
delete from public.provider_circuit_breakers where service = 'pgtap-reservation';

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  'e1000000-0000-4000-8000-000000000002'::uuid,
  'provider-reservation@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb
);

insert into public.generations (id, user_id, model, status, category, prompt)
values
  ('e2000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000002', 'reservation-test', 'pending', 'image', 'one'),
  ('e2000000-0000-4000-8000-000000000012', 'e1000000-0000-4000-8000-000000000002', 'reservation-test', 'pending', 'image', 'two');

select is(
  public.reserve_provider_submission(
    'e2000000-0000-4000-8000-000000000011', 'pgtap-reservation', null,
    100, 100, null, null, 1, 3600, 60, 60
  ) ->> 'reason',
  'admitted',
  'the first local generation atomically reserves provider capacity'
);

select ok(
  (select provider_submission_reserved_at is not null from public.generations
   where id = 'e2000000-0000-4000-8000-000000000011'),
  'the admitted generation stores a durable reservation'
);

select is(
  public.reserve_provider_submission(
    'e2000000-0000-4000-8000-000000000012', 'pgtap-reservation', null,
    100, 100, null, null, 1, 3600, 60, 60
  ) ->> 'reason',
  'max_in_flight',
  'a second generation cannot pass the same one-slot capacity check'
);

select is(
  (select provider_submission_reserved_at::text from public.generations
   where id = 'e2000000-0000-4000-8000-000000000012'),
  null,
  'a rejected generation does not retain a slot'
);

select is(
  public.reserve_provider_submission(
    'e2000000-0000-4000-8000-000000000011', 'pgtap-reservation', null,
    100, 100, null, null, 1, 3600, 60, 60
  ) ->> 'reason',
  'admitted',
  'replaying the same generation reuses its slot'
);

update public.generations
set status = 'succeeded'
where id = 'e2000000-0000-4000-8000-000000000011';

select is(
  public.reserve_provider_submission(
    'e2000000-0000-4000-8000-000000000012', 'pgtap-reservation', null,
    100, 100, null, null, 1, 3600, 60, 60
  ) ->> 'reason',
  'admitted',
  'terminal generations release capacity without a cleanup race'
);

-- The app reserves, it never calls the admission directly, so a model's share
-- only exists if the reservation hands it on.
insert into public.generations (id, user_id, model, status, category, prompt)
values
  ('e2000000-0000-4000-8000-000000000013', 'e1000000-0000-4000-8000-000000000002', 'reservation-test', 'pending', 'image', 'three'),
  ('e2000000-0000-4000-8000-000000000014', 'e1000000-0000-4000-8000-000000000002', 'reservation-test', 'pending', 'image', 'four');

select is(
  public.reserve_provider_submission(
    'e2000000-0000-4000-8000-000000000013', 'pgtap-reservation-share', 'shared-model',
    p_max_in_flight => 1000, p_rate_window_max => 100, p_model_rate_window_max => 1
  ) ->> 'reason',
  'admitted',
  'a reservation is admitted inside its model''s share'
);

select is(
  public.reserve_provider_submission(
    'e2000000-0000-4000-8000-000000000014', 'pgtap-reservation-share', 'shared-model',
    p_max_in_flight => 1000, p_rate_window_max => 100, p_model_rate_window_max => 1
  ) ->> 'reason',
  'model_rate_limited',
  'the reservation hands the model''s share on to the admission'
);

select is(
  (select provider_submission_reserved_at::text from public.generations
   where id = 'e2000000-0000-4000-8000-000000000014'),
  null,
  'a generation its model''s share refused does not retain a slot'
);

select has_index(
  'public', 'generations', 'generations_provider_submission_reserved_idx',
  'active provider reservations have a supporting partial index'
);

select * from finish();
rollback;
