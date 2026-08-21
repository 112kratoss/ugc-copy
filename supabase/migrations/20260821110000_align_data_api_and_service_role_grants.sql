-- Two grant divergences between the migration source and every long-lived
-- database, both surfaced by `registered_money_table_boundaries` passing
-- locally and failing in CI. Long-lived databases still hold the ambient
-- Supabase defaults their tables were created with; a clean replay creates
-- only what the migrations state, so the two disagree about who may touch
-- what. Production already matches the end state below, so this is a no-op
-- there and a correctness fix in every environment built from scratch.

-- 1. Data API grants with no consumer.
--
-- `marketplace_orders` and `marketplace_purchases` predate the explicit
-- REVOKE/GRANT convention and still carry `anon SELECT` plus
-- `authenticated SELECT/INSERT/UPDATE/DELETE` in production. Every read and
-- write of both goes through `createServiceClient()`, and neither table is
-- referenced anywhere under `src/app` or `ugc-mobile`, so nothing consumes
-- those grants. `transactions` keeps its authenticated SELECT, which the live
-- `Users can view their own transactions.` policy needs; only its unused
-- anonymous read goes.

REVOKE ALL PRIVILEGES ON TABLE public.marketplace_orders FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.marketplace_purchases FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.transactions FROM anon;

-- 2. Service-role access that was inherited rather than stated.
--
-- These tables never received an explicit service-role grant: the
-- pre-convention ones never had a GRANT block at all, and `20260723130000`
-- and `20260714100600` revoke `ALL ... FROM PUBLIC` while re-granting only
-- `authenticated`. Both shapes work in a long-lived database purely because
-- the ambient default is still there, and both leave the server identity with
-- no privilege at all after a clean replay -- which would ship a fresh
-- environment where marketplace checkout, creator wallets, generation
-- idempotency, mobile push and the workflow canvas are all unreachable from
-- the server. State the grant instead of inheriting it.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ai_usage_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.creator_resource_wallet_entries TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.creator_resource_wallets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generation_input_media TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.generation_start_requests TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_asset_content TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.marketplace_purchases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_notification_preferences TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_notifications TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.mobile_push_tokens TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_deletion_audits TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.source_tool_models TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.source_tools TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_canvas_assistant_messages TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_canvas_assistant_proposals TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_canvas_history TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_canvases TO service_role;
