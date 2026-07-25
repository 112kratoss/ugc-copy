-- Stop the creator resource wallet RLS policies re-evaluating auth.uid() per row.
--
-- `auth.uid()` written bare in a policy predicate is treated as volatile and is
-- re-executed for every candidate row, which turns an index lookup into a
-- per-row function call. Wrapping it in a scalar subquery lets the planner
-- evaluate it once per statement and hoist it into an InitPlan.
--
-- Caught by the Supabase performance advisor (auth_rls_initplan) immediately
-- after these tables reached production. Same predicate, same authorization
-- semantics — only the evaluation strategy changes.
--
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select

DROP POLICY IF EXISTS "Creators can view their resource wallet" ON public.creator_resource_wallets;
CREATE POLICY "Creators can view their resource wallet"
  ON public.creator_resource_wallets
  FOR SELECT
  USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "Creators can view their resource wallet entries" ON public.creator_resource_wallet_entries;
CREATE POLICY "Creators can view their resource wallet entries"
  ON public.creator_resource_wallet_entries
  FOR SELECT
  USING ((select auth.uid()) = user_id);
