-- Invite codes a person can say (20261111073612): every invite has a six-character
-- code, a visit can be recorded from it in either case, and a typed code replaces an
-- invite held from before unless it is the same one.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(34);

-- ─── The column and its maker ───────────────────────────────────────────────

SELECT col_not_null('public', 'referral_codes', 'short_code', 'every invite has a short code');
SELECT col_has_default('public', 'referral_codes', 'short_code', 'a new invite draws one by itself');
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'referral_codes'
      AND indexname = 'referral_codes_short_code_key' AND indexdef LIKE 'CREATE UNIQUE INDEX%'
  ),
  'short codes are unique'
);
SELECT ok(
  (SELECT bool_and(public.new_referral_short_code() ~ '^[2-9A-HJ-NP-Z]{6}$') FROM generate_series(1, 500)),
  'drawn codes use six characters without 0, O, 1 or I'
);
SELECT cmp_ok(
  (SELECT count(DISTINCT public.new_referral_short_code()) FROM generate_series(1, 500)),
  '>=', 495::bigint,
  'drawn codes are spread out'
);
SELECT ok(
  NOT has_function_privilege('anon', 'public.new_referral_short_code()', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.new_referral_short_code()', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.new_referral_short_code()', 'EXECUTE'),
  'only the service draws codes'
);
SELECT ok(
  to_regprocedure('public.create_referral_visit(text,text,text,uuid,text,text,text,text)') IS NOT NULL
  AND NOT has_function_privilege('anon', 'public.create_referral_visit(text,text,text,uuid,text,text,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.create_referral_visit(text,text,text,uuid,text,text,text,text)', 'EXECUTE'),
  'the visit keeps its one signature, the service''s alone'
);

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- a1 and a2 invite; b1 is a new account made after its visit.

INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
SELECT
  ('c1000000-0000-4000-8000-0000000000' || suffix)::uuid,
  'short-' || suffix || '@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb,
  now() - interval '10 days'
FROM unnest(ARRAY['a1', 'a2']) AS suffix;

CREATE TEMP TABLE short_codes AS
SELECT
  suffix,
  public.ensure_referral_code(('c1000000-0000-4000-8000-0000000000' || suffix)::uuid) AS answer
FROM unnest(ARRAY['a1', 'a2']) AS suffix;

-- ─── The code of an invite ──────────────────────────────────────────────────

SELECT col_has_check('public', 'referral_codes', 'short_code', 'a code is held to the six-character alphabet');
SELECT ok(
  (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'referral_codes_short_code_check') LIKE '%[2-9A-HJ-NP-Z]{6}%',
  'the alphabet has no 0, O, 1 or I'
);
SELECT throws_ok(
  $$UPDATE public.referral_codes SET short_code = 'ABCDEF' WHERE user_id = 'c1000000-0000-4000-8000-0000000000a1'$$,
  'P0001',
  'referral code identity is immutable',
  'a short code never changes once drawn'
);


SELECT ok(
  (SELECT bool_and(answer ->> 'short_code' ~ '^[2-9A-HJ-NP-Z]{6}$') FROM short_codes),
  'ensure_referral_code names the short code'
);
SELECT is(
  public.ensure_referral_code('c1000000-0000-4000-8000-0000000000a1') ->> 'short_code',
  (SELECT answer ->> 'short_code' FROM short_codes WHERE suffix = 'a1'),
  'the short code stays the same'
);
SELECT is(
  public.get_referral_dashboard('c1000000-0000-4000-8000-0000000000a1') -> 'referral' ->> 'shortCode',
  (SELECT answer ->> 'short_code' FROM short_codes WHERE suffix = 'a1'),
  'the dashboard names it'
);
SELECT is(
  (SELECT count(*) FROM public.referral_codes WHERE short_code IS NULL),
  0::bigint,
  'no invite is left without one'
);

-- ─── A visit from a code ────────────────────────────────────────────────────

CREATE TEMP TABLE short_visits (name text PRIMARY KEY, answer jsonb NOT NULL);

INSERT INTO short_visits
SELECT 'typed_upper', public.create_referral_visit(answer ->> 'short_code', 'web', NULL, NULL, NULL, NULL, NULL, 'code')
FROM short_codes WHERE suffix = 'a1';
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'typed_upper'), 'created', 'a typed code records a visit');
SELECT is(
  (SELECT answer ->> 'code' FROM short_visits WHERE name = 'typed_upper'),
  (SELECT answer ->> 'code' FROM short_codes WHERE suffix = 'a1'),
  'the visit answers with the link code'
);
SELECT is(
  (SELECT kind FROM public.referral_visits WHERE public_token = (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'typed_upper')),
  'code',
  'the visit says it came from a typed code'
);

INSERT INTO short_visits
SELECT 'typed_lower', public.create_referral_visit('  ' || lower(answer ->> 'short_code') || ' ', 'native', NULL, NULL, NULL, NULL, NULL, 'code')
FROM short_codes WHERE suffix = 'a1';
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'typed_lower'), 'created', 'case and spaces around a code do not matter');

INSERT INTO short_visits
SELECT 'link_short', public.create_referral_visit(answer ->> 'short_code', 'web', NULL, NULL, NULL, NULL, NULL, 'invite')
FROM short_codes WHERE suffix = 'a2';
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'link_short'), 'created', 'an invite link may carry the short code');

SELECT is(
  public.create_referral_visit('ZZZZZZ', 'web', NULL, NULL, NULL, NULL, NULL, 'code') ->> 'status',
  'invalid_code',
  'an unknown code is refused'
);
SELECT is(
  public.create_referral_visit('ABCDE0', 'web', NULL, NULL, NULL, NULL, NULL, 'code') ->> 'status',
  'invalid_code',
  'a code no invite could have is refused'
);
SELECT is(
  public.create_referral_visit('anything', 'web', NULL, NULL, NULL, NULL, NULL, 'typed') ->> 'status',
  'invalid_request',
  'only the three kinds are known'
);

-- ─── What a typed code does to an invite held from before ──────────────────

INSERT INTO short_visits
SELECT 'held_invite', public.create_referral_visit(answer ->> 'code', 'web', NULL, NULL, NULL, NULL, NULL, 'invite')
FROM short_codes WHERE suffix = 'a1';

INSERT INTO short_visits
SELECT 'typed_other', public.create_referral_visit(
  (SELECT answer ->> 'short_code' FROM short_codes WHERE suffix = 'a2'), 'web', NULL,
  (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'held_invite'),
  NULL, NULL, NULL, 'code');
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'typed_other'), 'created', 'a typed code replaces another invite held');
SELECT is(
  (SELECT answer ->> 'code' FROM short_visits WHERE name = 'typed_other'),
  (SELECT answer ->> 'code' FROM short_codes WHERE suffix = 'a2'),
  'the typed invite is the one kept'
);

INSERT INTO short_visits
SELECT 'typed_same', public.create_referral_visit(
  (SELECT answer ->> 'short_code' FROM short_codes WHERE suffix = 'a1'), 'web', NULL,
  (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'held_invite'),
  NULL, NULL, NULL, 'code');
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'typed_same'), 'preserved', 'typing the held invite''s own code keeps its visit');
SELECT is(
  (SELECT answer ->> 'visit_token' FROM short_visits WHERE name = 'typed_same'),
  (SELECT answer ->> 'visit_token' FROM short_visits WHERE name = 'held_invite'),
  'the same visit, not a second one'
);
SELECT is(
  (SELECT answer ->> 'short_code' FROM short_visits WHERE name = 'typed_same'),
  (SELECT answer ->> 'short_code' FROM short_codes WHERE suffix = 'a1'),
  'a kept visit names its short code too'
);

SELECT is(
  public.create_referral_visit(
    'ZZZZZZ', 'web', NULL,
    (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'held_invite'),
    NULL, NULL, NULL, 'code') ->> 'status',
  'invalid_code',
  'a wrong typed code is said to be wrong even with an invite held'
);

-- The link rules stay as they were.
INSERT INTO short_visits
SELECT 'link_after_invite', public.create_referral_visit(
  (SELECT answer ->> 'code' FROM short_codes WHERE suffix = 'a2'), 'web', NULL,
  (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'held_invite'),
  NULL, NULL, NULL, 'invite');
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'link_after_invite'), 'preserved', 'a second invite link keeps the first');

INSERT INTO short_visits
SELECT 'shared', public.create_referral_visit(answer ->> 'code', 'web', '/showcase/x', NULL, NULL, NULL, NULL, 'shared_link')
FROM short_codes WHERE suffix = 'a1';
INSERT INTO short_visits
SELECT 'link_after_shared', public.create_referral_visit(
  (SELECT answer ->> 'code' FROM short_codes WHERE suffix = 'a2'), 'web', NULL,
  (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'shared'),
  NULL, NULL, NULL, 'invite');
SELECT is((SELECT answer ->> 'status' FROM short_visits WHERE name = 'link_after_shared'), 'created', 'an invite link still replaces a shared link');

-- Typing the code of the invite a shared link left makes it the typed choice.
INSERT INTO short_visits
SELECT 'shared_again', public.create_referral_visit(answer ->> 'code', 'web', '/showcase/y', NULL, NULL, NULL, NULL, 'shared_link')
FROM short_codes WHERE suffix = 'a1';
INSERT INTO short_visits
SELECT 'typed_over_shared', public.create_referral_visit(
  (SELECT answer ->> 'short_code' FROM short_codes WHERE suffix = 'a1'), 'web', NULL,
  (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'shared_again'),
  NULL, NULL, NULL, 'code');
SELECT is(
  (SELECT kind FROM public.referral_visits WHERE public_token = (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'typed_over_shared')),
  'code',
  'typing a shared link''s own invite code makes it a typed choice'
);
SELECT is(
  public.create_referral_visit(
    (SELECT answer ->> 'code' FROM short_codes WHERE suffix = 'a2'), 'web', NULL,
    (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'typed_over_shared'),
    NULL, NULL, NULL, 'invite') ->> 'status',
  'preserved',
  'which a later invite link no longer replaces'
);

-- ─── A typed code's visit is claimed like any other ─────────────────────────

INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
VALUES ('c1000000-0000-4000-8000-0000000000b1', 'short-b1@example.invalid', 'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb, now() + interval '1 second');

SELECT is(
  public.claim_referral_visit(
    'c1000000-0000-4000-8000-0000000000b1',
    (SELECT (answer ->> 'visit_token')::uuid FROM short_visits WHERE name = 'typed_other')
  ) ->> 'status',
  'claimed',
  'a new account claims a typed code''s invite'
);
SELECT is(
  (SELECT inviter_user_id FROM public.referral_attributions WHERE invitee_user_id = 'c1000000-0000-4000-8000-0000000000b1'),
  'c1000000-0000-4000-8000-0000000000a2'::uuid,
  'and is credited to the typed code''s inviter'
);

SELECT * FROM finish();
ROLLBACK;
