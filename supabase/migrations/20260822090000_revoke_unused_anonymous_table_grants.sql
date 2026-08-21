-- Supabase projects created before the explicit Data API grant convention can
-- retain anonymous table privileges from platform defaults. RLS currently
-- hides these rows, but the unused grants are an unnecessary outer path that a
-- later permissive policy could silently activate.

REVOKE ALL PRIVILEGES ON TABLE
  public.ai_usage_events,
  public.generation_input_media,
  public.marketplace_asset_content,
  public.mobile_notification_preferences,
  public.mobile_notifications,
  public.mobile_push_tokens,
  public.post_deletion_audits,
  public.post_save_events,
  public.post_saves,
  public.profiles,
  public.workflow_canvas_assistant_messages,
  public.workflow_canvas_assistant_proposals,
  public.workflow_canvas_history,
  public.workflow_canvases
FROM anon;

-- A relation-level revoke does not remove independently granted column
-- privileges. Clear those too so long-lived databases and clean replays
-- converge even if their historical ACL shapes differ.
DO $$
DECLARE
  v_table_name text;
  v_column_list text;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'ai_usage_events',
    'generation_input_media',
    'marketplace_asset_content',
    'mobile_notification_preferences',
    'mobile_notifications',
    'mobile_push_tokens',
    'post_deletion_audits',
    'post_save_events',
    'post_saves',
    'profiles',
    'workflow_canvas_assistant_messages',
    'workflow_canvas_assistant_proposals',
    'workflow_canvas_history',
    'workflow_canvases'
  ]
  LOOP
    SELECT string_agg(quote_ident(columns.column_name), ', ' ORDER BY columns.ordinal_position)
    INTO v_column_list
    FROM information_schema.columns
    WHERE columns.table_schema = 'public'
      AND columns.table_name = v_table_name;

    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM anon',
      v_column_list,
      v_table_name
    );
  END LOOP;
END;
$$;

-- These four catalogs/social surfaces are deliberately anonymous-readable.
-- Preserve their existing table- or column-scoped SELECT contracts, while
-- removing PostgreSQL 17's unrelated MAINTAIN privilege from a web identity.
REVOKE MAINTAIN ON TABLE
  public.follows,
  public.source_tool_models,
  public.source_tools,
  public.templates
FROM anon;
