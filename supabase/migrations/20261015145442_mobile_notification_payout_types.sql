-- A seller is told when an operator pays or rejects their payout request
-- (creator_payout_paid / creator_payout_rejected, written by
-- notifyCreatorPayoutResolved). The type check last widened in
-- 20260712123000_invite_and_earn_referrals.sql refused the two inserts.
ALTER TABLE public.mobile_notifications DROP CONSTRAINT IF EXISTS mobile_notifications_type_check;
ALTER TABLE public.mobile_notifications ADD CONSTRAINT mobile_notifications_type_check CHECK (type IN (
  'generation_succeeded', 'generation_failed', 'credits_purchased', 'purchases_restored',
  'marketplace_unlocked', 'post_resource_unlocked', 'creator_followed', 'post_saved', 'post_remixed',
  'post_shared', 'referral_reward_earned', 'referral_reward_reversed',
  'creator_payout_paid', 'creator_payout_rejected'
));
