-- Cover foreign keys so parent updates/deletes and relationship joins do not
-- require full-table scans as these tables grow.
CREATE INDEX IF NOT EXISTS ai_usage_events_user_id_idx
  ON public.ai_usage_events (user_id);
CREATE INDEX IF NOT EXISTS generation_input_media_source_generation_idx
  ON public.generation_input_media (source_generation_id);
CREATE INDEX IF NOT EXISTS generation_share_events_actor_idx
  ON public.generation_share_events (actor_user_id);
CREATE INDEX IF NOT EXISTS generations_archived_by_idx
  ON public.generations (archived_by_user_id);
CREATE INDEX IF NOT EXISTS generations_template_idx
  ON public.generations (template_id);
CREATE INDEX IF NOT EXISTS marketplace_assets_seller_idx
  ON public.marketplace_assets (seller_user_id);
CREATE INDEX IF NOT EXISTS marketplace_purchases_order_idx
  ON public.marketplace_purchases (order_id);
CREATE INDEX IF NOT EXISTS mobile_notifications_actor_idx
  ON public.mobile_notifications (actor_user_id);
CREATE INDEX IF NOT EXISTS mobile_push_deliveries_user_idx
  ON public.mobile_push_deliveries (user_id);
CREATE INDEX IF NOT EXISTS post_reports_bundle_idx
  ON public.post_reports (bundle_id);
CREATE INDEX IF NOT EXISTS post_reports_reporter_idx
  ON public.post_reports (reporter_user_id);
CREATE INDEX IF NOT EXISTS post_bundle_purchases_order_idx
  ON public.post_resource_bundle_purchases (order_id);
CREATE INDEX IF NOT EXISTS post_resource_bundles_owner_idx
  ON public.post_resource_bundles (owner_user_id);
CREATE INDEX IF NOT EXISTS post_share_events_actor_idx
  ON public.post_share_events (actor_user_id);
CREATE INDEX IF NOT EXISTS posts_archived_by_idx
  ON public.posts (archived_by_user_id);
CREATE INDEX IF NOT EXISTS posts_reviewed_by_idx
  ON public.posts (reviewed_by);
CREATE INDEX IF NOT EXISTS transactions_user_idx
  ON public.transactions (user_id);
CREATE INDEX IF NOT EXISTS workflow_assistant_messages_proposal_idx
  ON public.workflow_canvas_assistant_messages (proposal_id);
CREATE INDEX IF NOT EXISTS workflow_assistant_messages_user_idx
  ON public.workflow_canvas_assistant_messages (user_id);
CREATE INDEX IF NOT EXISTS workflow_assistant_proposals_user_idx
  ON public.workflow_canvas_assistant_proposals (user_id);
CREATE INDEX IF NOT EXISTS workflow_canvas_history_user_idx
  ON public.workflow_canvas_history (user_id);
CREATE INDEX IF NOT EXISTS workflow_run_steps_generation_idx
  ON public.workflow_canvas_run_steps (generation_id);
CREATE INDEX IF NOT EXISTS workflow_canvas_runs_user_idx
  ON public.workflow_canvas_runs (user_id);

-- Keep every policy's existing command and predicates while evaluating auth
-- helpers once per statement instead of once for every candidate row.
DO $migration$
DECLARE
  policy_record record;
  optimized_qual text;
  optimized_with_check text;
  role_list text;
BEGIN
  FOR policy_record IN
    SELECT p.*
    FROM pg_policies AS p
    JOIN (
      VALUES
        ('public', 'ai_usage_events', 'Users can view their own usage events.'),
        ('public', 'follows', 'Users can insert their own follows.'),
        ('public', 'follows', 'Users can delete their own follows.'),
        ('public', 'workflow_canvas_history', 'Users can view their own workflow canvas history'),
        ('public', 'workflow_canvas_history', 'Users can create their own workflow canvas history'),
        ('public', 'workflow_shares', 'Users can create their own workflow shares'),
        ('public', 'posts', 'Users can insert their own posts'),
        ('public', 'posts', 'Users can update their own posts'),
        ('public', 'posts', 'Users can delete their own posts'),
        ('public', 'post_saves', 'Users can insert their own post saves'),
        ('public', 'post_saves', 'Users can delete their own post saves'),
        ('public', 'marketplace_assets', 'Sellers can view their own assets'),
        ('public', 'marketplace_assets', 'Sellers can insert their own assets'),
        ('public', 'marketplace_assets', 'Sellers can update their own assets'),
        ('public', 'marketplace_assets', 'Sellers can delete their own assets'),
        ('public', 'marketplace_asset_content', 'Asset content is viewable by seller or buyer'),
        ('public', 'post_resource_bundle_orders', 'Buyers can view their own post resource bundle orders'),
        ('public', 'post_resource_bundle_purchases', 'Buyers can view their own post resource bundle purchases'),
        ('public', 'marketplace_asset_content', 'Sellers can insert their own asset content'),
        ('public', 'marketplace_asset_content', 'Sellers can update their own asset content'),
        ('public', 'marketplace_orders', 'Buyers can view their own marketplace orders'),
        ('public', 'marketplace_purchases', 'Buyers can view their own marketplace purchases'),
        ('public', 'post_saves', 'Users can view their own post saves'),
        ('public', 'post_resource_bundles', 'Post resource bundles are viewable by owner or published'),
        ('public', 'post_resource_bundles', 'Users can insert their own post resource bundles'),
        ('public', 'post_resource_bundles', 'Users can update their own post resource bundles'),
        ('public', 'post_resource_bundles', 'Users can delete their own post resource bundles'),
        ('public', 'posts', 'Posts are viewable by owner or public'),
        ('public', 'post_deletion_audits', 'Owners can view their own post deletion audits'),
        ('public', 'post_deletion_audits', 'Owners can insert their own post deletion audits'),
        ('public', 'workflow_canvas_assistant_proposals', 'Users can view their own workflow canvas assistant proposals'),
        ('public', 'workflow_canvas_assistant_proposals', 'Users can create their own workflow canvas assistant proposals'),
        ('public', 'workflow_canvas_assistant_proposals', 'Users can update their own workflow canvas assistant proposals'),
        ('public', 'workflow_canvas_assistant_messages', 'Users can view their own workflow canvas assistant messages'),
        ('public', 'workflow_canvas_assistant_messages', 'Users can create their own workflow canvas assistant messages'),
        ('public', 'workflow_canvas_assistant_messages', 'Users can update their own workflow canvas assistant messages'),
        ('public', 'post_reports', 'Users can insert post reports'),
        ('public', 'post_reports', 'Users can view their own post reports'),
        ('public', 'mobile_push_tokens', 'Users can manage their own mobile push tokens'),
        ('public', 'generation_input_media', 'Users can view own generation input media'),
        ('public', 'generation_input_media', 'Users can insert own generation input media'),
        ('public', 'generation_input_media', 'Users can update own generation input media'),
        ('public', 'generation_input_media', 'Users can delete own generation input media'),
        ('public', 'mobile_notification_preferences', 'Users can view their own mobile notification preferences'),
        ('public', 'mobile_notification_preferences', 'Users can insert their own mobile notification preferences'),
        ('public', 'mobile_notifications', 'Users can view their own mobile notifications'),
        ('public', 'mobile_notifications', 'Users can update their own mobile notifications'),
        ('public', 'mobile_notification_preferences', 'Users can update their own mobile notification preferences'),
        ('public', 'post_media', 'Post media is viewable by owner or visible post'),
        ('public', 'post_media', 'Users can insert media for their own posts'),
        ('public', 'post_media', 'Users can update media for their own posts'),
        ('public', 'post_media', 'Users can delete media for their own posts'),
        ('storage', 'objects', 'Authenticated users can upload own files'),
        ('storage', 'objects', 'Authenticated users can upload own generated audio'),
        ('storage', 'objects', 'Authenticated users can upload own generated images'),
        ('storage', 'objects', 'Authenticated users can upload own generated videos'),
        ('storage', 'objects', 'Users can delete own generation inputs'),
        ('storage', 'objects', 'Users can read own generated audio'),
        ('storage', 'objects', 'Users can read own generated images'),
        ('storage', 'objects', 'Users can read own generated videos'),
        ('storage', 'objects', 'Users can read own generation inputs'),
        ('storage', 'objects', 'Users can read own uploads'),
        ('storage', 'objects', 'Users can update own generation inputs'),
        ('storage', 'objects', 'Users can upload own generation inputs')
    ) AS target(schema_name, table_name, policy_name)
      ON target.schema_name = p.schemaname
      AND target.table_name = p.tablename
      AND target.policy_name = p.policyname
  LOOP
    optimized_qual := CASE
      WHEN policy_record.qual IS NULL THEN NULL
      ELSE replace(policy_record.qual, 'auth.uid()', '(select auth.uid())')
    END;
    optimized_with_check := CASE
      WHEN policy_record.with_check IS NULL THEN NULL
      ELSE replace(policy_record.with_check, 'auth.uid()', '(select auth.uid())')
    END;

    SELECT string_agg(quote_ident(role_name::text), ', ')
    INTO role_list
    FROM unnest(policy_record.roles) AS role_name;

    EXECUTE format(
      'ALTER POLICY %I ON %I.%I TO %s%s%s',
      policy_record.policyname,
      policy_record.schemaname,
      policy_record.tablename,
      role_list,
      CASE
        WHEN optimized_qual IS NULL THEN ''
        ELSE format(' USING (%s)', optimized_qual)
      END,
      CASE
        WHEN optimized_with_check IS NULL THEN ''
        ELSE format(' WITH CHECK (%s)', optimized_with_check)
      END
    );
  END LOOP;
END;
$migration$;

-- Express authenticated-only intent with policy roles instead of auth.role().
ALTER POLICY "Authenticated users can view workflow shares"
  ON public.workflow_shares
  TO authenticated
  USING (true);

ALTER POLICY "Users can create their own workflow shares"
  ON public.workflow_shares TO authenticated;
ALTER POLICY "Users can view their own usage events."
  ON public.ai_usage_events TO authenticated;
ALTER POLICY "Users can insert their own follows."
  ON public.follows TO authenticated;
ALTER POLICY "Users can delete their own follows."
  ON public.follows TO authenticated;
ALTER POLICY "Users can view their own workflow canvas history"
  ON public.workflow_canvas_history TO authenticated;
ALTER POLICY "Users can create their own workflow canvas history"
  ON public.workflow_canvas_history TO authenticated;

ALTER POLICY "Users can view their own workflow canvas assistant proposals"
  ON public.workflow_canvas_assistant_proposals TO authenticated;
ALTER POLICY "Users can create their own workflow canvas assistant proposals"
  ON public.workflow_canvas_assistant_proposals TO authenticated;
ALTER POLICY "Users can update their own workflow canvas assistant proposals"
  ON public.workflow_canvas_assistant_proposals
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can view their own workflow canvas assistant messages"
  ON public.workflow_canvas_assistant_messages TO authenticated;
ALTER POLICY "Users can create their own workflow canvas assistant messages"
  ON public.workflow_canvas_assistant_messages TO authenticated;
ALTER POLICY "Users can update their own workflow canvas assistant messages"
  ON public.workflow_canvas_assistant_messages
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

-- The legacy policy allowed any authenticated user to update any generated
-- video. Preserve upsert support while enforcing ownership by path.
DROP POLICY IF EXISTS "Users can update generated videos." ON storage.objects;
CREATE POLICY "Users can update own generated videos"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'generated_videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  )
  WITH CHECK (
    bucket_id = 'generated_videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
