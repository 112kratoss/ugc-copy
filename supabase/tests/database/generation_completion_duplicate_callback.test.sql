-- Duplicate provider callbacks must not revoke a live completion worker lease.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

select ok(
  public.enqueue_generation_completion_job(
    'pgtap-duplicate-callback',
    '{"delivery":1}'::jsonb
  ) is not null,
  'the first callback creates a completion job'
);

select is(
  (
    select count(*)
    from public.claim_generation_completion_jobs(
      1,
      'pgtap-worker-a',
      300,
      'pgtap-duplicate-callback'
    )
  ),
  1::bigint,
  'the first worker claims the job'
);

select is(
  (
    select status || ':' || locked_by || ':' || attempt_count::text
    from public.generation_completion_jobs
    where prediction_id = 'pgtap-duplicate-callback'
  ),
  'processing:pgtap-worker-a:1',
  'the claim establishes one processing owner and attempt'
);

select is(
  public.enqueue_generation_completion_job(
    'pgtap-duplicate-callback',
    '{"delivery":2}'::jsonb
  ),
  (
    select id
    from public.generation_completion_jobs
    where prediction_id = 'pgtap-duplicate-callback'
  ),
  'a duplicate callback resolves to the same durable job'
);

select is(
  (
    select status || ':' || locked_by || ':' || attempt_count::text
    from public.generation_completion_jobs
    where prediction_id = 'pgtap-duplicate-callback'
  ),
  'processing:pgtap-worker-a:1',
  'duplicate enqueue preserves processing ownership and attempt count'
);

select is(
  (
    select count(*)
    from public.claim_generation_completion_jobs(
      1,
      'pgtap-worker-b',
      300,
      'pgtap-duplicate-callback'
    )
  ),
  0::bigint,
  'a second worker cannot claim the live lease after duplicate delivery'
);

select is(
  public.finish_generation_completion_job(
    (
      select id
      from public.generation_completion_jobs
      where prediction_id = 'pgtap-duplicate-callback'
    ),
    'pgtap-worker-a',
    true,
    null,
    60
  ),
  'succeeded',
  'the original owner can still finish the job'
);

select public.enqueue_generation_completion_job(
  'pgtap-duplicate-callback',
  '{"delivery":3}'::jsonb
);

select is(
  (
    select status
    from public.generation_completion_jobs
    where prediction_id = 'pgtap-duplicate-callback'
  ),
  'succeeded',
  'a later duplicate callback cannot reopen a succeeded job'
);

insert into public.generation_completion_jobs (
  prediction_id, payload, status, attempt_count, next_attempt_at,
  last_error, completed_at
)
values (
  'pgtap-failed-callback', '{}'::jsonb, 'failed', 5, now(),
  'exhausted fixture', now()
);

select public.enqueue_generation_completion_job(
  'pgtap-failed-callback',
  '{"delivery":2}'::jsonb
);

select is(
  (
    select status || ':' || attempt_count::text || ':' || last_error
    from public.generation_completion_jobs
    where prediction_id = 'pgtap-failed-callback'
  ),
  'failed:5:exhausted fixture',
  'duplicate delivery does not silently reopen an exhausted job'
);

select * from finish();
rollback;
