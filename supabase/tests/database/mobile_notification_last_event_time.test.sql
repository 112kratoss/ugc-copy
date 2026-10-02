-- An alert's place and age in the inbox follow its last event: its arrival, or
-- the latest event grouped into it. Reading it, and the bookkeeping that
-- follows a push, are writes to its row and not events.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(19);

insert into auth.users (id, email, aud, role, is_anonymous, created_at)
values ('e7100001-0000-4000-8000-000000000001', 'last-event-1@example.invalid', 'authenticated', 'authenticated', false, now());
insert into auth.sessions (id, user_id, created_at, updated_at)
values ('e7200000-0000-4000-8000-000000000001', 'e7100001-0000-4000-8000-000000000001', now(), now());

-- Three alerts that arrived on three different days, all long before this
-- transaction. Inside one transaction now() never moves, so only a row from
-- the past can show that a write changed its time.
insert into public.mobile_notifications (id, user_id, type, category, title, body, created_at, updated_at, last_event_at) values
  ('e7300000-0000-4000-8000-000000000003', 'e7100001-0000-4000-8000-000000000001', 'generation_succeeded', 'generation', 'newest', 'Local only', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z'),
  ('e7300000-0000-4000-8000-000000000002', 'e7100001-0000-4000-8000-000000000001', 'generation_succeeded', 'generation', 'middle', 'Local only', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'),
  ('e7300000-0000-4000-8000-000000000001', 'e7100001-0000-4000-8000-000000000001', 'generation_succeeded', 'generation', 'oldest', 'Local only', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

-- The inbox route's order.
prepare inbox as
  select title from public.mobile_notifications
  where user_id = 'e7100001-0000-4000-8000-000000000001'
  order by last_event_at desc, id desc;

select col_not_null('public', 'mobile_notifications', 'last_event_at', 'every alert has a last event');
select ok(exists(
  select 1 from pg_indexes
  where schemaname = 'public' and tablename = 'mobile_notifications'
    and indexdef like '%(user_id, last_event_at DESC, id DESC)%'
), 'the inbox order has an index');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e7100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e7200000-0000-4000-8000-000000000001","is_anonymous":false}', true);

select results_eq('inbox', $$ values ('newest'), ('middle'), ('oldest') $$, 'the inbox starts newest first');

-- One alert read: the write the read route makes.
select lives_ok($$ update public.mobile_notifications set is_read = true where id = 'e7300000-0000-4000-8000-000000000001' $$, 'the owner reads the oldest alert');
select is((select last_event_at from public.mobile_notifications where id = 'e7300000-0000-4000-8000-000000000001'), '2026-01-01T00:00:00Z'::timestamptz, 'reading an alert leaves its last event where it was');
select isnt((select updated_at from public.mobile_notifications where id = 'e7300000-0000-4000-8000-000000000001'), '2026-01-01T00:00:00Z'::timestamptz, 'the same write stamps updated_at, which is why the inbox does not read it');
select results_eq('inbox', $$ values ('newest'), ('middle'), ('oldest') $$, 'a read alert keeps its place');

-- Every alert read: the write the read-all route makes.
select lives_ok($$ update public.mobile_notifications set is_read = true where user_id = 'e7100001-0000-4000-8000-000000000001' and is_read = false $$, 'the owner marks every alert read');
select results_eq('inbox', $$ values ('newest'), ('middle'), ('oldest') $$, 'marking every alert read keeps each in its place');
select is((select count(distinct last_event_at) from public.mobile_notifications where user_id = 'e7100001-0000-4000-8000-000000000001'), 3::bigint, 'and leaves each alert its own time');

select throws_ok($$ update public.mobile_notifications set last_event_at = now() where id = 'e7300000-0000-4000-8000-000000000001' $$, '42501', null, 'an owner cannot move an alert by hand');

-- The write that follows a push send.
reset role;
set local role service_role;
select lives_ok($$ update public.mobile_notifications set pushed_at = now(), push_ticket_id = 'ticket-1' where id = 'e7300000-0000-4000-8000-000000000002' $$, 'the push send records its ticket on the alert');
select is((select last_event_at from public.mobile_notifications where id = 'e7300000-0000-4000-8000-000000000002'), '2026-01-02T00:00:00Z'::timestamptz, 'push bookkeeping leaves the last event where it was');

-- A grouped alert. Its first event is an arrival like any other.
select is((public.upsert_mobile_notification('e7100001-0000-4000-8000-000000000001', null, 'post_saved', 'social', 'grouped', 'Local only', null, 'post', 'post-1', null, 'last-event-fixture-group') ->> 'wasCreated')::boolean, true, 'the first event of a group creates the alert');
select is((select last_event_at from public.mobile_notifications where aggregation_key = 'last-event-fixture-group'), (select created_at from public.mobile_notifications where aggregation_key = 'last-event-fixture-group'), 'a new alert''s last event is its arrival');

-- The group is set back into the past, older than every other alert, and read,
-- so that its second event has somewhere to move it from.
reset role;
update public.mobile_notifications
set created_at = '2025-12-31T00:00:00Z', last_event_at = '2025-12-31T00:00:00Z', is_read = true
where aggregation_key = 'last-event-fixture-group';
select results_eq('inbox', $$ values ('newest'), ('middle'), ('oldest'), ('grouped') $$, 'an old group sits below newer alerts');

set local role service_role;
select is((public.upsert_mobile_notification('e7100001-0000-4000-8000-000000000001', null, 'post_saved', 'social', 'grouped', 'Local only', null, 'post', 'post-1', null, 'last-event-fixture-group') ->> 'wasCreated')::boolean, false, 'a second event joins the same alert');
select ok((
  select last_event_at > '2026-06-01T00:00:00Z'::timestamptz and event_count = 2 and not is_read
  from public.mobile_notifications where aggregation_key = 'last-event-fixture-group'
), 'the new event moves the alert to now, unread, with its count');

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"e7100001-0000-4000-8000-000000000001","role":"authenticated","session_id":"e7200000-0000-4000-8000-000000000001","is_anonymous":false}', true);
select results_eq('inbox', $$ values ('grouped'), ('newest'), ('middle'), ('oldest') $$, 'the alert with the newest event leads the inbox');

reset role;
select * from finish();
rollback;
