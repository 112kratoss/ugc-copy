-- F15a: the database end of the cost-report chain.
--
-- This function replaces JS that was already unit-tested, so the risk the audit
-- named is coverage moving somewhere the tests do not reach: "converting them
-- makes the builders thin adapters and moves the arithmetic into SQL, where
-- those tests no longer reach it". This file is where it is reached.
--
-- The fixture is the same one `src/__tests__/backend-cost-aggregates.test.ts`
-- uses, and every row exists to hit a semantic that a plain group-by would get
-- wrong. Together the two files pin the whole chain:
--
--   raw rows --> aggregate payload   (here)
--   aggregate payload --> report  ==  raw rows --> report   (vitest)

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

-- ─── Fixture ─────────────────────────────────────────────────────────────────

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values ('0000f15a-0000-4000-9000-000000000001'::uuid, 'f15a-agg@example.invalid',
        'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.generations (id, user_id, status, model, cost, output_url, created_at)
values
  ('0000f15a-0000-4000-9001-000000000001'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'succeeded', 'nano-banana-2', 8, 'generated_images/a.png', now() - interval '1 hour'),
  ('0000f15a-0000-4000-9001-000000000002'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'succeeded', 'nano-banana-2', 3, '', now() - interval '2 hours'),
  ('0000f15a-0000-4000-9001-000000000003'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'completed', 'veo-3.1', 25, 'generated_videos/b.mp4', now() - interval '3 hours'),
  ('0000f15a-0000-4000-9001-000000000004'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'failed', 'veo-3.1', 12, null, now() - interval '4 hours'),
  ('0000f15a-0000-4000-9001-000000000005'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'failed', 'veo-3.1', 0, null, now() - interval '5 hours'),
  ('0000f15a-0000-4000-9001-000000000006'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   null, null, -50, null, now() - interval '6 hours'),
  ('0000f15a-0000-4000-9001-000000000007'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'succeeded', 'nano-banana-2', 999, 'generated_images/old.png', now() - interval '40 hours');

insert into public.ai_usage_events (id, user_id, feature, provider, model, cost, status, created_at)
values
  ('0000f15a-0000-4000-9002-000000000001'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'prompt-assist', 'kie', 'gpt', 4, 'succeeded', now() - interval '1 hour'),
  ('0000f15a-0000-4000-9002-000000000002'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'prompt-assist', 'kie', 'gpt', 6, 'failed', now() - interval '2 hours'),
  ('0000f15a-0000-4000-9002-000000000003'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'caption', 'kie', 'gpt', 0, 'succeeded', now() - interval '3 hours'),
  ('0000f15a-0000-4000-9002-000000000004'::uuid, '0000f15a-0000-4000-9000-000000000001'::uuid,
   'caption', 'kie', 'gpt', 7, 'succeeded', now() - interval '30 hours');

insert into public.provider_dependency_events (id, service_name, outcome, method, timeout_ms, duration_ms, model_id, created_at)
values
  ('0000f15a-0000-4000-9003-000000000001'::uuid, 'kie', 'success', 'POST', 30000, 900, 'veo-3.1', now() - interval '1 hour'),
  ('0000f15a-0000-4000-9003-000000000002'::uuid, 'kie', 'http_error', 'POST', 30000, 1200, 'veo-3.1', now() - interval '2 hours'),
  ('0000f15a-0000-4000-9003-000000000003'::uuid, 'kie', 'timeout', 'POST', 30000, 30000, 'veo-3.1', now() - interval '3 hours'),
  ('0000f15a-0000-4000-9003-000000000004'::uuid, 'kie', 'success', 'POST', 30000, 15000, null, now() - interval '4 hours'),
  ('0000f15a-0000-4000-9003-000000000005'::uuid, 'razorpay', 'success', 'POST', 30000, 300, '   ', now() - interval '5 hours'),
  ('0000f15a-0000-4000-9003-000000000006'::uuid, 'razorpay', 'network_error', 'POST', 30000, 400, null, now() - interval '6 hours'),
  ('0000f15a-0000-4000-9003-000000000007'::uuid, 'kie', 'success', 'POST', 30000, 100, 'veo-3.1', now() - interval '40 hours');

insert into public.backend_rate_limits (scope, subject_key, window_start, request_count)
values
  ('generation-model:quote', 'f15a-user-1', now() - interval '1 hour', 40),
  ('generation-model:quote', 'f15a-user-2', now() - interval '2 hours', 60),
  ('media-read:sign', 'f15a-user-1', now() - interval '1 hour', 130),
  ('showcase-preview:read-url', 'f15a-user-1', now() - interval '2 hours', 25),
  ('post-comments:list', 'f15a-user-1', now() - interval '3 hours', 9),
  ('media-read:sign', 'f15a-user-9', now() - interval '40 hours', 5000);

insert into storage.buckets (id, name, public)
values ('generated_images', 'generated_images', true),
       ('generated_videos', 'generated_videos', true),
       ('showcase_media', 'showcase_media', true)
on conflict (id) do nothing;

insert into storage.objects (id, bucket_id, name, metadata, created_at)
values
  (gen_random_uuid(), 'generated_images', 'f15a/a.png', '{"size": 1024}'::jsonb, now() - interval '1 hour'),
  (gen_random_uuid(), 'generated_images', 'f15a/b.png', '{"size": "2048"}'::jsonb, now() - interval '2 hours'),
  (gen_random_uuid(), 'generated_images', 'f15a/c.png', '{"size": "not-a-number"}'::jsonb, now() - interval '3 hours'),
  (gen_random_uuid(), 'generated_videos', 'f15a/d.mp4', '{"mimetype": "video/mp4"}'::jsonb, now() - interval '4 hours'),
  (gen_random_uuid(), 'generated_videos', 'f15a/e.mp4', '"scalar"'::jsonb, now() - interval '5 hours'),
  (gen_random_uuid(), 'generated_videos', 'f15a/f.mp4', '{"size": 9000000}'::jsonb, now() - interval '6 hours'),
  (gen_random_uuid(), 'showcase_media', 'f15a/g.png', '{"size": 555}'::jsonb, now() - interval '1 hour'),
  (gen_random_uuid(), 'generated_images', 'f15a/h.png', '{"size": 777}'::jsonb, now() - interval '40 hours');

create temporary table f15a_result as
select public.get_backend_cost_aggregates(
  now() - interval '24 hours',
  ARRAY['generated_images', 'generated_videos', 'generated_audio', 'generation_inputs'],
  15000
) as payload;

-- ─── Window ──────────────────────────────────────────────────────────────────

select is(
  (select (payload -> 'generations' ->> 'rowCount')::bigint from f15a_result),
  6::bigint,
  'the window excludes rows older than p_since rather than counting the table'
);

-- ─── generations ─────────────────────────────────────────────────────────────

select is(
  (select (payload -> 'generations' ->> 'recentCreditCost')::numeric from f15a_result),
  48::numeric,
  'a negative cost clamps to 0 instead of subtracting from the total'
);

select is(
  (select (payload -> 'generations' ->> 'completedOutputCount')::bigint from f15a_result),
  2::bigint,
  'an empty output_url does not count as an output -- it is falsy in the JS this replaces'
);

select is(
  (select (payload -> 'generations' ->> 'failedPaidCount')::bigint from f15a_result),
  1::bigint,
  'a failed generation that cost nothing is not a failed *paid* generation'
);

select is(
  (select payload -> 'generations' -> 'byStatus' from f15a_result),
  '{"failed": 12, "unknown": 0, "completed": 25, "succeeded": 11}'::jsonb,
  'a null status groups under unknown, and a zero-cost group still gets a key'
);

select is(
  (select payload -> 'generations' -> 'byModel' from f15a_result),
  '{"unknown": 0, "veo-3.1": 37, "nano-banana-2": 11}'::jsonb,
  'cost sums per model, with nulls under unknown'
);

-- ─── ai_usage_events ─────────────────────────────────────────────────────────

select is(
  (select payload -> 'aiUsage' -> 'byFeature' from f15a_result),
  '{"caption": 0, "prompt-assist": 10}'::jsonb,
  'a feature whose only event was free keeps its key at 0 rather than disappearing'
);

select is(
  (select (payload -> 'aiUsage' ->> 'failedCount')::bigint from f15a_result),
  1::bigint,
  'ai usage failures count by status'
);

-- ─── provider_dependency_events ──────────────────────────────────────────────

select is(
  (select (payload -> 'providerDependencies' ->> 'failedCount')::bigint from f15a_result),
  3::bigint,
  'every outcome that is not success counts as a failure, timeouts included'
);

select is(
  (select (payload -> 'providerDependencies' ->> 'slowCount')::bigint from f15a_result),
  2::bigint,
  'slow is measured on duration alone, so a slow success still counts'
);

select is(
  (select payload -> 'providerDependencies' -> 'byModel' from f15a_result),
  '{"veo-3.1": 3}'::jsonb,
  'a blank model id is excluded from per-model counts, not bucketed under a placeholder'
);

-- This is the assertion most likely to break under a well-meaning rewrite:
-- `count(*) FILTER (WHERE ...)` grouped by service would emit {"razorpay": 0}
-- here, because razorpay has calls but no timeouts. The JS only ever increments
-- on an actual timeout, so the key must be absent.
select is(
  (select payload -> 'providerDependencies' -> 'timeoutsByService' from f15a_result),
  '{"kie": 1}'::jsonb,
  'a service with no timeouts is absent from timeoutsByService, not present with 0'
);

select is(
  (select (payload -> 'providerDependencies' ->> 'maxDurationMs')::bigint from f15a_result),
  30000::bigint,
  'max duration is the window maximum'
);

-- ─── backend_rate_limits ─────────────────────────────────────────────────────

-- No quoteRequests/mediaReadRequests here on purpose: which scopes count as a
-- media read is policy and lives in backend-cost-report.ts. If this object ever
-- grows those keys, the policy has forked into two places.
select is(
  (select payload -> 'rateLimits' -> 'byScope' from f15a_result),
  '{"media-read:sign": 130, "post-comments:list": 9, "generation-model:quote": 100, "showcase-preview:read-url": 25}'::jsonb,
  'request counts sum per scope, and the scope split stays out of SQL'
);

-- ─── storage.objects ─────────────────────────────────────────────────────────

select is(
  (select payload -> 'storage' -> 'bytesByBucket' from f15a_result),
  '{"generated_images": 3072, "generated_videos": 9000000}'::jsonb,
  'a numeric-string size parses, and non-numeric, missing or non-object metadata reads as 0 rather than raising'
);

select is(
  (select (payload -> 'storage' ->> 'rowCount')::bigint from f15a_result),
  6::bigint,
  'buckets outside the generated set are filtered out rather than summed'
);

select * from finish();
rollback;
