-- Cover referral foreign keys used by reward settlement, reconciliation, and
-- retention cleanup. These are additive and safe to apply after launch.
CREATE INDEX IF NOT EXISTS referral_attributions_program_id_idx
  ON public.referral_attributions (program_id);

CREATE INDEX IF NOT EXISTS referral_credit_ledger_reward_id_idx
  ON public.referral_credit_ledger (reward_id);

CREATE INDEX IF NOT EXISTS referral_credit_ledger_transaction_id_idx
  ON public.referral_credit_ledger (transaction_id);

CREATE INDEX IF NOT EXISTS referral_purchase_events_purchaser_user_id_idx
  ON public.referral_purchase_events (purchaser_user_id);

CREATE INDEX IF NOT EXISTS referral_visits_inviter_user_id_idx
  ON public.referral_visits (inviter_user_id);

CREATE INDEX IF NOT EXISTS referral_visits_program_id_idx
  ON public.referral_visits (program_id);
