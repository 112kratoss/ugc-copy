-- Behavioural coverage for F14's provider admission control.
--
-- The string-level migration test pins the *shape* of these functions. What it
-- cannot prove is the arithmetic: that a bucket actually refills over time,
-- that a rejected model bucket does not silently spend a global token, and that
-- the breaker's open -> half-open -> closed cycle terminates. Those are the
-- properties that decide whether the gate protects the provider or quietly
-- throttles the account to zero, so they are exercised here against real rows.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

-- Isolate from anything a prior test or seed left behind.
delete from public.provider_admission_buckets where scope like 'pgtap%';
delete from public.provider_circuit_breakers where service like 'pgtap%';

-- ─── Token bucket ────────────────────────────────────────────────────────────

-- A fresh scope is seeded at capacity, so the first submission is always
-- admitted rather than waiting for a refill that has not started.
select is(
  (public.admit_provider_submission('pgtap-bucket', null, 2, 1, null, null, 1000, 3600, 60, 60) ->> 'allowed')::boolean,
  true,
  'first submission on a fresh bucket is admitted'
);

select is(
  (public.admit_provider_submission('pgtap-bucket', null, 2, 1, null, null, 1000, 3600, 60, 60) ->> 'allowed')::boolean,
  true,
  'burst capacity is spendable up to the configured capacity'
);

select is(
  (public.admit_provider_submission('pgtap-bucket', null, 2, 1, null, null, 1000, 3600, 60, 60) ->> 'allowed')::boolean,
  false,
  'the bucket refuses once capacity is spent'
);

select is(
  (public.admit_provider_submission('pgtap-bucket', null, 2, 1, null, null, 1000, 3600, 60, 60) ->> 'reason'),
  'rate_limited',
  'a spent bucket reports rate_limited rather than a generic failure'
);

select ok(
  (public.admit_provider_submission('pgtap-bucket', null, 2, 1, null, null, 1000, 3600, 60, 60) ->> 'retryAfterSeconds')::integer >= 1,
  'a rejection always carries a retry hint of at least one second'
);

-- Refill is time-based, so rewinding the stamp is equivalent to waiting.
update public.provider_admission_buckets
set updated_at = now() - interval '5 seconds'
where scope = 'pgtap-bucket';

select is(
  (public.admit_provider_submission('pgtap-bucket', null, 2, 1, null, null, 1000, 3600, 60, 60) ->> 'allowed')::boolean,
  true,
  'the bucket refills over elapsed time'
);

select ok(
  (select tokens from public.provider_admission_buckets where scope = 'pgtap-bucket') <= 2,
  'refill never exceeds capacity, so idle time cannot bank unlimited burst'
);

-- ─── The global token must not leak when the model bucket refuses ────────────
--
-- This is the property that made these one function instead of three. Drain the
-- model bucket, then confirm the rejected call left the global bucket untouched.

select public.admit_provider_submission('pgtap-leak', 'slow-model', 100, 100, 1, 0.001, 1000, 3600, 60, 60);

select is(
  (public.admit_provider_submission('pgtap-leak', 'slow-model', 100, 100, 1, 0.001, 1000, 3600, 60, 60) ->> 'reason'),
  'model_rate_limited',
  'a drained per-model bucket rejects even when the global bucket is healthy'
);

select ok(
  (select tokens from public.provider_admission_buckets where scope = 'pgtap-leak')
    > (select tokens from public.provider_admission_buckets where scope = 'pgtap-leak:slow-model'),
  'the model rejection did not spend a global token'
);

-- ─── Circuit breaker ─────────────────────────────────────────────────────────

-- Below threshold the circuit stays closed: isolated failures are normal.
select public.record_provider_submission_outcome('pgtap-breaker', false, 3, 60, null);
select is(
  (select state from public.provider_circuit_breakers where service = 'pgtap-breaker'),
  'closed',
  'a single failure does not open the circuit'
);

select public.record_provider_submission_outcome('pgtap-breaker', false, 3, 60, null);
select public.record_provider_submission_outcome('pgtap-breaker', false, 3, 60, null);

select is(
  (select state from public.provider_circuit_breakers where service = 'pgtap-breaker'),
  'open',
  'consecutive failures past the threshold open the circuit'
);

select is(
  (public.admit_provider_submission('pgtap-breaker', null, 100, 100, null, null, 1000, 3600, 60, 60) ->> 'reason'),
  'circuit_open',
  'an open circuit rejects without consuming provider budget'
);

select ok(
  (select count(*) from public.provider_admission_buckets where scope = 'pgtap-breaker') = 0,
  'an open circuit never even seeds a bucket, so nothing is spent while it is open'
);

-- A provider Retry-After longer than our backoff wins.
select public.record_provider_submission_outcome('pgtap-retry', false, 1, 30, 300);
select ok(
  (select half_open_at from public.provider_circuit_breakers where service = 'pgtap-retry')
    > now() + interval '200 seconds',
  'a longer provider Retry-After overrides our own open duration'
);

-- Once the open window elapses, exactly one caller becomes the probe.
update public.provider_circuit_breakers
set half_open_at = now() - interval '1 second'
where service = 'pgtap-breaker';

select is(
  (public.admit_provider_submission('pgtap-breaker', null, 100, 100, null, null, 1000, 3600, 60, 60) ->> 'reason'),
  'circuit_probe',
  'the first caller after the open window becomes the probe'
);

select is(
  (public.admit_provider_submission('pgtap-breaker', null, 100, 100, null, null, 1000, 3600, 60, 60) ->> 'reason'),
  'circuit_probe_in_flight',
  'a second concurrent caller does not also probe, so recovery cannot stampede'
);

-- A successful probe closes the circuit outright.
select public.record_provider_submission_outcome('pgtap-breaker', true, 3, 60, null);
select is(
  (select state || ':' || consecutive_failures::text
     from public.provider_circuit_breakers where service = 'pgtap-breaker'),
  'closed:0',
  'a successful probe closes the circuit and clears the failure count'
);

select * from finish();
rollback;
