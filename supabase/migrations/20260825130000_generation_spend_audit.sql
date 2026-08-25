-- Preserve the credit facts of a generation past its deletion.
--
-- `generations` is both the content record and the credit-spend record, and
-- `generation-delete-service.ts` issues a hard DELETE. So when a creator tidies
-- up their work, the only evidence that credits were spent goes with it.
--
-- This is not hypothetical: reconstructing every balance on production from its
-- source rows leaves 4,775 credits across 4 accounts that cannot be traced to
-- any surviving row — more than twice all *recorded* generation spend. There is
-- no way to answer "where did this user's credits go" for an account that
-- deletes, and a disputed balance has no audit trail.
--
-- `ai_usage_events` is already an append-only ledger. The path carrying ~97% of
-- the spend was not, and this closes that gap.
--
-- DESIGN: an AFTER DELETE trigger, deliberately, rather than threading ledger
-- writes through the debit RPCs. Those nineteen functions are the money path;
-- rewriting them to double-write would put every purchase, hold, settle and
-- refund at risk to fix an audit gap. A trigger on the one statement that
-- destroys the record is the whole fix, and it cannot change what any balance
-- does. Refunds already leave their own trace (`refunded`), which is captured
-- here so net spend stays reconstructable.

CREATE TABLE IF NOT EXISTS public.generation_spend_audits (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  generation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cost integer NOT NULL,
  promotional_credits_used integer NOT NULL DEFAULT 0,
  refunded boolean NOT NULL DEFAULT false,
  status text,
  model text,
  template_run_id uuid,
  generation_created_at timestamptz,
  deleted_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT generation_spend_audits_cost_check CHECK (cost >= 0),
  CONSTRAINT generation_spend_audits_promotional_check
    CHECK (promotional_credits_used >= 0 AND promotional_credits_used <= cost)
);

-- One row per deleted generation. The delete path already refuses rows attached
-- to a template run, but a re-delete of the same id would otherwise double-count
-- the spend in any reconciliation built on this table.
CREATE UNIQUE INDEX IF NOT EXISTS generation_spend_audits_generation_idx
  ON public.generation_spend_audits (generation_id);

CREATE INDEX IF NOT EXISTS generation_spend_audits_user_deleted_idx
  ON public.generation_spend_audits (user_id, deleted_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.record_generation_spend_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- Free rows carry no spend to preserve; skipping them keeps the table to
  -- rows that actually moved a balance.
  IF coalesce(OLD.cost, 0) <= 0 THEN
    RETURN OLD;
  END IF;

  -- `generations.user_id` is `REFERENCES auth.users ON DELETE CASCADE`, so this
  -- trigger also fires while an account is being deleted — at which point the
  -- auth row is already gone and the INSERT below would fail its own foreign
  -- key, aborting the account deletion. Skipping is also the correct semantics:
  -- an erased account must not leave its spend history behind. This audit exists
  -- for the creator who tidies up their work, not for the one who leaves.
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = OLD.user_id) THEN
    RETURN OLD;
  END IF;

  INSERT INTO public.generation_spend_audits (
    generation_id,
    user_id,
    cost,
    promotional_credits_used,
    refunded,
    status,
    model,
    template_run_id,
    generation_created_at
  )
  VALUES (
    OLD.id,
    OLD.user_id,
    OLD.cost,
    -- Clamped to cost so the CHECK cannot reject the audit and, with it, abort
    -- a delete the user asked for. An audit row is worth more than exactness on
    -- a column that is itself only a tracker.
    least(greatest(coalesce(OLD.promotional_credits_used, 0), 0), OLD.cost),
    coalesce(OLD.refunded, false),
    OLD.status,
    OLD.model,
    OLD.template_run_id,
    OLD.created_at
  )
  ON CONFLICT (generation_id) DO NOTHING;

  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS generations_record_spend_audit ON public.generations;
CREATE TRIGGER generations_record_spend_audit
  AFTER DELETE ON public.generations
  FOR EACH ROW
  EXECUTE FUNCTION public.record_generation_spend_audit();

-- Operator-only. This is spend history for every account; the owner already
-- sees their own balance and creations through the app.
ALTER TABLE public.generation_spend_audits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.generation_spend_audits FROM PUBLIC;
REVOKE ALL ON TABLE public.generation_spend_audits FROM anon;
REVOKE ALL ON TABLE public.generation_spend_audits FROM authenticated;
-- service_role is revoked before it is granted, not merely granted. Supabase's
-- default privileges hand every new table in `public` the full `arwdDxtm` set to
-- anon, authenticated and service_role, so a bare `GRANT SELECT, INSERT` adds
-- nothing and the append-only guarantee would be a comment rather than a
-- constraint. Which default ACL applies depends on the role running the
-- migration, so the revoke makes the outcome the same either way.
REVOKE ALL ON TABLE public.generation_spend_audits FROM service_role;
GRANT SELECT, INSERT ON TABLE public.generation_spend_audits TO service_role;

REVOKE ALL ON FUNCTION public.record_generation_spend_audit() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_generation_spend_audit() FROM anon;
REVOKE ALL ON FUNCTION public.record_generation_spend_audit() FROM authenticated;
