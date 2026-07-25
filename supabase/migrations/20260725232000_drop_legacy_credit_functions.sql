-- Drop legacy credit RPCs that are no longer called anywhere.
--
-- * `deduct_credits(uuid, integer)` (20260225195908_remote_schema.sql) is the
--   pre-hardening spend path: a read-then-write balance check with no row
--   lock, so two concurrent calls can both pass the check and double-spend.
--   Spending now goes through the atomic reservation RPCs
--   (`start_generation`, `start_ai_usage_event`, the unlock RPCs), which
--   lock the profile row.
-- * `refund_generation(text)` (20260314170000_credit_refund.sql) refunded by
--   provider prediction id and predates the ledger-settled refund flow
--   (`settle_generation_failed` / `refund_ai_usage_event`); no server code
--   path invokes it.
--
-- Both were already service_role-only
-- (20260620040458_harden_credit_mutations_and_reconcile_mobile_refunds.sql);
-- the only remaining references were test mocks. Dropping them removes the
-- race-prone spend path entirely instead of leaving it callable.
--
-- `refund_credits(uuid, integer)` is intentionally kept: generation-services
-- still calls it.

DROP FUNCTION IF EXISTS public.deduct_credits(uuid, integer);
DROP FUNCTION IF EXISTS public.refund_generation(text);
