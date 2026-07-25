-- Credit integrity constraints.
--
-- `profiles.credits` predates the migration history (integer, nullable,
-- DEFAULT 0) and every balance mutation assumes arithmetic on a non-NULL
-- value: a NULL balance silently poisons `credits = credits - x` updates.
-- Backfill and lock both balance columns to NOT NULL DEFAULT 0.
--
-- DECISION: no `credits >= 0` / `promotional_credits >= 0` CHECK is added.
-- Negative balances are produced by design by the refund clawback paths:
--   * `reconcile_credit_purchase_adjustment`
--     (20260712123000_invite_and_earn_referrals.sql) runs
--     `SET credits = credits - v_credit_delta` with no clamp — refunding a
--     purchase whose credits were already spent must leave the account in
--     debt rather than forgive the spend.
--   * `reconcile_mobile_credit_refund`
--     (20260620035057_prepare_mobile_credit_refund_reconciliation.sql) runs
--     `SET credits = credits - txn.credits` with no clamp.
--   * `reconcile_referral_purchase_reward_adjustment` applies
--     `promotional_credits = promotional_credits + v_delta` (v_delta negative
--     on reversal) with no clamp, so clawing back an already-spent referral
--     bonus drives `promotional_credits` negative.
-- The spend paths already anticipate this: promotional spending clamps with
-- `greatest(promotional_credits, 0)` before reserving. A >= 0 CHECK would make
-- legitimate refund reconciliation fail mid-flight, so it is intentionally
-- omitted here.

UPDATE public.profiles
SET credits = 0
WHERE credits IS NULL;

UPDATE public.profiles
SET promotional_credits = 0
WHERE promotional_credits IS NULL;

ALTER TABLE public.profiles
  ALTER COLUMN credits SET DEFAULT 0,
  ALTER COLUMN credits SET NOT NULL,
  ALTER COLUMN promotional_credits SET DEFAULT 0,
  ALTER COLUMN promotional_credits SET NOT NULL;

-- Purchase amounts are always positive subunits; both live insert sites
-- (razorpay-credit-order-service and grant_mobile_purchase) write positive
-- catalog amounts, and `reconcile_credit_purchase_adjustment` already treats
-- `amount <= 0` as not-found. Enforce it for new writes with NOT VALID so the
-- lock is short and any pre-history row is left alone; deliberately not
-- VALIDATEd in this migration.
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_amount_positive_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_amount_positive_check
  CHECK (amount > 0) NOT VALID;
