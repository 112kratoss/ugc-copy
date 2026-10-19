-- profiles.saver_notice_seen_at: when the account was first told "Creators can
-- see who saved their posts." POST /api/profile/saver-notice writes it once the
-- notice has been read, on any device, and the save service names a saver only
-- once it is set.
--
-- On its own, after the alert changes: ALTER TABLE profiles takes an ACCESS
-- EXCLUSIVE lock, and current_identity_admission reads profiles for every
-- admitted API call, so the lock is held for this one statement only, and
-- given up after five seconds rather than queueing every request behind a
-- long transaction.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS saver_notice_seen_at timestamptz;

COMMENT ON COLUMN public.profiles.saver_notice_seen_at IS
  'When the account was first told that creators can see who saved their posts. Save alerts name a saver only once it is set.';
