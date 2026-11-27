-- Covering indexes for four foreign keys (database audit, 2026-11-27).
--
-- Supabase's performance advisor listed agent_oauth_authorizations.client_id, .grant_id and
-- .user_id and completed_post_remixes.actor_user_id as foreign keys with no index whose leading
-- column is the key. Deleting a referenced row (an OAuth client, a grant, an account) then scans
-- the whole referencing table to cascade or set null, under the referenced row's lock. The tables
-- are small today, so a plain CREATE INDEX takes milliseconds; lock_timeout bounds the wait for
-- the share lock it needs.
-- supabase/tests/database/foreign_key_covering_indexes.test.sql holds the indexes.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS agent_oauth_authorizations_client_id_idx ON public.agent_oauth_authorizations (client_id);
CREATE INDEX IF NOT EXISTS agent_oauth_authorizations_grant_id_idx ON public.agent_oauth_authorizations (grant_id);
CREATE INDEX IF NOT EXISTS agent_oauth_authorizations_user_id_idx ON public.agent_oauth_authorizations (user_id);
CREATE INDEX IF NOT EXISTS completed_post_remixes_actor_user_id_idx ON public.completed_post_remixes (actor_user_id);

COMMIT;
