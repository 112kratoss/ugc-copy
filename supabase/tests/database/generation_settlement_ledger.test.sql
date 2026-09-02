-- Behavioural coverage for generation settlement.
--
-- `settle_generation_failed` is the refund path for a generation that the
-- provider could not complete. Its load-bearing property is that the refund is
-- applied at most once no matter how many times a webhook, a cron sweep, and a
-- manual retry all race to settle the same provider task.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(39);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values (
  '00000000-0000-4000-8000-0000000000b1'::uuid,
  'settlement-test@example.invalid',
  'authenticated',
  'authenticated',
  '{}'::jsonb,
  '{}'::jsonb
);

update public.profiles set credits = 500
where id = '00000000-0000-4000-8000-0000000000b1'::uuid;

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, prompt, refunded)
values
  (
    '70000000-0000-4000-8000-000000000001'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'task-refundable',
    'processing',
    120,
    'image',
    'model-a',
    'a prompt',
    false
  ),
  (
    '70000000-0000-4000-8000-000000000002'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'task-already-refunded',
    'processing',
    75,
    'image',
    'model-a',
    'a prompt',
    true
  ),
  (
    '70000000-0000-4000-8000-000000000003'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'task-succeeded',
    'succeeded',
    60,
    'image',
    'model-a',
    'a prompt',
    false
  );

-- ─── Validation ──────────────────────────────────────────────────────────────

select is(
  (select public.settle_generation_failed('   ') ->> 'status'),
  'invalid_request',
  'a blank provider task id is rejected'
);

select is(
  (select public.settle_generation_failed('task-does-not-exist') ->> 'status'),
  'missing',
  'an unknown provider task reports missing rather than inventing a refund'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  500,
  'no rejected settlement moved the balance'
);

-- ─── Refund happens exactly once ─────────────────────────────────────────────

select is(
  (select public.settle_generation_failed('task-refundable') ->> 'status'),
  'failed',
  'a processing generation settles as failed'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  620,
  'the failed generation refunds its cost'
);

select is(
  (select refunded from public.generations where prediction_id = 'task-refundable'),
  true,
  'the generation is flagged refunded so a later sweep cannot repeat it'
);

select is(
  (select status from public.generations where prediction_id = 'task-refundable'),
  'failed',
  'the generation is marked failed'
);

select lives_ok(
  $$select public.settle_generation_failed('task-refundable')$$,
  'settling the same task again is safe'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  620,
  'a repeated settlement does not refund twice'
);

select lives_ok(
  $$select public.settle_generation_failed('task-refundable')$$,
  'a third settlement is still safe'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  620,
  'repeated settlements remain single-effect under a webhook and cron race'
);

-- ─── Already-refunded and already-succeeded generations ──────────────────────

select is(
  (select public.settle_generation_failed('task-already-refunded') ->> 'status'),
  'failed',
  'an already-refunded generation still settles its status'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  620,
  'an already-refunded generation does not refund again'
);

select is(
  (select public.settle_generation_failed('task-succeeded') ->> 'status'),
  'already_succeeded',
  'a succeeded generation refuses a late failure settlement'
);

-- ─── The provider's failure reason is preserved ──────────────────────────────
--
-- The reason is the only thing that distinguishes a content-policy rejection
-- from a provider outage. Each settlement runs as its own statement: a call
-- made inside the same SELECT that reads the column would be evaluated against
-- that statement's snapshot and read the pre-update value.
--
-- These rows carry cost 0 so they settle without moving the balance that the
-- assertions above and below pin.

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, prompt, refunded)
values
  (
    '70000000-0000-4000-8000-0000000000f1'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'task-failure-reason',
    'processing',
    0,
    'video',
    'seedance-2',
    'a prompt',
    false
  ),
  (
    '70000000-0000-4000-8000-0000000000f2'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'task-failure-reason-long',
    'processing',
    0,
    'video',
    'seedance-2',
    'a prompt',
    false
  );

select lives_ok(
  $$select public.settle_generation_failed('task-failure-reason', null, 'content policy violation')$$,
  'a failure settles with the provider reason attached'
);

select is(
  (select error_message from public.generations where prediction_id = 'task-failure-reason'),
  'content policy violation',
  'the provider failure reason is persisted onto the generation'
);

select lives_ok(
  $$select public.settle_generation_failed('task-failure-reason', null, '   ')$$,
  'a replay carrying no usable reason is safe'
);

select is(
  (select error_message from public.generations where prediction_id = 'task-failure-reason'),
  'content policy violation',
  'a replay carrying no reason does not erase the one already recorded'
);

select lives_ok(
  $$select public.settle_generation_failed('task-failure-reason-long', null, repeat('x', 600))$$,
  'an oversized provider reason does not abort settlement'
);

select is(
  (select length(error_message) from public.generations where prediction_id = 'task-failure-reason-long'),
  500,
  'an oversized provider reason is truncated rather than rejected'
);

-- ─── Start-failure settlement ────────────────────────────────────────────────
--
-- `settle_generation_start_failed` refunds a generation that never reached the
-- provider. Its critical guard is that a generation which DID reach the
-- provider must not be refunded here, or a running job would be paid back while
-- still consuming provider capacity.

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, prompt, refunded)
values
  (
    '70000000-0000-4000-8000-000000000004'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    null,
    'processing',
    90,
    'image',
    'model-a',
    'a prompt',
    false
  ),
  (
    '70000000-0000-4000-8000-000000000005'::uuid,
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'task-attached-to-provider',
    'processing',
    40,
    'image',
    'model-a',
    'a prompt',
    false
  );

select is(
  (select public.settle_generation_start_failed(null, 'boom') ->> 'status'),
  'invalid_request',
  'a null generation id is rejected'
);

select is(
  (select public.settle_generation_start_failed(
    '70000000-0000-4000-8000-0000000000ff'::uuid, 'boom') ->> 'status'),
  'missing',
  'an unknown generation reports missing'
);

select is(
  (select public.settle_generation_start_failed(
    '70000000-0000-4000-8000-000000000005'::uuid, 'boom') ->> 'status'),
  'provider_task_attached',
  'a generation already handed to the provider is not refunded as a start failure'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  620,
  'the provider-attached guard left the balance untouched'
);

select is(
  (select public.settle_generation_start_failed(
    '70000000-0000-4000-8000-000000000004'::uuid, 'provider rejected the request') ->> 'status'),
  'failed',
  'a generation that never reached the provider settles as failed'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  710,
  'the start failure refunds its cost'
);

select lives_ok(
  $$select public.settle_generation_start_failed(
      '70000000-0000-4000-8000-000000000004'::uuid, 'provider rejected the request')$$,
  'settling the same start failure again is safe'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  710,
  'a repeated start-failure settlement does not refund twice'
);

-- ─── Success settlement ──────────────────────────────────────────────────────
--
-- The load-bearing guard here is that a refunded generation can never later be
-- marked succeeded. Without it a user could be refunded and still receive the
-- output they were refunded for.

insert into public.generations (id, user_id, prediction_id, status, cost, category, model, prompt, refunded)
values (
  '70000000-0000-4000-8000-000000000006'::uuid,
  '00000000-0000-4000-8000-0000000000b1'::uuid,
  'task-will-succeed',
  'processing',
  30,
  'image',
  'model-a',
  'a prompt',
  false
);

select is(
  (select public.settle_generation_succeeded(
    '   ', 'https://cdn.example/out.png', null, null, null, null, null, null, null, null) ->> 'status'),
  'invalid_request',
  'a blank provider task id is rejected on the success path'
);

select is(
  (select public.settle_generation_succeeded(
    'task-will-succeed', 'https://cdn.example/out.png', null, null, null, null, -1, null, null, null) ->> 'status'),
  'invalid_request',
  'a negative preview attempt count is rejected'
);

select is(
  (select public.settle_generation_succeeded(
    'task-not-real', 'https://cdn.example/out.png', null, null, null, null, null, null, null, null) ->> 'status'),
  'missing',
  'an unknown provider task cannot be marked succeeded'
);

select is(
  (select public.settle_generation_succeeded(
    'task-refundable', 'https://cdn.example/out.png', null, null, null, null, null, null, null, null) ->> 'status'),
  'already_failed',
  'a refunded generation can never later be marked succeeded'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  710,
  'refusing to succeed a refunded generation left the balance untouched'
);

select is(
  (select public.settle_generation_succeeded(
    'task-will-succeed', 'https://cdn.example/out.png', null, null, null, null, null, null, null, null) ->> 'status'),
  'succeeded',
  'a processing generation settles as succeeded'
);

select is(
  (select status from public.generations where prediction_id = 'task-will-succeed'),
  'succeeded',
  'the generation is marked succeeded'
);

select is(
  (select output_url from public.generations where prediction_id = 'task-will-succeed'),
  'https://cdn.example/out.png',
  'the output url is recorded'
);

select is(
  (select public.settle_generation_succeeded(
    'task-will-succeed', 'https://cdn.example/other.png', null, null, null, null, null, null, null, null) ->> 'status'),
  'already_succeeded',
  'a repeated success settlement reports the durable state'
);

select is(
  (select output_url from public.generations where prediction_id = 'task-will-succeed'),
  'https://cdn.example/out.png',
  'a repeated success settlement does not overwrite the recorded output'
);

select is(
  (select credits from public.profiles where id = '00000000-0000-4000-8000-0000000000b1'::uuid),
  710,
  'success settlement never moves the credit balance'
);

select * from finish();
rollback;
