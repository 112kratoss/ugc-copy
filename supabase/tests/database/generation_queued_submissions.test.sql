-- The queue of generation starts waiting to be sent to the provider.
--
-- A queued start is a held generation with its provider request stored. Two
-- things have to hold for it to be sent once or refunded once: only a start
-- that has reached nothing may be queued, and its request can be taken out of
-- the queue by exactly one caller. Both are exercised here against real rows.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(34);

delete from public.generations;
delete from public.provider_admission_buckets where scope like 'pgtap-queue%';
delete from public.provider_circuit_breakers where service like 'pgtap-queue%';

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
values
  ('e1000000-0000-4000-8000-000000000004'::uuid, 'queue-one@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now()),
  ('e1000000-0000-4000-8000-000000000005'::uuid, 'queue-two@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now());

create function pg_temp.gen(n integer) returns uuid language sql as $$
  select ('e4000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

-- Generations 1 to 6 are the first creator's, 7 to 16 the second's.
insert into public.generations (id, user_id, model, status, category, prompt)
select
  pg_temp.gen(series),
  case when series <= 6 then 'e1000000-0000-4000-8000-000000000004'::uuid
       else 'e1000000-0000-4000-8000-000000000005'::uuid end,
  'queue-test', 'pending', 'image', 'queue fixture'
from generate_series(1, 16) as series;

create function pg_temp.enqueue(
  n integer,
  svc text default 'pgtap-queue',
  queue_max integer default 200,
  user_max integer default 4,
  mdl text default 'queue-model'
) returns jsonb language sql as $$
  select public.enqueue_provider_submission(
    pg_temp.gen(n), svc, mdl, 'https://api.kie.ai/api/v1/jobs/createTask',
    jsonb_build_object('model', 'queue-model', 'input', jsonb_build_object('prompt', 'request ' || n)),
    queue_max, user_max
  )
$$;

-- One ask of the gate for a generation's turn, as a start or a queue pass makes it.
create function pg_temp.ask(
  n integer,
  svc text,
  mdl text default 'queue-model',
  rate_max integer default 1,
  model_max integer default null,
  turn_since timestamptz default null
) returns jsonb language sql as $$
  select public.reserve_provider_submission(
    pg_temp.gen(n), svc, mdl,
    p_max_in_flight => 1000,
    p_rate_window_max => rate_max,
    p_model_rate_window_max => model_max,
    p_turn_since => turn_since
  )
$$;

-- ─── Queueing ────────────────────────────────────────────────────────────────

select is(pg_temp.enqueue(1) ->> 'status', 'queued', 'a held start that has reached nothing is queued');

select is(
  (select request #>> '{input,prompt}' from public.generation_queued_submissions where generation_id = pg_temp.gen(1)),
  'request 1',
  'with the provider request it would have sent'
);

select is(
  (select user_id from public.generation_queued_submissions where generation_id = pg_temp.gen(1)),
  'e1000000-0000-4000-8000-000000000004'::uuid,
  'and its creator, taken from the generation, not from the caller'
);

create temp table pgtap_first_queue as
  select queued_at from public.generation_queued_submissions where generation_id = pg_temp.gen(1);

select is((pg_temp.enqueue(1) ->> 'replayed')::boolean, true, 'queued twice, it is the same queued start');

select ok(
  (select count(*) = 1 and min(queued_at) = (select queued_at from pgtap_first_queue)
   from public.generation_queued_submissions where generation_id = pg_temp.gen(1)),
  'which keeps its place and its request'
);

select is(
  public.enqueue_provider_submission(
    'e4000000-0000-4000-8000-00000000ffff'::uuid, 'pgtap-queue', null, 'https://example.invalid', '{}'::jsonb
  ) ->> 'status',
  'missing',
  'a generation that does not exist is not queued'
);

select is(
  public.enqueue_provider_submission(pg_temp.gen(2), 'pgtap-queue', null, 'https://example.invalid', '[1]'::jsonb) ->> 'status',
  'invalid_request',
  'nor is one whose request is not a provider request'
);

-- A start the gate admitted is on its way: it holds a reservation.
update public.generations set provider_submission_reserved_at = now() where id = pg_temp.gen(2);
insert into public.provider_submission_waiters (generation_id, service, waiting_since, seen_at, reason)
values (pg_temp.gen(2), 'pgtap-queue', now(), now(), 'rate_limited');

select is(pg_temp.enqueue(2) ->> 'status', 'not_queueable', 'a start that is already on its way to the provider is not queued');

select is(
  pg_temp.enqueue(2) -> 'onItsWay',
  'false'::jsonb,
  'a reservation alone does not say it was sent: the reservation may be the start''s own'
);

select is(
  (select count(*)::int from public.provider_submission_waiters where generation_id = pg_temp.gen(2)),
  0,
  'and a start the queue would not take holds no place in the line'
);

-- ─── The queue's length ──────────────────────────────────────────────────────

select is(pg_temp.enqueue(3, 'pgtap-queue', 200, 2) ->> 'status', 'queued', 'a creator may have a second start waiting');

select is(
  pg_temp.enqueue(4, 'pgtap-queue', 200, 2) ->> 'status',
  'user_queue_full',
  'but not more than their share of the queue'
);

select is(
  pg_temp.enqueue(7, 'pgtap-queue', 200, 2) ->> 'status',
  'queued',
  'which is theirs alone: another creator is queued beside them'
);

select is(
  pg_temp.enqueue(8, 'pgtap-queue', 3, 4) ->> 'status',
  'queue_full',
  'the queue as a whole has a length too'
);

select is(
  (select count(*)::int from public.generation_queued_submissions where generation_id in (pg_temp.gen(4), pg_temp.gen(8))),
  0,
  'a refused start leaves no request behind'
);

-- Start 3 was settled by something that did not claim it (the reaper, say).
update public.generations set status = 'failed' where id = pg_temp.gen(3);

select is(
  (select count(*)::int from public.generation_queued_submissions where generation_id = pg_temp.gen(3)),
  0,
  'a queued start settled behind the queue''s back loses its request with its status, at once'
);

select is(
  pg_temp.enqueue(8, 'pgtap-queue', 3, 4) ->> 'status',
  'queued',
  'and holds no place in the queue'
);

-- ─── Claiming ────────────────────────────────────────────────────────────────

insert into public.provider_submission_waiters (generation_id, service, waiting_since, seen_at, reason)
values (pg_temp.gen(1), 'pgtap-queue', now(), now(), 'rate_limited');

create temp table pgtap_first_claim as
  select public.claim_queued_provider_submission(pg_temp.gen(1)) as claim;

select is(
  (select claim #>> '{request,input,prompt}' from pgtap_first_claim),
  'request 1',
  'the first caller to claim a queued start is handed its request'
);

select is(
  (select claim -> 'sendable' from pgtap_first_claim),
  'true'::jsonb,
  'and told the generation still holds its credits and may be sent'
);

select is(
  public.claim_queued_provider_submission(pg_temp.gen(1)),
  null::jsonb,
  'every caller after it is handed nothing, so the start is sent once'
);

select is(
  (select count(*)::int from public.provider_submission_waiters where generation_id = pg_temp.gen(1)),
  0,
  'a claimed start waits in line no longer'
);

-- Start 8 was marked "submission unknown" while its row waited: its hold is
-- spoken for, and it stays pending.
update public.generations set submission_unknown_at = now() where id = pg_temp.gen(8);

select is(
  public.claim_queued_provider_submission(pg_temp.gen(8)) -> 'sendable',
  'false'::jsonb,
  'a claimed start whose generation is no longer one to send is handed back to be dropped, not sent'
);

delete from public.generations where id = pg_temp.gen(7);

select is(
  (select count(*)::int from public.generation_queued_submissions where generation_id = pg_temp.gen(7)),
  0,
  'a deleted generation takes its queued request with it'
);

-- ─── The queue is the line ───────────────────────────────────────────────────
--
-- A queued start has no heartbeat: it is in the line for as long as it is in
-- the queue, whether or not anything is asking for it.

select pg_temp.ask(9, 'pgtap-queue-line');
select pg_temp.enqueue(10, 'pgtap-queue-line');
update public.provider_admission_buckets set admitted_at = '{}' where scope = 'pgtap-queue-line';

select is(
  pg_temp.ask(11, 'pgtap-queue-line') ->> 'reason',
  'rate_limited',
  'a new start cannot take the place a queued start is waiting for, though nothing is asking for it'
);

select is((pg_temp.ask(11, 'pgtap-queue-line') ->> 'waitersAhead')::int, 1, 'it is told how many are queued ahead of it');

select is(
  pg_temp.ask(10, 'pgtap-queue-line') ->> 'reason',
  'admitted',
  'the queued start has the turn its place in the queue gives it, with nobody saying when it was queued'
);

-- One model's queued starts are held to that model's share. They do not hold
-- the account's other places against another model.
select pg_temp.ask(12, 'pgtap-queue-model', 'm1', 2, 1);
select pg_temp.enqueue(13, 'pgtap-queue-model', 200, 4, 'm1');

select is(
  pg_temp.ask(14, 'pgtap-queue-model', 'm2', 2, 1) ->> 'reason',
  'admitted',
  'a model''s backlog in the queue does not keep another model out of the account''s places'
);

-- A callback attached a task to start 13 while it waited: it is running.
update public.generations set status = 'processing', prediction_id = 'pgtap-queue-task-13' where id = pg_temp.gen(13);

select is(
  (select count(*)::int from public.generation_queued_submissions where generation_id = pg_temp.gen(13)),
  0,
  'a queued start that got its task by another road is out of the queue'
);

select is(
  pg_temp.enqueue(13, 'pgtap-queue-model', 200, 4, 'm1') -> 'onItsWay',
  'true'::jsonb,
  'and a start asked about again once it has its task is told it is on its way'
);

-- A queued start past its time is owed no place. One nothing is driving (the
-- code rolled back to a deployment that knows no queue) must not stand ahead
-- of every start until the reaper ends it.
select pg_temp.enqueue(15, 'pgtap-queue-old');
update public.generation_queued_submissions set queued_at = now() - interval '14 minutes'
where generation_id = pg_temp.gen(15);

select is(
  pg_temp.ask(16, 'pgtap-queue-old') ->> 'reason',
  'rate_limited',
  'a start still inside the queue''s time keeps its place however long nothing has asked for it'
);

update public.generation_queued_submissions set queued_at = now() - interval '16 minutes'
where generation_id = pg_temp.gen(15);

select is(
  pg_temp.ask(16, 'pgtap-queue-old') ->> 'reason',
  'admitted',
  'one queued past it holds the gate against nobody'
);

-- A run step is not queued. Its turn is when it was first turned away.
select pg_temp.ask(5, 'pgtap-queue-step');
select pg_temp.enqueue(6, 'pgtap-queue-step');
update public.provider_admission_buckets set admitted_at = '{}' where scope = 'pgtap-queue-step';

select is(
  pg_temp.ask(4, 'pgtap-queue-step', 'queue-model', 1, null, now() - interval '10 minutes') ->> 'reason',
  'admitted',
  'a run step first turned away before a start was queued goes ahead of it'
);

-- ─── Who may touch the queue ─────────────────────────────────────────────────

select ok(
  not has_table_privilege('anon', 'public.generation_queued_submissions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.generation_queued_submissions', 'SELECT')
    and not has_table_privilege('authenticated', 'public.generation_queued_submissions', 'INSERT')
    and has_table_privilege('service_role', 'public.generation_queued_submissions', 'DELETE')
    and (select relrowsecurity from pg_class where oid = 'public.generation_queued_submissions'::regclass),
  'the queue, and the requests in it, are the service role''s alone'
);

select is(
  (select jsonb_agg(jsonb_build_object(
      'name', p.proname,
      'anon', has_function_privilege('anon', p.oid, 'execute'),
      'authenticated', has_function_privilege('authenticated', p.oid, 'execute'),
      'service_role', has_function_privilege('service_role', p.oid, 'execute')
    ) order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('enqueue_provider_submission', 'claim_queued_provider_submission',
                       'drop_queued_submission_of_settled_generation')),
  '[{"name": "claim_queued_provider_submission", "anon": false, "authenticated": false, "service_role": true},
    {"name": "drop_queued_submission_of_settled_generation", "anon": false, "authenticated": false, "service_role": true},
    {"name": "enqueue_provider_submission", "anon": false, "authenticated": false, "service_role": true}]'::jsonb,
  'and so are the functions that put a start in it, take one out, and clear one whose generation settled'
);

select * from finish();
rollback;
