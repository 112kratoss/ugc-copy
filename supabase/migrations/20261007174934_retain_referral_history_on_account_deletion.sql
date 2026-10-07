ALTER TABLE public.transactions ADD COLUMN detached_credit_grant_applied boolean NOT NULL DEFAULT false;

-- Financial history outlives Auth. Nullable live references detach through FK
-- actions; immutable detached UUIDs preserve reconciliation identity.
CREATE FUNCTION public.retain_referral_account_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  column_name text;
  detached_name text;
  previous jsonb;
  candidate jsonb;
  prior_id uuid;
BEGIN
  candidate := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'transactions' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.detached_credit_grant_applied THEN
        RAISE EXCEPTION 'Detached grant evidence cannot be supplied';
      END IF;
    ELSIF NEW.detached_credit_grant_applied IS DISTINCT FROM OLD.detached_credit_grant_applied THEN
      RAISE EXCEPTION 'Detached grant evidence is immutable';
    END IF;
  END IF;
  FOREACH column_name IN ARRAY TG_ARGV LOOP
    detached_name := 'detached_' || column_name;
    IF TG_OP = 'INSERT' THEN
      IF candidate->>detached_name IS NOT NULL THEN
        RAISE EXCEPTION 'Detached account identity cannot be supplied';
      END IF;
      CONTINUE;
    END IF;
    previous := to_jsonb(OLD);
    IF candidate->detached_name IS DISTINCT FROM previous->detached_name THEN
      RAISE EXCEPTION 'Detached account identity is immutable';
    END IF;
    IF candidate->column_name IS NOT DISTINCT FROM previous->column_name THEN
      CONTINUE;
    END IF;
    prior_id := (previous->>column_name)::uuid;
    IF prior_id IS NULL OR candidate->>column_name IS NOT NULL
       OR EXISTS (SELECT 1 FROM auth.users WHERE id = prior_id) THEN
      RAISE EXCEPTION 'Account identity can only detach after Auth deletion';
    END IF;
    candidate := candidate || jsonb_build_object(detached_name, prior_id);
    IF TG_TABLE_NAME = 'transactions' THEN
      candidate := candidate || jsonb_build_object('detached_credit_grant_applied',
        (OLD.status = 'success' AND OLD.credit_effect_applied) OR EXISTS (
          SELECT 1 FROM public.credit_purchase_adjustments
          WHERE transaction_id = OLD.id AND base_credit_delta <> 0
        ));
    END IF;
  END LOOP;
  NEW := jsonb_populate_record(NEW, candidate);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.retain_referral_account_identity() FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.transactions
  ADD COLUMN detached_user_id uuid,
  ALTER COLUMN user_id DROP NOT NULL,
  DROP CONSTRAINT transactions_user_id_fkey;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.transactions.detached_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_transactions_retain_account_identity BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('user_id');

ALTER TABLE public.referral_codes
  ADD COLUMN detached_user_id uuid,
  ALTER COLUMN user_id DROP NOT NULL,
  DROP CONSTRAINT referral_codes_user_id_fkey;
ALTER TABLE public.referral_codes ADD CONSTRAINT referral_codes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_codes.detached_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_referral_codes_retain_account_identity BEFORE INSERT OR UPDATE ON public.referral_codes
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('user_id');

ALTER TABLE public.referral_visits
  ADD COLUMN detached_inviter_user_id uuid,
  ALTER COLUMN inviter_user_id DROP NOT NULL,
  DROP CONSTRAINT referral_visits_inviter_user_id_fkey;
ALTER TABLE public.referral_visits ADD CONSTRAINT referral_visits_inviter_user_id_fkey
  FOREIGN KEY (inviter_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_visits.detached_inviter_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_referral_visits_retain_account_identity BEFORE INSERT OR UPDATE ON public.referral_visits
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('inviter_user_id');

ALTER TABLE public.referral_attributions
  ADD COLUMN detached_inviter_user_id uuid,
  ALTER COLUMN inviter_user_id DROP NOT NULL,
  DROP CONSTRAINT referral_attributions_inviter_user_id_fkey;
ALTER TABLE public.referral_attributions ADD CONSTRAINT referral_attributions_inviter_user_id_fkey
  FOREIGN KEY (inviter_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_attributions.detached_inviter_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
ALTER TABLE public.referral_attributions
  ADD COLUMN detached_invitee_user_id uuid,
  ALTER COLUMN invitee_user_id DROP NOT NULL,
  DROP CONSTRAINT referral_attributions_invitee_user_id_fkey;
ALTER TABLE public.referral_attributions ADD CONSTRAINT referral_attributions_invitee_user_id_fkey
  FOREIGN KEY (invitee_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_attributions.detached_invitee_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_referral_attributions_retain_account_identity BEFORE INSERT OR UPDATE ON public.referral_attributions
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('inviter_user_id', 'invitee_user_id');

ALTER TABLE public.referral_purchase_events
  ADD COLUMN detached_purchaser_user_id uuid,
  ALTER COLUMN purchaser_user_id DROP NOT NULL,
  DROP CONSTRAINT referral_purchase_events_purchaser_user_id_fkey;
ALTER TABLE public.referral_purchase_events ADD CONSTRAINT referral_purchase_events_purchaser_user_id_fkey
  FOREIGN KEY (purchaser_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_purchase_events.detached_purchaser_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_referral_purchase_events_retain_account_identity BEFORE INSERT OR UPDATE ON public.referral_purchase_events
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('purchaser_user_id');

ALTER TABLE public.referral_rewards
  ADD COLUMN detached_beneficiary_user_id uuid,
  ALTER COLUMN beneficiary_user_id DROP NOT NULL,
  DROP CONSTRAINT referral_rewards_beneficiary_user_id_fkey;
ALTER TABLE public.referral_rewards ADD CONSTRAINT referral_rewards_beneficiary_user_id_fkey
  FOREIGN KEY (beneficiary_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_rewards.detached_beneficiary_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_referral_rewards_retain_account_identity BEFORE INSERT OR UPDATE ON public.referral_rewards
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('beneficiary_user_id');

ALTER TABLE public.referral_credit_ledger
  ADD COLUMN detached_user_id uuid,
  ALTER COLUMN user_id DROP NOT NULL,
  DROP CONSTRAINT referral_credit_ledger_user_id_fkey;
ALTER TABLE public.referral_credit_ledger ADD CONSTRAINT referral_credit_ledger_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.referral_credit_ledger.detached_user_id IS
  'Original account UUID retained for financial reconciliation after Auth deletion; never an active account reference.';
CREATE TRIGGER aa_referral_credit_ledger_retain_account_identity BEFORE INSERT OR UPDATE ON public.referral_credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.retain_referral_account_identity('user_id');

-- The append-only ledger permits exactly the FK-driven identity detachment.
-- Amounts, event keys and every other field remain immutable, including for
-- service_role. Other audit tables retain their unconditional mutation guard.
CREATE OR REPLACE FUNCTION public.prevent_referral_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'referral_credit_ledger' AND TG_OP = 'UPDATE' THEN
    IF OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
       AND OLD.detached_user_id IS NULL AND NEW.detached_user_id = OLD.user_id
       AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id)
       AND (to_jsonb(NEW) - 'user_id' - 'detached_user_id') =
           (to_jsonb(OLD) - 'user_id' - 'detached_user_id') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'referral audit rows are append-only';
END;
$$;
REVOKE ALL ON FUNCTION public.prevent_referral_audit_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_deleted_account_referrals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.referral_codes SET is_enabled = false, disabled_reason = 'account_deleted'
    WHERE user_id = OLD.id;
  UPDATE public.referral_visits SET ip_hash = NULL, user_agent_hash = NULL, destination_path = NULL
    WHERE inviter_user_id = OLD.id;
  -- A deleted beneficiary has no delivery destination. Completion is durable,
  -- so queued history cannot become an endless FK-error retry after detachment.
  UPDATE public.referral_reward_notification_outbox q
    SET completed_at = now(), last_error_code = NULL
    FROM public.referral_credit_ledger l
    WHERE q.ledger_id = l.id AND l.user_id = OLD.id AND q.completed_at IS NULL;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_deleted_account_referrals() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER cancel_deleted_account_referrals BEFORE DELETE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.cancel_deleted_account_referrals();

CREATE INDEX referral_attributions_detached_invitee_idx ON public.referral_attributions(detached_invitee_user_id) WHERE detached_invitee_user_id IS NOT NULL;
DO $migration$
DECLARE definition text; old_block text; new_block text;
BEGIN
  SELECT pg_get_functiondef('public.prevent_referral_identity_mutation()'::regprocedure) INTO definition;
  old_block := $old$IF NEW.user_id IS DISTINCT FROM OLD.user_id$old$;
  new_block := $new$IF (NEW.user_id IS DISTINCT FROM OLD.user_id
      AND NOT (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL
        AND NEW.detached_user_id = OLD.user_id
        AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id)))$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in prevent_referral_identity_mutation()';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.settle_referral_purchase_rewards(uuid)'::regprocedure) INTO definition;
  old_block := $old$WHERE invitee_user_id = v_transaction.user_id$old$;
  new_block := $new$WHERE invitee_user_id = v_transaction.user_id
     OR (v_transaction.user_id IS NULL AND detached_invitee_user_id = v_transaction.detached_user_id)$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in settle_referral_purchase_rewards(uuid)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.settle_referral_purchase_rewards(uuid)'::regprocedure) INTO definition;
  old_block := $old$  IF v_first_transaction_id = v_transaction.id$old$;
  new_block := $new$  IF v_attribution.invitee_user_id IS NOT NULL AND v_first_transaction_id = v_transaction.id$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in settle_referral_purchase_rewards(uuid)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.list_unsettled_referral_purchase_transactions(integer)'::regprocedure) INTO definition;
  old_block := $old$ON attributions.invitee_user_id = transactions.user_id$old$;
  new_block := $new$ON attributions.invitee_user_id = transactions.user_id
      OR (transactions.user_id IS NULL AND attributions.detached_invitee_user_id = transactions.detached_user_id)$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in list_unsettled_referral_purchase_transactions(integer)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.settle_referral_purchase_rewards(uuid)'::regprocedure) INTO definition;
  old_block := $old$IF v_original_reward_credits > 0 THEN
    INSERT$old$;
  new_block := $new$IF v_original_reward_credits > 0 AND v_attribution.inviter_user_id IS NOT NULL THEN
    INSERT$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in settle_referral_purchase_rewards(uuid)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.reconcile_referral_purchase_reward_adjustment(uuid,text,integer,text,text)'::regprocedure) INTO definition;
  old_block := $old$  LOOP
    v_target_active := floor($old$;
  new_block := $new$  LOOP
    IF v_reward.beneficiary_user_id IS NULL THEN
      CONTINUE;
    END IF;
    v_target_active := floor($new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in reconcile_referral_purchase_reward_adjustment(uuid,text,integer,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)'::regprocedure) INTO definition;
  old_block := $old$  v_grant_applied := ($old$;
  new_block := $new$  v_grant_applied := v_transaction.detached_credit_grant_applied OR ($new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)'::regprocedure) INTO definition;
  old_block := $old$v_applied_credit_delta := CASE WHEN v_grant_applied THEN v_credit_delta ELSE 0 END;$old$;
  new_block := $new$v_applied_credit_delta := CASE WHEN v_grant_applied AND v_transaction.user_id IS NOT NULL THEN v_credit_delta ELSE 0 END;$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)'::regprocedure) INTO definition;
  old_block := $old$    v_referral_adjustment := public.reconcile_referral_purchase_reward_adjustment(
      p_transaction_id,
      CASE WHEN v_applied_credit_delta > 0 THEN 'reverse' ELSE 'restore' END,
      abs(v_applied_credit_delta),
      v_provider || ':' || btrim(p_provider_event_id),
      p_reason
    );$old$;
  new_block := $new$    -- Surviving referral beneficiaries reconcile below, even for a deleted buyer.$new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
  SELECT pg_get_functiondef('public.reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)'::regprocedure) INTO definition;
  old_block := $old$  INSERT INTO public.credit_purchase_adjustments ($old$;
  new_block := $new$  IF v_grant_applied AND v_credit_delta <> 0 THEN
    v_referral_adjustment := public.reconcile_referral_purchase_reward_adjustment(
      p_transaction_id,
      CASE WHEN v_credit_delta > 0 THEN 'reverse' ELSE 'restore' END,
      abs(v_credit_delta),
      v_provider || ':' || btrim(p_provider_event_id),
      p_reason
    );
    SELECT credits INTO v_balance FROM public.profiles WHERE id = v_transaction.user_id;
  END IF;

  INSERT INTO public.credit_purchase_adjustments ($new$;
  IF (length(definition) - length(replace(definition, old_block, ''))) / length(old_block) <> 1 THEN
    RAISE EXCEPTION 'Expected one referral deletion block in reconcile_credit_purchase_adjustment(uuid,text,text,bigint,text,text)';
  END IF;
  EXECUTE replace(definition, old_block, new_block);
END;
$migration$;
