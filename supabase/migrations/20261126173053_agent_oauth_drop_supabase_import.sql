-- The app's own authorization server for the MCP routes has been the only one since the cutover
-- of 2026-11-26 (docs/archive/agent-token-broker-plan-2026-11-26.md): Supabase Auth's OAuth server
-- is switched off, and its clients were copied into public.agent_oauth_clients that day by
-- agent_oauth_import_supabase_clients (20261126121704, replaced in 20261126151150). The copy was
-- a one-time step of the cutover and nothing calls it any more, so it goes. The tables and the
-- other agent_oauth_* functions are unchanged.

drop function if exists public.agent_oauth_import_supabase_clients(text[]);
