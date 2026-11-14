-- The waiting line in front of provider admission.
--
-- A start over the limit waits its turn instead of failing. What decides
-- whether that is a queue or a scramble is the order: a start may be admitted
-- only when there is a place for it and one for every live ticket older than
-- its own. Each rule of that order is exercised here against real rows.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(32);

delete from public.generations;
delete from public.provider_admission_buckets where scope like 'pgtap-line%';
delete from public.provider_circuit_breakers where service like 'pgtap-line%';

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values (
  'e1000000-0000-4000-8000-000000000003'::uuid,
  'provider-line@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now()
);

insert into public.generations (id, user_id, model, status, category, prompt)
select
  ('e3000000-0000-4000-8000-' || lpad(series::text, 12, '0'))::uuid,
  'e1000000-0000-4000-8000-000000000003'::uuid,
  'line-test', 'pending', 'image', 'waiting line fixture'
from generate_series(1, 20) as series;

-- One ask by generation number. A window of one makes every admission fill it.
create function pg_temp.ask(
  gen integer,
  waits boolean default true,
  svc text default 'pgtap-line',
  mdl text default null,
  rate_max integer default 1,
  model_max integer default null,
  flight_max integer default 1000
) returns jsonb language sql as $$
  select public.reserve_provider_submission(
    ('e3000000-0000-4000-8000-' || lpad(gen::text, 12, '0'))::uuid, svc, mdl,
    p_max_in_flight => flight_max,
    p_rate_window_max => rate_max,
    p_model_rate_window_max => model_max,
    p_wait => waits
  )
$$;

create function pg_temp.gen(n integer) returns uuid language sql as $$
  select ('e3000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- ─── Taking a ticket ─────────────────────────────────────────────────────────

select is(pg_temp.ask(1) ->> 'reason', 'admitted', 'with nobody waiting, a start is admitted as before');

select is(pg_temp.ask(2) ->> 'reason', 'rate_limited', 'a start over the limit is refused for the place it lacks');

select is((pg_temp.ask(2) ->> 'waiting')::boolean, true, 'and told it is waiting in line');

select is(
  (select reason from public.provider_submission_waiters where generation_id = pg_temp.gen(2)),
  'rate_limited',
  'it holds a ticket that says what it waits for'
);

select is((pg_temp.ask(3, false) ->> 'waiting')::boolean, false, 'a start that does not wait is refused outright');

select is(
  (select count(*)::int from public.provider_submission_waiters where generation_id = pg_temp.gen(3)),
  0,
  'and takes no ticket, so a run step that comes back later holds nobody up meanwhile'
);

-- ─── First come, first served ────────────────────────────────────────────────

-- A place opens. The start that has been waiting has not asked yet.
update public.provider_admission_buckets set admitted_at = '{}' where scope = 'pgtap-line';

select is(pg_temp.ask(4) ->> 'reason', 'rate_limited', 'a newcomer cannot take the place a waiting start is in line for');

select is((pg_temp.ask(4) ->> 'waitersAhead')::int, 1, 'it is told how many are ahead of it');

select is(pg_temp.ask(3, false) ->> 'reason', 'rate_limited', 'a start that does not wait is held behind the line too');

select is(pg_temp.ask(2) ->> 'reason', 'admitted', 'the place goes to the start that waited longest');

select ok(
  (select count(*) = 0 from public.provider_submission_waiters where generation_id = pg_temp.gen(2))
    and (select provider_submission_reserved_at is not null from public.generations where id = pg_temp.gen(2)),
  'an admitted start gives up its ticket for a reservation'
);

select is(pg_temp.ask(4) ->> 'reason', 'rate_limited', 'the next in line waits for the next place');

update public.provider_admission_buckets set admitted_at = '{}' where scope = 'pgtap-line';

select is(pg_temp.ask(4) ->> 'reason', 'admitted', 'and gets it');

-- ─── A ticket is stamped once ────────────────────────────────────────────────

select pg_temp.ask(5);
create temp table pgtap_first_ask as
  select waiting_since, seen_at from public.provider_submission_waiters where generation_id = pg_temp.gen(5);
select pg_temp.ask(5);

select is(
  (select waiting_since from public.provider_submission_waiters where generation_id = pg_temp.gen(5)),
  (select waiting_since from pgtap_first_ask),
  'asking again does not move a start back in the line'
);

select ok(
  (select seen_at from public.provider_submission_waiters where generation_id = pg_temp.gen(5))
    > (select seen_at from pgtap_first_ask),
  'it only shows the start is still there'
);

-- ─── Who is still in line ────────────────────────────────────────────────────

-- The request behind ticket 5 died: nothing has asked on it for twenty seconds.
update public.provider_submission_waiters set seen_at = now() - interval '20 seconds'
where generation_id = pg_temp.gen(5);
update public.provider_admission_buckets set admitted_at = '{}' where scope = 'pgtap-line';

select is(pg_temp.ask(6) ->> 'reason', 'admitted', 'a ticket nobody asks on holds no place');

-- It was only slow. It asks again, is alive again, and is the oldest in line.
select pg_temp.ask(5);
-- Then its wait runs out: the app settles the start as failed and refunds it.
update public.generations set status = 'failed' where id = pg_temp.gen(5);
update public.provider_admission_buckets set admitted_at = '{}' where scope = 'pgtap-line';

select is(pg_temp.ask(7) ->> 'reason', 'admitted', 'a start that gave up leaves the line at once');

update public.provider_submission_waiters set seen_at = now() - interval '5 minutes'
where generation_id = pg_temp.gen(5);
select pg_temp.ask(8);

select is(
  (select count(*)::int from public.provider_submission_waiters where generation_id = pg_temp.gen(5)),
  0,
  'a ticket long dead is removed by the next reservation, so the table stays the size of the line'
);

-- ─── A model's share ─────────────────────────────────────────────────────────
--
-- An account window of two, one of them at most for each model.

select is(pg_temp.ask(9, true, 'pgtap-line-model', 'm1', 2, 1) ->> 'reason', 'admitted', 'a model within its share is admitted');

select is(
  pg_temp.ask(10, true, 'pgtap-line-model', 'm1', 2, 1) ->> 'reason',
  'model_rate_limited',
  'a second start on it waits for the model, not for the account'
);

select is(
  pg_temp.ask(11, true, 'pgtap-line-model', 'm2', 2, 1) ->> 'reason',
  'admitted',
  'so it does not hold the account''s last place against another model'
);

update public.provider_admission_buckets set admitted_at = '{}'
where scope in ('pgtap-line-model', 'pgtap-line-model:m1');

select is(
  pg_temp.ask(12, true, 'pgtap-line-model', 'm1', 2, 1) ->> 'reason',
  'model_rate_limited',
  'a newcomer on the same model is behind the start already waiting for it'
);

select is(pg_temp.ask(10, true, 'pgtap-line-model', 'm1', 2, 1) ->> 'reason', 'admitted', 'which gets the model''s place');

-- ─── The in-flight cap ───────────────────────────────────────────────────────

create temp table pgtap_in_flight as
  select count(*)::int as n from public.generations
  where status in ('pending', 'waiting', 'processing') and provider_submission_reserved_at is not null;

select is(
  pg_temp.ask(13, true, 'pgtap-line-flight', null, 100, null, (select n from pgtap_in_flight)) ->> 'reason',
  'max_in_flight',
  'with every slot running, a start waits for one to finish'
);

-- One task finishes: the cap now has one slot, and two starts want it.
select is(
  pg_temp.ask(14, true, 'pgtap-line-flight', null, 100, null, (select n + 1 from pgtap_in_flight)) ->> 'reason',
  'max_in_flight',
  'the freed slot is not the newcomer''s'
);

select is(
  pg_temp.ask(13, true, 'pgtap-line-flight', null, 100, null, (select n + 1 from pgtap_in_flight)) ->> 'reason',
  'admitted',
  'it is the waiting start''s'
);

-- ─── The breaker ─────────────────────────────────────────────────────────────

select pg_temp.ask(15, true, 'pgtap-line-breaker');
select pg_temp.ask(16, true, 'pgtap-line-breaker');
select public.record_provider_submission_outcome('pgtap-line-breaker', false, 1, 60, null);

select is(
  pg_temp.ask(16, true, 'pgtap-line-breaker') ->> 'reason',
  'circuit_open',
  'while the provider is failing, a waiting start is told so instead of kept in line'
);

select is(
  (select count(*)::int from public.provider_submission_waiters where generation_id = pg_temp.gen(16)),
  0,
  'and its ticket is gone: no place in line clears an outage'
);

-- ─── The deployment before the line ──────────────────────────────────────────

select is(
  public.reserve_provider_submission(
    pg_temp.gen(17), 'pgtap-line-old', 'm1',
    p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 18, p_model_rate_window_max => 12
  ) ->> 'reason',
  'admitted',
  'a call that names neither new argument still resolves'
);

-- ─── Who may touch the line ──────────────────────────────────────────────────

select ok(
  not has_table_privilege('anon', 'public.provider_submission_waiters', 'SELECT')
    and not has_table_privilege('authenticated', 'public.provider_submission_waiters', 'SELECT')
    and not has_table_privilege('authenticated', 'public.provider_submission_waiters', 'INSERT')
    and has_table_privilege('service_role', 'public.provider_submission_waiters', 'DELETE'),
  'the line is the service role''s alone'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.provider_submission_waiters'::regclass),
  true,
  'and row security is on'
);

select is(
  (select jsonb_agg(jsonb_build_object(
      'anon', has_function_privilege('anon', p.oid, 'execute'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
      'service_role', has_function_privilege('service_role', p.oid, 'execute')
    ))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'reserve_provider_submission'),
  '[{"anon": false, "authenticated": false, "service_role": true}]'::jsonb,
  'the reservation has one candidate, and only the service role may call it'
);

select * from finish();
rollback;
