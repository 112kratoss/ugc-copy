-- Alerts reach their owners through the API, which reads with the service role;
-- no client reads mobile_notifications through the Data API. Yet
-- `authenticated` still held the table-wide SELECT the table was born with,
-- so a signed-in owner could read every column of their own rows.
--
-- Two of those columns name someone else: `actor_user_id` (who saved, shared,
-- followed or bought) and `dedupe_key`, which carries the same id in keys such
-- as `post-save:<saver>:<post>`. Since save alerts began naming savers
-- ("@maya saved your post"), a creator could match a named alert's id against
-- the id kept on earlier "Someone saved your post" rows and name those savers
-- too, breaking the promise that saves made before the apps said so stay
-- private.
--
-- Owners keep reading their own rows (row-level security still decides which),
-- but only the columns their Alerts show.
REVOKE SELECT ON TABLE public.mobile_notifications FROM authenticated;
GRANT SELECT (
  id,
  user_id,
  type,
  category,
  title,
  body,
  deep_link,
  object_type,
  object_id,
  event_count,
  is_read,
  created_at,
  updated_at,
  last_event_at
) ON TABLE public.mobile_notifications TO authenticated;
