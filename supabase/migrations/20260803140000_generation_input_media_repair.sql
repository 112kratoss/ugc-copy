-- Generations whose durable input media never persisted read their reference
-- media straight out of the `uploads` staging bucket.
--
-- `persistGenerationInputMedia` catches per-candidate errors and only logs, so a
-- transient download or insert failure leaves a generation with zero
-- `generation_input_media` rows while its `workflow_settings` still name the
-- staged paths. Three read paths then fall back to `buildLegacyGenerationInputMedia`
-- and serve those staging objects directly: the owner inputs view, remix source,
-- and paid-bundle recipe inputs.
--
-- That makes the staging objects load-bearing, which collides with the reclaim
-- sweep added in 20260803120000. This migration supports both halves of the fix:
-- a guard that refuses to reclaim a path such a generation still reads, and a
-- repair pass that heals the generation so the path stops being load-bearing.

-- Remediation state, deliberately not columns on `generations`. This tracks a
-- finite backlog plus the occasional future persist failure; when the class of
-- bug is gone the whole table drops without touching the hottest table in the
-- schema.
CREATE TABLE IF NOT EXISTS public.generation_input_media_repairs (
  generation_id uuid PRIMARY KEY REFERENCES public.generations(id) ON DELETE CASCADE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempted_at timestamptz,
  last_error text,
  repaired_at timestamptz
);

ALTER TABLE public.generation_input_media_repairs ENABLE ROW LEVEL SECURITY;

-- Service role only, matching media_upload_intents. No client ever reads or
-- writes repair state; the absence of a grant is the boundary and the absence of
-- a policy is the backstop.
REVOKE ALL ON public.generation_input_media_repairs FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.generation_input_media_repairs TO service_role;

-- Selection for both halves of the fix.
--
-- PostgREST cannot express the `workflow_settings::text LIKE` scan together with
-- the NOT EXISTS anti-join, so this has to be a function. One function serves
-- three callers so they can never disagree about what "legacy-only" means:
--
--   repair batch : (5, 3, now() - 1 hour)  -- capped, and old enough that an
--                                             in-flight start is not mid-persist
--   guard        : (1000, NULL, now())     -- NULL cap on purpose: an
--                                             attempt-exhausted generation still
--                                             reads its staged files, so it must
--                                             stay protected forever
--   hasWork      : (1, 3, now() - 1 hour)
--
-- The anti-join rides generation_input_media_generation_order_idx. The LIKE is a
-- sequential scan by nature; an infix pattern cannot use a btree index, and a
-- pg_trgm expression index over every workflow blob is not worth it to protect a
-- backlog this size. Revisit if `generations` grows enough for the daily scan to
-- matter -- the persist failure path can record a marker row here instead.
CREATE OR REPLACE FUNCTION public.list_generations_missing_durable_input_media(
  p_limit integer,
  p_max_attempts integer,
  p_created_before timestamptz
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  category text,
  model text,
  workflow_settings jsonb,
  attempt_count integer
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT
    g.id,
    g.user_id,
    g.category,
    g.model,
    g.workflow_settings,
    coalesce(r.attempt_count, 0) AS attempt_count
  FROM public.generations g
  LEFT JOIN public.generation_input_media_repairs r
    ON r.generation_id = g.id
  WHERE g.workflow_settings::text LIKE '%uploads/%'
    AND g.created_at < p_created_before
    AND NOT EXISTS (
      SELECT 1
      FROM public.generation_input_media m
      WHERE m.generation_id = g.id
    )
    AND (p_max_attempts IS NULL OR coalesce(r.attempt_count, 0) < p_max_attempts)
  ORDER BY g.created_at ASC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.list_generations_missing_durable_input_media(
  integer, integer, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_generations_missing_durable_input_media(
  integer, integer, timestamptz
) TO service_role;
