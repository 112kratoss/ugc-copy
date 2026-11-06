-- A remix's alerts name the remixer by the handle they have now (remix plan,
-- phase 3; owner, 2026-11-05: A is told by name when B's remix finishes, and
-- again when B posts it).
--
-- The alerts store the remixer's handle in their words, and the finished alert
-- opens /creators/<handle> (20261105175342 lists the words). A handle can be
-- changed, and the old one is then free for anyone to claim: an alert still
-- saying "@maya remixed your post" would name, and open the page of, whoever
-- took "maya" next. So when an account's handle changes, its remix alerts take
-- the new one, and with no handle left to give they name no one, in the words
-- 20261105175342 gives an alert with no remixer to name. An alert already
-- written without the name (across a block, or since unnamed) stays as it is.
--
-- The words (renamed_remix_alert_words) are 20261105175342's, whose insert trigger
-- also names the remixer by the handle they have when the alert is written. A
-- migration of its own: it locks profiles only (CREATE TRIGGER's SHARE ROW
-- EXCLUSIVE, beside which reads go on), never profiles and the inbox together.

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Each alert is read and written in one statement, from its own row: a block
-- unnaming the same alert at the same moment is seen (the row's newer version is
-- read again before it is written), and a block that comes after finds the new
-- name to take out.
CREATE OR REPLACE FUNCTION public.rename_remix_alerts_of_renamed_remixer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.mobile_notifications AS alert
  SET (title, deep_link) = (
    SELECT words.title, words.deep_link
    FROM public.renamed_remix_alert_words(alert.title, alert.deep_link, alert.object_id, NEW.username) AS words
  )
  WHERE alert.actor_user_id = NEW.id
    AND alert.type = 'post_remixed'
    AND alert.title ~ '^@\S+ (remixed your post|posted a remix of your post)$';
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION public.rename_remix_alerts_of_renamed_remixer() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rename_remix_alerts_of_renamed_remixer() TO service_role;

COMMENT ON FUNCTION public.rename_remix_alerts_of_renamed_remixer() IS
  'When an account''s handle changes, its remix alerts name it by the new one, or no one without one.';

CREATE OR REPLACE TRIGGER profiles_rename_remix_alerts
AFTER UPDATE OF username ON public.profiles
FOR EACH ROW
WHEN (OLD.username IS DISTINCT FROM NEW.username)
EXECUTE FUNCTION public.rename_remix_alerts_of_renamed_remixer();

COMMIT;
