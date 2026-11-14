-- Behavioural coverage for F14's provider admission control.
--
-- The string-level migration tests pin the *shape* of these functions. What
-- they cannot prove is the arithmetic: that the rate window really slides,
-- that an admission the model's share refuses takes no place in the account's
-- window, and that the breaker's open -> half-open -> closed cycle terminates.
-- Those are the properties that decide whether the gate protects the provider
-- or quietly throttles the account to zero, so they are exercised here against
-- real rows.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

-- Isolate from anything a prior test or seed left behind.
delete from public.provider_admission_buckets where scope like 'pgtap%';
delete from public.provider_circuit_breakers where service like 'pgtap%';

-- ─── Sliding rate window ─────────────────────────────────────────────────────

-- A fresh scope starts with an empty window, so the whole burst the window
-- holds is admitted at once.
select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'allowed')::boolean,
  true,
  'first submission on a fresh window is admitted'
);

select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'allowed')::boolean,
  true,
  'the window admits a burst up to its count'
);

select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'allowed')::boolean,
  false,
  'the window refuses once its count is reached'
);

select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'reason'),
  'rate_limited',
  'a full window reports rate_limited rather than a generic failure'
);

select ok(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'retryAfterSeconds')::integer between 11 and 12,
  'with every admission just made, the next place is a whole window away'
);

-- Admission is time-based, so rewriting the stamps is equivalent to waiting.
-- One admission is now older than the window and one is five seconds old.
update public.provider_admission_buckets
set admitted_at = array[now() - interval '13 seconds', now() - interval '5 seconds']
where scope = 'pgtap-window';

select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'allowed')::boolean,
  true,
  'an admission older than the window no longer counts'
);

select is(
  (select cardinality(admitted_at) from public.provider_admission_buckets where scope = 'pgtap-window'),
  2,
  'aged admissions are pruned on write, so the row never outgrows the window'
);

-- The window holds the five-second-old admission and the one just made. The
-- next place opens when the older of the two turns twelve, seven seconds from
-- now: a fixed window would have said "at the next boundary" instead.
select ok(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'retryAfterSeconds')::integer between 6 and 7,
  'a refusal says when the oldest admission in the window ages out'
);

-- More stamps than the count, as a lowered count or a recorded probe leaves
-- behind. A place opens only once all but one of the newest two have aged
-- out, which is when the two-second-old stamp turns twelve.
update public.provider_admission_buckets
set admitted_at = array[
  now() - interval '11 seconds', now() - interval '10 seconds',
  now() - interval '3 seconds', now() - interval '2 seconds', now() - interval '1 second'
]
where scope = 'pgtap-window';

select ok(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'retryAfterSeconds')::integer between 9 and 10,
  'an overfull window waits for enough admissions to age out, not just the oldest'
);

-- Half a second short of the window still holds its place, half a second past
-- it does not: the window is twelve seconds, not roughly twelve.
update public.provider_admission_buckets
set admitted_at = array[now() - interval '11.5 seconds', now() - interval '1 second']
where scope = 'pgtap-window';

select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'reason'),
  'rate_limited',
  'an admission still inside the window keeps its place'
);

update public.provider_admission_buckets
set admitted_at = array[now() - interval '12.5 seconds', now() - interval '1 second']
where scope = 'pgtap-window';

select is(
  (public.admit_provider_submission('pgtap-window', p_max_in_flight => 1000, p_rate_window_seconds => 12, p_rate_window_max => 2) ->> 'allowed')::boolean,
  true,
  'a place opens exactly one window after the admission that held it'
);

-- ─── A caller from before the window still resolves ──────────────────────────
--
-- Migrations reach production before the code that stops sending the bucket
-- arguments, and a rollback puts that code back. A bucket of one token that
-- all but never refills would refuse the second call; the arguments are
-- accepted in their old positions and decide nothing.
select public.admit_provider_submission('pgtap-legacy', null, 1, 0.0001, 1, 0.0001, 1000, 3600, 60, 60);

select is(
  (public.admit_provider_submission('pgtap-legacy', null, 1, 0.0001, 1, 0.0001, 1000, 3600, 60, 60) ->> 'reason'),
  'admitted',
  'the retired bucket arguments are accepted and ignored'
);

-- ─── A model's share must not take a place in the account window ─────────────
--
-- This is the property that made these one function instead of three. Fill the
-- model's share, then confirm the refused call left the account window alone.

select public.admit_provider_submission('pgtap-share', 'busy-model', p_max_in_flight => 1000, p_rate_window_max => 100, p_model_rate_window_max => 1);

select is(
  (public.admit_provider_submission('pgtap-share', 'busy-model', p_max_in_flight => 1000, p_rate_window_max => 100, p_model_rate_window_max => 1) ->> 'reason'),
  'model_rate_limited',
  'a model at its share is refused even when the account window has room'
);

select ok(
  (public.admit_provider_submission('pgtap-share', 'busy-model', p_max_in_flight => 1000, p_rate_window_max => 100, p_model_rate_window_max => 1) ->> 'retryAfterSeconds')::integer between 11 and 12,
  'a model refusal says when the model''s own place opens'
);

select is(
  (select cardinality(admitted_at) from public.provider_admission_buckets where scope = 'pgtap-share'),
  1,
  'the model refusals took no place in the account window'
);

select is(
  (public.admit_provider_submission('pgtap-share', 'quiet-model', p_max_in_flight => 1000, p_rate_window_max => 100, p_model_rate_window_max => 1) ->> 'reason'),
  'admitted',
  'another model is admitted while one model is at its share'
);

select is(
  (public.admit_provider_submission('pgtap-share', 'busy-model', p_max_in_flight => 1000, p_rate_window_max => 100) ->> 'reason'),
  'admitted',
  'a caller that names no share is held to the account window only'
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

-- The probe is a request the provider counts, so the admissions that follow a
-- recovery see it in the window.
select is(
  (select cardinality(admitted_at) from public.provider_admission_buckets where scope = 'pgtap-breaker'),
  1,
  'the probe is recorded in the rate window'
);

-- A window that filled before the circuit opened must not keep the probe out,
-- or the breaker could never close.
select public.admit_provider_submission('pgtap-probe-full', p_max_in_flight => 1000, p_rate_window_max => 1);
select public.record_provider_submission_outcome('pgtap-probe-full', false, 1, 60, null);
update public.provider_circuit_breakers
set half_open_at = now() - interval '1 second'
where service = 'pgtap-probe-full';

select is(
  (public.admit_provider_submission('pgtap-probe-full', p_max_in_flight => 1000, p_rate_window_max => 1) ->> 'reason'),
  'circuit_probe',
  'the probe is admitted through a full rate window'
);

select * from finish();
rollback;
