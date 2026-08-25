-- Keep dev-era test purchases out of revenue.
--
-- Seven successful web transactions from February 2026 charged 1 or 5 rupees and
-- granted a full 500 credits each — Razorpay test-mode traffic from before the
-- catalog price was wired up. They are indistinguishable from real sales in
-- every revenue query, and they inflate the web rail from one genuine purchase
-- to eight, and credits-sold from 500 to 4,000. Six more abandoned checkouts
-- from the same sessions distort the conversion figure the same way.
--
-- The mobile rail already had this concept: `admin-revenue-service` excludes
-- `provider = 'sandbox'` from `mobile_store_transactions`. The web rail had no
-- equivalent.
--
-- DETECTION: every real purchase settles at exactly the catalog rate of 83 paise
-- per credit, because `razorpay-credit-order-service` derives the amount from
-- PRICING_PLAN_MAP and `add_credits` grants the credits recorded on the row. The
-- test rows sit at 1.00 and 0.20 paise per credit. The threshold below is 20 — a
-- four-fold margin under the real rate, so no genuine purchase can be caught by
-- it even if pricing changes substantially.
--
-- Credits already granted are deliberately left alone. Three of these accounts
-- still hold the balances, and clawing them back now would take spendable
-- credits from people who did nothing wrong. This flag changes reporting only.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

UPDATE public.transactions
SET is_test = true
WHERE mobile_product_id IS NULL
  AND credits > 0
  AND amount < credits * 20
  AND NOT is_test;

-- Reporting reads `is_test = false` over the whole table, so the index is
-- partial on the rows that are excluded — a handful now, and it stays small.
CREATE INDEX IF NOT EXISTS transactions_is_test_idx
  ON public.transactions (created_at DESC)
  WHERE is_test;

COMMENT ON COLUMN public.transactions.is_test IS
  'Dev-era or test-mode purchase. Excluded from revenue reporting; the credits it granted are still real and still spendable.';
