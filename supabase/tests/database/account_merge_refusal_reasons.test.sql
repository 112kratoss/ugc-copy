-- What a refused guest→account link says (20261125073220).
--
-- Every 'not_eligible' answer names its reason and whether the same ticket can
-- pass later. The app stops sending a ticket on retryable = false, so the
-- property that matters is the split: a refusal no retry can cure must never
-- be reported as retryable (the app would retry it forever), and the one a
-- retry can cure must never be reported as final (the app would drop a ticket
-- that still carries credits). Neither may spend the ticket.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

-- ─── Fixtures ────────────────────────────────────────────────────────────────
-- Guests c1…c5, accounts d1 and d2. Each auth.users row brings its profile.

insert into auth.users (id, instance_id, aud, role, email, encrypted_password, created_at, updated_at, is_anonymous)
values
  ('c1c1c1c1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('c2c2c2c2-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('c3c3c3c3-0000-4000-8000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('c4c4c4c4-0000-4000-8000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('c5c5c5c5-0000-4000-8000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', null, '', now(), now(), true),
  ('d1d1d1d1-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'one@example.test', '', now(), now(), false),
  ('d2d2d2d2-0000-4000-8000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'two@example.test', '', now(), now(), false);

update public.profiles set credits = 300 where id = 'c1c1c1c1-0000-4000-8000-000000000001';
update public.profiles set credits = 40 where id = 'c2c2c2c2-0000-4000-8000-000000000002';
update public.profiles set credits = 10 where id = 'd1d1d1d1-0000-4000-8000-000000000001';

-- Ticket 4 is already past its expiry.
insert into public.account_merge_tickets (ticket_hash, guest_user_id, created_at, expires_at)
values
  (repeat('1', 64), 'c1c1c1c1-0000-4000-8000-000000000001', now(), now() + interval '30 days'),
  (repeat('2', 64), 'c2c2c2c2-0000-4000-8000-000000000002', now(), now() + interval '30 days'),
  (repeat('3', 64), 'c3c3c3c3-0000-4000-8000-000000000003', now(), now() + interval '30 days'),
  (repeat('4', 64), 'c4c4c4c4-0000-4000-8000-000000000004', now() - interval '31 days', now() - interval '1 day');

-- ─── A ticket this database never had ────────────────────────────────────────

select is(
  public.redeem_account_merge_ticket(repeat('e', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "not_eligible", "reason": "unknown_ticket", "retryable": false}'::jsonb,
  'an unknown ticket is refused for good'
);

select is(
  public.redeem_account_merge_ticket('not-a-hash', 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "not_eligible", "reason": "invalid_request", "retryable": false}'::jsonb,
  'a malformed hash is refused for good'
);

select is(
  public.redeem_account_merge_ticket(repeat('1', 64), null, 'mobile') ->> 'reason',
  'invalid_request',
  'a missing account is a malformed request'
);

-- ─── The guest has become an account of its own ──────────────────────────────

update auth.users set is_anonymous = false, email = 'was-a-guest@example.test'
where id = 'c1c1c1c1-0000-4000-8000-000000000001';

select is(
  public.redeem_account_merge_ticket(repeat('1', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "not_eligible", "reason": "guest_registered", "retryable": false}'::jsonb,
  'a guest that registered on its own is refused for good'
);

select is(
  (select consumed_at from public.account_merge_tickets where ticket_hash = repeat('1', 64)),
  null,
  'the refusal does not spend the ticket'
);

select is(
  (select credits from public.profiles where id = 'd1d1d1d1-0000-4000-8000-000000000001'),
  10,
  'the account receives nothing'
);

select is(
  (select credits from public.profiles where id = 'c1c1c1c1-0000-4000-8000-000000000001'),
  300,
  'the guest-made account keeps its credits'
);

select is(
  public.redeem_account_merge_ticket(repeat('1', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile') ->> 'reason',
  'guest_registered',
  'a repeat gets the same answer, never already_merged'
);

-- ─── The guest is the account itself ─────────────────────────────────────────

select is(
  public.redeem_account_merge_ticket(repeat('1', 64), 'c1c1c1c1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "not_eligible", "reason": "same_account", "retryable": false}'::jsonb,
  'a guest made an account in place has nothing to move onto itself'
);

-- ─── The guest is already linked ─────────────────────────────────────────────

update public.profiles
set merged_into_user_id = 'd2d2d2d2-0000-4000-8000-000000000002', merged_at = now()
where id = 'c3c3c3c3-0000-4000-8000-000000000003';

select is(
  public.redeem_account_merge_ticket(repeat('3', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "not_eligible", "reason": "guest_linked", "retryable": false}'::jsonb,
  'a guest linked without a ledger row is refused for good'
);

select is(
  (select consumed_at from public.account_merge_tickets where ticket_hash = repeat('3', 64)),
  null,
  'that refusal does not spend the ticket either'
);

-- ─── The account is not ready: the one refusal a retry can cure ──────────────

-- A guest naming another guest: the route never sends it, and the ticket stays.
select is(
  public.redeem_account_merge_ticket(repeat('2', 64), 'c5c5c5c5-0000-4000-8000-000000000005', 'mobile'),
  '{"status": "not_eligible", "reason": "account_not_ready", "retryable": true}'::jsonb,
  'an account that is not a registered one yet is retryable'
);

select is(
  public.merge_guest_account(
    'c2c2c2c2-0000-4000-8000-000000000002', 'f0f0f0f0-0000-4000-8000-000000000000', 'mobile'
  ),
  '{"status": "not_eligible", "reason": "account_not_ready", "retryable": true}'::jsonb,
  'an account whose profile is not there yet is retryable'
);

-- The account itself linked into another: not this case, since a link is never
-- undone (the route turns such a caller away before the database is asked).
update public.profiles
set merged_into_user_id = 'd2d2d2d2-0000-4000-8000-000000000002', merged_at = now()
where id = 'c5c5c5c5-0000-4000-8000-000000000005';

select is(
  public.merge_guest_account(
    'c2c2c2c2-0000-4000-8000-000000000002', 'c5c5c5c5-0000-4000-8000-000000000005', 'mobile'
  ),
  '{"status": "not_eligible", "reason": "account_linked", "retryable": false}'::jsonb,
  'an account linked into another is refused for good: a link is never undone'
);

select is(
  (select consumed_at from public.account_merge_tickets where ticket_hash = repeat('2', 64)),
  null,
  'a retryable refusal leaves the ticket spendable'
);

-- And the retry passes once the account is right.
select is(
  public.redeem_account_merge_ticket(repeat('2', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "merged", "credits_moved": 40, "promotional_credits_moved": 0, "credits": 50}'::jsonb,
  'the same ticket links once the account is a registered one, with no reason on success'
);

select isnt(
  (select consumed_at from public.account_merge_tickets where ticket_hash = repeat('2', 64)),
  null,
  'the settled link spends the ticket'
);

select is(
  public.redeem_account_merge_ticket(repeat('2', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "already_merged"}'::jsonb,
  'a replay answers as before'
);

select is(
  public.redeem_account_merge_ticket(repeat('2', 64), 'd2d2d2d2-0000-4000-8000-000000000002', 'mobile'),
  '{"status": "conflict"}'::jsonb,
  'a ticket spent on another account answers as before'
);

select is(
  public.redeem_account_merge_ticket(repeat('4', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile'),
  '{"status": "expired"}'::jsonb,
  'an expired ticket answers as before'
);

-- ─── A permanent refusal outranks a retryable one ────────────────────────────

-- c1 is registered now, c5 is linked: both sides refuse, and the guest's wins.
select is(
  public.merge_guest_account(
    'c1c1c1c1-0000-4000-8000-000000000001', 'c5c5c5c5-0000-4000-8000-000000000005', 'mobile'
  ) ->> 'reason',
  'guest_registered',
  'the guest''s permanent refusal wins over the account''s retryable one'
);

select is(
  public.merge_guest_account(
    'f0f0f0f0-0000-4000-8000-000000000000', 'f1f1f1f1-0000-4000-8000-000000000001', 'mobile'
  ),
  '{"status": "not_eligible", "reason": "guest_gone", "retryable": false}'::jsonb,
  'a missing guest outranks a missing account'
);

select is(
  public.merge_guest_account(
    'c2c2c2c2-0000-4000-8000-000000000002', 'c2c2c2c2-0000-4000-8000-000000000002', 'mobile'
  ) ->> 'reason',
  'same_account',
  'the same id on both sides is same_account'
);

select is(
  public.merge_guest_account(
    'c4c4c4c4-0000-4000-8000-000000000004', 'd1d1d1d1-0000-4000-8000-000000000001', 'desktop'
  ),
  '{"status": "not_eligible", "reason": "invalid_request", "retryable": false}'::jsonb,
  'an unknown surface is a malformed request'
);

select is(
  public.merge_guest_account(null, 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile') ->> 'reason',
  'invalid_request',
  'a missing guest id is a malformed request'
);

-- ─── The guest's ticket is gone with the guest ───────────────────────────────

delete from auth.users where id = 'c4c4c4c4-0000-4000-8000-000000000004';

select is(
  (select count(*) from public.account_merge_tickets where ticket_hash = repeat('4', 64)),
  0::bigint,
  'deleting a guest deletes its tickets'
);

select is(
  public.redeem_account_merge_ticket(repeat('4', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile') ->> 'reason',
  'unknown_ticket',
  'so its ticket answers unknown_ticket from then on'
);

-- ─── Every refusal carries both fields ───────────────────────────────────────

select is(
  (
    select count(*)
    from (values
      (public.redeem_account_merge_ticket(repeat('e', 64), 'd1d1d1d1-0000-4000-8000-000000000001', 'mobile')),
      (public.redeem_account_merge_ticket(repeat('1', 64), 'd2d2d2d2-0000-4000-8000-000000000002', 'mobile')),
      (public.redeem_account_merge_ticket(repeat('3', 64), 'd2d2d2d2-0000-4000-8000-000000000002', 'mobile')),
      (public.merge_guest_account('c3c3c3c3-0000-4000-8000-000000000003', 'f0f0f0f0-0000-4000-8000-000000000000', 'web'))
    ) as answers (answer)
    where answer ->> 'status' = 'not_eligible'
      and jsonb_typeof(answer -> 'reason') = 'string'
      and jsonb_typeof(answer -> 'retryable') = 'boolean'
  ),
  4::bigint,
  'every not_eligible answer says its reason and whether a retry can help'
);

-- ─── Still out of every client's reach ───────────────────────────────────────

select is(
  pg_catalog.has_function_privilege('authenticated', 'public.redeem_account_merge_ticket(text, uuid, text)', 'EXECUTE'),
  false,
  'a signed-in client cannot redeem a ticket directly'
);

select is(
  pg_catalog.has_function_privilege('anon', 'public.merge_guest_account(uuid, uuid, text)', 'EXECUTE'),
  false,
  'nor link accounts directly'
);

select * from finish();
rollback;
