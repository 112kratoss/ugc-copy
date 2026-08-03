-- `uploads` is a shared staging bucket. The post composer signs objects into it
-- and copies them to showcase_media on publish; the generation pipeline signs
-- objects into it and copies them to generation_inputs on start. Only the post
-- paths ever deleted the staging copy, so:
--
--   * every generation input left a permanent duplicate behind, and
--   * every abandoned composer draft left its media behind.
--
-- Nothing recorded that these objects existed, so there was no way to collect
-- them without listing the bucket and guessing from age -- and age alone cannot
-- distinguish an abandoned draft from a live one. This table makes the guess
-- unnecessary: every signed upload gets a row, and the row records what claimed
-- the bytes and whether the staging object has been deleted yet.

CREATE TABLE IF NOT EXISTS public.media_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Bucket-relative, exactly what storage.from('uploads').remove() expects, so
  -- the sweep never has to reconstruct a path. Callers that hold the prefixed
  -- 'uploads/...' form normalize before writing.
  storage_path text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  content_type text,
  -- What the client claimed at sign time. The object may be smaller, larger, or
  -- absent -- this is for reporting, never for enforcement.
  declared_bytes bigint CHECK (declared_bytes IS NULL OR declared_bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  -- Consumed and cleared are deliberately separate. The post paths copy the
  -- bytes and delete the staging object in one request, so they set both. The
  -- generation path sets only consumed_at: an unchanged picker selection can be
  -- submitted twice, and the second generation still needs those bytes, so the
  -- sweep clears them later rather than the request deleting them immediately.
  consumed_at timestamptz,
  consumed_by text CHECK (consumed_by IN (
    'post_publish',
    'post_update',
    'generation_input',
    'generation_restore'
  )),
  storage_cleared_at timestamptz,
  CONSTRAINT media_upload_intents_consumed_pair_check
    CHECK ((consumed_at IS NULL) = (consumed_by IS NULL))
);

-- The sweep's only query: uncleared rows, oldest first. Partial so it stays
-- small -- the steady state is that almost everything has been cleared.
CREATE INDEX IF NOT EXISTS media_upload_intents_uncleared_idx
  ON public.media_upload_intents (created_at)
  WHERE storage_cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS media_upload_intents_user_idx
  ON public.media_upload_intents (user_id);

ALTER TABLE public.media_upload_intents ENABLE ROW LEVEL SECURITY;

-- Service role only, matching posts and post_media. Clients never read or write
-- this table: they learn about their upload from the sign response, and the
-- lifecycle is entirely server-owned. No grant to anon or authenticated is the
-- boundary; the absence of a policy is the backstop.
REVOKE ALL ON public.media_upload_intents FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.media_upload_intents TO service_role;
