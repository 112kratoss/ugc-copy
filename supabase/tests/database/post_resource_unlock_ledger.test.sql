-- Behavioural coverage for credit-funded post-resource-bundle unlocks.
--
-- `unlock_post_resource_bundle_with_credits` spends real credits and grants a
-- durable entitlement to a creator's paid attachment. Its load-bearing
-- properties mirror the marketplace unlock: charge at most once per buyer and
-- bundle, never let promotional credits fund a purchase, and never let an
-- author buy their own bundle.

begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

insert into auth.users (id, email, aud, role, raw_app_meta_data, raw_user_meta_data)
values
  ('e1000000-0000-4000-8000-000000000001'::uuid, 'bundle-buyer@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('e2000000-0000-4000-8000-000000000002'::uuid, 'bundle-author@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb),
  ('e3000000-0000-4000-8000-000000000003'::uuid, 'bundle-promo@example.invalid',
   'authenticated', 'authenticated', '{}'::jsonb, '{}'::jsonb);

update public.profiles set credits = 1000, promotional_credits = 0
where id = 'e1000000-0000-4000-8000-000000000001'::uuid;

update public.profiles set credits = 1000, promotional_credits = 0
where id = 'e2000000-0000-4000-8000-000000000002'::uuid;

update public.profiles set credits = 900, promotional_credits = 900
where id = 'e3000000-0000-4000-8000-000000000003'::uuid;

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values
  ('f0000000-0000-4000-8000-000000000001'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
   'public', 'text', 'external', 'text', 'paid bundle post'),
  ('f0000000-0000-4000-8000-000000000002'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
   'public', 'text', 'external', 'text', 'free bundle post');

insert into public.post_resource_bundles (post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text)
values
  ('f0000000-0000-4000-8000-000000000001'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
   'paid', 'published', 'Paid bundle', 200, 'the unlockable prompt'),
  ('f0000000-0000-4000-8000-000000000002'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
   'free', 'published', 'Free bundle', 0, 'the free prompt');

-- ─── Guards ──────────────────────────────────────────────────────────────────

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e1000000-0000-4000-8000-000000000001'::uuid,
    'f0000000-0000-4000-8000-0000000000ff'::uuid
  ) ->> 'status',
  'not_found',
  'a post without a purchasable bundle cannot be unlocked'
);

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e2000000-0000-4000-8000-000000000002'::uuid,
    'f0000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'owned_by_user',
  'an author cannot buy their own bundle'
);

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e1000000-0000-4000-8000-000000000001'::uuid,
    'f0000000-0000-4000-8000-000000000002'::uuid
  ) ->> 'status',
  'not_paid',
  'a free bundle is not a credit purchase'
);

select is(
  (select credits from public.profiles where id = 'e1000000-0000-4000-8000-000000000001'::uuid),
  1000,
  'no rejected unlock moved the buyer balance'
);

-- ─── Promotional credits cannot fund a bundle purchase ───────────────────────

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e3000000-0000-4000-8000-000000000003'::uuid,
    'f0000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'insufficient_credits',
  'an entirely promotional balance cannot fund a bundle unlock'
);

select is(
  (select credits from public.profiles where id = 'e3000000-0000-4000-8000-000000000003'::uuid),
  900,
  'the refused promotional purchase left the balance intact'
);

-- ─── The purchase charges exactly once ───────────────────────────────────────

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e1000000-0000-4000-8000-000000000001'::uuid,
    'f0000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'completed',
  'a funded buyer unlocks the bundle'
);

select is(
  (select credits from public.profiles where id = 'e1000000-0000-4000-8000-000000000001'::uuid),
  800,
  'the bundle price is deducted once'
);

select is(
  (
    select count(*)::integer from public.post_resource_bundle_purchases
    where buyer_user_id = 'e1000000-0000-4000-8000-000000000001'::uuid
  ),
  1,
  'exactly one entitlement row is created'
);

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e1000000-0000-4000-8000-000000000001'::uuid,
    'f0000000-0000-4000-8000-000000000001'::uuid
  ) ->> 'status',
  'already_owned',
  'a repeated unlock reports the existing entitlement'
);

select is(
  (select credits from public.profiles where id = 'e1000000-0000-4000-8000-000000000001'::uuid),
  800,
  'a repeated unlock never charges the buyer twice'
);

select is(
  (
    select count(*)::integer from public.post_resource_bundle_purchases
    where buyer_user_id = 'e1000000-0000-4000-8000-000000000001'::uuid
  ),
  1,
  'a repeated unlock does not duplicate the entitlement'
);

-- ─── Insufficient funds ──────────────────────────────────────────────────────

update public.profiles set credits = 5, promotional_credits = 0
where id = 'e1000000-0000-4000-8000-000000000001'::uuid;

insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body)
values ('f0000000-0000-4000-8000-000000000003'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
        'public', 'text', 'external', 'text', 'second paid bundle post');

insert into public.post_resource_bundles (post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text)
values ('f0000000-0000-4000-8000-000000000003'::uuid, 'e2000000-0000-4000-8000-000000000002'::uuid,
        'paid', 'published', 'Another paid bundle', 500, 'another unlockable prompt');

select is(
  public.unlock_post_resource_bundle_with_credits(
    'e1000000-0000-4000-8000-000000000001'::uuid,
    'f0000000-0000-4000-8000-000000000003'::uuid
  ) ->> 'status',
  'insufficient_credits',
  'a buyer without enough credits is refused'
);

select * from finish();
rollback;
