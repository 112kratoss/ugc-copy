-- A media sweep uploads a derivative (preview, display, feed rendition or
-- teaser) beside a creation's public copy, in showcase/<creation>/, before the
-- row update that names it. When no update records it (the update matched no
-- row because the post was deleted or made private, its cover row repointed,
-- or the sweep's lease taken over while it worked; or the attempt failed after
-- the upload), the object stayed in the public bucket named by nothing: no
-- row, no queue entry, nothing that would remove it. #619 queues what a
-- deleted post's rows name before the delete, which cannot include an upload
-- that lands after it.
--
-- The sweeps now hand such paths to the revocation queue through this
-- function, since the queue takes no INSERT from service_role. The
-- showcase-media-revocations job applies its one rule to them: it keeps what
-- something still names (a creation published again at once gets the same
-- content-addressed names), waits while a sweep holds a live lease on a
-- serving post's row, and removes and verifies the rest.

-- Only the job touches the queue, and briefly; this waits at most five seconds
-- for it.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.showcase_media_revocations
  DROP CONSTRAINT showcase_media_revocations_reason_check,
  ADD CONSTRAINT showcase_media_revocations_reason_check
    CHECK (reason IN ('post_unexposed', 'post_deleted', 'exposure_drift', 'sweep_unrecorded'));

CREATE FUNCTION public.queue_unrecorded_showcase_media(p_paths text[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_queued integer;
BEGIN
  -- A hand-off carries what one sweep run uploaded (a preview and a display,
  -- or a feed rendition and a teaser), or what the rows a removal deleted named
  -- beyond what it removed: a handful either way. The cap only refuses a caller
  -- using this as a bulk entry.
  IF cardinality(p_paths) > 50 THEN
    RAISE EXCEPTION 'queue_unrecorded_showcase_media takes at most 50 paths, got %', cardinality(p_paths)
      USING ERRCODE = '22023';
  END IF;

  -- Only an object in a creation's public folder, queued under that creation.
  -- The job checks each path against its folder again before removing it.
  INSERT INTO public.showcase_media_revocations (generation_id, showcase_asset_path, reason)
  SELECT DISTINCT split_part(named.path, '/', 2)::uuid, named.path, 'sweep_unrecorded'
  FROM unnest(p_paths) AS named(path)
  WHERE named.path ~ '^showcase/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[^/]'
  ON CONFLICT (generation_id, showcase_asset_path) DO NOTHING;

  GET DIAGNOSTICS v_queued = ROW_COUNT;
  RETURN v_queued;
END;
$$;

ALTER FUNCTION public.queue_unrecorded_showcase_media(text[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_unrecorded_showcase_media(text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_unrecorded_showcase_media(text[])
  TO service_role;

COMMENT ON FUNCTION public.queue_unrecorded_showcase_media(text[]) IS
  'Trusted entry to the showcase revocation queue for the media sweeps: queues what a sweep uploaded in a creation''s public folder and no update recorded. The showcase-media-revocations job decides what is removed.';

COMMENT ON TABLE public.showcase_media_revocations IS
  'Public showcase derivatives nothing may need any more: queued by the posts triggers in the post write''s own transaction, and by the media sweeps for uploads no update recorded. A row is deleted once its object is verified gone or still in use; the showcase-media-revocations job retries the rest.';
