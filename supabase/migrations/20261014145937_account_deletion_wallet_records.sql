-- What a deleted account was still owed, kept past the account.
--
-- creator_resource_wallets is `REFERENCES auth.users ON DELETE CASCADE`
-- (20260723130000), and account deletion is a hard admin.deleteUser. Only a
-- payout request already filed survives, detached (20260801150000), and a
-- request needs $100 (20260801120000). A seller who deleted with earnings below
-- that, or who never asked for them, left no trace that the platform owed them
-- anything. A financial liability is never silently destroyed: the deletion
-- service writes one row per wallet here while the auth rows still exist, in
-- both the immediate pass and the scheduler's retry, before the Auth delete
-- that cascades the wallet away.
--
-- Deliberately no foreign key on either id: the row must outlive the user it
-- describes (precedent: account_deletion_jobs, 20260714112000, and
-- credit_grant_identity_fingerprints, 20260829120000). job_id is the
-- account_deletion_jobs key, the deleted target's user id, so a linked guest's
-- wallet carries the target's job_id beside its own user_id.
--
-- The amounts copy the wallet's columns with no CHECKs of their own: a
-- constraint here could only ever stop the deletion this row records.

CREATE TABLE public.account_deletion_wallet_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  job_id uuid NOT NULL,
  available_token_subunits bigint NOT NULL,
  held_token_subunits bigint NOT NULL,
  lifetime_earned_token_subunits bigint NOT NULL,
  lifetime_refunded_token_subunits bigint NOT NULL,
  lifetime_paid_out_token_subunits bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- One row per wallet per deletion: a retried job repeats its write as a
  -- no-op (ON CONFLICT DO NOTHING needs only INSERT).
  CONSTRAINT account_deletion_wallet_records_user_job_key UNIQUE (user_id, job_id)
);

COMMENT ON TABLE public.account_deletion_wallet_records IS
  'Append-only. The creator wallet balances an account deletion found, written before Auth deletion cascades creator_resource_wallets away. Amounts in wallet token subunits (10000 = $1).';

-- Operator-only, like the wallet ledger it outlives: no client reads it.
ALTER TABLE public.account_deletion_wallet_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "No client access to account_deletion_wallet_records"
  ON public.account_deletion_wallet_records FOR ALL TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- Append-only, enforced. New tables are born with every privilege for anon,
-- authenticated and service_role through Supabase's default ACL, so a bare
-- GRANT SELECT, INSERT changes nothing: UPDATE and DELETE are gone only once
-- everything is revoked first.
REVOKE ALL ON TABLE public.account_deletion_wallet_records
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.account_deletion_wallet_records TO service_role;
