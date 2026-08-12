begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(33);

select ok(
  to_regprocedure('public.record_showcase_feed_events(uuid,text,jsonb)') is not null,
  'the bounded feed-event batch RPC exists'
);
select ok(
  has_function_privilege('service_role', 'public.record_showcase_feed_events(uuid,text,jsonb)', 'EXECUTE'),
  'service_role can execute the batch RPC'
);
select ok(
  not has_function_privilege('anon', 'public.record_showcase_feed_events(uuid,text,jsonb)', 'EXECUTE'),
  'anon cannot execute the privileged batch RPC'
);
select ok(
  not has_function_privilege('authenticated', 'public.record_showcase_feed_events(uuid,text,jsonb)', 'EXECUTE'),
  'authenticated cannot execute the privileged batch RPC'
);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('71000001-0000-4000-8000-000000000001', 'batch-creator@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('71000002-0000-4000-8000-000000000002', 'batch-viewer@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('71000003-0000-4000-8000-000000000003', 'batch-other@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values
  ('72000000-0000-4000-8000-000000000001', '71000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'batch post one'),
  ('72000000-0000-4000-8000-000000000002', '71000001-0000-4000-8000-000000000001', 'public', 'text', 'external', 'text', 'batch post two');

insert into public.feed_sessions (
  id, viewer_user_id, anonymous_key_hash, algorithm_version_id, created_at, expires_at
)
values
  (
    '73000000-0000-4000-8000-000000000001',
    '71000002-0000-4000-8000-000000000002',
    null,
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now(),
    now() + interval '2 hours'
  ),
  (
    '73000000-0000-4000-8000-000000000002',
    null,
    repeat('a', 64),
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now(),
    now() + interval '2 hours'
  ),
  (
    '73000000-0000-4000-8000-000000000003',
    '71000002-0000-4000-8000-000000000002',
    null,
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now(),
    now() + interval '2 hours'
  ),
  (
    '73000000-0000-4000-8000-000000000004',
    '71000002-0000-4000-8000-000000000002',
    null,
    (select id from public.feed_algorithm_versions where status = 'active' limit 1),
    now() - interval '4 hours',
    now() - interval '2 hours'
  );

insert into public.feed_session_items (
  session_id, post_id, position, candidate_source, final_score, served_at
)
values
  ('73000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 0, 'batch-test', 1, now()),
  ('73000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000002', 0, 'batch-test', 1, now()),
  ('73000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000001', 0, 'batch-test', 1, now()),
  ('73000000-0000-4000-8000-000000000004', '72000000-0000-4000-8000-000000000002', 3, 'batch-test', 1, now() - interval '3 hours');

with fixture as (
  select id as delivery_id, session_id
  from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000001'
), recorded as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002',
    repeat('z', 64),
    jsonb_build_array(
      jsonb_build_object(
        'clientEventId', 'batch-happy-impression',
        'feedSessionId', fixture.session_id,
        'deliveryId', fixture.delivery_id,
        'postId', '72000000-0000-4000-8000-000000000001',
        'eventType', 'impression',
        'position', 0,
        'sourceSurface', 'feed',
        'occurredAt', now(),
        'metadata', '{}'::jsonb
      ),
      jsonb_build_object(
        'clientEventId', 'batch-happy-feedback',
        'postId', '72000000-0000-4000-8000-000000000001',
        'eventType', 'not_interested',
        'position', 0,
        'sourceSurface', 'feed',
        'occurredAt', now(),
        'metadata', '{}'::jsonb
      )
    )
  ) as result
  from fixture
)
select is(
  (select result->>'recorded' from recorded),
  '2',
  'a signed-in happy batch records every entry'
);

select is(
  (select count(*)::integer from public.feed_events where client_event_id like 'batch-happy-%'),
  2,
  'the happy batch writes exactly two events'
);
select is(
  (select count(*)::integer from public.feed_user_post_feedback where user_id = '71000002-0000-4000-8000-000000000002' and post_id = '72000000-0000-4000-8000-000000000001'),
  1,
  'feedback is persisted after its event'
);

with fixture as (
  select id as delivery_id, session_id
  from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000001'
), replayed as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(
      jsonb_build_object('clientEventId', 'batch-happy-impression', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'impression', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb),
      jsonb_build_object('clientEventId', 'batch-happy-feedback', 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'not_interested', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb)
    )
  ) as result
  from fixture
)
select ok(
  (select (result->'outcomes'->0->>'duplicate')::boolean and (result->'outcomes'->1->>'duplicate')::boolean from replayed),
  'an exact replay returns duplicate outcomes'
);
select is(
  (select count(*)::integer from public.feed_events where client_event_id like 'batch-happy-%'),
  2,
  'an exact replay does not add rows'
);

with mixed as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(
      jsonb_build_object('clientEventId', 'batch-mixed-valid', 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'unsave', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb),
      jsonb_build_object('clientEventId', 'batch-happy-impression', 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'impression', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb)
    )
  ) as result
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->1->>'status') from mixed),
  '1/1/409',
  'a mismatched client ID is a per-entry 409 while its sibling commits'
);
select is(
  (select count(*)::integer from public.feed_events where client_event_id = 'batch-mixed-valid'),
  1,
  'the valid sibling in a mismatched replay batch is durable'
);

with capped as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(
      jsonb_build_object('clientEventId', 'batch-capped-feedback', 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'not_interested', 'position', 0, 'sourceSurface', 'showcase-reel', 'occurredAt', now(), 'metadata', '{}'::jsonb)
    )
  ) as result
)
select ok(
  (select (result->'outcomes'->0->>'duplicate')::boolean from capped),
  'a capped per-viewer signal resolves as an idempotent duplicate'
);
select is(
  (select count(*)::integer from public.feed_events where viewer_user_id = '71000002-0000-4000-8000-000000000002' and post_id = '72000000-0000-4000-8000-000000000001' and event_type = 'not_interested'),
  1,
  'the capped duplicate remains one event row'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000003'
), capped_with_new_delivery as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-capped-feedback-delivered', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'not_interested', 'position', 0, 'sourceSurface', 'showcase-reel', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select ok(
  (select (result->'outcomes'->0->>'duplicate')::boolean from capped_with_new_delivery),
  'a new delivery still falls through to the signed-in viewer/post cap'
);

select public.record_showcase_feed_events(
  '71000002-0000-4000-8000-000000000002', repeat('z', 64),
  jsonb_build_array(jsonb_build_object('clientEventId', 'batch-hide-first', 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'hide_creator', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000003'
), capped_hide_with_delivery as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-hide-delivered', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'hide_creator', 'position', 0, 'sourceSurface', 'showcase-reel', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select ok(
  (select (result->'outcomes'->0->>'duplicate')::boolean from capped_hide_with_delivery),
  'a new delivery still falls through to the signed-in viewer/creator cap'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000001'
)
select public.record_showcase_feed_events(
  '71000002-0000-4000-8000-000000000002', repeat('z', 64),
  jsonb_build_array(jsonb_build_object('clientEventId', 'batch-progress-1', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'media_progress', 'position', 0, 'durationMs', 100, 'progress', 0.4, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
) from fixture;
with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000001'
)
select public.record_showcase_feed_events(
  '71000002-0000-4000-8000-000000000002', repeat('z', 64),
  jsonb_build_array(jsonb_build_object('clientEventId', 'batch-progress-2', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'media_progress', 'position', 0, 'durationMs', 200, 'progress', 0.8, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
) from fixture;

select is(
  (select progress from public.feed_events where event_type = 'media_progress' and session_id = '73000000-0000-4000-8000-000000000001'),
  0.8::double precision,
  'media progress delegates to the GREATEST upsert for progress'
);
select is(
  (select duration_ms from public.feed_events where event_type = 'media_progress' and session_id = '73000000-0000-4000-8000-000000000001'),
  200,
  'media progress keeps the greatest duration'
);
select is(
  (select count(*)::integer from public.feed_events where event_type = 'media_progress' and session_id = '73000000-0000-4000-8000-000000000001'),
  1,
  'repeated media progress keeps one row'
);

with poison as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(
      jsonb_build_object('clientEventId', 'batch-poison-valid', 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'unsave', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb),
      jsonb_build_object('clientEventId', 'batch-poison-authoritative', 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'purchase', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb)
    )
  ) as result
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->1->>'status') from poison),
  '1/1/400',
  'a poison authoritative event is isolated from its valid sibling'
);
select is(
  (select count(*)::integer from public.feed_events where client_event_id = 'batch-poison-valid'),
  1,
  'the poison entry savepoint leaves the valid sibling committed'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000002'
), guest as (
  select public.record_showcase_feed_events(
    null, repeat('a', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-guest-impression', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'impression', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is((select result->>'recorded' from guest), '1', 'a guest batch records against its anonymous delivery');
select is(
  (select anonymous_key_hash from public.feed_events where client_event_id = 'batch-guest-impression'),
  repeat('a', 64),
  'the guest event stores only the anonymous identity hash'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000001'
), wrong_viewer as (
  select public.record_showcase_feed_events(
    '71000003-0000-4000-8000-000000000003', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-wrong-viewer', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'open', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->0->>'status') from wrong_viewer),
  '0/1/400',
  'a signed-in viewer cannot use another viewer session'
);
select is(
  (select count(*)::integer from public.feed_events where client_event_id = 'batch-wrong-viewer'),
  0,
  'the cross-identity event is not inserted'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000004'
), delayed as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-delayed-valid', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'impression', 'position', 3, 'sourceSurface', 'feed', 'occurredAt', now() - interval '3 hours', 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') from delayed),
  '1/0',
  'a queued first event is accepted after expiry when it occurred during the session and remains under 24 hours old'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000004'
), outside_session as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-delayed-after-expiry', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'open', 'position', 3, 'sourceSurface', 'feed', 'occurredAt', now() - interval '1 hour', 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->0->>'status') from outside_session),
  '0/1/400',
  'an event that occurred after session expiry is isolated as invalid'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000002'
), account_using_guest as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('a', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-account-guest-session', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'open', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->0->>'status') from account_using_guest),
  '0/1/400',
  'an authenticated actor cannot claim an anonymous feed session'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000001'
), guest_using_account as (
  select public.record_showcase_feed_events(
    null, repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-guest-account-session', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'open', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->0->>'status') from guest_using_account),
  '0/1/400',
  'an anonymous actor cannot claim an authenticated feed session'
);

with malformed as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(
      jsonb_build_object('clientEventId', 'batch-malformed-valid-sibling', 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'unsave', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb),
      jsonb_build_object('clientEventId', 'batch-malformed-uuid', 'postId', 'not-a-uuid', 'eventType', 'unsave', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb),
      jsonb_build_object('clientEventId', 'batch-malformed-bigint', 'deliveryId', 'not-a-bigint', 'postId', '72000000-0000-4000-8000-000000000002', 'eventType', 'open', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb)
    )
  ) as result
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->1->>'status') || '/' || (result->'outcomes'->2->>'status') from malformed),
  '1/2/400/400',
  'malformed UUID and bigint entries are isolated while a valid sibling commits'
);

with fixture as (
  select id as delivery_id, session_id from public.feed_session_items
  where session_id = '73000000-0000-4000-8000-000000000003'
), wrong_position as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-wrong-position', 'feedSessionId', fixture.session_id, 'deliveryId', fixture.delivery_id, 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'open', 'position', 99, 'sourceSurface', 'feed', 'occurredAt', now(), 'metadata', '{}'::jsonb))
  ) as result from fixture
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->0->>'status') from wrong_position),
  '0/1/400',
  'a delivery position mismatch is isolated before the context trigger runs'
);

with too_old as (
  select public.record_showcase_feed_events(
    '71000002-0000-4000-8000-000000000002', repeat('z', 64),
    jsonb_build_array(jsonb_build_object('clientEventId', 'batch-too-old', 'postId', '72000000-0000-4000-8000-000000000001', 'eventType', 'unsave', 'position', 0, 'sourceSurface', 'feed', 'occurredAt', now() - interval '25 hours', 'metadata', '{}'::jsonb))
  ) as result
)
select is(
  (select (result->>'recorded') || '/' || (result->>'rejected') || '/' || (result->'outcomes'->0->>'status') from too_old),
  '0/1/400',
  'the privileged RPC enforces the same 24-hour ingestion bound as the public parser'
);

select throws_ok(
  $$ select public.record_showcase_feed_events(null, repeat('a', 64), '[]'::jsonb) $$,
  'P0001',
  'Feed event batch must contain between 1 and 25 entries',
  'the RPC rejects an empty batch even when called by a privileged role'
);
select throws_ok(
  $$ select public.record_showcase_feed_events(null, repeat('a', 64), (select jsonb_agg(jsonb_build_object('clientEventId', value)) from generate_series(1, 26) as value)) $$,
  'P0001',
  'Feed event batch must contain between 1 and 25 entries',
  'the RPC rejects more than 25 entries'
);

select * from finish();
rollback;
