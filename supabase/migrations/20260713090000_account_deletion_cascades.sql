-- Account deletion must remove user-owned records instead of being blocked by
-- legacy foreign keys that predate the in-app deletion flow.
DO $$
DECLARE
  relation_name text;
  constraint_name text;
  column_name text;
BEGIN
  FOR relation_name, constraint_name, column_name IN
    SELECT * FROM (VALUES
      ('public.transactions', 'transactions_user_id_fkey', 'user_id'),
      ('public.showcase_saves', 'showcase_saves_user_id_fkey', 'user_id'),
      ('public.workflow_canvases', 'workflow_canvases_user_id_fkey', 'user_id'),
      ('public.workflow_canvas_runs', 'workflow_canvas_runs_user_id_fkey', 'user_id'),
      ('public.workflow_canvas_history', 'workflow_canvas_history_user_id_fkey', 'user_id'),
      ('public.workflow_canvas_assistant_proposals', 'workflow_canvas_assistant_proposals_user_id_fkey', 'user_id'),
      ('public.workflow_canvas_assistant_messages', 'workflow_canvas_assistant_messages_user_id_fkey', 'user_id'),
      ('public.ai_usage_events', 'ai_usage_events_user_id_fkey', 'user_id')
    ) AS constraints_to_update(relation_name, constraint_name, column_name)
  LOOP
    IF to_regclass(relation_name) IS NOT NULL AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = constraint_name
        AND conrelid = to_regclass(relation_name)
    ) THEN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', relation_name, constraint_name);
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES auth.users(id) ON DELETE CASCADE',
        relation_name,
        constraint_name,
        column_name
      );
    END IF;
  END LOOP;
END $$;
