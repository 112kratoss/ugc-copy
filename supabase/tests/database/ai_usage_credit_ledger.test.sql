-- Behavioural coverage for the paid-AI credit ledger.
--
-- These two RPCs are the money path: `start_ai_usage_event` holds credits and
-- `settle_ai_usage_event` either keeps or refunds them. The properties that
-- matter are single-effect ones — a replayed idempotency key must not deduct
-- twice, and a repeated settlement must not refund twice — so they are asserted
-- against real balances rather than against the SQL text.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

-- ─── Privilege boundaries ────────────────────────────────────────────────────

select is(
  (
    select procedures.prosecdef
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.settle_ai_usage_event(uuid, text, text, jsonb, text)'::regprocedure
  ),
  true,
  'settlement runs with owner privileges'
);

select is(
  (
    select pg_catalog.has_function_privilege('anon', procedures.oid, 'EXECUTE')
        or pg_catalog.has_function_privilege('authenticated', procedures.oid, 'EXECUTE')
    from pg_catalog.pg_proc AS procedures
    where procedures.oid = 'public.settle_ai_usage_event(uuid, text, text, jsonb, text)'::regprocedure
  ),
  false,
  'client roles cannot settle an AI usage event directly'
);

-- ─── Fixtures ────────────────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  '00000000-0000-4000-8000-0000000000a1'::uuid,
  'ledger-test@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

-- The on_auth_user_created trigger creates the profile; pin the balance so the
-- assertions below are about the RPCs and not about signup defaults.
update public.profiles set credits = 1000
where id = '00000000-0000-4000-8000-0000000000a1'::uuid;

create temporary table ledger_probe (label text, payload jsonb) on commit drop;

-- ─── Validation ──────────────────────────────────────────────────────────────

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000a1'::uuid, -5, 'enhance', 'kie', 'model-a', null, 'p', null
  ) ->> 'status'),
  'invalid_cost',
  'a negative cost is rejected before any deduction'
);

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000a1'::uuid, 10, '   ', 'kie', 'model-a', null, 'p', null
  ) ->> 'status'),
  'invalid_request',
  'a blank feature is rejected'
);

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000a1'::uuid, 10, 'enhance', 'kie', 'model-a', null, 'p', 'not-a-sha256'
  ) ->> 'status'),
  'invalid_idempotency_key',
  'a malformed idempotency key hash is rejected'
);

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000ff'::uuid, 10, 'enhance', 'kie', 'model-a', null, 'p', null
  ) ->> 'status'),
  'profile_not_found',
  'an unknown profile cannot start paid usage'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  1000,
  'no rejected request moved the balance'
);

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000a1'::uuid, 5000, 'enhance', 'kie', 'model-a', null, 'p', null
  ) ->> 'status'),
  'insufficient_credits',
  'a request beyond the balance is refused'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  1000,
  'a refused request does not deduct'
);

-- ─── Happy path ──────────────────────────────────────────────────────────────

insert into ledger_probe (label, payload)
select 'start', public.start_ai_usage_event(
  '00000000-0000-4000-8000-0000000000a1'::uuid, 100, 'enhance', 'kie', 'model-a', 'text', 'prompt', null
);

select is(
  (select payload ->> 'status' from ledger_probe where label = 'start'),
  'started',
  'a valid request starts'
);

select is(
  (select (payload ->> 'remaining_credits')::integer from ledger_probe where label = 'start'),
  900,
  'the hold is deducted immediately and reported'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  900,
  'the balance reflects the hold'
);

select is(
  (
    select status
    from public.ai_usage_events
    where id = ((select payload ->> 'event_id' from ledger_probe where label = 'start'))::uuid
  ),
  'pending',
  'the event is pending until settled'
);

-- ─── Settlement is single-effect ─────────────────────────────────────────────

select is(
  (select public.settle_ai_usage_event(
    ((select payload ->> 'event_id' from ledger_probe where label = 'start'))::uuid,
    'succeeded', 'output', '{"ok":true}'::jsonb, null
  ) ->> 'status'),
  'succeeded',
  'a pending event settles as succeeded'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  900,
  'a successful settlement keeps the credits spent'
);

select is(
  (select public.settle_ai_usage_event(
    ((select payload ->> 'event_id' from ledger_probe where label = 'start'))::uuid,
    'succeeded', 'output', '{"ok":true}'::jsonb, null
  ) ->> 'status'),
  'already_succeeded',
  'a repeated success settlement reports the durable state'
);

select is(
  (select (public.settle_ai_usage_event(
    ((select payload ->> 'event_id' from ledger_probe where label = 'start'))::uuid,
    'succeeded', 'output', '{"ok":true}'::jsonb, null
  ) ->> 'settled')::boolean),
  false,
  'a repeated success settlement applies no second effect'
);

select is(
  (select public.settle_ai_usage_event(
    ((select payload ->> 'event_id' from ledger_probe where label = 'start'))::uuid,
    'refunded', null, null, 'late failure'
  ) ->> 'status'),
  'transition_conflict',
  'a succeeded event cannot later be refunded'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  900,
  'the rejected refund did not restore credits'
);

-- ─── Refund is single-effect ─────────────────────────────────────────────────

insert into ledger_probe (label, payload)
select 'refundable', public.start_ai_usage_event(
  '00000000-0000-4000-8000-0000000000a1'::uuid, 200, 'enhance', 'kie', 'model-a', 'text', 'prompt', null
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  700,
  'the second hold is deducted'
);

select is(
  (select public.settle_ai_usage_event(
    ((select payload ->> 'event_id' from ledger_probe where label = 'refundable'))::uuid,
    'refunded', null, null, 'provider failed'
  ) ->> 'status'),
  'refunded',
  'a failed event refunds'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  900,
  'the refund restores exactly the held amount'
);

select is(
  (select public.settle_ai_usage_event(
    ((select payload ->> 'event_id' from ledger_probe where label = 'refundable'))::uuid,
    'refunded', null, null, 'provider failed'
  ) ->> 'status'),
  'already_refunded',
  'a repeated refund reports the durable state'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  900,
  'a repeated refund does not credit the account twice'
);

-- ─── Idempotency key replay ──────────────────────────────────────────────────

insert into ledger_probe (label, payload)
select 'keyed', public.start_ai_usage_event(
  '00000000-0000-4000-8000-0000000000a1'::uuid, 50, 'enhance', 'kie', 'model-a', 'text', 'prompt', repeat('a', 64)
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  850,
  'the keyed request deducts once'
);

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000a1'::uuid, 50, 'enhance', 'kie', 'model-a', 'text', 'prompt', repeat('a', 64)
  ) ->> 'status'),
  'in_progress',
  'replaying a key while the first request is pending reports in_progress'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  850,
  'replaying a pending key does not deduct a second time'
);

select lives_ok(
  $$
    select public.settle_ai_usage_event(
      ((select payload ->> 'event_id' from ledger_probe where label = 'keyed'))::uuid,
      'succeeded', 'output', '{"result":"cached"}'::jsonb, null
    )
  $$,
  'the keyed event settles'
);

select is(
  (select public.start_ai_usage_event(
    '00000000-0000-4000-8000-0000000000a1'::uuid, 50, 'enhance', 'kie', 'model-a', 'text', 'prompt', repeat('a', 64)
  ) ->> 'status'),
  'succeeded_replay',
  'replaying a key after success returns the stored replay'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000a1'::uuid),
  850,
  'replaying a succeeded key never charges again'
);

select * from finish();
rollback;
