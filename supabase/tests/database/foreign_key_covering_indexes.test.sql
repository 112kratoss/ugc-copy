-- The foreign keys of agent_oauth_authorizations and completed_post_remixes each have an index whose
-- leading columns are the key's columns (database audit, 2026-11-27: the advisor listed four without one).
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;
SELECT plan(5);

SELECT has_index('public', 'agent_oauth_authorizations', 'agent_oauth_authorizations_client_id_idx', ARRAY['client_id']);
SELECT has_index('public', 'agent_oauth_authorizations', 'agent_oauth_authorizations_grant_id_idx', ARRAY['grant_id']);
SELECT has_index('public', 'agent_oauth_authorizations', 'agent_oauth_authorizations_user_id_idx', ARRAY['user_id']);
SELECT has_index('public', 'completed_post_remixes', 'completed_post_remixes_actor_user_id_idx', ARRAY['actor_user_id']);

-- No foreign key on the tables this migration covers is left without a leading-column index.
SELECT is_empty(
  $$
  SELECT c.conrelid::regclass::text || ' ' || c.conname
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.conrelid IN ('public.agent_oauth_authorizations'::regclass, 'public.completed_post_remixes'::regclass)
    AND NOT EXISTS (
      SELECT 1
      FROM pg_index i
      WHERE i.indrelid = c.conrelid
        AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
        AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey
    )
  $$,
  'every foreign key on the covered tables has a leading-column index'
);

SELECT * FROM finish();
ROLLBACK;
