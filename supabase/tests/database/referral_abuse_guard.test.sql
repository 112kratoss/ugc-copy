-- Invite & Earn abuse guard (20261109213008): who may reach it, what a claim
-- decides from the device and identity it is given, what settlement pays, what
-- an operator can change, and what retention clears.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(96);

-- ─── Who may reach it ───────────────────────────────────────────────────────

SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.referral_account_devices'::regclass), 'account devices have RLS');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.referral_review_events'::regclass), 'review events have RLS');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid='public.deleted_account_identity_fingerprints'::regclass), 'deleted identities have RLS');
SELECT ok(NOT has_table_privilege('anon','public.referral_account_devices','SELECT,INSERT,UPDATE,DELETE'), 'anonymous device access denied');
SELECT ok(NOT has_table_privilege('authenticated','public.referral_account_devices','SELECT,INSERT,UPDATE,DELETE'), 'authenticated device access denied');
SELECT ok(NOT has_table_privilege('anon','public.referral_review_events','SELECT,INSERT,UPDATE,DELETE'), 'anonymous review access denied');
SELECT ok(NOT has_table_privilege('authenticated','public.referral_review_events','SELECT,INSERT,UPDATE,DELETE'), 'authenticated review access denied');
SELECT ok(NOT has_table_privilege('anon','public.deleted_account_identity_fingerprints','SELECT,INSERT,UPDATE,DELETE'), 'anonymous identity access denied');
SELECT ok(NOT has_table_privilege('authenticated','public.deleted_account_identity_fingerprints','SELECT,INSERT,UPDATE,DELETE'), 'authenticated identity access denied');
SELECT ok(has_table_privilege('service_role','public.referral_review_events','SELECT') AND has_table_privilege('service_role','public.referral_review_events','INSERT'), 'service reads and appends the review trail');
SELECT ok(NOT has_table_privilege('service_role','public.referral_review_events','UPDATE,DELETE'), 'service cannot rewrite the review trail');
SELECT ok(NOT has_table_privilege('service_role','public.deleted_account_identity_fingerprints','UPDATE,DELETE'), 'service cannot forget a deleted identity');
SELECT ok(to_regprocedure('public.claim_referral_visit(uuid,uuid)') IS NULL, 'the two-argument claim is gone, not overloaded');
SELECT ok(to_regprocedure('public.create_referral_visit(text,text,text,uuid,text,text)') IS NULL, 'the six-argument visit is gone, not overloaded');
SELECT ok(
  NOT has_function_privilege('anon', f, 'EXECUTE') AND NOT has_function_privilege('authenticated', f, 'EXECUTE') AND has_function_privilege('service_role', f, 'EXECUTE'),
  f || ' is the service''s alone'
) FROM unnest(ARRAY[
  'public.claim_referral_visit(uuid,uuid,text[])',
  'public.create_referral_visit(text,text,text,uuid,text,text,text)',
  'public.record_referral_account_device(uuid,text,text)',
  'public.set_referral_attribution_reward_state(uuid,text,text,uuid)',
  'public.set_referral_code_enabled(uuid,boolean,text,uuid)',
  'public.prune_referral_risk_signals(integer)',
  'public.referral_device_hash(text)'
]) AS f;

-- The server computes this digest in src/lib/referral-device.ts; one vector for both.
SELECT is(
  public.referral_device_hash('fid_' || repeat('a', 64)),
  '0b1a0e16d16cdf199bedd04aad6ba553e386be0f628030d83a418ffd44d78985',
  'the device digest matches the server''s'
);

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- a1 invites. a2 is an unrelated account. e1 is the operator. f1..f9 are new
-- accounts, made in this transaction, so none is older than its visit.

INSERT INTO auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data, created_at)
SELECT
  ('c0000000-0000-4000-8000-0000000000' || suffix)::uuid,
  'guard-' || suffix || '@example.invalid',
  'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb,
  CASE WHEN suffix LIKE 'f%' THEN now() ELSE now() - interval '10 days' END
FROM unnest(ARRAY['a1','a2','e1','f1','f2','f3','f4','f5','f6','f7','f8','f9']) AS suffix;

CREATE TEMP TABLE guard_code AS
SELECT (public.ensure_referral_code('c0000000-0000-4000-8000-0000000000a1') ->> 'code') AS code;

-- Each visit: a name, the network, the device that opened the link.
CREATE TEMP TABLE guard_visits (name text PRIMARY KEY, token uuid NOT NULL);
INSERT INTO guard_visits
SELECT spec.name, (public.create_referral_visit(guard_code.code, 'web', NULL, NULL, spec.ip, NULL, spec.device) ->> 'visit_token')::uuid
FROM guard_code, (VALUES
  ('clean',     repeat('d', 64), repeat('1', 64)),
  ('own',       repeat('d', 64), repeat('a', 64)),
  ('reused',    repeat('d', 64), repeat('1', 64)),
  ('app',       repeat('d', 64), public.referral_device_hash('fid_' || repeat('e', 64))),
  ('flagged',   repeat('c', 64), repeat('b', 64)),
  ('rereg',     repeat('d', 64), repeat('2', 64)),
  ('later',     repeat('d', 64), repeat('3', 64)),
  ('welcome',   repeat('d', 64), repeat('4', 64)),
  ('garbage',   repeat('d', 64), repeat('5', 64)),
  ('nodevice',  NULL,            NULL)
) AS spec(name, ip, device);

SELECT is((SELECT count(*)::int FROM public.referral_visits WHERE device_hash IS NOT NULL AND inviter_user_id = 'c0000000-0000-4000-8000-0000000000a1'), 9, 'a visit keeps the device that opened it');

-- The inviter used the program from device a, on network c; a2 owns device b.
SELECT public.record_referral_account_device('c0000000-0000-4000-8000-0000000000a1', repeat('a', 64), repeat('c', 64));
SELECT public.record_referral_account_device('c0000000-0000-4000-8000-0000000000a2', repeat('b', 64), repeat('f', 64));
SELECT is((SELECT count(*)::int FROM public.referral_account_devices), 2, 'an account''s devices are recorded');
SELECT public.record_referral_account_device('c0000000-0000-4000-8000-0000000000a1', 'not-a-digest', NULL);
SELECT public.record_referral_account_device(gen_random_uuid(), repeat('a', 64), NULL);
SELECT is((SELECT count(*)::int FROM public.referral_account_devices), 2, 'a malformed digest and an unknown account record nothing');

-- The inviter signed in to the app on installation e.
INSERT INTO public.onboarding_events (client_event_id, installation_id, user_id, flow_version, platform, event_name, occurred_at)
VALUES (gen_random_uuid(), 'fid_' || repeat('e', 64), 'c0000000-0000-4000-8000-0000000000a1', 1, 'ios', 'auth_succeeded', now());

-- ─── What a claim decides ───────────────────────────────────────────────────

SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f1', (SELECT token FROM guard_visits WHERE name = 'clean')) ->> 'reward_state',
  'eligible', 'a friend on their own device is eligible'
);
SELECT ok(EXISTS(SELECT 1 FROM public.referral_account_devices WHERE user_id = 'c0000000-0000-4000-8000-0000000000f1' AND device_hash = repeat('1', 64)), 'the friend''s device is remembered');
SELECT is((SELECT risk_flags FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f1'), '{}'::text[], 'a clean referral carries no flags');

SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f2', (SELECT token FROM guard_visits WHERE name = 'own')) ->> 'reward_state',
  'blocked', 'a friend who signs up on the inviter''s device is recorded but blocked'
);
SELECT is((SELECT reward_state_reason FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f2'), 'same_device_as_inviter', 'the block says why');
SELECT is((SELECT reward_state_source FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f2'), 'system', 'the guard''s block is the system''s');
SELECT is(
  (SELECT count(*)::int FROM public.referral_review_events AS events
   JOIN public.referral_attributions AS attributions ON attributions.id = events.attribution_id
   WHERE attributions.invitee_user_id = 'c0000000-0000-4000-8000-0000000000f2'
     AND events.action = 'block' AND events.source = 'system' AND events.reviewer_id IS NULL),
  1, 'the guard''s block is on the trail'
);

SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f3', (SELECT token FROM guard_visits WHERE name = 'reused')) ->> 'reward_state',
  'blocked', 'a second friend on the first friend''s device is blocked'
);
SELECT is((SELECT reward_state_reason FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f3'), 'device_reused_by_invitees', 'a reused device is named');

SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f4', (SELECT token FROM guard_visits WHERE name = 'app')) ->> 'reward_state',
  'blocked', 'the installation the inviter signed in on counts as the inviter''s device'
);

SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f5', (SELECT token FROM guard_visits WHERE name = 'flagged')) ->> 'reward_state',
  'eligible', 'another account''s device and the inviter''s network do not block'
);
SELECT is((SELECT risk_flags FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f5'), ARRAY['shared_device', 'same_network'], 'they are flagged for the operator');

-- An identity that had an account before is not a new account.
INSERT INTO public.deleted_account_identity_fingerprints (fingerprint, first_recorded_at)
VALUES (repeat('9', 64), now() - interval '1 day'), (repeat('8', 64), now() + interval '1 minute');
INSERT INTO public.credit_grant_identity_fingerprints (program_key, fingerprint, first_claimed_at, recorded_via)
SELECT program_key, repeat('7', 64), now() - interval '1 day', 'claim' FROM public.credit_grant_programs LIMIT 1;

SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f6', (SELECT token FROM guard_visits WHERE name = 'rereg'), ARRAY[repeat('6', 64), repeat('9', 64)]) ->> 'status',
  'existing_account', 'an identity whose earlier account was deleted is refused'
);
SELECT ok(NOT EXISTS(SELECT 1 FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f6'), 'and gets no attribution');
SELECT ok((SELECT claimed_at IS NULL FROM public.referral_visits WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'rereg')), 'and leaves the visit unclaimed');
SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f7', (SELECT token FROM guard_visits WHERE name = 'later'), ARRAY[repeat('8', 64)]) ->> 'status',
  'claimed', 'a digest recorded after the account was made is the account''s own'
);
SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f8', (SELECT token FROM guard_visits WHERE name = 'welcome'), ARRAY[repeat('7', 64)]) ->> 'status',
  'existing_account', 'an identity that claimed welcome credits on an earlier account is refused'
);
SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f8', (SELECT token FROM guard_visits WHERE name = 'garbage'), ARRAY['not-a-digest', NULL]) ->> 'status',
  'claimed', 'anything not shaped like a digest is ignored'
);
SELECT is(
  public.claim_referral_visit('c0000000-0000-4000-8000-0000000000f9', (SELECT token FROM guard_visits WHERE name = 'nodevice')) ->> 'reward_state',
  'eligible', 'a visit with no device, and a claim with no digests, are eligible'
);

-- A visit kept from before the digest existed learns its device when the link is opened again.
SELECT is(
  public.create_referral_visit((SELECT code FROM guard_code), 'web', NULL, (SELECT token FROM guard_visits WHERE name = 'rereg'), NULL, NULL, repeat('2', 64)) ->> 'status',
  'preserved', 'an unclaimed visit is kept'
);
UPDATE public.referral_visits SET device_hash = NULL WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'rereg');
DO $$
BEGIN
  PERFORM public.create_referral_visit((SELECT code FROM guard_code), 'web', NULL, (SELECT token FROM guard_visits WHERE name = 'rereg'), NULL, NULL, repeat('2', 64));
END;
$$;
SELECT is((SELECT device_hash FROM public.referral_visits WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'rereg')), repeat('2', 64), 'and takes the device it was missing');
SELECT is(
  public.create_referral_visit((SELECT code FROM guard_code), 'web', NULL, NULL, NULL, NULL, 'not-a-digest') ->> 'status',
  'invalid_request', 'a malformed device digest is refused'
);

-- ─── What settlement pays ───────────────────────────────────────────────────
-- One 500-credit top-up per friend: 25 credits to each side when it pays.

INSERT INTO public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
SELECT ('c0000000-0000-4000-8000-0000000001' || suffix)::uuid, ('c0000000-0000-4000-8000-0000000000' || suffix)::uuid, 'guard_order_' || suffix, 41500, 500, 'created'
FROM unnest(ARRAY['f1','f2','f5','f7']) AS suffix;
UPDATE public.transactions SET status = 'success', credit_effect_applied = true
WHERE razorpay_order_id LIKE 'guard_order_%';

SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000001f1') ->> 'status', 'settled', 'an eligible friend''s top-up settles');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000a1'), 25, 'the inviter is paid 5%');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000f1'), 25, 'the friend is paid 5% on the first top-up');

SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000001f2') ->> 'status', 'attribution_blocked', 'a blocked friend''s top-up settles nothing');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.referral_purchase_events WHERE transaction_id = 'c0000000-0000-4000-8000-0000000001f2'), 'and writes no purchase event');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000a1'), 25, 'the inviter is paid nothing for it');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000f2'), 0, 'nor is the blocked friend');
SELECT ok(NOT EXISTS(SELECT 1 FROM public.list_unsettled_referral_purchase_transactions(100) WHERE transaction_id = 'c0000000-0000-4000-8000-0000000001f2'), 'the reconciliation does not retry a blocked top-up');
SELECT ok(EXISTS(SELECT 1 FROM public.list_unsettled_referral_purchase_transactions(100) WHERE transaction_id = 'c0000000-0000-4000-8000-0000000001f5'), 'it still lists an eligible one');

-- The inviter later opens Invite & Earn on the device a friend signed up on.
SELECT public.record_referral_account_device('c0000000-0000-4000-8000-0000000000a1', repeat('b', 64), NULL);
SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000001f5') ->> 'status', 'attribution_blocked', 'settlement blocks a referral whose two accounts now share a device');
SELECT is((SELECT reward_state || ':' || reward_state_reason || ':' || reward_state_source FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f5'), 'blocked:same_device_as_inviter:system', 'and records why');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000a1'), 25, 'before anything is paid');

-- Both accounts signed in to the app on one installation.
INSERT INTO public.onboarding_events (client_event_id, installation_id, user_id, flow_version, platform, event_name, occurred_at)
VALUES
  (gen_random_uuid(), 'fid_' || repeat('0', 64), 'c0000000-0000-4000-8000-0000000000a1', 1, 'android', 'auth_succeeded', now()),
  (gen_random_uuid(), 'fid_' || repeat('0', 64), 'c0000000-0000-4000-8000-0000000000f7', 1, 'android', 'auth_succeeded', now());
SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000001f7') ->> 'status', 'attribution_blocked', 'settlement blocks a referral whose two accounts signed in on one installation');

-- ─── What an operator can change ────────────────────────────────────────────

CREATE TEMP TABLE guard_subject AS
SELECT id FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f2';

SELECT is(public.set_referral_attribution_reward_state((SELECT id FROM guard_subject), 'eligible', 'ok', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'invalid', 'a decision needs a reason');
SELECT is(public.set_referral_attribution_reward_state((SELECT id FROM guard_subject), 'eligible', 'A reason.', NULL) ->> 'status', 'invalid', 'and a reviewer');
SELECT is(public.set_referral_attribution_reward_state((SELECT id FROM guard_subject), 'paused', 'A reason.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'invalid', 'and a state the program knows');
SELECT is(public.set_referral_attribution_reward_state(gen_random_uuid(), 'eligible', 'A reason.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'not_found', 'an unknown referral is not found');
SELECT is(public.set_referral_attribution_reward_state((SELECT id FROM guard_subject), 'blocked', 'A reason.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'unchanged', 'blocking a blocked referral changes nothing');
SELECT is((SELECT reward_state_source FROM public.referral_attributions WHERE id = (SELECT id FROM guard_subject)), 'system', 'and leaves the decision the system''s');

SELECT is(
  public.set_referral_attribution_reward_state((SELECT id FROM guard_subject), 'eligible', '  A shared family laptop; two people.  ', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status',
  'updated', 'an operator unblocks a referral'
);
SELECT is((SELECT reward_state || ':' || reward_state_source || ':' || reward_state_reason FROM public.referral_attributions WHERE id = (SELECT id FROM guard_subject)), 'eligible:operator:A shared family laptop; two people.', 'the decision, its source and its reason are kept');
SELECT is(
  (SELECT count(*)::int FROM public.referral_review_events
   WHERE attribution_id = (SELECT id FROM guard_subject) AND action = 'unblock' AND source = 'operator'
     AND reviewer_id = 'c0000000-0000-4000-8000-0000000000e1' AND reason = 'A shared family laptop; two people.'),
  1, 'and written on the trail with the reviewer'
);
SELECT ok(EXISTS(SELECT 1 FROM public.list_unsettled_referral_purchase_transactions(100) WHERE transaction_id = 'c0000000-0000-4000-8000-0000000001f2'), 'the top-up it skipped is work for the reconciliation again');
SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000001f2') ->> 'status', 'settled', 'and settles, though the devices still match: the operator decided');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000a1'), 50, 'the inviter is paid for it');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000f2'), 25, 'and so is the friend');

SELECT is(
  public.set_referral_attribution_reward_state((SELECT id FROM public.referral_attributions WHERE invitee_user_id = 'c0000000-0000-4000-8000-0000000000f1'), 'blocked', 'Two accounts, one person.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status',
  'updated', 'an operator blocks an eligible referral'
);
-- Neither of these two shares a device with the inviter, so nothing but the
-- recorded block stands between their top-ups and a reward.
INSERT INTO public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
VALUES
  ('c0000000-0000-4000-8000-0000000002f1', 'c0000000-0000-4000-8000-0000000000f1', 'guard_order_f1_second', 41500, 500, 'created'),
  ('c0000000-0000-4000-8000-0000000001f3', 'c0000000-0000-4000-8000-0000000000f3', 'guard_order_f3', 41500, 500, 'created');
UPDATE public.transactions SET status = 'success', credit_effect_applied = true
WHERE razorpay_order_id IN ('guard_order_f1_second', 'guard_order_f3');
SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000002f1') ->> 'status', 'attribution_blocked', 'an operator''s block holds at the friend''s next top-up');
SELECT is(public.settle_referral_purchase_rewards('c0000000-0000-4000-8000-0000000001f3') ->> 'status', 'attribution_blocked', 'a friend on a reused device is paid nothing either');
SELECT is((SELECT promotional_credits FROM public.profiles WHERE id = 'c0000000-0000-4000-8000-0000000000a1'), 50, 'and the inviter''s balance does not move');

SELECT throws_ok(
  $$UPDATE public.referral_attributions SET reward_state_reason = NULL WHERE reward_state = 'blocked'$$,
  '23514', NULL, 'a block cannot lose its reason'
);
SELECT throws_ok($$UPDATE public.referral_review_events SET reason = 'edited'$$, 'P0001', 'referral audit rows are append-only', 'the trail cannot be edited');
SELECT throws_ok($$DELETE FROM public.referral_review_events$$, 'P0001', 'referral audit rows are append-only', 'nor deleted');
SELECT throws_ok(
  $$INSERT INTO public.referral_review_events (attribution_id, action, source, reason) VALUES ((SELECT id FROM guard_subject), 'block', 'operator', 'No reviewer named.')$$,
  '23514', NULL, 'an operator''s entry names its reviewer'
);

-- The inviter's link.
CREATE TEMP TABLE guard_link AS
SELECT id FROM public.referral_codes WHERE user_id = 'c0000000-0000-4000-8000-0000000000a1';

SELECT is(public.set_referral_code_enabled((SELECT id FROM guard_link), false, 'no', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'invalid', 'switching a link off needs a reason');
SELECT is(public.set_referral_code_enabled(gen_random_uuid(), false, 'A reason.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'not_found', 'an unknown link is not found');
SELECT is(public.set_referral_code_enabled((SELECT id FROM guard_link), true, 'A reason.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'unchanged', 'switching on a link that is on changes nothing');
SELECT is(public.set_referral_code_enabled((SELECT id FROM guard_link), false, 'Repeated self-invites.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'updated', 'an operator switches a link off');
SELECT is((SELECT is_enabled::text || ':' || disabled_reason FROM public.referral_codes WHERE id = (SELECT id FROM guard_link)), 'false:Repeated self-invites.', 'the link is off, with the reason');
SELECT is(public.create_referral_visit((SELECT code FROM guard_code), 'web') ->> 'status', 'invalid_code', 'a link that is off takes no new visit');
SELECT is(public.set_referral_code_enabled((SELECT id FROM guard_link), true, 'Reviewed with the creator.', 'c0000000-0000-4000-8000-0000000000e1') ->> 'status', 'updated', 'and switches it on again');
SELECT is((SELECT count(*)::int FROM public.referral_review_events WHERE referral_code_id = (SELECT id FROM guard_link) AND source = 'operator'), 2, 'both switches are on the trail');

-- ─── What retention clears ──────────────────────────────────────────────────

UPDATE public.referral_visits
SET visited_at = now() - interval '91 days', expires_at = now() - interval '61 days'
WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'rereg');
UPDATE public.referral_account_devices
SET last_seen_at = now() - interval '91 days'
WHERE user_id = 'c0000000-0000-4000-8000-0000000000a2';

SELECT is(public.prune_referral_risk_signals(100), 2, 'one old visit and one idle device are cleared');
SELECT is(
  (SELECT (ip_hash IS NULL AND user_agent_hash IS NULL AND device_hash IS NULL)::text FROM public.referral_visits WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'rereg')),
  'true', 'a visit older than 90 days keeps no digest'
);
SELECT ok(EXISTS(SELECT 1 FROM public.referral_visits WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'rereg')), 'and stays, so the inviter''s visit count does not move');
SELECT is((SELECT device_hash FROM public.referral_visits WHERE public_token = (SELECT token FROM guard_visits WHERE name = 'clean')), repeat('1', 64), 'a recent visit keeps its device');
SELECT is((SELECT (ip_hash IS NULL)::text || ':' || device_hash FROM public.referral_account_devices WHERE user_id = 'c0000000-0000-4000-8000-0000000000a2' AND device_hash = repeat('b', 64)), 'true:' || repeat('b', 64), 'an idle device loses its network and stays known');
SELECT is(public.prune_referral_risk_signals(100), 0, 'a second pass finds nothing');

-- An account keeps its twenty most recent devices.
SELECT public.record_referral_account_device('c0000000-0000-4000-8000-0000000000a2', md5(n::text) || md5(n::text), NULL)
FROM generate_series(1, 25) AS n;
SELECT is((SELECT count(*)::int FROM public.referral_account_devices WHERE user_id = 'c0000000-0000-4000-8000-0000000000a2'), 20, 'an account''s devices are capped at twenty');

SELECT * FROM finish();
ROLLBACK;
