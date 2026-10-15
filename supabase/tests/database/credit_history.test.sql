-- list_credit_history (20261015174548_credit_history.sql): every source of a
-- credit movement listed once, with its sign and its words; a guest linked to the
-- account included, the link itself not; keyset pages without gaps or repeats;
-- the entries summing to the balance; and the function closed to clients.
--
-- Each movement is made by the RPC that makes it in production, so a change to a
-- money path that stops leaving its record shows up here. Every call in one
-- transaction shares now(), so most entries tie on time and the pages lean on
-- the entry id to order them.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- A is the account under test, G a guest later linked to it, I the friend who
-- invited A, O an unrelated creator (seller, operator, and a buyer of its own).
insert into auth.users (id, email, aud, role, is_anonymous, created_at) values
  ('c7000001-0000-4000-8000-000000000001', 'credit-history-account@example.invalid', 'authenticated', 'authenticated', false, now()),
  ('c7000002-0000-4000-8000-000000000002', null, 'authenticated', 'authenticated', true, now()),
  ('c7000003-0000-4000-8000-000000000003', 'credit-history-inviter@example.invalid', 'authenticated', 'authenticated', false, now()),
  ('c7000004-0000-4000-8000-000000000004', 'credit-history-other@example.invalid', 'authenticated', 'authenticated', false, now());

update public.profiles
set username = 'history-maker', display_name = 'History Maker'
where id = 'c7000001-0000-4000-8000-000000000001';

create temp table fx (name text primary key, id uuid not null) on commit drop;

-- Welcome credits.
select is(
  public.claim_credit_grant_program('c7000001-0000-4000-8000-000000000001', 'welcome_credits_v1', 'web', null)->>'status',
  'claimed', 'fixture: welcome credits claimed');
update public.credit_grants set claimed_at = now() - interval '30 days'
where user_id = 'c7000001-0000-4000-8000-000000000001';
insert into fx select 'welcome', id from public.credit_grants where user_id = 'c7000001-0000-4000-8000-000000000001';

-- A was invited by I.
insert into public.referral_codes (id, user_id, code)
values ('c7100001-0000-4000-8000-000000000001', 'c7000003-0000-4000-8000-000000000003', 'historyinviter1');
insert into public.referral_visits (id, referral_code_id, program_id, inviter_user_id, channel, expires_at)
select 'c7100002-0000-4000-8000-000000000002', 'c7100001-0000-4000-8000-000000000001', id,
       'c7000003-0000-4000-8000-000000000003', 'web', now() + interval '30 days'
from public.referral_programs where status = 'active' order by version desc limit 1;
insert into public.referral_attributions (program_id, referral_visit_id, inviter_user_id, invitee_user_id)
select program_id, id, inviter_user_id, 'c7000001-0000-4000-8000-000000000001'
from public.referral_visits where id = 'c7100002-0000-4000-8000-000000000002';

-- A web purchase of the Creator pack, its referral rewards, a partial refund, a
-- won dispute that restores it, then a dispute that takes it all back.
insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values ('c7200001-0000-4000-8000-000000000001', 'c7000001-0000-4000-8000-000000000001', 'order_credit_history_1', 166000, 2000, 'created');
select ok(public.add_credits('c7000001-0000-4000-8000-000000000001', 2000, 'c7200001-0000-4000-8000-000000000001', 'pay_credit_history_1'),
  'fixture: web purchase granted');
select is(public.settle_referral_purchase_rewards('c7200001-0000-4000-8000-000000000001')->>'status', 'settled',
  'fixture: referral rewards settled');
select is(public.reconcile_credit_purchase_adjustment('c7200001-0000-4000-8000-000000000001', 'razorpay', 'evt_history_refund', 83000, 'reverse', 'razorpay_refund')->>'status',
  'partially_reversed', 'fixture: half of the purchase refunded');
select is(public.reconcile_credit_purchase_adjustment('c7200001-0000-4000-8000-000000000001', 'razorpay', 'evt_history_restore', 0, 'restore', 'razorpay_dispute_won')->>'status',
  'restored', 'fixture: purchase restored');
select is(public.reconcile_credit_purchase_adjustment('c7200001-0000-4000-8000-000000000001', 'razorpay', 'evt_history_dispute', 166000, 'reverse', 'razorpay_dispute_open')->>'status',
  'reversed', 'fixture: purchase disputed');

-- A purchase refunded before its grant moved no credits.
insert into public.transactions (id, user_id, razorpay_order_id, amount, credits, status)
values ('c7200002-0000-4000-8000-000000000002', 'c7000001-0000-4000-8000-000000000001', 'order_credit_history_void', 41500, 500, 'created');
select is(public.reconcile_credit_purchase_adjustment('c7200002-0000-4000-8000-000000000002', 'razorpay', 'evt_history_void', 41500, 'reverse', 'razorpay_refund')->>'status',
  'reversed', 'fixture: ungranted purchase voided');

-- A purchase refunded before 2026-07-12, as the backfill left it: refunded, with
-- its grant time and no adjustment row.
insert into public.transactions (id, user_id, razorpay_order_id, razorpay_payment_id, amount, credits, status,
  credit_effect_applied, credit_purchase_succeeded_at, refunded_at, credit_reversed_amount_subunits, credit_reversed_credits)
values ('c7200003-0000-4000-8000-000000000003', 'c7000001-0000-4000-8000-000000000001', 'order_credit_history_legacy', 'pay_credit_history_legacy',
  41500, 500, 'refunded', false, now() - interval '90 days', now() - interval '89 days', 41500, 500);

-- An app purchase of the Pro pack funds the spending below.
select is(public.complete_mobile_purchase('c7000001-0000-4000-8000-000000000001', null, 'magicbooklet.credits.pro', 'play_store',
  'history_store_pro', 'mobile_play_store_history_store_pro', 'mobile_play_store_history_store_pro')->>'status',
  'completed', 'fixture: app purchase settled');
insert into fx select 'pro_purchase', id from public.transactions where razorpay_order_id = 'mobile_play_store_history_store_pro';

-- Operator adjustments: one moves the balance, one only re-buckets promotion.
select is(public.apply_admin_credit_adjustment('c7000001-0000-4000-8000-000000000001', 'c7000004-0000-4000-8000-000000000004', 40, 40,
  'goodwill for a slow run', 'credit-history-adjust-1')->>'status', 'applied', 'fixture: goodwill adjustment');
select is(public.apply_admin_credit_adjustment('c7000001-0000-4000-8000-000000000001', 'c7000004-0000-4000-8000-000000000004', 0, -5,
  'promotional correction', 'credit-history-adjust-2')->>'status', 'applied', 'fixture: promotional-only adjustment');
insert into fx select 'goodwill', id from public.admin_credit_adjustments where idempotency_key = 'credit-history-adjust-1';

-- Generations: a refunded video, a running motion video, a running image, a free
-- one, and two deleted creations (one refunded first).
insert into fx select 'video', (public.start_generation('c7000001-0000-4000-8000-000000000001', 120, 'kling-3.0-video', 'a fox', 'video', 5, null, null, '{}'::jsonb, null)->>'generation_id')::uuid;
select is(public.settle_generation_start_failed((select id from fx where name = 'video'), 'provider refused')->>'status', 'failed',
  'fixture: video refunded');
insert into fx select 'motion', (public.start_generation('c7000001-0000-4000-8000-000000000001', 80, 'kling-3.0', 'a dance', 'video', 5, 'motion', null, '{}'::jsonb, null)->>'generation_id')::uuid;
insert into fx select 'image', (public.start_generation('c7000001-0000-4000-8000-000000000001', 10, 'nano-banana-2', 'a cat', 'image', null, null, null, '{}'::jsonb, null)->>'generation_id')::uuid;
insert into fx select 'free', (public.start_generation('c7000001-0000-4000-8000-000000000001', 0, 'nano-banana-2', 'free', 'image', null, null, null, '{}'::jsonb, null)->>'generation_id')::uuid;
insert into fx select 'deleted_image', (public.start_generation('c7000001-0000-4000-8000-000000000001', 30, 'flux-2-pro', 'gone', 'image', null, null, null, '{}'::jsonb, null)->>'generation_id')::uuid;
select is(public.settle_generation_start_failed((select id from fx where name = 'deleted_image'), 'provider refused')->>'status', 'failed',
  'fixture: deleted image refunded first');
insert into fx select 'deleted_video', (public.start_generation('c7000001-0000-4000-8000-000000000001', 50, 'veo-3.1', 'gone too', 'video', 8, null, null, '{}'::jsonb, null)->>'generation_id')::uuid;
delete from public.generations where id in ((select id from fx where name = 'deleted_image'), (select id from fx where name = 'deleted_video'));

-- AI features: a refunded prompt enhancement and a settled assistant reply.
insert into fx select 'enhance', (public.start_ai_usage_event('c7000001-0000-4000-8000-000000000001', 3, 'prompt_enhancement', 'openai', 'gpt-5', 'image', 'make it pop', null)->>'event_id')::uuid;
select is(public.settle_ai_usage_event((select id from fx where name = 'enhance'), 'refunded', null, null, 'provider down')->>'status', 'refunded',
  'fixture: prompt enhancement refunded');
insert into fx select 'assistant', (public.start_ai_usage_event('c7000001-0000-4000-8000-000000000001', 2, 'workflow_assistant', 'openai', 'gpt-5', null, 'help', null)->>'event_id')::uuid;
select is(public.settle_ai_usage_event((select id from fx where name = 'assistant'), 'succeeded', 'done', '{}'::jsonb, null)->>'status', 'succeeded',
  'fixture: assistant reply settled');

-- Legacy audio reservations: one refunded, one held.
insert into fx select 'voice', (public.reserve_creation_credits('c7000001-0000-4000-8000-000000000001', 15, 'history-voice-1')->>'reservation_id')::uuid;
select is(public.refund_creation_credit_reservation('c7000001-0000-4000-8000-000000000001', 'history-voice-1')->>'status', 'refunded',
  'fixture: voice reservation refunded');
insert into fx select 'sound', (public.reserve_creation_credits('c7000001-0000-4000-8000-000000000001', 7, 'history-sound-2')->>'reservation_id')::uuid;

-- A recipe and a marketplace resource bought with credits, and a marketplace
-- purchase that the 2026-04-06 migration copied into the recipe tables.
insert into public.posts (id, user_id, visibility, category, source_kind, post_format, body) values
  ('c7300001-0000-4000-8000-000000000001', 'c7000004-0000-4000-8000-000000000004', 'public', 'text', 'external', 'text', 'Neon portrait recipe'),
  ('c7300002-0000-4000-8000-000000000002', 'c7000004-0000-4000-8000-000000000004', 'public', 'text', 'external', 'text', 'Copied legacy recipe');
insert into public.post_resource_bundles (id, post_id, owner_user_id, access_mode, status, title, price_usd_cents, prompt_text) values
  ('c7400001-0000-4000-8000-000000000001', 'c7300001-0000-4000-8000-000000000001', 'c7000004-0000-4000-8000-000000000004', 'paid', 'published', 'Neon', 200, 'the prompt'),
  ('c7400002-0000-4000-8000-000000000002', 'c7300002-0000-4000-8000-000000000002', 'c7000004-0000-4000-8000-000000000004', 'paid', 'published', 'Copied', 100, 'the old prompt');
select is(public.unlock_post_resource_bundle_with_credits('c7000001-0000-4000-8000-000000000001', 'c7300001-0000-4000-8000-000000000001')->>'status',
  'completed', 'fixture: recipe unlocked with credits');
insert into fx select 'recipe', id from public.post_resource_bundle_purchases
where buyer_user_id = 'c7000001-0000-4000-8000-000000000001' and bundle_id = 'c7400001-0000-4000-8000-000000000001';

insert into public.marketplace_assets (id, seller_user_id, type, title, price_usd_cents, status) values
  ('c7500001-0000-4000-8000-000000000001', 'c7000004-0000-4000-8000-000000000004', 'prompt_pack', 'Lighting presets', 150, 'active'),
  ('c7500002-0000-4000-8000-000000000002', 'c7000004-0000-4000-8000-000000000004', 'prompt_pack', 'Legacy presets', 100, 'active');
select is(public.unlock_marketplace_asset_with_credits('c7000001-0000-4000-8000-000000000001', 'c7500001-0000-4000-8000-000000000001')->>'status',
  'completed', 'fixture: marketplace resource unlocked with credits');
select is(public.unlock_marketplace_asset_with_credits('c7000001-0000-4000-8000-000000000001', 'c7500002-0000-4000-8000-000000000002')->>'status',
  'completed', 'fixture: legacy marketplace resource unlocked with credits');
insert into fx select 'resource', id from public.marketplace_purchases where asset_id = 'c7500001-0000-4000-8000-000000000001';
insert into fx select 'legacy_resource', id from public.marketplace_purchases where asset_id = 'c7500002-0000-4000-8000-000000000002';
insert into public.post_resource_bundle_orders (id, bundle_id, buyer_user_id, legacy_order_id, razorpay_order_id, amount_subunits, currency, status)
select 'c7600001-0000-4000-8000-000000000001', 'c7400002-0000-4000-8000-000000000002', buyer_user_id, id, razorpay_order_id, amount_subunits, currency, status
from public.marketplace_orders where asset_id = 'c7500002-0000-4000-8000-000000000002';
insert into public.post_resource_bundle_purchases (bundle_id, buyer_user_id, order_id, legacy_purchase_id, price_usd_cents, amount_subunits, currency, created_at)
select 'c7400002-0000-4000-8000-000000000002', buyer_user_id, 'c7600001-0000-4000-8000-000000000001', id, price_usd_cents, amount_subunits, currency, created_at
from public.marketplace_purchases where asset_id = 'c7500002-0000-4000-8000-000000000002';
insert into fx select 'copied_recipe', id from public.post_resource_bundle_purchases where bundle_id = 'c7400002-0000-4000-8000-000000000002';

-- The guest buys in the app and starts a video, is linked to A, and the video's
-- refund lands after the link.
select is(public.complete_mobile_purchase('c7000002-0000-4000-8000-000000000002', null, 'magicbooklet.credits.starter', 'app_store',
  'history_guest_store_1', 'mobile_app_store_history_guest_store_1', 'mobile_app_store_history_guest_store_1')->>'status',
  'completed', 'fixture: guest app purchase settled');
insert into fx select 'guest_purchase', id from public.transactions where razorpay_order_id = 'mobile_app_store_history_guest_store_1';
insert into fx select 'guest_video', (public.start_generation('c7000002-0000-4000-8000-000000000002', 40, 'seedance-2', 'guest clip', 'video', 5, null, null, '{}'::jsonb, null)->>'generation_id')::uuid;
select is(public.merge_guest_account('c7000002-0000-4000-8000-000000000002', 'c7000001-0000-4000-8000-000000000001', 'mobile')->>'status',
  'merged', 'fixture: guest linked to the account');
select is(public.settle_generation_start_failed((select id from fx where name = 'guest_video'), 'provider refused')->>'status', 'failed',
  'fixture: guest video refunded after the link');

-- The unrelated creator's own purchase.
select is(public.complete_mobile_purchase('c7000004-0000-4000-8000-000000000004', null, 'magicbooklet.credits.starter', 'app_store',
  'history_other_store_1', 'mobile_app_store_history_other_store_1', 'mobile_app_store_history_other_store_1')->>'status',
  'completed', 'fixture: unrelated purchase settled');

-- The whole history of A with its linked guest, read in one page.
create temp table h on commit drop as
select row_number() over (order by occurred_at desc, entry_id collate "C" desc) as position, *
from public.list_credit_history(
  array['c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002']::uuid[], null, null, 101);

create function pg_temp.entry(p_entry_id text) returns text language sql as $$
  select concat_ws(' | ', kind, amount::text, title, coalesce(detail, '-')) from h where entry_id = p_entry_id
$$;

-- ─── Every source, with its sign and its words ──────────────────────────────
select is(pg_temp.entry('purchase:c7200001-0000-4000-8000-000000000001'), 'purchase | 2000 | Creator pack | Bought on the web',
  'a web purchase is a purchase of its pack, in');
select is(pg_temp.entry('purchase:' || (select id from fx where name = 'pro_purchase')), 'purchase | 10000 | Pro pack | Bought in the app',
  'an app purchase is a purchase of its pack, in');
select is((select count(*)::int from h where entry_id like 'purchase:%' and entry_id like '%' || (select razorpay_order_id from public.transactions where id = (select id from fx where name = 'pro_purchase'))), 0,
  'an app purchase is listed from its credit transaction alone');
select is((select count(*)::int from h where entry_id like 'purchase%c7200001-0000-4000-8000-000000000001%'), 1,
  'the purchase itself is listed once');
select is(
  (select array_agg(concat_ws(' | ', kind, amount::text, title, detail) order by amount) from h where entry_id like 'purchase-adjustment:%'),
  array[
    'reversal | -2000 | Payment disputed | Creator pack',
    'reversal | -1000 | Purchase refunded | Creator pack',
    'reversal | 1000 | Purchase restored | Creator pack'
  ],
  'refunds, disputes and restores of a purchase are reversals of its pack, signed as they moved the balance');
select is(pg_temp.entry('purchase:c7200003-0000-4000-8000-000000000003'), 'purchase | 500 | Starter pack | Bought on the web',
  'a purchase refunded before the adjustment ledger keeps its purchase');
select is(pg_temp.entry('purchase:c7200003-0000-4000-8000-000000000003:refund'), 'reversal | -500 | Purchase refunded | Starter pack',
  'and its refund, from the transaction itself');
select is((select count(*)::int from h where entry_id like '%c7200002-0000-4000-8000-000000000002%'), 0,
  'a purchase refunded before its grant moved nothing and is not listed');
select is(pg_temp.entry('grant:' || (select id from fx where name = 'welcome')), 'grant | 25 | Welcome credits | -',
  'welcome credits are a grant, in');
select is(
  (select array_agg(concat_ws(' | ', kind, amount::text, title, detail) order by amount) from h where entry_id like 'referral:%'),
  array[
    'reversal | -100 | Referral reward reversed | First top-up bonus',
    'reversal | -50 | Referral reward reversed | First top-up bonus',
    'reversal | 50 | Referral reward restored | First top-up bonus',
    'grant | 100 | Referral reward | First top-up bonus'
  ],
  'the first top-up bonus is a grant, its reversals and restoration follow the purchase');
select is(pg_temp.entry('adjustment:' || (select id from fx where name = 'goodwill')), 'adjustment | 40 | Adjustment | Made by Magicbooklet support',
  'an operator adjustment is an adjustment, without the operator''s note');
select is((select count(*)::int from h where kind = 'adjustment'), 1,
  'an adjustment of promotional credits alone is not listed');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'video') || ':charge'), 'spend | -120 | Video generation | -',
  'a video is a spend, out');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'video') || ':refund'), 'refund | 120 | Refund: failed video | -',
  'its refund is a refund, in');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'motion') || ':charge'), 'spend | -80 | Motion video | -',
  'a motion video is a spend');
select is((select count(*)::int from h where entry_id = 'generation:' || (select id from fx where name = 'motion') || ':refund'), 0,
  'a generation that was not refunded has no refund');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'image') || ':charge'), 'spend | -10 | Image generation | -',
  'an image is a spend');
select is((select count(*)::int from h where entry_id like '%' || (select id from fx where name = 'free') || '%'), 0,
  'a free generation is not listed');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'deleted_image') || ':charge'), 'spend | -30 | Image generation | Deleted creation',
  'a deleted creation keeps its spend, named from its model');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'deleted_image') || ':refund'), 'refund | 30 | Refund: failed image | Deleted creation',
  'and its refund');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'deleted_video') || ':charge'), 'spend | -50 | Video generation | Deleted creation',
  'a deleted video keeps its spend');
select is((select count(*)::int from h where entry_id = 'generation:' || (select id from fx where name = 'deleted_video') || ':refund'), 0,
  'a deleted creation that was not refunded has no refund');
select is(pg_temp.entry('ai-usage:' || (select id from fx where name = 'enhance') || ':charge'), 'spend | -3 | Prompt enhancement | -',
  'a prompt enhancement is a spend');
select is(pg_temp.entry('ai-usage:' || (select id from fx where name = 'enhance') || ':refund'), 'refund | 3 | Refund: failed prompt enhancement | -',
  'its refund is a refund');
select is(pg_temp.entry('ai-usage:' || (select id from fx where name = 'assistant') || ':charge'), 'spend | -2 | Workflow assistant | -',
  'an assistant reply is a spend');
select is((select count(*)::int from h where entry_id = 'ai-usage:' || (select id from fx where name = 'assistant') || ':refund'), 0,
  'a settled assistant reply has no refund');
select is(pg_temp.entry('reservation:' || (select id from fx where name = 'voice') || ':charge'), 'spend | -15 | Audio generation | -',
  'a legacy audio reservation is a spend');
select is(pg_temp.entry('reservation:' || (select id from fx where name = 'voice') || ':refund'), 'refund | 15 | Refund: failed audio | -',
  'its refund is a refund');
select is(pg_temp.entry('reservation:' || (select id from fx where name = 'sound') || ':charge'), 'spend | -7 | Audio generation | -',
  'a held reservation is a spend');
select is(pg_temp.entry('unlock:' || (select id from fx where name = 'recipe')), 'spend | -200 | Recipe unlocked | Neon portrait recipe',
  'a recipe bought with credits is a spend, named by its post');
select is(pg_temp.entry('marketplace-unlock:' || (select id from fx where name = 'resource')), 'spend | -150 | Resource unlocked | Lighting presets',
  'a marketplace resource bought with credits is a spend, named by its title');
select is(pg_temp.entry('unlock:' || (select id from fx where name = 'copied_recipe')), 'spend | -100 | Recipe unlocked | Copied legacy recipe',
  'a marketplace purchase copied into the recipe tables is listed from the copy');
select is((select count(*)::int from h where entry_id = 'marketplace-unlock:' || (select id from fx where name = 'legacy_resource')), 0,
  'and not a second time from the marketplace');

-- ─── The linked guest, and the link ─────────────────────────────────────────
select is(pg_temp.entry('purchase:' || (select id from fx where name = 'guest_purchase')), 'purchase | 500 | Starter pack | Bought in the app',
  'the linked guest''s purchase is in the account''s history');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'guest_video') || ':charge'), 'spend | -40 | Video generation | -',
  'the linked guest''s spend is in it');
select is(pg_temp.entry('generation:' || (select id from fx where name = 'guest_video') || ':refund'), 'refund | 40 | Refund: failed video | -',
  'and a refund that landed after the link');
select is((select count(*)::int from h where amount = 460 or title ilike '%link%' or title ilike '%merge%'), 0,
  'the link moved the guest''s balance but is not an entry');
select is(
  (select count(*)::int from public.list_credit_history(array['c7000001-0000-4000-8000-000000000001']::uuid[], null, null, 101)
   where entry_id like '%' || (select id from fx where name = 'guest_purchase') || '%'),
  0, 'the account alone does not read the guest''s rows');
select is(
  (select count(*)::int from h
   where entry_id in (
     select 'purchase:' || t.id from public.transactions t
     where t.user_id = 'c7000004-0000-4000-8000-000000000004')),
  0, 'the unrelated creator''s purchase is not in the account''s history');
select is(
  (select count(*)::int from h
   where entry_id in (
     select 'referral:' || l.id from public.referral_credit_ledger l
     where l.user_id = 'c7000003-0000-4000-8000-000000000003')),
  0, 'the inviter''s rewards stay with the inviter');
select is(
  (select array_agg(title order by entry_id) from public.list_credit_history(array['c7000004-0000-4000-8000-000000000004']::uuid[], null, null, 101)),
  array['Starter pack'], 'the unrelated creator reads only its own purchase');

-- ─── The list adds up, newest first ─────────────────────────────────────────
select is(
  (select sum(amount)::int from h),
  (select sum(credits)::int from public.profiles where id in ('c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002')),
  'the entries sum to the balance of the account and its linked guest');
select is((select count(*)::int from h), 32, 'every movement is listed once');
select is((select count(*)::int from (select distinct entry_id from h) ids), 32, 'entry ids are unique');
select is(
  (select array_agg(entry_id order by position desc) from (select * from h order by position desc limit 3) oldest),
  array[
    'purchase:c7200003-0000-4000-8000-000000000003',
    'purchase:c7200003-0000-4000-8000-000000000003:refund',
    'grant:' || (select id from fx where name = 'welcome')
  ],
  'older movements come last, oldest at the end');
select ok(
  (select bool_and(earlier.occurred_at >= later.occurred_at
     and (earlier.occurred_at > later.occurred_at or earlier.entry_id collate "C" > later.entry_id collate "C"))
   from h earlier join h later on later.position = earlier.position + 1),
  'each entry is newer than the next, ties broken by entry id');

-- ─── Keyset pages ───────────────────────────────────────────────────────────
create function pg_temp.walk(p_user_ids uuid[], p_page integer) returns text[] language plpgsql as $$
declare
  v_ids text[] := '{}';
  v_last record;
  v_count integer;
  v_before_at timestamptz := null;
  v_before_id text := null;
begin
  loop
    v_count := 0;
    for v_last in select * from public.list_credit_history(p_user_ids, v_before_at, v_before_id, p_page) loop
      v_ids := v_ids || v_last.entry_id;
      v_before_at := v_last.occurred_at;
      v_before_id := v_last.entry_id;
      v_count := v_count + 1;
    end loop;
    exit when v_count < p_page;
  end loop;
  return v_ids;
end;
$$;

select is(pg_temp.walk(array['c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002']::uuid[], 1),
  (select array_agg(entry_id order by position) from h), 'pages of one cover the list without gaps or repeats');
select is(pg_temp.walk(array['c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002']::uuid[], 3),
  (select array_agg(entry_id order by position) from h), 'pages of three cover the list without gaps or repeats');
select is(pg_temp.walk(array['c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002']::uuid[], 7),
  (select array_agg(entry_id order by position) from h), 'pages of seven cover the list without gaps or repeats');
select is(pg_temp.walk(array['c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002']::uuid[], 32),
  (select array_agg(entry_id order by position) from h), 'a page the size of the list ends with an empty one');
select is(
  (select count(*)::int from public.list_credit_history(
    array['c7000001-0000-4000-8000-000000000001', 'c7000002-0000-4000-8000-000000000002']::uuid[],
    (select occurred_at from h where position = 32), (select entry_id from h where position = 32), 30)),
  0, 'nothing comes after the last entry');

-- ─── Refusals ───────────────────────────────────────────────────────────────
select throws_ok($$select * from public.list_credit_history(array[]::uuid[], null, null, 30)$$, '22023', null,
  'an empty identity set is refused');
select throws_ok($$select * from public.list_credit_history(null, null, null, 30)$$, '22023', null,
  'a missing identity set is refused');
select throws_ok($$select * from public.list_credit_history(array['c7000001-0000-4000-8000-000000000001', null]::uuid[], null, null, 30)$$, '22023', null,
  'a set with a hole is refused');
select throws_ok($$select * from public.list_credit_history(array['c7000001-0000-4000-8000-000000000001', 'c7000004-0000-4000-8000-000000000004']::uuid[], null, null, 30)$$, '22023', null,
  'an identity not linked to the first is refused');
select throws_ok($$select * from public.list_credit_history(array['c7000002-0000-4000-8000-000000000002', 'c7000001-0000-4000-8000-000000000001']::uuid[], null, null, 30)$$, '22023', null,
  'the account cannot be read as if linked to its guest');
select throws_ok($$select * from public.list_credit_history(array['c7000001-0000-4000-8000-000000000001']::uuid[], null, null, 0)$$, '22023', null,
  'a limit below one is refused');
select throws_ok($$select * from public.list_credit_history(array['c7000001-0000-4000-8000-000000000001']::uuid[], null, null, 102)$$, '22023', null,
  'a limit above 101 is refused');
select throws_ok($$select * from public.list_credit_history(array['c7000001-0000-4000-8000-000000000001']::uuid[], now(), null, 30)$$, '22023', null,
  'half a cursor is refused');

-- ─── Closed to clients ──────────────────────────────────────────────────────
select ok(not has_function_privilege('anon', 'public.list_credit_history(uuid[], timestamp with time zone, text, integer)', 'EXECUTE'),
  'anonymous callers cannot read credit history');
select ok(not has_function_privilege('authenticated', 'public.list_credit_history(uuid[], timestamp with time zone, text, integer)', 'EXECUTE'),
  'a signed-in client cannot read credit history directly');
select ok(has_function_privilege('service_role', 'public.list_credit_history(uuid[], timestamp with time zone, text, integer)', 'EXECUTE'),
  'the API reads it as the service role');
select ok((select prosecdef and proconfig = array['search_path=public, pg_temp'] from pg_proc
  where oid = 'public.list_credit_history(uuid[], timestamp with time zone, text, integer)'::regprocedure),
  'it is a definer function with a pinned search path');

select * from finish();
rollback;
