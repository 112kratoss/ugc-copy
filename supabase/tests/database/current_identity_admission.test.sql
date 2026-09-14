begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

-- Fixtures: an active account with a live session, a banned account, an
-- account whose profile is missing, a merged guest, a soft-deleted account.
insert into auth.users (
  id, email, aud, role, is_anonymous, raw_app_meta_data, raw_user_meta_data,
  created_at, banned_until, deleted_at
) values
  ('a2000000-0000-4000-8000-000000000001'::uuid, 'admission-active@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb,
   '2026-08-22T00:00:00Z', null, null),
  ('b2000000-0000-4000-8000-000000000002'::uuid, 'admission-banned@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb,
   '2026-08-22T00:00:00Z', timezone('utc'::text, now()) + interval '1 hour', null),
  ('c2000000-0000-4000-8000-000000000003'::uuid, 'admission-unprofiled@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb,
   '2026-08-22T00:00:00Z', null, null),
  ('d2000000-0000-4000-8000-000000000004'::uuid, null,
   'authenticated', 'authenticated', true, '{}'::jsonb, '{}'::jsonb,
   '2026-08-22T00:00:00Z', null, null),
  ('e2000000-0000-4000-8000-000000000005'::uuid, 'admission-deleted@example.invalid',
   'authenticated', 'authenticated', false, '{}'::jsonb, '{}'::jsonb,
   '2026-08-22T00:00:00Z', null, timezone('utc'::text, now()));

insert into auth.sessions (id, user_id, created_at, updated_at) values
  ('f2000000-0000-4000-8000-000000000011'::uuid,
   'a2000000-0000-4000-8000-000000000001'::uuid,
   timezone('utc'::text, now()), timezone('utc'::text, now())),
  ('f2000000-0000-4000-8000-000000000012'::uuid,
   'b2000000-0000-4000-8000-000000000002'::uuid,
   timezone('utc'::text, now()), timezone('utc'::text, now()));

delete from public.profiles where id = 'c2000000-0000-4000-8000-000000000003'::uuid;

update public.profiles
set merged_into_user_id = 'a2000000-0000-4000-8000-000000000001'::uuid,
    merged_at = timezone('utc'::text, now())
where id = 'd2000000-0000-4000-8000-000000000004'::uuid;

select is(
  has_function_privilege('anon', 'public.current_identity_admission()', 'EXECUTE'),
  false,
  'anon cannot execute the admission RPC'
);
select is(
  has_function_privilege('authenticated', 'public.current_identity_admission()', 'EXECUTE'),
  true,
  'authenticated can execute the admission RPC'
);
select is(
  has_function_privilege('service_role', 'public.current_identity_admission()', 'EXECUTE'),
  true,
  'service_role can execute the admission RPC'
);

-- Active account, live session.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f2000000-0000-4000-8000-000000000011"}',
  true
);
select is(public.current_identity_admission() ->> 'state', 'active',
  'an active account reports its lifecycle state');
select is((public.current_identity_admission() ->> 'session_valid')::boolean, true,
  'a session that still exists is valid');
select is((public.current_identity_admission() ->> 'banned')::boolean, false,
  'an account without a ban is not banned');
select is(
  (public.current_identity_admission() ->> 'created_at')::timestamptz,
  '2026-08-22T00:00:00Z'::timestamptz,
  'created_at comes from auth.users'
);
select ok(
  public.current_identity_admission() ->> 'created_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}',
  'created_at is serialized as an ISO 8601 timestamp'
);

-- Same account, a session id that no longer exists (signed out elsewhere or
-- revoked): the token is still validly signed but must be refused.
select set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f2000000-0000-4000-8000-0000000000ff"}',
  true
);
select is((public.current_identity_admission() ->> 'session_valid')::boolean, false,
  'a revoked session is reported invalid');

-- A session that exists but belongs to another user never validates a token.
select set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"f2000000-0000-4000-8000-000000000012"}',
  true
);
select is((public.current_identity_admission() ->> 'session_valid')::boolean, false,
  'another account''s session does not validate this subject');

-- A malformed session claim fails closed instead of raising.
select set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated","session_id":"not-a-uuid"}',
  true
);
select is((public.current_identity_admission() ->> 'session_valid')::boolean, false,
  'a malformed session claim is reported invalid');

-- Tokens without a session claim (legacy shape) keep GoTrue''s behaviour.
select set_config(
  'request.jwt.claims',
  '{"sub":"a2000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select is((public.current_identity_admission() ->> 'session_valid')::boolean, true,
  'a token without a session claim is not refused for it');

-- Banned account.
select set_config(
  'request.jwt.claims',
  '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"f2000000-0000-4000-8000-000000000012"}',
  true
);
select is((public.current_identity_admission() ->> 'banned')::boolean, true,
  'an account with a future banned_until is banned');
select is(public.current_identity_admission() ->> 'state', 'active',
  'the ban does not hide the lifecycle state');

reset role;
update auth.users
set banned_until = timezone('utc'::text, now()) - interval '1 hour'
where id = 'b2000000-0000-4000-8000-000000000002'::uuid;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"b2000000-0000-4000-8000-000000000002","role":"authenticated","session_id":"f2000000-0000-4000-8000-000000000012"}',
  true
);
select is((public.current_identity_admission() ->> 'banned')::boolean, false,
  'an expired ban no longer counts');

-- Account without a profile: the lifecycle state is unknown, so the proxy
-- must fail closed (503) rather than admit or reject as a bad token.
select set_config(
  'request.jwt.claims',
  '{"sub":"c2000000-0000-4000-8000-000000000003","role":"authenticated"}',
  true
);
select isnt(public.current_identity_admission(), null,
  'an account without a profile still returns an admission object');
select is(public.current_identity_admission() -> 'state', 'null'::jsonb,
  'a missing profile reports a null lifecycle state');

-- Merged guest.
select set_config(
  'request.jwt.claims',
  '{"sub":"d2000000-0000-4000-8000-000000000004","role":"authenticated"}',
  true
);
select is(public.current_identity_admission() ->> 'state', 'merged',
  'a merged guest reports the merged state');

-- Soft-deleted account and unknown subject: no admission at all.
select set_config(
  'request.jwt.claims',
  '{"sub":"e2000000-0000-4000-8000-000000000005","role":"authenticated"}',
  true
);
select is(public.current_identity_admission(), null,
  'a soft-deleted account gets no admission');
select set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000aa","role":"authenticated"}',
  true
);
select is(public.current_identity_admission(), null,
  'an unknown subject gets no admission');

-- The function inspects only the caller: another subject''s data is never
-- addressable, because there is no argument to ask with.
select is(
  (select pronargs from pg_proc where proname = 'current_identity_admission'
     and pronamespace = 'public'::regnamespace),
  0::smallint,
  'the admission RPC takes no arguments'
);

select * from finish();
rollback;
