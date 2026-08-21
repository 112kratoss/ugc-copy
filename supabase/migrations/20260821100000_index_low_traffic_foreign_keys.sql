-- These foreign keys mostly point at admin/reviewer identities and are low
-- traffic, but PostgreSQL still needs a supporting lookup when an auth user is
-- deleted or updated. Keep the indexes narrow because their primary purpose is
-- referential-integrity maintenance rather than application query ordering.

CREATE INDEX IF NOT EXISTS generations_moderation_removed_by_idx
  ON public.generations (moderation_removed_by)
  WHERE moderation_removed_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS contact_messages_handled_by_idx
  ON public.contact_messages (handled_by)
  WHERE handled_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS account_merge_tickets_target_user_id_idx
  ON public.account_merge_tickets (target_user_id)
  WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS admin_user_sanctions_reviewer_id_idx
  ON public.admin_user_sanctions (reviewer_id);

CREATE INDEX IF NOT EXISTS admin_generation_moderation_actions_reviewer_id_idx
  ON public.admin_generation_moderation_actions (reviewer_id);
