-- Keep protected, malformed and failed work recoverable without letting it
-- permanently occupy the first bounded batch. Original upload age is unchanged.
ALTER TABLE public.media_upload_intents
  ADD COLUMN reclaim_checked_at timestamptz,
  ADD COLUMN reclaim_priority_at timestamptz
    GENERATED ALWAYS AS (coalesce(reclaim_checked_at, created_at)) STORED;

CREATE INDEX media_upload_intents_reclaim_priority_idx
  ON public.media_upload_intents (reclaim_priority_at, id)
  WHERE storage_cleared_at IS NULL;

COMMENT ON COLUMN public.media_upload_intents.reclaim_checked_at IS
  'Last bounded reclaim selection; advances before external work so failed or protected rows cannot monopolize subsequent batches.';
COMMENT ON COLUMN public.media_upload_intents.reclaim_priority_at IS
  'Fair reclaim order: original upload age until first scan, then most recent scan time. Does not authorize deletion.';
