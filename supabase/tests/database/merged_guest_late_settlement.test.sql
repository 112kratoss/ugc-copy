-- Work a guest started, settled after the guest signed up.
--
-- `merge_guest_account` moves a guest's balance to the account, drains the
-- guest's row and links it. The guest's generations, template runs and AI-usage
-- events keep the guest's user id, so everything that settles after the merge
-- names a drained row. A raw balance write to that row reaches the account
-- through `forward_linked_account_credit_change`; what the trigger cannot fix is
-- a decision read from the drained row: whether the next paid step of a template
-- run is affordable, how much of it the promotional balance covers, and the
-- balance a settlement reports back. These are asserted through the real
-- functions, with an unmerged user beside them as the control.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(53);

-- ─── Fixtures ────────────────────────────────────────────────────────────────
--
-- 5e0e…01 is the guest, …02 the account it links to, …03 a registered user who
-- never merges, …04 the creator of the template both runs belong to.

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, is_anonymous)
values
  ('5e0e0000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('5e0e0000-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'late-settlement-owner@example.test', '', now(), now(), false),
  ('5e0e0000-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'late-settlement-control@example.test', '', now(), now(), false),
  ('5e0e0000-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'late-settlement-creator@example.test', '', now(), now(), false);

-- The guest bought 200 credits; the account holds 50, 20 of them promotional;
-- the control holds 100, 10 of them promotional.
update public.profiles set credits = 200, promotional_credits = 0
where id = '5e0e0000-0000-4000-8000-000000000001';
update public.profiles set credits = 50, promotional_credits = 20
where id = '5e0e0000-0000-4000-8000-000000000002';
update public.profiles set credits = 100, promotional_credits = 10
where id = '5e0e0000-0000-4000-8000-000000000003';

insert into public.templates (id, name, creator_user_id, status, is_active)
values (
  '5e0e1000-0000-4000-8000-000000000001',
  'Late settlement fixture',
  '5e0e0000-0000-4000-8000-000000000004',
  'draft', true
);

insert into public.template_runs (
  id, template_id, user_id, graph_snapshot, graph_hash, input_manifest,
  input_storage_paths, output_node_id, output_kind, status,
  estimated_total_credits, estimated_remaining_credits
)
values
  (
    '5e0e2000-0000-4000-8000-000000000001',
    '5e0e1000-0000-4000-8000-000000000001',
    '5e0e0000-0000-4000-8000-000000000001',
    '{"version":1,"nodes":[],"edges":[]}'::jsonb,
    repeat('a', 64), '[]'::jsonb, '{}'::jsonb,
    'step-two', 'image', 'processing', 80, 80
  ),
  (
    '5e0e2000-0000-4000-8000-000000000002',
    '5e0e1000-0000-4000-8000-000000000001',
    '5e0e0000-0000-4000-8000-000000000003',
    '{"version":1,"nodes":[],"edges":[]}'::jsonb,
    repeat('b', 64), '[]'::jsonb, '{}'::jsonb,
    'step-one', 'image', 'processing', 25, 25
  );

insert into public.template_run_steps (id, run_id, node_id, kind, media_kind, label, status)
values
  ('5e0e3000-0000-4000-8000-000000000001', '5e0e2000-0000-4000-8000-000000000001', 'step-one', 'generation', 'image', 'Step one', 'queued'),
  ('5e0e3000-0000-4000-8000-000000000002', '5e0e2000-0000-4000-8000-000000000001', 'step-two', 'generation', 'image', 'Step two', 'queued'),
  ('5e0e3000-0000-4000-8000-000000000003', '5e0e2000-0000-4000-8000-000000000002', 'step-one', 'generation', 'image', 'Step one', 'queued');

-- Every result is kept by name, so each function runs exactly once and the
-- assertions below read what it returned.
create temporary table late_settlement_results (
  label text primary key,
  result jsonb not null
);

-- ─── The guest starts four pieces of paid work ───────────────────────────────

insert into late_settlement_results
select 'guest generation', public.start_generation(
  '5e0e0000-0000-4000-8000-000000000001',
  30, 'late-settlement-model', 'fails at the provider after sign-up', 'image',
  null, null, null, null, null
);

insert into late_settlement_results
select 'guest generation attached', public.attach_generation_provider_task(
  (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'guest generation'),
  'late-settlement-guest-task'
);

insert into late_settlement_results
select 'guest unsubmitted generation', public.start_generation(
  '5e0e0000-0000-4000-8000-000000000001',
  15, 'late-settlement-model', 'never reaches the provider', 'image',
  null, null, null, null, null
);

insert into late_settlement_results
select 'guest ai usage', public.start_ai_usage_event(
  '5e0e0000-0000-4000-8000-000000000001',
  5, 'prompt_enhancement', 'late-settlement-provider', 'late-settlement-model',
  'text', 'enhance this prompt', null
);

insert into late_settlement_results
select 'guest template step one', public.start_template_generation(
  '5e0e0000-0000-4000-8000-000000000001',
  '5e0e2000-0000-4000-8000-000000000001',
  '5e0e3000-0000-4000-8000-000000000001',
  40, 'late-settlement-model', 'image', null, null, null, repeat('1', 64)
);

select is(
  (
    select array_agg(result ->> 'status' order by label)
    from late_settlement_results
    where label in ('guest generation', 'guest unsubmitted generation', 'guest ai usage', 'guest template step one')
  ),
  array['started', 'started', 'started', 'started'],
  'the guest starts a generation, an unsubmitted generation, an AI-usage event and a template step'
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest generation attached'),
  'attached',
  'the provider accepts the guest''s first generation'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000001'),
  110,
  'the guest is charged 90 of its 200 credits before signing up'
);

-- ─── The guest signs up ──────────────────────────────────────────────────────

select is(
  public.merge_guest_account(
    '5e0e0000-0000-4000-8000-000000000001',
    '5e0e0000-0000-4000-8000-000000000002',
    'mobile'
  ) ->> 'status',
  'merged',
  'the guest links to its new account with all four pieces still open'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  array[160, 20],
  'the account holds its own 50 credits and the guest''s remaining 110'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000001'),
  array[0, 0],
  'the guest row is drained'
);

-- ─── A generation started before the merge fails after it ───────────────────

insert into late_settlement_results
select 'guest generation failed', public.settle_generation_failed(
  'late-settlement-guest-task', now(), 'The provider rejected this request.'
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest generation failed'),
  'failed',
  'a generation the guest started settles as failed after the merge'
);

select is(
  (select (result ->> 'refunded')::boolean from late_settlement_results where label = 'guest generation failed'),
  true,
  'its failure is refunded'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  190,
  'the refund for a generation the guest started reaches the account'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000001'),
  0,
  'the refund leaves no balance on the drained guest row'
);

-- ─── An AI-usage event started before the merge is refunded after it ────────

insert into late_settlement_results
select 'guest ai usage refunded', public.settle_ai_usage_event(
  (select (result ->> 'event_id')::uuid from late_settlement_results where label = 'guest ai usage'),
  'refunded', null, null, 'The enhancer failed.'
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest ai usage refunded'),
  'refunded',
  'an AI-usage event the guest started is refunded after the merge'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  195,
  'the AI-usage refund reaches the account'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'guest ai usage refunded'),
  195,
  'the AI-usage refund reports the account''s balance, not the drained row''s'
);

select is(
  public.settle_ai_usage_event(
    (select (result ->> 'event_id')::uuid from late_settlement_results where label = 'guest ai usage'),
    'refunded', null, null, 'A retried refund.'
  ) ->> 'remaining_credits',
  '195',
  'a replayed AI-usage refund reports the account''s balance and refunds nothing twice'
);

-- ─── A generation the provider never accepted is settled after the merge ────

insert into late_settlement_results
select 'guest unsubmitted generation failed', public.settle_generation_start_failed(
  (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'guest unsubmitted generation'),
  'The provider could not accept this request.'
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest unsubmitted generation failed'),
  'failed',
  'a start the provider never accepted settles after the merge'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  210,
  'its refund reaches the account'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'guest unsubmitted generation failed'),
  210,
  'the start-failure refund reports the account''s balance'
);

-- ─── A template run in progress across the merge takes its next step ────────

insert into late_settlement_results
select 'guest template step two', public.start_template_generation(
  '5e0e0000-0000-4000-8000-000000000001',
  '5e0e2000-0000-4000-8000-000000000001',
  '5e0e3000-0000-4000-8000-000000000002',
  40, 'late-settlement-model', 'image', null, null, null, repeat('2', 64)
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest template step two'),
  'started',
  'the next paid step of the guest''s template run starts after the merge'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  170,
  'the step is charged to the account'
);

select is(
  (select promotional_credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  0,
  'the account''s promotional credits pay for the step first'
);

select is(
  (
    select array[generations.cost, generations.promotional_credits_used]
    from public.generations
    where id = (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'guest template step two')
  ),
  array[40, 20],
  'the step''s generation records the promotional share taken from the account'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'guest template step two'),
  170,
  'the started step reports the account''s balance'
);

select is(
  (
    select generations.user_id
    from public.generations
    where id = (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'guest template step two')
  ),
  '5e0e0000-0000-4000-8000-000000000001'::uuid,
  'the step''s generation still belongs to the guest id its run belongs to'
);

select is(
  (
    select (status, generation_id)::text
    from public.template_run_steps
    where id = '5e0e3000-0000-4000-8000-000000000002'
  ),
  (
    select ('processing', (result ->> 'generation_id')::uuid)::text
    from late_settlement_results where label = 'guest template step two'
  ),
  'the step is processing its new generation'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000001'),
  array[0, 0],
  'the step takes nothing from the drained guest row'
);

select is(
  public.start_template_generation(
    '5e0e0000-0000-4000-8000-000000000001',
    '5e0e2000-0000-4000-8000-000000000001',
    '5e0e3000-0000-4000-8000-000000000002',
    40, 'late-settlement-model', 'image', null, null, null, repeat('2', 64)
  ) ->> 'status',
  'in_progress',
  'a repeated start of the same step charges nothing again'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  170,
  'the repeated start leaves the account''s balance alone'
);

-- ─── Template steps refused by the provider are refunded after the merge ────

insert into late_settlement_results
select 'guest template step two failed', public.settle_template_generation_start_failed(
  (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'guest template step two'),
  'The provider could not accept this request.'
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest template step two failed'),
  'failed',
  'a step started after the merge and refused by the provider settles'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  array[210, 20],
  'its refund returns the whole charge, promotional share included, to the account'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'guest template step two failed'),
  210,
  'the template refund reports the account''s balance'
);

insert into late_settlement_results
select 'guest template step one failed', public.settle_template_generation_start_failed(
  (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'guest template step one'),
  'The provider could not accept this request.'
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'guest template step one failed'),
  'failed',
  'a step the guest started before the merge settles after it'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  array[250, 20],
  'the step charged to the guest before the merge is refunded to the account'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'guest template step one failed'),
  250,
  'that refund reports the account''s balance too'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000001'),
  array[0, 0],
  'after every refund the guest row still holds nothing'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  250,
  'the account ends with its own 50 credits and all 200 of the guest''s'
);

-- ─── A user who never merged is unchanged ───────────────────────────────────

insert into late_settlement_results
select 'control generation', public.start_generation(
  '5e0e0000-0000-4000-8000-000000000003',
  20, 'late-settlement-model', 'the control generation', 'image',
  null, null, null, null, null
);

insert into late_settlement_results
select 'control generation attached', public.attach_generation_provider_task(
  (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'control generation'),
  'late-settlement-control-task'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[80, 0],
  'an unmerged user is charged on its own row, promotional credits first'
);

select is(
  public.settle_generation_failed(
    'late-settlement-control-task', now(), 'The provider rejected this request.'
  ) ->> 'refunded',
  'true',
  'an unmerged user''s failed generation is refunded'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[100, 10],
  'the refund returns to the unmerged user''s own row'
);

insert into late_settlement_results
select 'control unsubmitted generation', public.start_generation(
  '5e0e0000-0000-4000-8000-000000000003',
  7, 'late-settlement-model', 'the control start failure', 'image',
  null, null, null, null, null
);

insert into late_settlement_results
select 'control unsubmitted generation failed', public.settle_generation_start_failed(
  (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'control unsubmitted generation'),
  'The provider could not accept this request.'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'control unsubmitted generation failed'),
  100,
  'an unmerged user''s start-failure refund reports its own balance'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[100, 10],
  'and lands on its own row'
);

insert into late_settlement_results
select 'control ai usage', public.start_ai_usage_event(
  '5e0e0000-0000-4000-8000-000000000003',
  5, 'prompt_enhancement', 'late-settlement-provider', 'late-settlement-model',
  'text', 'enhance the control prompt', null
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[95, 5],
  'an unmerged user''s AI usage is charged on its own row'
);

select is(
  public.settle_ai_usage_event(
    (select (result ->> 'event_id')::uuid from late_settlement_results where label = 'control ai usage'),
    'refunded', null, null, 'The enhancer failed.'
  ) ->> 'remaining_credits',
  '100',
  'an unmerged user''s AI-usage refund reports its own balance'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[100, 10],
  'and lands on its own row, promotional share included'
);

insert into late_settlement_results
select 'control template step', public.start_template_generation(
  '5e0e0000-0000-4000-8000-000000000003',
  '5e0e2000-0000-4000-8000-000000000002',
  '5e0e3000-0000-4000-8000-000000000003',
  25, 'late-settlement-model', 'image', null, null, null, repeat('3', 64)
);

select is(
  (select result ->> 'status' from late_settlement_results where label = 'control template step'),
  'started',
  'an unmerged user''s template step starts'
);

select is(
  (select (result ->> 'remaining_credits')::integer from late_settlement_results where label = 'control template step'),
  75,
  'and reports its own balance'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[75, 0],
  'the step is charged on its own row, promotional credits first'
);

select is(
  public.settle_template_generation_start_failed(
    (select (result ->> 'generation_id')::uuid from late_settlement_results where label = 'control template step'),
    'The provider could not accept this request.'
  ) ->> 'remaining_credits',
  '100',
  'an unmerged user''s template refund reports its own balance'
);

select is(
  (select array[credits, promotional_credits] from public.profiles where id = '5e0e0000-0000-4000-8000-000000000003'),
  array[100, 10],
  'and returns the whole charge to its own row'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  250,
  'the account is untouched by the unmerged user''s work'
);

-- ─── An account that cannot afford the step is still refused ────────────────

update public.template_run_steps
set status = 'queued', generation_id = null
where id = '5e0e3000-0000-4000-8000-000000000002';

select is(
  public.start_template_generation(
    '5e0e0000-0000-4000-8000-000000000001',
    '5e0e2000-0000-4000-8000-000000000001',
    '5e0e3000-0000-4000-8000-000000000002',
    251, 'late-settlement-model', 'image', null, null, null, repeat('5', 64)
  ) ->> 'status',
  'insufficient_credits',
  'a step costing more than the account holds is refused'
);

select is(
  (select credits from public.profiles where id = '5e0e0000-0000-4000-8000-000000000002'),
  250,
  'the refused step charges nothing'
);

-- ─── Privileges are unchanged ────────────────────────────────────────────────

select is(
  (
    select array_agg(pg_catalog.has_function_privilege('authenticated', procedures, 'EXECUTE') order by procedures::text)
    from unnest(array[
      'public.start_template_generation(uuid, uuid, uuid, integer, text, text, integer, text, uuid, text)'::regprocedure,
      'public.settle_generation_failed(text, timestamp with time zone, text)'::regprocedure,
      'public.settle_generation_start_failed(uuid, text)'::regprocedure,
      'public.settle_template_generation_start_failed(uuid, text)'::regprocedure,
      'public.settle_ai_usage_event(uuid, text, text, jsonb, text)'::regprocedure
    ]) as procedures
  ),
  array[false, false, false, false, false],
  'a signed-in client still cannot call any settlement function'
);

select is(
  (
    select array_agg(pg_catalog.has_function_privilege('service_role', procedures, 'EXECUTE') order by procedures::text)
    from unnest(array[
      'public.start_template_generation(uuid, uuid, uuid, integer, text, text, integer, text, uuid, text)'::regprocedure,
      'public.settle_generation_failed(text, timestamp with time zone, text)'::regprocedure,
      'public.settle_generation_start_failed(uuid, text)'::regprocedure,
      'public.settle_template_generation_start_failed(uuid, text)'::regprocedure,
      'public.settle_ai_usage_event(uuid, text, text, jsonb, text)'::regprocedure
    ]) as procedures
  ),
  array[true, true, true, true, true],
  'the service role still calls every settlement function'
);

select * from finish();
rollback;
