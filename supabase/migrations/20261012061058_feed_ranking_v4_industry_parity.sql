-- Feed ranking v4: closing the gaps to the industry leaders
-- (docs/plans/feed-algorithm-v4-industry-parity-2026-10-12.md, section 2).
--
-- v3 stays active. v4 is seeded 'shadow', so nothing serves it until an
-- operator activates it or an experiment variant references it. These reach
-- the live ranker the moment this applies:
--
-- 1. A comment feed event, written only by server actions (a service-role
--    insert, or record_showcase_feed_events with p_authoritative => true; a
--    client batch is refused). It stamps feed_delivery_facts.commented_at,
--    counts as a meaningful engagement (is_meaningful_feed_engagement gains
--    p_commented_at), adds 1.0 per comment to v1's usefulness numerator and
--    3.0 to the viewer's interest weights, as a save does.
-- 2. refresh_user_interest_weights writes a semantic_cluster dimension
--    ('c' || cluster_id) for every event on a clustered post. v3 ignores it;
--    v4's interest_match reads it.
-- 3. post_content_embeddings moves to 384 dimensions (gte-small, computed by
--    the embed-post edge function) and gains cluster and near-duplicate
--    columns; its updated_at becomes the version of the text embedded. Its
--    rows are regenerable and production holds none.
-- 4. refresh_feed_delivery_fact_daily runs as its caller, like every other
--    feed refresh, instead of as its owner.
--
-- Everything else is additive: feed_semantic_clusters, account_labels,
-- feed_viewer_daily and its refresh (pruned at 400 days by
-- prune_feed_personalization_data), get_ranked_feed_candidates_v4, the
-- viewer, position, format and assignment scorecards,
-- create_feed_algorithm_version_draft, the RPCs the embeddings and safety
-- label jobs call, and for-you-rules v4 as 'shadow'. Every function is
-- SECURITY INVOKER with search_path pinned to public, pg_temp and is callable
-- by the service role only. No ranking weight appears in SQL: TypeScript
-- remains the only scorer.

-- ─── Content embeddings at 384 dimensions ───────────────────────────────────
--
-- 20260711064036 created post_content_embeddings only where pgvector could be
-- enabled, and found the vector type's schema at run time (v_vector_type).
-- v4 cannot work without it -- the candidate RPC, the clusters and the taste
-- vector all need the type -- so this refuses to continue when it is missing.
-- The functions below name the type, its distance operator and its mean
-- aggregate as extensions.vector, OPERATOR(extensions.<=>) and
-- extensions.avg: their search path is pinned to public, pg_temp, where an
-- unqualified name would not resolve. Supabase installs pgvector into
-- extensions, and so did 20260711064036, so the schema is checked rather than
-- assumed.
DO $feed_v4_vectors$
DECLARE
  v_vector_type text;
  v_vector_schema text;
  v_constraint record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_extension
    WHERE extname = 'vector'
  ) AND EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'vector'
  ) THEN
    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
  END IF;

  SELECT n.nspname, format('%I.%I', n.nspname, t.typname)
  INTO v_vector_schema, v_vector_type
  FROM pg_type AS t
  JOIN pg_namespace AS n ON n.oid = t.typnamespace
  JOIN pg_depend AS d
    ON d.classid = 'pg_type'::regclass
   AND d.objid = t.oid
   AND d.deptype = 'e'
  JOIN pg_extension AS e
    ON e.oid = d.refobjid
   AND e.extname = 'vector'
  WHERE t.typname = 'vector'
  LIMIT 1;

  IF v_vector_type IS NULL THEN
    RAISE EXCEPTION 'Feed ranking v4 requires the pgvector extension';
  END IF;

  IF v_vector_schema <> 'extensions' THEN
    RAISE EXCEPTION 'Feed ranking v4 expects pgvector in the extensions schema, found it in %',
      v_vector_schema;
  END IF;

  IF to_regclass('public.post_content_embeddings') IS NULL THEN
    RAISE EXCEPTION 'post_content_embeddings is missing; 20260711064036 creates it with pgvector';
  END IF;

  -- Regenerable, and pinned to 1536 until now: drop rather than convert.
  DELETE FROM public.post_content_embeddings
  WHERE embedding_dimensions <> 384;

  -- The 1536 CHECK was declared inline, so its name was generated; find it by
  -- what it constrains. The 384 CHECK added below is found the same way when
  -- this runs again, and re-added.
  FOR v_constraint IN
    SELECT constraints.conname
    FROM pg_constraint AS constraints
    WHERE constraints.conrelid = 'public.post_content_embeddings'::regclass
      AND constraints.contype = 'c'
      AND pg_get_constraintdef(constraints.oid) LIKE '%embedding_dimensions%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.post_content_embeddings DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;

  -- pgvector keeps a vector column's dimensions in its type modifier.
  IF (
    SELECT attributes.atttypmod
    FROM pg_attribute AS attributes
    WHERE attributes.attrelid = 'public.post_content_embeddings'::regclass
      AND attributes.attname = 'embedding'
      AND NOT attributes.attisdropped
  ) IS DISTINCT FROM 384 THEN
    DROP INDEX IF EXISTS public.post_content_embeddings_embedding_hnsw_idx;
    EXECUTE format(
      'ALTER TABLE public.post_content_embeddings ALTER COLUMN embedding TYPE %s(384)',
      v_vector_type
    );
  END IF;

  BEGIN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS post_content_embeddings_embedding_hnsw_idx '
      || 'ON public.post_content_embeddings USING hnsw (embedding %I.vector_cosine_ops)',
      v_vector_schema
    );
  EXCEPTION
    WHEN undefined_object OR feature_not_supported OR invalid_parameter_value THEN
      RAISE NOTICE 'HNSW indexing is unavailable; post embeddings will use exact cosine search';
  END;
END;
$feed_v4_vectors$;

ALTER TABLE public.post_content_embeddings
  ALTER COLUMN embedding_dimensions SET DEFAULT 384,
  ADD CONSTRAINT post_content_embeddings_embedding_dimensions_check
    CHECK (embedding_dimensions = 384);

ALTER TABLE public.post_content_embeddings
  ADD COLUMN IF NOT EXISTS cluster_id integer
    CHECK (cluster_id >= 0),
  ADD COLUMN IF NOT EXISTS canonical_post_id uuid
    REFERENCES public.posts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS near_duplicate_similarity double precision
    CHECK (
      near_duplicate_similarity BETWEEN -1 AND 1
      AND near_duplicate_similarity <> 'NaN'::double precision
    );

ALTER TABLE public.post_content_embeddings
  DROP CONSTRAINT IF EXISTS post_content_embeddings_canonical_not_self_check;
ALTER TABLE public.post_content_embeddings
  ADD CONSTRAINT post_content_embeddings_canonical_not_self_check
    CHECK (canonical_post_id IS NULL OR canonical_post_id <> post_id);

CREATE INDEX IF NOT EXISTS post_content_embeddings_cluster_idx
  ON public.post_content_embeddings (cluster_id);

-- The foreign key's index, and the chain check in mark_post_near_duplicates.
CREATE INDEX IF NOT EXISTS post_content_embeddings_canonical_post_idx
  ON public.post_content_embeddings (canonical_post_id)
  WHERE canonical_post_id IS NOT NULL;

-- updated_at is now the posts.updated_at of the text the embedding was last
-- computed from or checked against, written by the embed-post edge function,
-- so list_posts_pending_embedding can compare the two exactly. The touch
-- trigger stamped the wall clock on every write: a cluster assignment would
-- have made a post edited since its embedding look embedded, and an edit made
-- while the function was running would have been lost.
DROP TRIGGER IF EXISTS post_content_embeddings_set_updated_at
  ON public.post_content_embeddings;

COMMENT ON TABLE public.post_content_embeddings IS
  'gte-small (384-dimension) text embeddings of public posts, written by the embed-post edge function; clusters and near-duplicate marks are written by the feed-embeddings job.';
COMMENT ON COLUMN public.post_content_embeddings.updated_at IS
  'posts.updated_at of the text this embedding was last computed from or checked against; a newer posts.updated_at makes the post pending again.';
COMMENT ON COLUMN public.post_content_embeddings.cluster_id IS
  'feed_semantic_clusters.cluster_id this post belongs to; NULL until the clustering job has seen it.';
COMMENT ON COLUMN public.post_content_embeddings.canonical_post_id IS
  'The older post this one near-duplicates (cosine >= 0.95). A marked post is recommended only to followers of its author.';
COMMENT ON COLUMN public.post_content_embeddings.near_duplicate_similarity IS
  'Cosine similarity to canonical_post_id when it was marked.';

-- Function signatures ignore type modifiers, so this drops the 1536 version
-- and the replacement checks the width itself. Otherwise the same function:
-- public, visible, unarchived posts of one model, nearest first.
DROP FUNCTION IF EXISTS public.match_post_content_embeddings(
  extensions.vector, text, double precision, integer
);

CREATE OR REPLACE FUNCTION public.match_post_content_embeddings(
  p_query_embedding extensions.vector(384),
  p_embedding_model text,
  p_match_threshold double precision DEFAULT 0.0,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (post_id uuid, semantic_similarity double precision)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_query_embedding IS NULL OR extensions.vector_dims(p_query_embedding) <> 384 THEN
    RAISE EXCEPTION 'Semantic query embedding must have 384 dimensions';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Semantic candidate limit must be between 1 and 500';
  END IF;

  IF p_match_threshold IS NULL OR p_match_threshold < -1 OR p_match_threshold > 1 THEN
    RAISE EXCEPTION 'Semantic match threshold must be between -1 and 1';
  END IF;

  RETURN QUERY
  SELECT
    embeddings.post_id,
    (
      1.0 - (
        embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding
      )
    )::double precision
  FROM public.post_content_embeddings AS embeddings
  JOIN public.posts AS posts ON posts.id = embeddings.post_id
  WHERE embeddings.embedding_model = p_embedding_model
    AND posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND posts.review_status = 'visible'
    AND (
      1.0 - (
        embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding
      )
    ) >= p_match_threshold
  ORDER BY embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.match_post_content_embeddings(extensions.vector, text, double precision, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.match_post_content_embeddings(extensions.vector, text, double precision, integer)
  TO service_role;

COMMENT ON FUNCTION public.match_post_content_embeddings(extensions.vector, text, double precision, integer) IS
  'Nearest public, visible posts to a 384-dimension query embedding of one model, by cosine similarity; service role only.';

-- ─── Semantic clusters ───────────────────────────────────────────────────────

-- k-means centroids over the newest embeddings, replaced wholesale by the
-- feed-embeddings job (replace_feed_semantic_clusters). Cluster ids are reused
-- from run to run; post_content_embeddings.cluster_id points here by value.
CREATE TABLE IF NOT EXISTS public.feed_semantic_clusters (
  cluster_id integer PRIMARY KEY CHECK (cluster_id >= 0),
  embedding_model text NOT NULL
    CHECK (char_length(embedding_model) BETWEEN 1 AND 160),
  centroid extensions.vector(384) NOT NULL,
  member_count integer NOT NULL DEFAULT 0 CHECK (member_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.feed_semantic_clusters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feed_semantic_clusters FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_semantic_clusters TO service_role;
DROP POLICY IF EXISTS "No client access to feed_semantic_clusters" ON public.feed_semantic_clusters;
CREATE POLICY "No client access to feed_semantic_clusters"
  ON public.feed_semantic_clusters FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMENT ON TABLE public.feed_semantic_clusters IS
  'Backend-owned k-means centroids of post embeddings; post_content_embeddings.cluster_id refers to cluster_id. Service role only.';

-- ─── Account labels ──────────────────────────────────────────────────────────

-- Account-level safety labels the maintenance job derives from content and
-- feedback, each with a TTL. An active label keeps the account's posts out of
-- every pool but following.
CREATE TABLE IF NOT EXISTS public.account_labels (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text NOT NULL
    CHECK (label IN ('nsfw_account', 'negative_feedback_account', 'spam_account')),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 80),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (user_id, label)
);

CREATE INDEX IF NOT EXISTS account_labels_expires_idx
  ON public.account_labels (expires_at);

ALTER TABLE public.account_labels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_labels FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.account_labels TO service_role;
DROP POLICY IF EXISTS "No client access to account_labels" ON public.account_labels;
CREATE POLICY "No client access to account_labels"
  ON public.account_labels FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMENT ON TABLE public.account_labels IS
  'Account-level safety labels with a TTL (nsfw_account, negative_feedback_account, spam_account); an active label limits the account to its followers. Service role only.';

-- ─── The comment event and the semantic_cluster interest dimension ──────────

-- Both CHECKs were declared inline, so their names were generated; find them
-- by what they constrain, then add named replacements.
DO $feed_v4_vocabularies$
DECLARE
  v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT constraints.conname
    FROM pg_constraint AS constraints
    WHERE constraints.conrelid = 'public.feed_events'::regclass
      AND constraints.contype = 'c'
      AND pg_get_constraintdef(constraints.oid) LIKE '%event_type%'
      AND pg_get_constraintdef(constraints.oid) LIKE '%remix_complete%'
  LOOP
    EXECUTE format('ALTER TABLE public.feed_events DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;

  FOR v_constraint IN
    SELECT constraints.conname
    FROM pg_constraint AS constraints
    WHERE constraints.conrelid = 'public.user_interest_weights'::regclass
      AND constraints.contype = 'c'
      AND pg_get_constraintdef(constraints.oid) LIKE '%dimension_type%'
      AND pg_get_constraintdef(constraints.oid) LIKE '%source_tool%'
  LOOP
    EXECUTE format('ALTER TABLE public.user_interest_weights DROP CONSTRAINT %I', v_constraint.conname);
  END LOOP;
END;
$feed_v4_vocabularies$;

ALTER TABLE public.feed_events
  ADD CONSTRAINT feed_events_event_type_check CHECK (
    event_type IN (
      'impression',
      'open',
      'dwell',
      'media_progress',
      'quick_skip',
      'save',
      'unsave',
      'share',
      'follow',
      'remix_start',
      'remix_complete',
      'resource_open',
      'purchase',
      'not_interested',
      'hide_creator',
      'report',
      'comment'
    )
  );

ALTER TABLE public.user_interest_weights
  ADD CONSTRAINT user_interest_weights_dimension_type_check CHECK (
    dimension_type IN (
      'category',
      'creator',
      'source_tool',
      'media_type',
      'resource_kind',
      'semantic_cluster'
    )
  );

ALTER TABLE public.feed_delivery_facts
  ADD COLUMN IF NOT EXISTS commented_at timestamptz;

COMMENT ON COLUMN public.feed_delivery_facts.commented_at IS
  'First comment the viewer wrote on the post from this delivery (write-once, from the server-written comment event).';

-- Reproduced from 20260728180500_feed_delivery_facts.sql with one more
-- write-once outcome: a comment stamps commented_at.
CREATE OR REPLACE FUNCTION public.apply_feed_delivery_outcome()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.delivery_fact_id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.feed_delivery_facts AS facts
  SET rendered_at = least(coalesce(facts.rendered_at, NEW.occurred_at), NEW.occurred_at),
      last_event_at = greatest(coalesce(facts.last_event_at, NEW.occurred_at), NEW.occurred_at),
      qualified_impression_at = CASE WHEN NEW.event_type = 'impression'
        THEN coalesce(facts.qualified_impression_at, NEW.occurred_at)
        ELSE facts.qualified_impression_at END,
      opened_at = CASE WHEN NEW.event_type = 'open'
        THEN coalesce(facts.opened_at, NEW.occurred_at)
        ELSE facts.opened_at END,
      quick_skipped_at = CASE WHEN NEW.event_type = 'quick_skip'
        THEN coalesce(facts.quick_skipped_at, NEW.occurred_at)
        ELSE facts.quick_skipped_at END,
      dwell_ms_max = CASE WHEN NEW.event_type IN ('dwell', 'quick_skip')
        THEN greatest(facts.dwell_ms_max, coalesce(NEW.duration_ms, 0)::bigint)
        ELSE facts.dwell_ms_max END,
      media_progress_max = CASE WHEN NEW.event_type = 'media_progress'
        THEN least(1.0::double precision, greatest(facts.media_progress_max, coalesce(NEW.progress, 0)))
        ELSE facts.media_progress_max END,
      media_duration_ms = CASE WHEN NEW.event_type = 'media_progress'
        THEN coalesce(facts.media_duration_ms, NEW.duration_ms)
        ELSE facts.media_duration_ms END,
      saved_at = CASE WHEN NEW.event_type = 'save'
        THEN coalesce(facts.saved_at, NEW.occurred_at)
        ELSE facts.saved_at END,
      shared_at = CASE WHEN NEW.event_type = 'share'
        THEN coalesce(facts.shared_at, NEW.occurred_at)
        ELSE facts.shared_at END,
      followed_at = CASE WHEN NEW.event_type = 'follow'
        THEN coalesce(facts.followed_at, NEW.occurred_at)
        ELSE facts.followed_at END,
      remix_started_at = CASE WHEN NEW.event_type = 'remix_start'
        THEN coalesce(facts.remix_started_at, NEW.occurred_at)
        ELSE facts.remix_started_at END,
      remix_completed_at = CASE WHEN NEW.event_type = 'remix_complete'
        THEN coalesce(facts.remix_completed_at, NEW.occurred_at)
        ELSE facts.remix_completed_at END,
      resource_opened_at = CASE WHEN NEW.event_type = 'resource_open'
        THEN coalesce(facts.resource_opened_at, NEW.occurred_at)
        ELSE facts.resource_opened_at END,
      purchased_at = CASE WHEN NEW.event_type = 'purchase'
        THEN coalesce(facts.purchased_at, NEW.occurred_at)
        ELSE facts.purchased_at END,
      not_interested_at = CASE WHEN NEW.event_type = 'not_interested'
        THEN coalesce(facts.not_interested_at, NEW.occurred_at)
        ELSE facts.not_interested_at END,
      hid_creator_at = CASE WHEN NEW.event_type = 'hide_creator'
        THEN coalesce(facts.hid_creator_at, NEW.occurred_at)
        ELSE facts.hid_creator_at END,
      reported_at = CASE WHEN NEW.event_type = 'report'
        THEN coalesce(facts.reported_at, NEW.occurred_at)
        ELSE facts.reported_at END,
      commented_at = CASE WHEN NEW.event_type = 'comment'
        THEN coalesce(facts.commented_at, NEW.occurred_at)
        ELSE facts.commented_at END
  WHERE facts.delivery_id = NEW.delivery_fact_id;

  RETURN NEW;
END;
$$;

-- A comment is a meaningful engagement, like a save. The new parameter
-- defaults to NULL, so a caller this migration does not re-create (the v3
-- scorecard) keeps its seven-argument call and its meaning. The old
-- signature is dropped first: keeping both would make every seven-argument
-- call ambiguous.
DROP FUNCTION IF EXISTS public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz
);

CREATE OR REPLACE FUNCTION public.is_meaningful_feed_engagement(
  p_category text,
  p_media_progress_max double precision,
  p_dwell_ms_max bigint,
  p_saved_at timestamptz,
  p_remix_started_at timestamptz,
  p_resource_opened_at timestamptz,
  p_purchased_at timestamptz,
  p_commented_at timestamptz DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT
    (p_category = 'video' AND coalesce(p_media_progress_max, 0) >= 0.5)
    OR (coalesce(p_category, '') <> 'video' AND coalesce(p_dwell_ms_max, 0) >= 3000)
    OR p_saved_at IS NOT NULL
    OR p_remix_started_at IS NOT NULL
    OR p_resource_opened_at IS NOT NULL
    OR p_purchased_at IS NOT NULL
    OR p_commented_at IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz
) TO service_role;

COMMENT ON FUNCTION public.is_meaningful_feed_engagement(
  text, double precision, bigint, timestamptz, timestamptz, timestamptz, timestamptz, timestamptz
) IS
  'Single source of truth for the binary meaningful-engagement reward over a rendered delivery: video >= 50%, other formats >= 3 s, or a save, remix start, resource open, purchase or comment.';

ALTER TABLE public.post_feed_stats
  ADD COLUMN IF NOT EXISTS comment_count bigint NOT NULL DEFAULT 0
    CHECK (comment_count >= 0);

ALTER TABLE public.feed_delivery_fact_daily
  ADD COLUMN IF NOT EXISTS comment_count bigint NOT NULL DEFAULT 0;

-- ─── Server-written events in the batch RPC ─────────────────────────────────
--
-- Reproduced from 20260812150000_feed_event_batch_rpc.sql with one more
-- parameter. p_authoritative says the batch comes from a server action, not
-- from a client: such a batch may record comment, follow, remix_complete and
-- purchase for a signed-in viewer, the delivery optional as for save. A
-- client batch is refused all four, comment included, and report stays
-- refused everywhere: reports live in post_reports. The three-argument
-- function the clients' route calls is kept, and now delegates with
-- p_authoritative => false; p_authoritative has no default, so a call names
-- exactly one of the two.
CREATE OR REPLACE FUNCTION public.record_showcase_feed_events(
  p_actor_user_id uuid,
  p_anonymous_key_hash text,
  p_events jsonb,
  p_authoritative boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event jsonb;
  v_event_index integer := 0;
  v_recorded integer := 0;
  v_rejected integer := 0;
  v_outcomes jsonb := '[]'::jsonb;
  v_outcome jsonb;
  v_duplicate boolean;
  v_existing public.feed_events%ROWTYPE;
  v_creator_user_id uuid;
  v_client_event_id text;
  v_feed_session_id uuid;
  v_delivery_id bigint;
  v_post_id uuid;
  v_event_type text;
  v_position integer;
  v_duration_ms integer;
  v_progress double precision;
  v_source_surface text;
  v_occurred_at timestamptz;
  v_metadata jsonb;
  v_session_id uuid;
  v_session_user_id uuid;
  v_session_anonymous_key_hash text;
  v_session_created_at timestamptz;
  v_session_expires_at timestamptz;
  v_delivery_position integer;
  v_saved boolean;
  v_status integer;
  v_error text;
BEGIN
  IF jsonb_typeof(p_events) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Feed event batch must be an array';
  END IF;

  IF jsonb_array_length(p_events) < 1 OR jsonb_array_length(p_events) > 25 THEN
    RAISE EXCEPTION 'Feed event batch must contain between 1 and 25 entries';
  END IF;

  IF p_actor_user_id IS NULL
    AND char_length(coalesce(p_anonymous_key_hash, '')) NOT BETWEEN 32 AND 128
  THEN
    RAISE EXCEPTION 'Anonymous feed event batches require a valid identity hash';
  END IF;

  IF p_authoritative IS NULL THEN
    RAISE EXCEPTION 'Feed event batch authority must be true or false';
  END IF;

  FOR v_event IN SELECT value FROM jsonb_array_elements(p_events)
  LOOP
    v_outcome := NULL;

    BEGIN
      v_duplicate := false;
      v_existing := NULL;
      v_client_event_id := v_event->>'clientEventId';
      v_feed_session_id := nullif(v_event->>'feedSessionId', '')::uuid;
      v_delivery_id := nullif(v_event->>'deliveryId', '')::bigint;
      v_post_id := (v_event->>'postId')::uuid;
      v_event_type := v_event->>'eventType';
      v_position := nullif(v_event->>'position', '')::integer;
      v_duration_ms := nullif(v_event->>'durationMs', '')::integer;
      v_progress := nullif(v_event->>'progress', '')::double precision;
      v_source_surface := v_event->>'sourceSurface';
      v_occurred_at := (v_event->>'occurredAt')::timestamptz;
      v_metadata := coalesce(v_event->'metadata', '{}'::jsonb);

      -- The public parser enforces this same 24-hour/5-minute window. Keep the
      -- transaction boundary defensive because this privileged RPC is also
      -- callable by server jobs, and expired mobile queue entries must not be
      -- able to grow the event tables without bound.
      IF v_occurred_at IS NULL
        OR v_occurred_at < now() - interval '24 hours'
        OR v_occurred_at > now() + interval '5 minutes'
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed event timestamp is outside the accepted window.';
      END IF;

      SELECT posts.user_id
      INTO v_creator_user_id
      FROM public.posts AS posts
      WHERE posts.id = v_post_id
        AND posts.visibility = 'public'
        AND posts.archived_at IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '404|Public feed post was not found.';
      END IF;

      IF v_event_type = 'hide_creator' AND p_actor_user_id = v_creator_user_id THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Creators cannot hide their own profile.';
      END IF;

      -- Server-only types. Only a server action (p_authoritative) records
      -- comment, follow, remix_complete and purchase, and only for a signed-in
      -- viewer; a report is never a feed event (reports live in post_reports).
      IF v_event_type = 'report'
        OR (
          NOT p_authoritative
          AND v_event_type = ANY (ARRAY['comment', 'follow', 'remix_complete', 'purchase'])
        )
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|This feed event must be recorded by its authoritative server action.';
      END IF;

      IF v_event_type = ANY (ARRAY['comment', 'follow', 'remix_complete', 'purchase'])
        AND p_actor_user_id IS NULL
      THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '401|Authentication is required for this feed event.';
      END IF;

      SELECT events.*
      INTO v_existing
      FROM public.feed_events AS events
      WHERE events.client_event_id = v_client_event_id;

      IF FOUND THEN
        IF v_existing.post_id IS DISTINCT FROM v_post_id
          OR v_existing.creator_user_id IS DISTINCT FROM v_creator_user_id
          OR v_existing.event_type IS DISTINCT FROM v_event_type
          OR v_existing.source_surface IS DISTINCT FROM v_source_surface
          OR v_existing.viewer_user_id IS DISTINCT FROM p_actor_user_id
          OR v_existing.anonymous_key_hash IS DISTINCT FROM (
            CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END
          )
        THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed event ID is already used by a different event.';
        END IF;
        v_duplicate := true;
      END IF;

      IF NOT v_duplicate THEN
        IF v_event_type = ANY (ARRAY['save', 'unsave']) AND p_actor_user_id IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '401|Authentication is required for feed save events.';
        END IF;

        IF v_delivery_id IS NULL AND (
          v_event_type = ANY (ARRAY[
            'impression', 'open', 'dwell', 'media_progress', 'quick_skip',
            'share', 'remix_start', 'resource_open'
          ])
          OR (
            v_event_type = ANY (ARRAY['not_interested', 'hide_creator'])
            AND p_actor_user_id IS NULL
          )
        ) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|A matching feed delivery is required for this event.';
        END IF;

        v_session_id := v_feed_session_id;
        IF v_delivery_id IS NOT NULL THEN
          SELECT items.session_id, items.position
          INTO v_session_id, v_delivery_position
          FROM public.feed_session_items AS items
          WHERE items.id = v_delivery_id
            AND items.post_id = v_post_id
            AND (v_feed_session_id IS NULL OR items.session_id = v_feed_session_id);

          IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed delivery does not match this post.';
          END IF;
          IF v_position IS NOT NULL AND v_position IS DISTINCT FROM v_delivery_position THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed event position does not match its delivery.';
          END IF;
          v_position := coalesce(v_position, v_delivery_position);
        END IF;

        IF v_session_id IS NOT NULL THEN
          SELECT
            sessions.viewer_user_id,
            sessions.anonymous_key_hash,
            sessions.created_at,
            sessions.expires_at
          INTO
            v_session_user_id,
            v_session_anonymous_key_hash,
            v_session_created_at,
            v_session_expires_at
          FROM public.feed_sessions AS sessions
          WHERE sessions.id = v_session_id;

          IF NOT FOUND
            OR v_occurred_at < v_session_created_at
            OR v_occurred_at >= v_session_expires_at
          THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed session was not found or was inactive when this event occurred.';
          END IF;
          IF v_session_user_id IS NOT NULL THEN
            IF v_session_user_id IS DISTINCT FROM p_actor_user_id THEN
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed session does not belong to this viewer.';
            END IF;
          ELSIF p_actor_user_id IS NOT NULL
            OR v_session_anonymous_key_hash IS DISTINCT FROM p_anonymous_key_hash
          THEN
            -- Do not let an account claim a delivery created for a guest (or
            -- vice versa). Besides crossing actor modes, that would otherwise
            -- reach validate_feed_event_context() as a 23514 and abort every
            -- sibling in this batch.
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Feed session does not belong to this viewer.';
          END IF;
        END IF;

        IF v_event_type = 'media_progress' AND v_progress IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '400|Media progress events require a progress value.';
        END IF;

        IF v_event_type = ANY (ARRAY['save', 'unsave']) AND p_actor_user_id IS NOT NULL THEN
          SELECT EXISTS (
            SELECT 1
            FROM public.post_saves AS saves
            WHERE saves.user_id = p_actor_user_id
              AND saves.post_id = v_post_id
          ) INTO v_saved;
          IF v_saved IS DISTINCT FROM (v_event_type = 'save') THEN
            RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed save event does not match the authoritative save state.';
          END IF;
        END IF;

        BEGIN
          IF v_event_type = 'media_progress' THEN
            PERFORM public.record_feed_media_progress_event(
              v_client_event_id,
              v_feed_session_id,
              v_delivery_id,
              p_actor_user_id,
              CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END,
              v_post_id,
              v_creator_user_id,
              v_source_surface,
              v_position,
              v_duration_ms,
              v_progress,
              v_metadata,
              v_occurred_at
            );
          ELSE
            INSERT INTO public.feed_events (
              client_event_id,
              session_id,
              session_item_id,
              viewer_user_id,
              anonymous_key_hash,
              post_id,
              creator_user_id,
              event_type,
              source_surface,
              position,
              duration_ms,
              progress,
              metadata,
              occurred_at
            ) VALUES (
              v_client_event_id,
              v_feed_session_id,
              v_delivery_id,
              p_actor_user_id,
              CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END,
              v_post_id,
              v_creator_user_id,
              v_event_type,
              v_source_surface,
              v_position,
              v_duration_ms,
              v_progress,
              v_metadata,
              v_occurred_at
            );
          END IF;
        EXCEPTION WHEN unique_violation THEN
          -- Re-resolve every capped uniqueness contract explicitly:
          -- feed_events_session_item_type_unique_idx,
          -- feed_events_user_post_signal_unique_idx and
          -- feed_events_user_creator_hide_unique_idx.
          v_existing := NULL;
          SELECT events.* INTO v_existing
          FROM public.feed_events AS events
          WHERE events.client_event_id = v_client_event_id;

          IF FOUND THEN
            IF v_existing.post_id = v_post_id
              AND v_existing.creator_user_id = v_creator_user_id
              AND v_existing.event_type = v_event_type
              AND v_existing.source_surface = v_source_surface
              AND v_existing.viewer_user_id IS NOT DISTINCT FROM p_actor_user_id
              AND v_existing.anonymous_key_hash IS NOT DISTINCT FROM (
                CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END
              )
            THEN
              v_duplicate := true;
            ELSE
              -- An occupied client ID is authoritative. Never let an unrelated
              -- semantic cap mask a same-ID/different-event conflict.
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed event ID is already used by a different event.';
            END IF;
          ELSE
            v_existing := NULL;
            IF v_delivery_id IS NOT NULL THEN
              SELECT events.* INTO v_existing
              FROM public.feed_events AS events
              WHERE events.session_item_id = v_delivery_id
                AND events.event_type = v_event_type;
            END IF;

            IF v_existing.id IS NULL
              AND p_actor_user_id IS NOT NULL
              AND v_event_type = ANY (ARRAY['save', 'unsave', 'not_interested'])
            THEN
              SELECT events.* INTO v_existing
              FROM public.feed_events AS events
              WHERE events.viewer_user_id = p_actor_user_id
                AND events.post_id = v_post_id
                AND events.event_type = v_event_type;
            END IF;

            IF v_existing.id IS NULL
              AND p_actor_user_id IS NOT NULL
              AND v_event_type = 'hide_creator'
            THEN
              SELECT events.* INTO v_existing
              FROM public.feed_events AS events
              WHERE events.viewer_user_id = p_actor_user_id
                AND events.creator_user_id = v_creator_user_id
                AND events.event_type = v_event_type;
            END IF;

            IF v_existing.id IS NOT NULL
              AND (v_event_type = 'hide_creator' OR v_existing.post_id = v_post_id)
              AND v_existing.creator_user_id = v_creator_user_id
              AND v_existing.event_type = v_event_type
              AND v_existing.viewer_user_id IS NOT DISTINCT FROM p_actor_user_id
              AND v_existing.anonymous_key_hash IS NOT DISTINCT FROM (
                CASE WHEN p_actor_user_id IS NULL THEN p_anonymous_key_hash ELSE NULL END
              )
            THEN
              v_duplicate := true;
            ELSE
              RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '409|Feed event ID is already used by a different event.';
            END IF;
          END IF;
        END;
      END IF;

      -- Preference state is deliberately applied only after the event insert or
      -- duplicate resolution. Tests pin this ordering.
      IF p_actor_user_id IS NOT NULL AND v_event_type = 'not_interested' THEN
        INSERT INTO public.feed_user_post_feedback (
          user_id, post_id, feedback_type, updated_at
        ) VALUES (
          p_actor_user_id, v_post_id, 'not_interested', v_occurred_at
        )
        ON CONFLICT (user_id, post_id) DO UPDATE SET
          feedback_type = EXCLUDED.feedback_type,
          updated_at = EXCLUDED.updated_at;
      ELSIF p_actor_user_id IS NOT NULL AND v_event_type = 'hide_creator' THEN
        INSERT INTO public.feed_user_creator_feedback (
          user_id, creator_user_id, feedback_type, updated_at
        ) VALUES (
          p_actor_user_id, v_creator_user_id, 'hide_creator', v_occurred_at
        )
        ON CONFLICT (user_id, creator_user_id) DO UPDATE SET
          feedback_type = EXCLUDED.feedback_type,
          updated_at = EXCLUDED.updated_at;
      END IF;

      v_outcome := jsonb_build_object(
        'index', v_event_index,
        'ok', true,
        'duplicate', v_duplicate
      );
    EXCEPTION
      WHEN SQLSTATE 'P0001' THEN
        v_status := substring(SQLERRM FROM 1 FOR 3)::integer;
        v_error := substring(SQLERRM FROM 5);
        v_outcome := jsonb_build_object(
          'index', v_event_index,
          'ok', false,
          'status', v_status,
          'error', v_error
        );
      WHEN SQLSTATE '22P02' OR SQLSTATE '22003' OR SQLSTATE '22007' OR SQLSTATE '22008' THEN
        -- Type casts are driven entirely by this one JSON entry. Treat malformed
        -- UUID, bigint, numeric and timestamp values as poison input while
        -- retaining transport-level 500s for real database failures.
        v_outcome := jsonb_build_object(
          'index', v_event_index,
          'ok', false,
          'status', 400,
          'error', 'Feed event contains an invalid identifier or value.'
        );
      WHEN OTHERS THEN
        -- Unknown database failures are transport-level failures, not poison
        -- input. Abort the transaction so callers return a retryable HTTP 500;
        -- replaying successful siblings is safe through client_event_id.
        RAISE;
    END;

    IF coalesce((v_outcome->>'ok')::boolean, false) THEN
      v_recorded := v_recorded + 1;
    ELSE
      v_rejected := v_rejected + 1;
    END IF;
    v_outcomes := v_outcomes || jsonb_build_array(v_outcome);
    v_event_index := v_event_index + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'recorded', v_recorded,
    'rejected', v_rejected,
    'outcomes', v_outcomes
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb, boolean)
  TO service_role;

COMMENT ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb, boolean) IS
  'Records 1-25 validated feed events in one transaction with per-entry savepoint isolation; p_authoritative admits the server-written comment, follow, remix_complete and purchase types for a signed-in viewer.';

CREATE OR REPLACE FUNCTION public.record_showcase_feed_events(
  p_actor_user_id uuid,
  p_anonymous_key_hash text,
  p_events jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN public.record_showcase_feed_events(
    p_actor_user_id,
    p_anonymous_key_hash,
    p_events,
    false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.record_showcase_feed_events(uuid, text, jsonb) IS
  'Records 1-25 validated client feed events in one transaction with per-entry savepoint isolation and mixed outcomes; server-only event types are refused.';

-- ─── Stats refreshes ─────────────────────────────────────────────────────────

-- Reproduced from 20261011170309_feed_ranking_v3_x_adoption.sql with comment
-- events counted into comment_count and weighted 1.0 in the usefulness
-- numerator, as a save is.
CREATE OR REPLACE FUNCTION public.refresh_post_feed_stats(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affected_rows integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed stats timestamp is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Feed stats refresh limit must be between 1 and 10000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_post_feed_stats', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidate_posts AS MATERIALIZED (
    SELECT p.id AS post_id
    FROM public.posts AS p
    LEFT JOIN public.post_feed_stats AS existing
      ON existing.post_id = p.id
    WHERE existing.post_id IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM public.feed_events AS recent_event
        WHERE recent_event.post_id = p.id
          AND recent_event.delivery_fact_id IS NOT NULL
          AND recent_event.occurred_at >= p_as_of - interval '31 days'
          AND recent_event.occurred_at <= p_as_of
      )
    GROUP BY p.id
    ORDER BY min(existing.updated_at) ASC NULLS FIRST, p.id
    LIMIT p_limit
  ),
  windows(window_key, duration) AS (
    VALUES
      ('24h'::text, interval '24 hours'),
      ('7d'::text, interval '7 days'),
      ('30d'::text, interval '30 days')
  ),
  raw_rollup AS (
    SELECT
      candidates.post_id,
      windows.window_key,
      count(events.id) FILTER (WHERE events.event_type = 'impression')::bigint
        AS impression_count,
      count(DISTINCT coalesce(events.viewer_user_id::text, 'anon:' || events.anonymous_key_hash))
        FILTER (WHERE events.event_type = 'impression')::bigint AS unique_viewer_count,
      count(events.id) FILTER (WHERE events.event_type = 'open')::bigint AS open_count,
      coalesce(
        sum(least(
          coalesce(events.duration_ms::double precision, events.event_value),
          3600000.0::double precision
        ))
          FILTER (WHERE events.event_type = 'dwell'),
        0.0::double precision
      )::bigint AS dwell_ms,
      count(events.id) FILTER (WHERE events.event_type = 'media_progress')::bigint
        AS media_progress_count,
      count(events.id) FILTER (WHERE events.event_type = 'quick_skip')::bigint
        AS quick_skip_count,
      count(events.id) FILTER (WHERE events.event_type = 'save')::bigint AS save_count,
      count(events.id) FILTER (WHERE events.event_type = 'share')::bigint AS share_count,
      count(events.id) FILTER (WHERE events.event_type = 'comment')::bigint AS comment_count,
      count(events.id) FILTER (WHERE events.event_type = 'follow')::bigint AS follow_count,
      count(events.id) FILTER (WHERE events.event_type = 'remix_start')::bigint
        AS remix_start_count,
      count(events.id) FILTER (WHERE events.event_type = 'remix_complete')::bigint
        AS remix_complete_count,
      count(events.id) FILTER (WHERE events.event_type = 'resource_open')::bigint
        AS resource_open_count,
      count(events.id) FILTER (WHERE events.event_type = 'purchase')::bigint AS purchase_count,
      count(events.id) FILTER (WHERE events.event_type = 'not_interested')::bigint
        AS not_interested_count,
      count(events.id) FILTER (WHERE events.event_type = 'hide_creator')::bigint
        AS hide_creator_count,
      count(events.id) FILTER (WHERE events.event_type = 'report')::bigint AS report_count,
      max(events.occurred_at) AS last_event_at,
      max(events.received_at) AS last_event_received_at
    FROM candidate_posts AS candidates
    CROSS JOIN windows
    LEFT JOIN public.feed_events AS events
      ON events.post_id = candidates.post_id
     AND events.delivery_fact_id IS NOT NULL
     AND events.occurred_at >= p_as_of - windows.duration
     AND events.occurred_at <= p_as_of
    GROUP BY candidates.post_id, windows.window_key
  ),
  scored AS (
    SELECT
      raw.*,
      least(
        1.0::double precision,
        (
          2.0::double precision
          + 0.15::double precision * raw.open_count::double precision
          + 1.00::double precision * raw.save_count::double precision
          + 0.50::double precision * raw.share_count::double precision
          + 1.00::double precision * raw.comment_count::double precision
          + 1.25::double precision * raw.follow_count::double precision
          + 1.50::double precision * raw.remix_start_count::double precision
          + 2.00::double precision * raw.remix_complete_count::double precision
          + 0.75::double precision * raw.resource_open_count::double precision
          + 2.50::double precision * raw.purchase_count::double precision
        ) / (raw.impression_count::double precision + 25.0::double precision)
      ) AS usefulness_score,
      least(
        1.0::double precision,
        (raw.quick_skip_count::double precision + 1.25::double precision)
          / (raw.impression_count::double precision + 5.0::double precision)
      ) AS quick_skip_rate,
      least(
        1.0::double precision,
        (
          raw.not_interested_count::double precision
          + raw.hide_creator_count::double precision
          + 2.0::double precision * raw.report_count::double precision
          + 0.2::double precision
        ) / (raw.impression_count::double precision + 20.0::double precision)
      ) AS negative_feedback_rate
    FROM raw_rollup AS raw
  )
  INSERT INTO public.post_feed_stats (
    post_id,
    window_key,
    impression_count,
    unique_viewer_count,
    open_count,
    dwell_ms,
    media_progress_count,
    quick_skip_count,
    save_count,
    share_count,
    comment_count,
    follow_count,
    remix_start_count,
    remix_complete_count,
    resource_open_count,
    purchase_count,
    not_interested_count,
    hide_creator_count,
    report_count,
    usefulness_score,
    quick_skip_rate,
    negative_feedback_rate,
    last_event_at,
    last_event_received_at,
    updated_at
  )
  SELECT
    scored.post_id,
    scored.window_key,
    scored.impression_count,
    scored.unique_viewer_count,
    scored.open_count,
    scored.dwell_ms,
    scored.media_progress_count,
    scored.quick_skip_count,
    scored.save_count,
    scored.share_count,
    scored.comment_count,
    scored.follow_count,
    scored.remix_start_count,
    scored.remix_complete_count,
    scored.resource_open_count,
    scored.purchase_count,
    scored.not_interested_count,
    scored.hide_creator_count,
    scored.report_count,
    scored.usefulness_score,
    scored.quick_skip_rate,
    scored.negative_feedback_rate,
    scored.last_event_at,
    scored.last_event_received_at,
    p_as_of
  FROM scored
  ON CONFLICT (post_id, window_key) DO UPDATE
  SET impression_count = EXCLUDED.impression_count,
      unique_viewer_count = EXCLUDED.unique_viewer_count,
      open_count = EXCLUDED.open_count,
      dwell_ms = EXCLUDED.dwell_ms,
      media_progress_count = EXCLUDED.media_progress_count,
      quick_skip_count = EXCLUDED.quick_skip_count,
      save_count = EXCLUDED.save_count,
      share_count = EXCLUDED.share_count,
      comment_count = EXCLUDED.comment_count,
      follow_count = EXCLUDED.follow_count,
      remix_start_count = EXCLUDED.remix_start_count,
      remix_complete_count = EXCLUDED.remix_complete_count,
      resource_open_count = EXCLUDED.resource_open_count,
      purchase_count = EXCLUDED.purchase_count,
      not_interested_count = EXCLUDED.not_interested_count,
      hide_creator_count = EXCLUDED.hide_creator_count,
      report_count = EXCLUDED.report_count,
      usefulness_score = EXCLUDED.usefulness_score,
      quick_skip_rate = EXCLUDED.quick_skip_rate,
      negative_feedback_rate = EXCLUDED.negative_feedback_rate,
      last_event_at = EXCLUDED.last_event_at,
      last_event_received_at = EXCLUDED.last_event_received_at,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer) IS
  'Idempotently refreshes Bayesian-smoothed feed stats, comments included, for a bounded rotating post batch, counting events by their immutable delivery fact.';

-- Reproduced from 20260808130000_feed_ranking_v2_starvation_free_refresh.sql;
-- both meaningful-engagement counts now pass commented_at.
CREATE OR REPLACE FUNCTION public.refresh_post_feed_engagement_stats(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affected_rows integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed engagement stats timestamp is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Feed engagement stats refresh limit must be between 1 and 10000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_post_feed_engagement_stats', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidate_posts AS MATERIALIZED (
    SELECT facts.post_id
    FROM public.feed_delivery_facts AS facts
    LEFT JOIN public.post_feed_stats AS existing
      ON existing.post_id = facts.post_id
    WHERE facts.ranked_at >= p_as_of - interval '31 days'
      AND facts.ranked_at <= p_as_of
    GROUP BY facts.post_id
    ORDER BY min(existing.updated_at) ASC NULLS FIRST, facts.post_id
    LIMIT p_limit
  ),
  windows(window_key, duration) AS (
    VALUES
      ('24h'::text, interval '24 hours'),
      ('7d'::text, interval '7 days'),
      ('30d'::text, interval '30 days')
  ),
  rollup AS (
    SELECT
      candidates.post_id,
      windows.window_key,
      posts.category AS category,
      count(facts.delivery_id) FILTER (WHERE facts.served_at IS NOT NULL)::bigint
        AS served_delivery_count,
      count(facts.delivery_id) FILTER (WHERE facts.rendered_at IS NOT NULL)::bigint
        AS rendered_count,
      -- A rendered video delivery IS a start (the feed autoplays), so an
      -- instant swipe lands in the denominator instead of vanishing.
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL AND posts.category = 'video'
      )::bigint AS video_start_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND posts.category = 'video'
          AND facts.media_progress_max >= 0.5
      )::bigint AS video_half_completion_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND posts.category = 'video'
          AND facts.media_progress_max >= 0.95
      )::bigint AS video_completion_count,
      -- Attention milliseconds: watched fraction x duration for video, held
      -- dwell for everything else. Never mixed across formats.
      coalesce(sum(
        CASE
          WHEN facts.rendered_at IS NULL THEN 0
          WHEN posts.category = 'video'
            THEN least(
              facts.media_progress_max * coalesce(facts.media_duration_ms, 0)::double precision,
              3600000.0::double precision
            )
          ELSE least(facts.dwell_ms_max::double precision, 3600000.0::double precision)
        END
      ), 0.0::double precision)::bigint AS attention_ms_total,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND (posts.category <> 'video' OR facts.media_duration_ms IS NOT NULL)
      )::bigint AS attention_delivery_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND public.is_meaningful_feed_engagement(
            posts.category,
            facts.media_progress_max,
            facts.dwell_ms_max,
            facts.saved_at,
            facts.remix_started_at,
            facts.resource_opened_at,
            facts.purchased_at,
            facts.commented_at
          )
      )::bigint AS meaningful_engagement_count,
      -- v1 divided quick skips by impressions, but a quick skip fires INSTEAD
      -- of a qualified impression, so its own numerator was excluded from its
      -- denominator. Rendered deliveries fix that.
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL AND facts.quick_skipped_at IS NOT NULL
      )::bigint AS quick_skip_delivery_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL AND facts.is_exploration
      )::bigint AS exploration_delivery_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.rendered_at IS NOT NULL
          AND facts.is_exploration
          AND public.is_meaningful_feed_engagement(
            posts.category,
            facts.media_progress_max,
            facts.dwell_ms_max,
            facts.saved_at,
            facts.remix_started_at,
            facts.resource_opened_at,
            facts.purchased_at,
            facts.commented_at
          )
      )::bigint AS exploration_success_count
    FROM candidate_posts AS candidates
    CROSS JOIN windows
    JOIN public.posts AS posts ON posts.id = candidates.post_id
    LEFT JOIN public.feed_delivery_facts AS facts
      ON facts.post_id = candidates.post_id
     AND facts.ranked_at >= p_as_of - windows.duration
     AND facts.ranked_at <= p_as_of
    GROUP BY candidates.post_id, windows.window_key, posts.category
  ),
  scored AS (
    SELECT
      rollup.*,
      CASE
        WHEN rollup.category = 'video' THEN least(
          1.0::double precision,
          (rollup.video_half_completion_count::double precision + 1.5)
            / (rollup.video_start_count::double precision + 6.0)
        )
        ELSE least(
          1.0::double precision,
          (rollup.meaningful_engagement_count::double precision + 1.5)
            / (rollup.rendered_count::double precision + 6.0)
        )
      END AS engagement_depth,
      -- Saturating at ~20s of held attention: past that, more seconds say
      -- little about whether this was the right thing to recommend.
      CASE
        WHEN rollup.attention_delivery_count = 0 THEN 0.0::double precision
        ELSE least(
          1.0::double precision,
          1.0::double precision - exp(
            -1.0::double precision
            * (
              (rollup.attention_ms_total::double precision / 1000.0)
              / rollup.attention_delivery_count::double precision
            ) / 20.0::double precision
          )
        )
      END AS attention_seconds_norm,
      least(
        1.0::double precision,
        (rollup.meaningful_engagement_count::double precision + 2.0)
          / (rollup.rendered_count::double precision + 12.0)
      ) AS meaningful_engagement_rate
    FROM rollup
  )
  INSERT INTO public.post_feed_stats AS stats (
    post_id,
    window_key,
    served_delivery_count,
    rendered_count,
    video_start_count,
    video_half_completion_count,
    video_completion_count,
    attention_ms_total,
    attention_delivery_count,
    meaningful_engagement_count,
    quick_skip_delivery_count,
    exploration_delivery_count,
    exploration_success_count,
    engagement_depth,
    attention_seconds_norm,
    meaningful_engagement_rate,
    updated_at
  )
  SELECT
    scored.post_id,
    scored.window_key,
    scored.served_delivery_count,
    scored.rendered_count,
    scored.video_start_count,
    scored.video_half_completion_count,
    scored.video_completion_count,
    scored.attention_ms_total,
    scored.attention_delivery_count,
    scored.meaningful_engagement_count,
    scored.quick_skip_delivery_count,
    scored.exploration_delivery_count,
    scored.exploration_success_count,
    scored.engagement_depth,
    scored.attention_seconds_norm,
    scored.meaningful_engagement_rate,
    p_as_of
  FROM scored
  ON CONFLICT (post_id, window_key) DO UPDATE
  SET served_delivery_count = EXCLUDED.served_delivery_count,
      rendered_count = EXCLUDED.rendered_count,
      video_start_count = EXCLUDED.video_start_count,
      video_half_completion_count = EXCLUDED.video_half_completion_count,
      video_completion_count = EXCLUDED.video_completion_count,
      attention_ms_total = EXCLUDED.attention_ms_total,
      attention_delivery_count = EXCLUDED.attention_delivery_count,
      meaningful_engagement_count = EXCLUDED.meaningful_engagement_count,
      quick_skip_delivery_count = EXCLUDED.quick_skip_delivery_count,
      exploration_delivery_count = EXCLUDED.exploration_delivery_count,
      exploration_success_count = EXCLUDED.exploration_success_count,
      engagement_depth = EXCLUDED.engagement_depth,
      attention_seconds_norm = EXCLUDED.attention_seconds_norm,
      meaningful_engagement_rate = EXCLUDED.meaningful_engagement_rate,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_post_feed_engagement_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_feed_engagement_stats(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_post_feed_engagement_stats(timestamptz, integer) IS
  'Refreshes fact-based post engagement aggregates (depth, attention, meaningful engagement including comments) for a bounded rotating post batch.';

-- Reproduced from 20261011170309_feed_ranking_v3_x_adoption.sql; the
-- meaningful-engagement count now passes commented_at.
CREATE OR REPLACE FUNCTION public.refresh_creator_feed_stats(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_affected_rows integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Creator stats timestamp is required';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Creator stats refresh limit must be between 1 and 10000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_creator_feed_stats', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidate_creators AS MATERIALIZED (
    -- Creators with rendered deliveries in the window, plus every creator
    -- whose stats rows still hold counts: once a creator's deliveries have
    -- all rolled out of the 30-day window the row must be rebuilt to zero, or
    -- a stale rendered_count keeps their next post out of the cold pool. A
    -- row already rebuilt to zero is left alone, so the candidates do not
    -- grow with every creator ever measured.
    SELECT creators.creator_user_id
    FROM (
      SELECT facts.creator_user_id
      FROM public.feed_delivery_facts AS facts
      WHERE facts.creator_user_id IS NOT NULL
        AND facts.rendered_at IS NOT NULL
        AND facts.ranked_at >= p_as_of - interval '31 days'
        AND facts.ranked_at <= p_as_of
      UNION
      SELECT stale.creator_user_id
      FROM public.creator_feed_stats AS stale
      WHERE stale.rendered_count > 0
         OR stale.negative_feedback_count > 0
    ) AS creators
    LEFT JOIN public.creator_feed_stats AS existing
      ON existing.creator_user_id = creators.creator_user_id
    GROUP BY creators.creator_user_id
    ORDER BY min(existing.updated_at) ASC NULLS FIRST, creators.creator_user_id
    LIMIT p_limit
  ),
  windows(window_key, duration) AS (
    VALUES
      ('24h'::text, interval '24 hours'),
      ('7d'::text, interval '7 days'),
      ('30d'::text, interval '30 days')
  ),
  rollup AS (
    SELECT
      candidates.creator_user_id,
      windows.window_key,
      count(facts.delivery_id)::bigint AS rendered_count,
      count(facts.delivery_id) FILTER (
        WHERE public.is_meaningful_feed_engagement(
          posts.category,
          facts.media_progress_max,
          facts.dwell_ms_max,
          facts.saved_at,
          facts.remix_started_at,
          facts.resource_opened_at,
          facts.purchased_at,
          facts.commented_at
        )
      )::bigint AS meaningful_engagement_count,
      count(facts.delivery_id) FILTER (
        WHERE facts.not_interested_at IS NOT NULL
          OR facts.hid_creator_at IS NOT NULL
      )::bigint AS negative_delivery_count,
      count(DISTINCT facts.post_id)::bigint AS post_count
    FROM candidate_creators AS candidates
    CROSS JOIN windows
    LEFT JOIN public.feed_delivery_facts AS facts
      ON facts.creator_user_id = candidates.creator_user_id
     AND facts.rendered_at IS NOT NULL
     AND facts.ranked_at >= p_as_of - windows.duration
     AND facts.ranked_at <= p_as_of
    LEFT JOIN public.posts AS posts ON posts.id = facts.post_id
    GROUP BY candidates.creator_user_id, windows.window_key
  ),
  report_rollup AS (
    -- Aggregated apart from `rollup` so reports never multiply by deliveries.
    -- A report a moderator dismissed counts for nothing, and one account
    -- reporting the same post again adds nothing: the count is of distinct
    -- (post, reporter) pairs. A report whose reporter was deleted counts once.
    SELECT
      candidates.creator_user_id,
      windows.window_key,
      count(DISTINCT (
        reports.post_id::text || ':'
        || coalesce(reports.reporter_user_id::text, reports.id::text)
      ))::bigint AS report_count
    FROM candidate_creators AS candidates
    CROSS JOIN windows
    JOIN public.posts AS creator_posts
      ON creator_posts.user_id = candidates.creator_user_id
    JOIN public.post_reports AS reports
      ON reports.post_id = creator_posts.id
     AND reports.status <> 'dismissed'
     AND reports.created_at >= p_as_of - windows.duration
     AND reports.created_at <= p_as_of
    GROUP BY candidates.creator_user_id, windows.window_key
  ),
  scored AS (
    SELECT
      rollup.creator_user_id,
      rollup.window_key,
      rollup.rendered_count,
      rollup.meaningful_engagement_count,
      rollup.post_count,
      (
        rollup.negative_delivery_count
        + 2 * coalesce(report_rollup.report_count, 0)
      )::bigint AS negative_feedback_count
    FROM rollup
    LEFT JOIN report_rollup
      ON report_rollup.creator_user_id = rollup.creator_user_id
     AND report_rollup.window_key = rollup.window_key
  )
  INSERT INTO public.creator_feed_stats (
    creator_user_id,
    window_key,
    rendered_count,
    meaningful_engagement_count,
    post_count,
    quality_rate,
    negative_feedback_count,
    negative_feedback_rate,
    updated_at
  )
  SELECT
    scored.creator_user_id,
    scored.window_key,
    scored.rendered_count,
    scored.meaningful_engagement_count,
    scored.post_count,
    -- Bayesian toward a modest global rate so a creator with two lucky
    -- deliveries cannot outrank a proven one.
    least(
      1.0::double precision,
      (scored.meaningful_engagement_count::double precision + 3.0)
        / (scored.rendered_count::double precision + 20.0)
    ),
    scored.negative_feedback_count,
    -- The same 0.2 / 20 prior as a post's negative_feedback_risk, so a
    -- creator with no deliveries sits at 0.01, not at zero or at a guess.
    least(
      1.0::double precision,
      (scored.negative_feedback_count::double precision + 0.2)
        / (scored.rendered_count::double precision + 20.0)
    ),
    p_as_of
  FROM scored
  ON CONFLICT (creator_user_id, window_key) DO UPDATE
  SET rendered_count = EXCLUDED.rendered_count,
      meaningful_engagement_count = EXCLUDED.meaningful_engagement_count,
      post_count = EXCLUDED.post_count,
      quality_rate = EXCLUDED.quality_rate,
      negative_feedback_count = EXCLUDED.negative_feedback_count,
      negative_feedback_rate = EXCLUDED.negative_feedback_rate,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_affected_rows = ROW_COUNT;
  RETURN v_affected_rows / 3;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_creator_feed_stats(timestamptz, integer) IS
  'Refreshes bounded creator quality and negative-feedback aggregates from durable delivery facts and post reports.';

-- Reproduced from 20261005170739_track_empty_interest_refreshes.sql with two
-- additions and nothing else changed: a comment weighs 3.0, as a save does,
-- and every weighted event on a clustered post also writes the
-- semantic_cluster dimension ('c' || cluster_id), with the same weight and
-- decay as its category.
CREATE OR REPLACE FUNCTION public.refresh_user_interest_weights(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_lookback_days integer DEFAULT 90,
  p_half_life_days integer DEFAULT 30,
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Interest refresh timestamp is required';
  END IF;

  IF p_lookback_days IS NULL OR p_lookback_days < 1 OR p_lookback_days > 365 THEN
    RAISE EXCEPTION 'Interest lookback days must be between 1 and 365';
  END IF;

  IF p_half_life_days IS NULL OR p_half_life_days < 1 OR p_half_life_days > 365 THEN
    RAISE EXCEPTION 'Interest half-life days must be between 1 and 365';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'Interest refresh limit must be between 1 and 5000';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_user_interest_weights', 0)) THEN
    RETURN 0;
  END IF;

  SELECT array_agg(candidate.user_id ORDER BY candidate.last_refresh ASC NULLS FIRST, candidate.user_id)
  INTO v_user_ids
  FROM (
    SELECT
      active.user_id,
      coalesce(min(refresh.refreshed_at), min(interests.updated_at)) AS last_refresh
    FROM (
      SELECT events.viewer_user_id AS user_id
      FROM public.feed_events AS events
      WHERE events.viewer_user_id IS NOT NULL
        -- Session pruning clears session_item_id after two days; the immutable
        -- delivery_fact_id keeps the full configured interest window usable.
        AND events.delivery_fact_id IS NOT NULL
        AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
        AND events.occurred_at <= p_as_of

      UNION

      -- Creators with recent successful generations are refreshed even with no
      -- feed activity at all, which is exactly the cold-start case.
      SELECT generations.user_id
      FROM public.generations AS generations
      WHERE generations.user_id IS NOT NULL
        AND generations.status = 'completed'
        AND generations.completed_at >= p_as_of - make_interval(days => p_lookback_days)
        AND generations.completed_at <= p_as_of
    ) AS active
    LEFT JOIN public.user_interest_weights AS interests
      ON interests.user_id = active.user_id
    LEFT JOIN public.user_interest_refresh_state AS refresh
      ON refresh.user_id = active.user_id
    GROUP BY active.user_id
    ORDER BY coalesce(min(refresh.refreshed_at), min(interests.updated_at)) ASC NULLS FIRST, active.user_id
    LIMIT p_limit
  ) AS candidate;

  IF coalesce(cardinality(v_user_ids), 0) = 0 THEN
    RETURN 0;
  END IF;

  DELETE FROM public.user_interest_weights
  WHERE user_id = ANY(v_user_ids);

  WITH weighted_events AS (
    SELECT
      events.viewer_user_id AS user_id,
      posts.user_id AS creator_user_id,
      posts.category,
      posts.post_format,
      posts.source_tool_slug,
      embeddings.cluster_id AS semantic_cluster_id,
      events.occurred_at,
      events.received_at,
      (
        CASE events.event_type
          WHEN 'open' THEN 0.10::double precision
          WHEN 'dwell' THEN CASE
            WHEN coalesce(events.duration_ms::double precision, events.event_value, 0) >= 3000
              THEN 0.35::double precision
            ELSE 0.05::double precision
          END
          WHEN 'media_progress' THEN CASE
            WHEN coalesce(events.progress, events.event_value, 0) >= 0.75
              THEN 0.50::double precision
            ELSE 0.10::double precision
          END
          WHEN 'quick_skip' THEN -1.00::double precision
          WHEN 'save' THEN 3.00::double precision
          WHEN 'unsave' THEN -1.00::double precision
          WHEN 'share' THEN 2.00::double precision
          WHEN 'comment' THEN 3.00::double precision
          WHEN 'follow' THEN 4.00::double precision
          WHEN 'remix_start' THEN 4.00::double precision
          WHEN 'remix_complete' THEN 6.00::double precision
          WHEN 'resource_open' THEN 2.00::double precision
          WHEN 'purchase' THEN 8.00::double precision
          WHEN 'not_interested' THEN -6.00::double precision
          WHEN 'hide_creator' THEN -8.00::double precision
          WHEN 'report' THEN -10.00::double precision
          ELSE 0.00::double precision
        END
      ) * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - events.occurred_at))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.feed_events AS events
    JOIN public.posts AS posts ON posts.id = events.post_id
    LEFT JOIN public.post_content_embeddings AS embeddings
      ON embeddings.post_id = events.post_id
     AND embeddings.embedding_model = 'gte-small'
    WHERE events.viewer_user_id = ANY(v_user_ids)
      AND events.delivery_fact_id IS NOT NULL
      AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
      AND events.occurred_at <= p_as_of
  ),
  weighted_creations AS (
    SELECT
      generations.user_id,
      public.normalize_feed_interest_category(generations.category) AS category,
      generations.completed_at AS occurred_at,
      (
        3.00::double precision
        + CASE WHEN generations.template_run_id IS NOT NULL THEN 1.00::double precision ELSE 0.00::double precision END
      ) * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - generations.completed_at))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.generations AS generations
    LEFT JOIN public.template_runs AS runs ON runs.id = generations.template_run_id
    WHERE generations.user_id = ANY(v_user_ids)
      AND generations.status = 'completed'
      AND generations.completed_at >= p_as_of - make_interval(days => p_lookback_days)
      AND generations.completed_at <= p_as_of
      AND public.normalize_feed_interest_category(generations.category) IS NOT NULL
  ),
  onboarding_seeds AS (
    SELECT
      states.user_id,
      public.normalize_feed_interest_category(states.goal) AS category,
      coalesce(states.updated_at, states.created_at) AS occurred_at,
      4.00::double precision * power(
        0.5::double precision,
        greatest(
          0.0::double precision,
          extract(epoch FROM (p_as_of - coalesce(states.updated_at, states.created_at)))::double precision
        ) / (p_half_life_days::double precision * 86400.0::double precision)
      ) AS signed_weight
    FROM public.mobile_onboarding_states AS states
    WHERE states.user_id = ANY(v_user_ids)
      AND public.normalize_feed_interest_category(states.goal) IS NOT NULL
  ),
  dimensions AS (
    SELECT
      weighted.user_id,
      'category'::text AS dimension_type,
      weighted.category AS dimension_value,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.category IS NOT NULL AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'media_type'::text,
      coalesce(weighted.post_format, weighted.category),
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE coalesce(weighted.post_format, weighted.category) IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'source_tool'::text,
      weighted.source_tool_slug,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.source_tool_slug IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'creator'::text,
      weighted.creator_user_id::text,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.signed_weight <> 0

    UNION ALL

    SELECT
      weighted.user_id,
      'semantic_cluster'::text,
      'c' || weighted.semantic_cluster_id::text,
      weighted.signed_weight,
      weighted.occurred_at,
      weighted.received_at
    FROM weighted_events AS weighted
    WHERE weighted.semantic_cluster_id IS NOT NULL
      AND weighted.signed_weight <> 0

    UNION ALL

    SELECT
      creations.user_id,
      'category'::text,
      creations.category,
      creations.signed_weight,
      creations.occurred_at,
      creations.occurred_at
    FROM weighted_creations AS creations
    WHERE creations.signed_weight <> 0

    UNION ALL

    SELECT
      creations.user_id,
      'media_type'::text,
      creations.category,
      creations.signed_weight,
      creations.occurred_at,
      creations.occurred_at
    FROM weighted_creations AS creations
    WHERE creations.signed_weight <> 0

    UNION ALL

    SELECT
      seeds.user_id,
      'category'::text,
      seeds.category,
      seeds.signed_weight,
      seeds.occurred_at,
      seeds.occurred_at
    FROM onboarding_seeds AS seeds
    WHERE seeds.signed_weight <> 0

    UNION ALL

    SELECT
      seeds.user_id,
      'media_type'::text,
      seeds.category,
      seeds.signed_weight,
      seeds.occurred_at,
      seeds.occurred_at
    FROM onboarding_seeds AS seeds
    WHERE seeds.signed_weight <> 0
  )
  INSERT INTO public.user_interest_weights (
    user_id,
    dimension_type,
    dimension_value,
    weight,
    positive_score,
    negative_score,
    positive_event_count,
    negative_event_count,
    last_event_at,
    last_event_received_at,
    updated_at
  )
  SELECT
    dimensions.user_id,
    dimensions.dimension_type,
    dimensions.dimension_value,
    least(
      20.0::double precision,
      greatest(-20.0::double precision, sum(dimensions.signed_weight))
    ),
    sum(greatest(dimensions.signed_weight, 0.0::double precision)),
    sum(greatest(-dimensions.signed_weight, 0.0::double precision)),
    count(*) FILTER (WHERE dimensions.signed_weight > 0),
    count(*) FILTER (WHERE dimensions.signed_weight < 0),
    max(dimensions.occurred_at),
    max(dimensions.received_at),
    p_as_of
  FROM dimensions
  GROUP BY dimensions.user_id, dimensions.dimension_type, dimensions.dimension_value
  HAVING abs(sum(dimensions.signed_weight)) >= 0.01::double precision
  ON CONFLICT (user_id, dimension_type, dimension_value) DO UPDATE
  SET weight = EXCLUDED.weight,
      positive_score = EXCLUDED.positive_score,
      negative_score = EXCLUDED.negative_score,
      positive_event_count = EXCLUDED.positive_event_count,
      negative_event_count = EXCLUDED.negative_event_count,
      last_event_at = EXCLUDED.last_event_at,
      last_event_received_at = EXCLUDED.last_event_received_at,
      updated_at = EXCLUDED.updated_at;

  -- A successful refresh may legitimately produce no dimensions (audio-only,
  -- impressions-only, or cancelling weights). Record progress independently.
  -- Wall-clock completion advances even when a caller reuses the same p_as_of.
  INSERT INTO public.user_interest_refresh_state (user_id, refreshed_at)
  SELECT user_id, clock_timestamp() FROM unnest(v_user_ids) AS batch(user_id)
  ON CONFLICT (user_id) DO UPDATE SET refreshed_at = EXCLUDED.refreshed_at;

  RETURN cardinality(v_user_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer) IS
  'Rebuilds decayed interest weights (category, media type, source tool, creator, semantic cluster) for a bounded batch of recently active users.';

-- Reproduced from 20260809180000_feed_delivery_fact_daily.sql with
-- comment_count added, and run as its caller like every other feed refresh:
-- the service role already holds the grants it needs.
CREATE OR REPLACE FUNCTION public.refresh_feed_delivery_fact_daily(
  p_as_of timestamptz DEFAULT now(),
  p_lookback_days integer DEFAULT 3,
  p_retention_days integer DEFAULT 400
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_as_of timestamptz := coalesce(p_as_of, now());
  -- A rolling re-aggregation, not an append-once. Facts are mutated after
  -- insert -- `served_at`, `opened_at`, `saved_at` and the rest are stamped as
  -- outcomes arrive -- so a day's bucket is not final when the day ends.
  -- Recomputing the last few days each run lets late outcomes land.
  v_lookback integer := greatest(coalesce(p_lookback_days, 3), 1);
  v_retention integer := greatest(coalesce(p_retention_days, 400), 1);
  v_from date := (v_as_of - make_interval(days => v_lookback))::date;
  v_days integer;
  v_pruned integer;
BEGIN
  INSERT INTO public.feed_delivery_fact_daily AS target (
    fact_date, algorithm_version_id, experiment_id, experiment_variant_id,
    candidate_source, surface,
    deliveries, exploration_deliveries, served, rendered, qualified_impressions,
    opens, quick_skips, saves, shares, follows, remix_starts, remix_completes,
    resource_opens, purchases, not_interested, hid_creator, reports, comment_count,
    dwell_ms_sum, dwell_ms_count, media_progress_sum, media_progress_count,
    final_score_sum, final_score_count, refreshed_at
  )
  SELECT
    facts.ranked_at::date,
    facts.algorithm_version_id,
    facts.experiment_id,
    facts.experiment_variant_id,
    facts.candidate_source,
    facts.surface,
    count(*),
    count(*) FILTER (WHERE facts.is_exploration),
    count(*) FILTER (WHERE facts.served_at IS NOT NULL),
    count(*) FILTER (WHERE facts.rendered_at IS NOT NULL),
    count(*) FILTER (WHERE facts.qualified_impression_at IS NOT NULL),
    count(*) FILTER (WHERE facts.opened_at IS NOT NULL),
    count(*) FILTER (WHERE facts.quick_skipped_at IS NOT NULL),
    count(*) FILTER (WHERE facts.saved_at IS NOT NULL),
    count(*) FILTER (WHERE facts.shared_at IS NOT NULL),
    count(*) FILTER (WHERE facts.followed_at IS NOT NULL),
    count(*) FILTER (WHERE facts.remix_started_at IS NOT NULL),
    count(*) FILTER (WHERE facts.remix_completed_at IS NOT NULL),
    count(*) FILTER (WHERE facts.resource_opened_at IS NOT NULL),
    count(*) FILTER (WHERE facts.purchased_at IS NOT NULL),
    count(*) FILTER (WHERE facts.not_interested_at IS NOT NULL),
    count(*) FILTER (WHERE facts.hid_creator_at IS NOT NULL),
    count(*) FILTER (WHERE facts.reported_at IS NOT NULL),
    count(*) FILTER (WHERE facts.commented_at IS NOT NULL),
    -- Counted on `> 0`, not on `IS NOT NULL`. `dwell_ms_max` and
    -- `media_progress_max` are NOT NULL DEFAULT 0, so a null-check would count
    -- every delivery as an observation and quietly divide by the wrong
    -- denominator -- an average that stays plausible while being wrong.
    coalesce(sum(facts.dwell_ms_max), 0),
    count(*) FILTER (WHERE facts.dwell_ms_max > 0),
    coalesce(sum(facts.media_progress_max), 0),
    count(*) FILTER (WHERE facts.media_progress_max > 0),
    -- `final_score` is NOT NULL, so every delivery contributes one.
    coalesce(sum(facts.final_score), 0),
    count(*),
    now()
  FROM public.feed_delivery_facts AS facts
  WHERE facts.ranked_at >= v_from
    AND facts.ranked_at < (v_as_of + interval '1 day')::date
  GROUP BY 1, 2, 3, 4, 5, 6
  ON CONFLICT ON CONSTRAINT feed_delivery_fact_daily_grain DO UPDATE SET
    deliveries = excluded.deliveries,
    exploration_deliveries = excluded.exploration_deliveries,
    served = excluded.served,
    rendered = excluded.rendered,
    qualified_impressions = excluded.qualified_impressions,
    opens = excluded.opens,
    quick_skips = excluded.quick_skips,
    saves = excluded.saves,
    shares = excluded.shares,
    follows = excluded.follows,
    remix_starts = excluded.remix_starts,
    remix_completes = excluded.remix_completes,
    resource_opens = excluded.resource_opens,
    purchases = excluded.purchases,
    not_interested = excluded.not_interested,
    hid_creator = excluded.hid_creator,
    reports = excluded.reports,
    comment_count = excluded.comment_count,
    dwell_ms_sum = excluded.dwell_ms_sum,
    dwell_ms_count = excluded.dwell_ms_count,
    media_progress_sum = excluded.media_progress_sum,
    media_progress_count = excluded.media_progress_count,
    final_score_sum = excluded.final_score_sum,
    final_score_count = excluded.final_score_count,
    refreshed_at = now()
  -- Assignment, not accumulation: the source rows are re-read in full for the
  -- window, so adding would double-count every refresh.
  WHERE target.fact_date = excluded.fact_date;

  GET DIAGNOSTICS v_days = ROW_COUNT;

  DELETE FROM public.feed_delivery_fact_daily
  WHERE fact_date < (v_as_of - make_interval(days => v_retention))::date;

  GET DIAGNOSTICS v_pruned = ROW_COUNT;

  RETURN jsonb_build_object(
    'buckets_refreshed', v_days,
    'buckets_pruned', v_pruned,
    'from_date', v_from,
    'retention_days', v_retention
  );
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_feed_delivery_fact_daily(timestamptz, integer, integer) IS
  'Recomputes the daily experiment-grain rollup of delivery facts (comments included) over the trailing lookback and prunes buckets past retention.';

-- ─── Viewer-grain daily rollup ───────────────────────────────────────────────
--
-- feed_delivery_fact_daily cannot answer viewer questions -- sessions per
-- viewer, next-day and seventh-day return, the 7-day creation rate, a
-- sample-ratio check -- because it has no viewer in its grain. This one does:
-- a row per UTC day, viewer, algorithm version and experiment variant, kept
-- 400 days like the fact rollup. viewer_key is the user id, or 'anon:' and
-- the anonymous key hash. As in the fact rollup, UNIQUE NULLS NOT DISTINCT is
-- what lets ON CONFLICT find a row whose experiment_variant_id is NULL.
CREATE TABLE IF NOT EXISTS public.feed_viewer_daily (
  fact_date date NOT NULL,
  viewer_key text NOT NULL CHECK (char_length(viewer_key) BETWEEN 1 AND 140),
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  algorithm_version_id uuid NOT NULL,
  experiment_id uuid,
  experiment_variant_id uuid,
  sessions integer NOT NULL DEFAULT 0 CHECK (sessions >= 0),
  served integer NOT NULL DEFAULT 0 CHECK (served >= 0),
  rendered integer NOT NULL DEFAULT 0 CHECK (rendered >= 0),
  qualified integer NOT NULL DEFAULT 0 CHECK (qualified >= 0),
  meaningful integer NOT NULL DEFAULT 0 CHECK (meaningful >= 0),
  quick_skips integer NOT NULL DEFAULT 0 CHECK (quick_skips >= 0),
  negatives integer NOT NULL DEFAULT 0 CHECK (negatives >= 0),
  saves integer NOT NULL DEFAULT 0 CHECK (saves >= 0),
  remix_starts integer NOT NULL DEFAULT 0 CHECK (remix_starts >= 0),
  comments integer NOT NULL DEFAULT 0 CHECK (comments >= 0),
  first_served_at timestamptz,
  last_served_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_viewer_daily_grain
    UNIQUE NULLS NOT DISTINCT (fact_date, viewer_key, algorithm_version_id, experiment_variant_id),
  CONSTRAINT feed_viewer_daily_identity_check
    CHECK (
      (viewer_user_id IS NOT NULL AND viewer_key = viewer_user_id::text)
      OR (viewer_user_id IS NULL AND viewer_key LIKE 'anon:%')
    )
);

-- The cascade from auth.users needs it; the grain index leads with fact_date.
CREATE INDEX IF NOT EXISTS feed_viewer_daily_viewer_user_idx
  ON public.feed_viewer_daily (viewer_user_id)
  WHERE viewer_user_id IS NOT NULL;

ALTER TABLE public.feed_viewer_daily ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feed_viewer_daily FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_viewer_daily TO service_role;
DROP POLICY IF EXISTS "No client access to feed_viewer_daily" ON public.feed_viewer_daily;
CREATE POLICY "No client access to feed_viewer_daily"
  ON public.feed_viewer_daily FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

COMMENT ON TABLE public.feed_viewer_daily IS
  'Daily feed outcomes per viewer, algorithm version and experiment variant (UTC days, 400-day retention); the grain behind sessions per viewer, return rates, the creation rate and sample-ratio checks. Service role only.';

-- Recomputes the last p_days UTC days, the as-of day included, from delivery
-- facts (bucketed by ranked_at, as the fact rollup is) and from sessions that
-- produced no fact at all, which still count as a visit. A session with facts
-- is counted through them, so no session is counted twice. Assignment, not
-- accumulation: the window is re-read in full each run.
CREATE OR REPLACE FUNCTION public.refresh_feed_viewer_daily(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_days integer DEFAULT 3
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_to date;
  v_from date;
  v_rows integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Viewer daily rollup timestamp is required';
  END IF;

  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'Viewer daily rollup days must be between 1 and 30';
  END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('refresh_feed_viewer_daily', 0)) THEN
    RETURN 0;
  END IF;

  v_to := (p_as_of AT TIME ZONE 'UTC')::date;
  v_from := v_to - (p_days - 1);

  WITH fact_rows AS (
    SELECT
      (facts.ranked_at AT TIME ZONE 'UTC')::date AS fact_date,
      coalesce(facts.viewer_user_id::text, 'anon:' || facts.anonymous_key_hash) AS viewer_key,
      facts.viewer_user_id,
      facts.algorithm_version_id,
      facts.experiment_id,
      facts.experiment_variant_id,
      facts.session_id,
      facts.served_at,
      (facts.rendered_at IS NOT NULL) AS was_rendered,
      (facts.qualified_impression_at IS NOT NULL) AS was_qualified,
      (
        facts.rendered_at IS NOT NULL
        AND coalesce(public.is_meaningful_feed_engagement(
          posts.category,
          facts.media_progress_max,
          facts.dwell_ms_max,
          facts.saved_at,
          facts.remix_started_at,
          facts.resource_opened_at,
          facts.purchased_at,
          facts.commented_at
        ), false)
      ) AS was_meaningful,
      (facts.quick_skipped_at IS NOT NULL) AS was_quick_skipped,
      (
        facts.not_interested_at IS NOT NULL
        OR facts.hid_creator_at IS NOT NULL
        OR facts.reported_at IS NOT NULL
      ) AS was_negative,
      (facts.saved_at IS NOT NULL) AS was_saved,
      (facts.remix_started_at IS NOT NULL) AS was_remix_started,
      (facts.commented_at IS NOT NULL) AS was_commented
    FROM public.feed_delivery_facts AS facts
    LEFT JOIN public.posts AS posts ON posts.id = facts.post_id
    WHERE facts.ranked_at >= (v_from::timestamp AT TIME ZONE 'UTC')
      AND facts.ranked_at < ((v_to + 1)::timestamp AT TIME ZONE 'UTC')
  ),
  session_rows AS (
    SELECT
      (sessions.created_at AT TIME ZONE 'UTC')::date AS fact_date,
      coalesce(sessions.viewer_user_id::text, 'anon:' || sessions.anonymous_key_hash) AS viewer_key,
      sessions.viewer_user_id,
      sessions.algorithm_version_id,
      assignments.experiment_id,
      assignments.variant_id AS experiment_variant_id,
      sessions.id AS session_id
    FROM public.feed_sessions AS sessions
    LEFT JOIN public.feed_experiment_assignments AS assignments
      ON assignments.id = sessions.experiment_assignment_id
    WHERE sessions.created_at >= (v_from::timestamp AT TIME ZONE 'UTC')
      AND sessions.created_at < ((v_to + 1)::timestamp AT TIME ZONE 'UTC')
      AND NOT EXISTS (
        SELECT 1
        FROM public.feed_delivery_facts AS session_facts
        WHERE session_facts.session_id = sessions.id
      )
  ),
  combined AS (
    SELECT
      fact_rows.fact_date,
      fact_rows.viewer_key,
      fact_rows.viewer_user_id,
      fact_rows.algorithm_version_id,
      fact_rows.experiment_id,
      fact_rows.experiment_variant_id,
      fact_rows.session_id,
      fact_rows.served_at,
      fact_rows.was_rendered,
      fact_rows.was_qualified,
      fact_rows.was_meaningful,
      fact_rows.was_quick_skipped,
      fact_rows.was_negative,
      fact_rows.was_saved,
      fact_rows.was_remix_started,
      fact_rows.was_commented
    FROM fact_rows
    UNION ALL
    SELECT
      session_rows.fact_date,
      session_rows.viewer_key,
      session_rows.viewer_user_id,
      session_rows.algorithm_version_id,
      session_rows.experiment_id,
      session_rows.experiment_variant_id,
      session_rows.session_id,
      NULL::timestamptz,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false
    FROM session_rows
  )
  INSERT INTO public.feed_viewer_daily AS target (
    fact_date,
    viewer_key,
    viewer_user_id,
    algorithm_version_id,
    experiment_id,
    experiment_variant_id,
    sessions,
    served,
    rendered,
    qualified,
    meaningful,
    quick_skips,
    negatives,
    saves,
    remix_starts,
    comments,
    first_served_at,
    last_served_at,
    updated_at
  )
  SELECT
    combined.fact_date,
    combined.viewer_key,
    combined.viewer_user_id,
    combined.algorithm_version_id,
    combined.experiment_id,
    combined.experiment_variant_id,
    count(DISTINCT combined.session_id)::integer,
    count(*) FILTER (WHERE combined.served_at IS NOT NULL)::integer,
    count(*) FILTER (WHERE combined.was_rendered)::integer,
    count(*) FILTER (WHERE combined.was_qualified)::integer,
    count(*) FILTER (WHERE combined.was_meaningful)::integer,
    count(*) FILTER (WHERE combined.was_quick_skipped)::integer,
    count(*) FILTER (WHERE combined.was_negative)::integer,
    count(*) FILTER (WHERE combined.was_saved)::integer,
    count(*) FILTER (WHERE combined.was_remix_started)::integer,
    count(*) FILTER (WHERE combined.was_commented)::integer,
    min(combined.served_at),
    max(combined.served_at),
    timezone('utc'::text, now())
  FROM combined
  GROUP BY
    combined.fact_date,
    combined.viewer_key,
    combined.viewer_user_id,
    combined.algorithm_version_id,
    combined.experiment_id,
    combined.experiment_variant_id
  ON CONFLICT ON CONSTRAINT feed_viewer_daily_grain DO UPDATE
  SET viewer_user_id = EXCLUDED.viewer_user_id,
      experiment_id = EXCLUDED.experiment_id,
      sessions = EXCLUDED.sessions,
      served = EXCLUDED.served,
      rendered = EXCLUDED.rendered,
      qualified = EXCLUDED.qualified,
      meaningful = EXCLUDED.meaningful,
      quick_skips = EXCLUDED.quick_skips,
      negatives = EXCLUDED.negatives,
      saves = EXCLUDED.saves,
      remix_starts = EXCLUDED.remix_starts,
      comments = EXCLUDED.comments,
      first_served_at = EXCLUDED.first_served_at,
      last_served_at = EXCLUDED.last_served_at,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_feed_viewer_daily(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_feed_viewer_daily(timestamptz, integer)
  TO service_role;

COMMENT ON FUNCTION public.refresh_feed_viewer_daily(timestamptz, integer) IS
  'Recomputes feed_viewer_daily for the last 1 to 30 UTC days from delivery facts and fact-less sessions; returns the rows written. Service role only.';

-- ─── Retention ───────────────────────────────────────────────────────────────
--
-- Reproduced from 20260809230000_report_feed_retention_clamp.sql with the
-- viewer-grain rollup added under the same rule as the facts: it is pruned in
-- bounded batches, and a requested retention shorter than the facts it
-- summarises is clamped upward and reported, never applied. The old
-- five-parameter signature is dropped first: keeping both would make every
-- PostgREST call ambiguous.
DROP FUNCTION IF EXISTS public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer
);

CREATE OR REPLACE FUNCTION public.prune_feed_personalization_data(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_event_retention_days integer DEFAULT 90,
  p_session_retention_days integer DEFAULT 2,
  p_limit integer DEFAULT 5000,
  p_fact_retention_days integer DEFAULT 400,
  p_viewer_daily_retention_days integer DEFAULT 400
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_events_deleted integer := 0;
  v_sessions_deleted integer := 0;
  v_assignments_deleted integer := 0;
  v_interests_deleted integer := 0;
  v_post_feedback_deleted integer := 0;
  v_creator_feedback_deleted integer := 0;
  v_facts_deleted integer := 0;
  v_session_ids uuid[] := ARRAY[]::uuid[];
  v_fact_retention_days integer;
  v_viewer_daily_deleted integer := 0;
  v_viewer_daily_retention_days integer;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed retention timestamp is required';
  END IF;

  IF p_event_retention_days IS NULL
    OR p_event_retention_days < 7
    OR p_event_retention_days > 730
  THEN
    RAISE EXCEPTION 'Feed event retention days must be between 7 and 730';
  END IF;

  IF p_session_retention_days IS NULL
    OR p_session_retention_days < 1
    OR p_session_retention_days > p_event_retention_days
  THEN
    RAISE EXCEPTION 'Feed session retention days must be between 1 and event retention days';
  END IF;

  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'Feed retention limit must be between 1 and 50000';
  END IF;

  IF p_fact_retention_days IS NULL
    OR p_fact_retention_days < 1
    OR p_fact_retention_days > 1460
  THEN
    RAISE EXCEPTION 'Feed fact retention days must be between 1 and 1460';
  END IF;

  IF p_viewer_daily_retention_days IS NULL
    OR p_viewer_daily_retention_days < 1
    OR p_viewer_daily_retention_days > 1460
  THEN
    RAISE EXCEPTION 'Feed viewer daily retention days must be between 1 and 1460';
  END IF;

  -- Facts must not be pruned before the events that reference them, but a
  -- policy mismatch is clamped rather than raised. Raising aborted the whole
  -- job -- the four stats refreshes above included -- every hour for a
  -- configuration disagreement the caller could not see.
  --
  -- Clamped *upward*, so an automatic correction never deletes more than the
  -- caller asked for. Retaining longer than requested is recoverable; deleting
  -- sooner is not.
  v_fact_retention_days := greatest(p_fact_retention_days, p_event_retention_days);

  -- The viewer-grain rollup summarises facts, so it is clamped the same way:
  -- never kept for less time than the facts it is built from.
  v_viewer_daily_retention_days := greatest(p_viewer_daily_retention_days, v_fact_retention_days);

  IF NOT pg_try_advisory_xact_lock(hashtextextended('prune_feed_personalization_data', 0)) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'already_running');
  END IF;

  WITH doomed AS (
    SELECT events.id
    FROM public.feed_events AS events
    WHERE events.received_at < p_as_of - make_interval(days => p_event_retention_days)
    ORDER BY events.received_at ASC, events.id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_events AS events
    USING doomed
    WHERE events.id = doomed.id
    RETURNING 1
  )
  SELECT count(*) INTO v_events_deleted FROM deleted;

  SELECT coalesce(
    array_agg(doomed.id ORDER BY doomed.expires_at ASC, doomed.id),
    ARRAY[]::uuid[]
  )
  INTO v_session_ids
  FROM (
    SELECT sessions.id, sessions.expires_at
    FROM public.feed_sessions AS sessions
    WHERE sessions.expires_at < p_as_of - make_interval(days => p_session_retention_days)
    ORDER BY sessions.expires_at ASC, sessions.id
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ) AS doomed;

  IF cardinality(v_session_ids) > 0 THEN
    -- Block new references to the doomed session items until the short cleanup
    -- transaction has detached retained events and deleted the session graph.
    PERFORM 1
    FROM public.feed_session_items AS items
    WHERE items.session_id = ANY (v_session_ids)
    FOR UPDATE;

    UPDATE public.feed_events AS events
    SET session_id = NULL,
        session_item_id = NULL
    WHERE events.session_id = ANY (v_session_ids)
      OR events.session_item_id IN (
        SELECT items.id
        FROM public.feed_session_items AS items
        WHERE items.session_id = ANY (v_session_ids)
      );

    DELETE FROM public.feed_sessions AS sessions
    WHERE sessions.id = ANY (v_session_ids);

    GET DIAGNOSTICS v_sessions_deleted = ROW_COUNT;
  END IF;

  WITH doomed AS (
    SELECT assignments.id
    FROM public.feed_experiment_assignments AS assignments
    WHERE assignments.expires_at IS NOT NULL
      AND assignments.expires_at < p_as_of
    ORDER BY assignments.expires_at ASC, assignments.id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_experiment_assignments AS assignments
    USING doomed
    WHERE assignments.id = doomed.id
    RETURNING 1
  )
  SELECT count(*) INTO v_assignments_deleted FROM deleted;

  WITH doomed AS (
    SELECT interests.user_id, interests.dimension_type, interests.dimension_value
    FROM public.user_interest_weights AS interests
    WHERE interests.last_event_at < p_as_of - make_interval(days => p_event_retention_days)
      AND abs(interests.weight) < 0.05::double precision
    ORDER BY interests.last_event_at ASC,
      interests.user_id,
      interests.dimension_type,
      interests.dimension_value
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.user_interest_weights AS interests
    USING doomed
    WHERE interests.user_id = doomed.user_id
      AND interests.dimension_type = doomed.dimension_type
      AND interests.dimension_value = doomed.dimension_value
    RETURNING 1
  )
  SELECT count(*) INTO v_interests_deleted FROM deleted;

  WITH doomed AS (
    SELECT feedback.user_id, feedback.post_id
    FROM public.feed_user_post_feedback AS feedback
    WHERE feedback.is_active = false
      AND feedback.updated_at < p_as_of - make_interval(days => p_event_retention_days)
    ORDER BY feedback.updated_at ASC, feedback.user_id, feedback.post_id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_user_post_feedback AS feedback
    USING doomed
    WHERE feedback.user_id = doomed.user_id
      AND feedback.post_id = doomed.post_id
    RETURNING 1
  )
  SELECT count(*) INTO v_post_feedback_deleted FROM deleted;

  WITH doomed AS (
    SELECT feedback.user_id, feedback.creator_user_id
    FROM public.feed_user_creator_feedback AS feedback
    WHERE feedback.is_active = false
      AND feedback.updated_at < p_as_of - make_interval(days => p_event_retention_days)
    ORDER BY feedback.updated_at ASC, feedback.user_id, feedback.creator_user_id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_user_creator_feedback AS feedback
    USING doomed
    WHERE feedback.user_id = doomed.user_id
      AND feedback.creator_user_id = doomed.creator_user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_creator_feedback_deleted FROM deleted;

  WITH doomed AS (
    SELECT facts.delivery_id
    FROM public.feed_delivery_facts AS facts
    WHERE facts.ranked_at < p_as_of - make_interval(days => v_fact_retention_days)
    ORDER BY facts.ranked_at ASC, facts.delivery_id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_delivery_facts AS facts
    USING doomed
    WHERE facts.delivery_id = doomed.delivery_id
    RETURNING 1
  )
  SELECT count(*) INTO v_facts_deleted FROM deleted;

  -- The rollup has no surrogate key, so the bounded batch is chosen by row
  -- address; the grain index leads with fact_date.
  DELETE FROM public.feed_viewer_daily AS daily
  WHERE daily.ctid = ANY (ARRAY(
    SELECT doomed.ctid
    FROM public.feed_viewer_daily AS doomed
    WHERE doomed.fact_date < (p_as_of AT TIME ZONE 'UTC')::date - v_viewer_daily_retention_days
    ORDER BY doomed.fact_date ASC
    LIMIT p_limit
  ));

  GET DIAGNOSTICS v_viewer_daily_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'skipped', false,
    'events_deleted', v_events_deleted,
    'sessions_deleted', v_sessions_deleted,
    'assignments_deleted', v_assignments_deleted,
    'interests_deleted', v_interests_deleted,
    'post_feedback_deleted', v_post_feedback_deleted,
    'creator_feedback_deleted', v_creator_feedback_deleted,
    'facts_deleted', v_facts_deleted,
    'fact_retention_days_requested', p_fact_retention_days,
    'fact_retention_days_applied', v_fact_retention_days,
    'fact_retention_clamped', v_fact_retention_days <> p_fact_retention_days,
    'viewer_daily_deleted', v_viewer_daily_deleted,
    'viewer_daily_retention_days_requested', p_viewer_daily_retention_days,
    'viewer_daily_retention_days_applied', v_viewer_daily_retention_days,
    'viewer_daily_retention_clamped', v_viewer_daily_retention_days <> p_viewer_daily_retention_days
  );
END;
$$;

REVOKE ALL ON FUNCTION public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer, integer
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer, integer
) TO service_role;

COMMENT ON FUNCTION public.prune_feed_personalization_data(
  timestamptz, integer, integer, integer, integer, integer
) IS
  'Prunes expired feed telemetry in bounded batches: events, sessions, assignments, stale interests, inactive feedback, delivery facts and the viewer-grain rollup; fact and viewer-rollup retention are clamped upward and the applied values reported.';

-- ─── Candidate retrieval v4 ──────────────────────────────────────────────────
--
-- A copy of get_ranked_feed_candidates_v3 (20261011170309) with these changes:
--   * taste: the mean gte-small embedding of the viewer's (or anonymous
--     hash's) newest p_taste_limit deliveries in the last
--     p_taste_lookback_days that were saved, remixed, commented on,
--     purchased or meaningfully engaged with. taste_available says whether
--     the viewer has one.
--   * eligible carries each post's semantic cluster and a recommendable flag:
--     a near-duplicate of an older post, or a post by an account with an
--     active label, is not recommendable. Only the following pool may return
--     a post that is not; every other pool requires it.
--   * a semantic pool (priority 4, between affinity and trending): the
--     eligible posts nearest the taste vector, at least
--     p_semantic_min_similarity, up to p_semantic_limit.
--   * three more columns after v3's 24, in v3's order: semantic_similarity
--     (cosine to the taste vector, clamped to [0, 1], 0 without one),
--     semantic_cluster ('c' || cluster_id) and taste_available.
--     interest_match also reads the viewer's semantic_cluster weights.
-- Like v2 and v3 it returns the deduplicated pool union unranked: no weight
-- appears in this SQL, and TypeScript is the only scorer.
CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates_v4(
  p_viewer_user_id uuid DEFAULT NULL,
  p_anonymous_key_hash text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_following_limit integer DEFAULT 100,
  p_interest_limit integer DEFAULT 150,
  p_trending_limit integer DEFAULT 100,
  p_recent_limit integer DEFAULT 150,
  p_exploration_limit integer DEFAULT 100,
  p_seen_lookback_days integer DEFAULT 14,
  p_creator_prior_cap double precision DEFAULT 0.15,
  p_exploration_confidence double precision DEFAULT 1.5,
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_cold_limit integer DEFAULT 50,
  p_cold_max_age_hours integer DEFAULT 168,
  p_cold_impression_threshold integer DEFAULT 60,
  p_max_age_days integer DEFAULT 365,
  p_served_lookback_hours integer DEFAULT 6,
  p_trending_per_author_cap integer DEFAULT 5,
  p_creator_prior_mean double precision DEFAULT 0.15,
  p_semantic_limit integer DEFAULT 150,
  p_semantic_min_similarity double precision DEFAULT 0.0,
  p_taste_lookback_days integer DEFAULT 90,
  p_taste_limit integer DEFAULT 50,
  p_exclude_near_duplicates boolean DEFAULT true,
  p_exclude_labelled_accounts boolean DEFAULT true
)
RETURNS TABLE (
  post_id uuid,
  interest_match double precision,
  creator_affinity double precision,
  smoothed_usefulness double precision,
  freshness double precision,
  relevant_trend double precision,
  exploration_bonus double precision,
  quick_skip_risk double precision,
  negative_feedback_risk double precision,
  engagement_depth double precision,
  attention_seconds_norm double precision,
  creator_quality double precision,
  exploration_ucb double precision,
  seen_recently boolean,
  last_seen_at timestamptz,
  candidate_source text,
  served_recently boolean,
  is_following boolean,
  author_rendered_30d bigint,
  post_rendered_30d bigint,
  post_meaningful_30d bigint,
  post_age_hours double precision,
  reports_7d bigint,
  sources text[],
  semantic_similarity double precision,
  semantic_cluster text,
  taste_available boolean
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed candidate timestamp is required';
  END IF;

  IF p_following_limit IS NULL OR p_following_limit < 0 OR p_following_limit > 500
    OR p_interest_limit IS NULL OR p_interest_limit < 0 OR p_interest_limit > 500
    OR p_trending_limit IS NULL OR p_trending_limit < 0 OR p_trending_limit > 500
    OR p_recent_limit IS NULL OR p_recent_limit < 0 OR p_recent_limit > 500
    OR p_exploration_limit IS NULL OR p_exploration_limit < 0 OR p_exploration_limit > 500
    OR p_cold_limit IS NULL OR p_cold_limit < 0 OR p_cold_limit > 500
    OR p_semantic_limit IS NULL OR p_semantic_limit < 0 OR p_semantic_limit > 500
  THEN
    RAISE EXCEPTION 'Feed candidate pool limits must be between 0 and 500';
  END IF;

  IF p_seen_lookback_days IS NULL OR p_seen_lookback_days < 0 OR p_seen_lookback_days > 365 THEN
    RAISE EXCEPTION 'Feed seen lookback days must be between 0 and 365';
  END IF;

  IF p_creator_prior_cap IS NULL OR p_creator_prior_cap < 0 OR p_creator_prior_cap > 1 THEN
    RAISE EXCEPTION 'Creator prior cap must be between 0 and 1';
  END IF;

  IF p_exploration_confidence IS NULL
    OR p_exploration_confidence < 0
    OR p_exploration_confidence > 5
  THEN
    RAISE EXCEPTION 'Exploration confidence must be between 0 and 5';
  END IF;

  IF p_cold_max_age_hours IS NULL OR p_cold_max_age_hours < 0 OR p_cold_max_age_hours > 8760
    OR p_served_lookback_hours IS NULL OR p_served_lookback_hours < 0 OR p_served_lookback_hours > 8760
  THEN
    RAISE EXCEPTION 'Feed candidate hour windows must be between 0 and 8760';
  END IF;

  IF p_cold_impression_threshold IS NULL
    OR p_cold_impression_threshold < 0
    OR p_cold_impression_threshold > 100000
  THEN
    RAISE EXCEPTION 'Cold-start impression threshold must be between 0 and 100000';
  END IF;

  IF p_max_age_days IS NULL OR p_max_age_days < 1 OR p_max_age_days > 3650 THEN
    RAISE EXCEPTION 'Feed candidate max age days must be between 1 and 3650';
  END IF;

  IF p_trending_per_author_cap IS NULL
    OR p_trending_per_author_cap < 1
    OR p_trending_per_author_cap > 50
  THEN
    RAISE EXCEPTION 'Trending per-author cap must be between 1 and 50';
  END IF;

  IF p_creator_prior_mean IS NULL OR p_creator_prior_mean < 0 OR p_creator_prior_mean > 1 THEN
    RAISE EXCEPTION 'Creator prior mean must be between 0 and 1';
  END IF;

  IF p_semantic_min_similarity IS NULL
    OR p_semantic_min_similarity < -1
    OR p_semantic_min_similarity > 1
  THEN
    RAISE EXCEPTION 'Semantic minimum similarity must be between -1 and 1';
  END IF;

  IF p_taste_lookback_days IS NULL OR p_taste_lookback_days < 1 OR p_taste_lookback_days > 365 THEN
    RAISE EXCEPTION 'Taste lookback days must be between 1 and 365';
  END IF;

  IF p_taste_limit IS NULL OR p_taste_limit < 1 OR p_taste_limit > 200 THEN
    RAISE EXCEPTION 'Taste limit must be between 1 and 200';
  END IF;

  IF p_exclude_near_duplicates IS NULL OR p_exclude_labelled_accounts IS NULL THEN
    RAISE EXCEPTION 'Feed candidate exclusion flags must be true or false';
  END IF;

  RETURN QUERY
  WITH seen AS MATERIALIZED (
    -- One viewer-prefixed index range scan; cost tracks the viewer's own
    -- recent activity, never the size of the catalog.
    SELECT events.post_id, max(events.occurred_at) AS last_seen_at
    FROM public.feed_events AS events
    WHERE events.event_type = 'impression'
      AND p_seen_lookback_days > 0
      AND events.occurred_at >= p_as_of - make_interval(days => p_seen_lookback_days)
      AND (
        (p_viewer_user_id IS NOT NULL AND events.viewer_user_id = p_viewer_user_id)
        OR (
          p_viewer_user_id IS NULL
          AND p_anonymous_key_hash IS NOT NULL
          AND events.anonymous_key_hash = p_anonymous_key_hash
        )
      )
    GROUP BY events.post_id
  ),
  served AS MATERIALIZED (
    -- Same shape as seen, over delivery facts (feed_delivery_facts_viewer_served_idx
    -- and feed_delivery_facts_anonymous_served_idx). p_served_lookback_hours = 0
    -- is the kill switch.
    SELECT facts.post_id, max(facts.served_at) AS last_served_at
    FROM public.feed_delivery_facts AS facts
    WHERE p_served_lookback_hours > 0
      AND facts.served_at >= p_as_of - make_interval(hours => p_served_lookback_hours)
      AND (
        (p_viewer_user_id IS NOT NULL AND facts.viewer_user_id = p_viewer_user_id)
        OR (
          p_viewer_user_id IS NULL
          AND p_anonymous_key_hash IS NOT NULL
          AND facts.anonymous_key_hash = p_anonymous_key_hash
        )
      )
    GROUP BY facts.post_id
  ),
  taste_facts AS MATERIALIZED (
    -- The viewer's newest positive deliveries with an embedding: saved,
    -- remixed, commented on, purchased or meaningfully engaged with. The
    -- same viewer-prefixed served_at ranges as served; facts are kept 30
    -- days, so a longer lookback reads what is left.
    SELECT facts.post_id
    FROM public.feed_delivery_facts AS facts
    LEFT JOIN public.posts AS taste_posts ON taste_posts.id = facts.post_id
    WHERE facts.served_at >= p_as_of - make_interval(days => p_taste_lookback_days)
      AND facts.served_at <= p_as_of
      AND (
        (p_viewer_user_id IS NOT NULL AND facts.viewer_user_id = p_viewer_user_id)
        OR (
          p_viewer_user_id IS NULL
          AND p_anonymous_key_hash IS NOT NULL
          AND facts.anonymous_key_hash = p_anonymous_key_hash
        )
      )
      AND (
        facts.saved_at IS NOT NULL
        OR facts.remix_started_at IS NOT NULL
        OR facts.commented_at IS NOT NULL
        OR facts.purchased_at IS NOT NULL
        OR (
          facts.rendered_at IS NOT NULL
          AND public.is_meaningful_feed_engagement(
            taste_posts.category,
            facts.media_progress_max,
            facts.dwell_ms_max,
            facts.saved_at,
            facts.remix_started_at,
            facts.resource_opened_at,
            facts.purchased_at,
            facts.commented_at
          )
        )
      )
      AND EXISTS (
        SELECT 1
        FROM public.post_content_embeddings AS taste_embeddings
        WHERE taste_embeddings.post_id = facts.post_id
          AND taste_embeddings.embedding_model = 'gte-small'
      )
    ORDER BY facts.served_at DESC, facts.delivery_id DESC
    LIMIT p_taste_limit
  ),
  taste AS MATERIALIZED (
    -- The viewer's taste vector: the mean of those embeddings. Cosine
    -- distance ignores length, so the mean of unit vectors needs no
    -- normalising. No positive delivery, no row.
    SELECT extensions.avg(taste_embeddings.embedding) AS embedding
    FROM taste_facts
    JOIN public.post_content_embeddings AS taste_embeddings
      ON taste_embeddings.post_id = taste_facts.post_id
     AND taste_embeddings.embedding_model = 'gte-small'
    HAVING count(*) > 0
  ),
  eligible AS MATERIALIZED (
    SELECT
      p.id,
      p.user_id AS creator_id,
      p.category,
      p.post_format,
      p.source_tool_slug,
      p.created_at,
      (seen.post_id IS NOT NULL) AS seen_recently,
      seen.last_seen_at,
      (served.post_id IS NOT NULL) AS served_recently,
      embeddings.cluster_id,
      -- May this post reach a viewer who does not follow its author? Not a
      -- near-duplicate of an older post, and not a post by an account with
      -- an active safety label. Every pool but following requires it.
      NOT (
        (p_exclude_near_duplicates AND embeddings.canonical_post_id IS NOT NULL)
        OR (
          p_exclude_labelled_accounts
          AND EXISTS (
            SELECT 1
            FROM public.account_labels AS labels
            WHERE labels.user_id = p.user_id
              AND labels.expires_at > p_as_of
          )
        )
      ) AS recommendable
    FROM public.posts AS p
    LEFT JOIN seen ON seen.post_id = p.id
    LEFT JOIN served ON served.post_id = p.id
    LEFT JOIN public.post_content_embeddings AS embeddings
      ON embeddings.post_id = p.id
     AND embeddings.embedding_model = 'gte-small'
    WHERE p.visibility = 'public'
      AND p.archived_at IS NULL
      AND p.review_status = 'visible'
      AND p.is_nsfw = false
      AND p.created_at >= p_as_of - make_interval(days => p_max_age_days)
      AND p.user_id IS DISTINCT FROM p_viewer_user_id
      AND (p_category IS NULL OR p.category = p_category)
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.feed_user_post_feedback AS post_feedback
          WHERE post_feedback.user_id = p_viewer_user_id
            AND post_feedback.post_id = p.id
            AND post_feedback.is_active = true
        )
      )
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.feed_user_creator_feedback AS creator_feedback
          WHERE creator_feedback.user_id = p_viewer_user_id
            AND creator_feedback.creator_user_id = p.user_id
            AND creator_feedback.is_active = true
        )
      )
      -- A block hides content in both directions. Two anti-joins rather than
      -- one OR so each direction is a primary-key or
      -- user_blocks_blocked_user_idx probe.
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = p_viewer_user_id
            AND blocks.blocked_user_id = p.user_id
        )
      )
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = p.user_id
            AND blocks.blocked_user_id = p_viewer_user_id
        )
      )
      AND (
        p_viewer_user_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.post_reports AS reports
          WHERE reports.reporter_user_id = p_viewer_user_id
            AND reports.post_id = p.id
        )
      )
  ),
  semantic_scores AS MATERIALIZED (
    -- Cosine distance from each embedded eligible post to the taste vector,
    -- computed once for the semantic pool and the semantic_similarity
    -- feature. Empty when the viewer has no taste vector: the EXISTS is a
    -- one-time filter, so no embedding is read at all then. A NaN (a zero
    -- vector) is dropped rather than ranked.
    SELECT scored.post_id, scored.distance
    FROM (
      SELECT
        e.id AS post_id,
        (
          semantic_embeddings.embedding OPERATOR(extensions.<=>) taste.embedding
        )::double precision AS distance
      FROM eligible AS e
      JOIN public.post_content_embeddings AS semantic_embeddings
        ON semantic_embeddings.post_id = e.id
       AND semantic_embeddings.embedding_model = 'gte-small'
      CROSS JOIN taste
      WHERE EXISTS (SELECT 1 FROM taste)
    ) AS scored
    WHERE scored.distance <> 'NaN'::double precision
  ),
  posterior AS (
    -- Beta(successes + 1, failures + 1) over rendered deliveries, 30d. The raw
    -- counts are returned too: the caller's cold-start slot draws from its own
    -- Beta prior over them.
    SELECT
      e.id AS post_id,
      coalesce(stats.rendered_count, 0)::bigint AS rendered_30d,
      coalesce(stats.meaningful_engagement_count, 0)::bigint AS meaningful_30d,
      (coalesce(stats.meaningful_engagement_count, 0)::double precision + 1.0) AS alpha,
      (
        greatest(
          0.0::double precision,
          coalesce(stats.rendered_count, 0)::double precision
            - coalesce(stats.meaningful_engagement_count, 0)::double precision
        ) + 1.0
      ) AS beta
    FROM eligible AS e
    LEFT JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id AND stats.window_key = '30d'
  ),
  exploration_scores AS (
    SELECT
      posterior.post_id,
      posterior.rendered_30d,
      posterior.meaningful_30d,
      least(
        1.0::double precision,
        greatest(
          0.0::double precision,
          (posterior.alpha / (posterior.alpha + posterior.beta))
          + p_exploration_confidence * sqrt(
            (posterior.alpha * posterior.beta)
            / (
              power(posterior.alpha + posterior.beta, 2.0::double precision)
              * (posterior.alpha + posterior.beta + 1.0)
            )
          )
        )
      ) AS exploration_ucb
    FROM posterior
  ),
  trend_scores AS (
    -- X ranks popular posts by projected 24-hour reach. Renders so far are
    -- projected to a full day assuming exposure decays with an 8-hour
    -- half-life (lambda = ln 2 / 8):
    --   projected = rendered_24h * (1 - exp(-24 lambda)) / (1 - exp(-lambda * max(age_h, 0.5)))
    -- so a two-hour-old post with 10 renders outranks a day-old post with 12.
    -- The projection only scales the volume factor; the meaningful-engagement
    -- rate still decides quality. Used by the trending pool and, as the
    -- relevant_trend feature, by the caller.
    SELECT
      e.id AS post_id,
      e.creator_id,
      e.seen_recently,
      e.created_at,
      e.recommendable,
      stats.rendered_count AS rendered_24h,
      least(
        1.0::double precision,
        greatest(
          0.0::double precision,
          coalesce(stats.meaningful_engagement_rate, 0.0::double precision)
            * least(
              1.0::double precision,
              ln(1.0::double precision + projection.projected_24h)
                / ln(101.0::double precision)
            )
        )
      ) AS velocity
    FROM eligible AS e
    JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id
     AND stats.window_key = '24h'
    CROSS JOIN LATERAL (
      SELECT
        greatest(0, stats.rendered_count)::double precision
          * (
            1.0::double precision
            - exp(-(ln(2.0::double precision) / 8.0::double precision) * 24.0::double precision)
          )
          / (
            1.0::double precision
            - exp(
              -(ln(2.0::double precision) / 8.0::double precision)
              * greatest(
                extract(epoch FROM (p_as_of - e.created_at))::double precision
                  / 3600.0::double precision,
                0.5::double precision
              )
            )
          ) AS projected_24h
    ) AS projection
  ),
  following_pool AS (
    SELECT e.id AS post_id, 'following'::text AS source, 1 AS source_priority
    FROM eligible AS e
    JOIN public.follows AS f
      ON f.following_id = e.creator_id
     AND f.follower_id = p_viewer_user_id
    WHERE p_viewer_user_id IS NOT NULL
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_following_limit
  ),
  cold_pool AS (
    -- X's cold source: new posts from authors the feed has barely shown. An
    -- author with no 30d creator_feed_stats row has never been rendered, so
    -- that counts as zero exposure.
    SELECT e.id AS post_id, 'cold'::text AS source, 2 AS source_priority
    FROM eligible AS e
    LEFT JOIN public.creator_feed_stats AS creator_stats
      ON creator_stats.creator_user_id = e.creator_id
     AND creator_stats.window_key = '30d'
    WHERE e.recommendable
      AND e.created_at >= p_as_of - make_interval(hours => p_cold_max_age_hours)
      AND coalesce(creator_stats.rendered_count, 0) < p_cold_impression_threshold
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_cold_limit
  ),
  interest_pool AS (
    SELECT e.id AS post_id, 'affinity'::text AS source, 3 AS source_priority
    FROM eligible AS e
    WHERE p_viewer_user_id IS NOT NULL
      AND e.recommendable
      AND EXISTS (
        SELECT 1
        FROM public.user_interest_weights AS interest
        WHERE interest.user_id = p_viewer_user_id
          AND interest.weight > 0
          AND (
            (interest.dimension_type = 'category' AND interest.dimension_value = e.category)
            OR (interest.dimension_type = 'media_type' AND interest.dimension_value IN (e.category, e.post_format))
            OR (interest.dimension_type = 'source_tool' AND interest.dimension_value = e.source_tool_slug)
            OR (interest.dimension_type = 'creator' AND interest.dimension_value = e.creator_id::text)
          )
      )
    ORDER BY e.seen_recently ASC, (
      SELECT max(interest.weight)
      FROM public.user_interest_weights AS interest
      WHERE interest.user_id = p_viewer_user_id
        AND interest.weight > 0
        AND (
          (interest.dimension_type = 'category' AND interest.dimension_value = e.category)
          OR (interest.dimension_type = 'media_type' AND interest.dimension_value IN (e.category, e.post_format))
          OR (interest.dimension_type = 'source_tool' AND interest.dimension_value = e.source_tool_slug)
          OR (interest.dimension_type = 'creator' AND interest.dimension_value = e.creator_id::text)
        )
    ) DESC NULLS LAST, e.created_at DESC, e.id DESC
    LIMIT p_interest_limit
  ),
  semantic_pool AS (
    -- Nearest the viewer's taste first, unseen before seen.
    SELECT e.id AS post_id, 'semantic'::text AS source, 4 AS source_priority
    FROM eligible AS e
    JOIN semantic_scores AS semantic ON semantic.post_id = e.id
    WHERE e.recommendable
      AND 1.0::double precision - semantic.distance >= p_semantic_min_similarity
    ORDER BY e.seen_recently ASC, semantic.distance ASC, e.created_at DESC, e.id DESC
    LIMIT p_semantic_limit
  ),
  trending_pool AS (
    SELECT e.post_id, 'trending'::text AS source, 5 AS source_priority
    FROM (
      SELECT
        trend.*,
        row_number() OVER (
          PARTITION BY trend.creator_id
          ORDER BY trend.velocity DESC, trend.created_at DESC, trend.post_id DESC
        ) AS author_rank
      FROM trend_scores AS trend
      WHERE trend.recommendable
    ) AS e
    WHERE e.author_rank <= p_trending_per_author_cap
    ORDER BY e.seen_recently ASC,
      e.velocity DESC,
      e.rendered_24h DESC,
      e.created_at DESC,
      e.post_id DESC
    LIMIT p_trending_limit
  ),
  recent_pool AS (
    SELECT e.id AS post_id, 'fresh'::text AS source, 6 AS source_priority
    FROM eligible AS e
    WHERE e.recommendable
    ORDER BY e.seen_recently ASC, e.created_at DESC, e.id DESC
    LIMIT p_recent_limit
  ),
  exploration_pool AS (
    SELECT e.id AS post_id, 'exploration'::text AS source, 7 AS source_priority
    FROM eligible AS e
    JOIN exploration_scores AS scores ON scores.post_id = e.id
    WHERE e.recommendable
    ORDER BY e.seen_recently ASC, scores.exploration_ucb DESC, e.created_at DESC, e.id DESC
    LIMIT p_exploration_limit
  ),
  pooled AS (
    SELECT * FROM following_pool
    UNION ALL SELECT * FROM cold_pool
    UNION ALL SELECT * FROM interest_pool
    UNION ALL SELECT * FROM semantic_pool
    UNION ALL SELECT * FROM trending_pool
    UNION ALL SELECT * FROM recent_pool
    UNION ALL SELECT * FROM exploration_pool
  ),
  deduplicated AS (
    -- Every source a post came from, in pool-priority order; the first one is
    -- candidate_source, the label v2's DISTINCT ON kept. Postgres refuses
    -- DISTINCT together with an ORDER BY on another expression inside one
    -- aggregate, so duplicates are removed in the subquery instead.
    SELECT
      pool.post_id,
      (array_agg(pool.source ORDER BY pool.source_priority))[1] AS source,
      array_agg(pool.source ORDER BY pool.source_priority) AS sources
    FROM (
      SELECT DISTINCT pooled.post_id, pooled.source, pooled.source_priority
      FROM pooled
    ) AS pool
    GROUP BY pool.post_id
  )
  SELECT
    e.id,
    least(1.0::double precision, greatest(0.0::double precision, coalesce(interest.value, 0)))
      AS interest_match,
    least(1.0::double precision, greatest(0.0::double precision, coalesce(affinity.value, 0)))
      AS creator_affinity,
    coalesce(stats_7d.usefulness_score, 0.08::double precision) AS smoothed_usefulness,
    least(
      1.0::double precision,
      power(
        0.5::double precision,
        greatest(0.0::double precision, extract(epoch FROM (p_as_of - e.created_at))::double precision)
          / 259200.0::double precision
      )
    ) AS freshness,
    least(
      1.0::double precision,
      greatest(0.0::double precision, coalesce(trend.velocity, 0.0::double precision))
    ) AS relevant_trend,
    1.0::double precision
      / sqrt(1.0::double precision + coalesce(stats_30d.impression_count, 0)::double precision / 20.0::double precision)
      AS exploration_bonus,
    least(
      1.0::double precision,
      (coalesce(stats_7d.quick_skip_delivery_count, 0)::double precision + 1.0::double precision)
        / (coalesce(stats_7d.rendered_count, 0)::double precision + 8.0::double precision)
    ) AS quick_skip_risk,
    -- Reports come from post_reports (the report feed event was never
    -- emitted), and the denominator is rendered deliveries, as every other
    -- fact-derived rate.
    least(
      1.0::double precision,
      (
        coalesce(stats_7d.not_interested_count, 0)::double precision
        + coalesce(stats_7d.hide_creator_count, 0)::double precision
        + (2.0::double precision * coalesce(post_reports_7d.report_count, 0)::double precision)
        + 0.2::double precision
      ) / (coalesce(stats_7d.rendered_count, 0)::double precision + 20.0::double precision)
    ) AS negative_feedback_risk,
    coalesce(stats_7d.engagement_depth, 0.25::double precision) AS engagement_depth,
    coalesce(stats_7d.attention_seconds_norm, 0.0::double precision) AS attention_seconds_norm,
    -- A creator with no stats row has simply not been measured yet: give it
    -- the prior mean, not zero, so new authors are not penalised.
    least(p_creator_prior_cap, coalesce(creator_stats.quality_rate, p_creator_prior_mean))
      AS creator_quality,
    coalesce(scores.exploration_ucb, 0.0::double precision) AS exploration_ucb,
    e.seen_recently,
    e.last_seen_at,
    d.source,
    e.served_recently,
    follow_state.is_following,
    coalesce(creator_stats.rendered_count, 0)::bigint AS author_rendered_30d,
    coalesce(scores.rendered_30d, 0)::bigint AS post_rendered_30d,
    coalesce(scores.meaningful_30d, 0)::bigint AS post_meaningful_30d,
    greatest(
      0.0::double precision,
      extract(epoch FROM (p_as_of - e.created_at))::double precision / 3600.0::double precision
    ) AS post_age_hours,
    coalesce(post_reports_7d.report_count, 0)::bigint AS reports_7d,
    d.sources,
    least(
      1.0::double precision,
      greatest(
        0.0::double precision,
        coalesce(1.0::double precision - semantic.distance, 0.0::double precision)
      )
    ) AS semantic_similarity,
    CASE WHEN e.cluster_id IS NOT NULL THEN 'c' || e.cluster_id::text END AS semantic_cluster,
    taste_state.available AS taste_available
  FROM deduplicated AS d
  JOIN eligible AS e ON e.id = d.post_id
  LEFT JOIN exploration_scores AS scores ON scores.post_id = e.id
  LEFT JOIN trend_scores AS trend ON trend.post_id = e.id
  LEFT JOIN public.post_feed_stats AS stats_7d
    ON stats_7d.post_id = e.id AND stats_7d.window_key = '7d'
  LEFT JOIN public.post_feed_stats AS stats_30d
    ON stats_30d.post_id = e.id AND stats_30d.window_key = '30d'
  LEFT JOIN public.creator_feed_stats AS creator_stats
    ON creator_stats.creator_user_id = e.creator_id AND creator_stats.window_key = '30d'
  LEFT JOIN semantic_scores AS semantic ON semantic.post_id = e.id
  CROSS JOIN (SELECT EXISTS (SELECT 1 FROM taste) AS available) AS taste_state
  LEFT JOIN LATERAL (
    -- Non-dismissed reports in the 7-day window, one per reporter, so a
    -- single account cannot multiply its own report.
    SELECT count(DISTINCT coalesce(reports.reporter_user_id::text, reports.id::text))::bigint
      AS report_count
    FROM public.post_reports AS reports
    WHERE reports.post_id = e.id
      AND reports.status <> 'dismissed'
      AND reports.created_at >= p_as_of - interval '7 days'
      AND reports.created_at <= p_as_of
  ) AS post_reports_7d ON true
  LEFT JOIN LATERAL (
    SELECT EXISTS (
      SELECT 1
      FROM public.follows AS f
      WHERE f.follower_id = p_viewer_user_id
        AND f.following_id = e.creator_id
    ) AS is_following
  ) AS follow_state ON true
  LEFT JOIN LATERAL (
    SELECT least(
      1.0::double precision,
      greatest(
        0.0::double precision,
        coalesce(sum(greatest(i.weight, 0.0::double precision)), 0.0::double precision)
          / 10.0::double precision
      )
    ) AS value
    FROM public.user_interest_weights AS i
    WHERE i.user_id = p_viewer_user_id
      AND (
        (i.dimension_type = 'category' AND i.dimension_value = e.category)
        OR (i.dimension_type = 'media_type' AND i.dimension_value IN (e.category, e.post_format))
        OR (i.dimension_type = 'source_tool' AND i.dimension_value = e.source_tool_slug)
        OR (i.dimension_type = 'semantic_cluster' AND i.dimension_value = 'c' || e.cluster_id::text)
      )
  ) AS interest ON true
  LEFT JOIN LATERAL (
    SELECT least(
      1.0::double precision,
      (
        CASE WHEN follow_state.is_following THEN 0.75::double precision ELSE 0.0::double precision END
      ) + greatest(
        0.0::double precision,
        coalesce((
          SELECT max(i.weight) / 10.0::double precision
          FROM public.user_interest_weights AS i
          WHERE i.user_id = p_viewer_user_id
            AND i.dimension_type = 'creator'
            AND i.dimension_value = e.creator_id::text
        ), 0.0::double precision)
      )
    ) AS value
  ) AS affinity ON true;
END;
$$;

REVOKE ALL ON FUNCTION public.get_ranked_feed_candidates_v4(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz,
  integer, integer, integer, integer, integer, integer, double precision,
  integer, double precision, integer, integer, boolean, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ranked_feed_candidates_v4(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz,
  integer, integer, integer, integer, integer, integer, double precision,
  integer, double precision, integer, integer, boolean, boolean
) TO service_role;

COMMENT ON FUNCTION public.get_ranked_feed_candidates_v4(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz,
  integer, integer, integer, integer, integer, integer, double precision,
  integer, double precision, integer, integer, boolean, boolean
) IS
  'v3''s unranked candidate union plus a taste-vector semantic pool, semantic similarity and cluster features, and recommendation-level exclusion of near-duplicates and labelled accounts outside the following pool; scoring belongs to the caller.';

-- ─── Scorecards ──────────────────────────────────────────────────────────────

-- Viewer-grain outcomes per algorithm version and experiment variant over the
-- last p_days UTC days of feed_viewer_daily (the current, partial day
-- included). A viewer counts once per version and variant.
--   d1_return_rate   viewers served on some day d and again on d + 1, over
--                    viewers served on a day d before the window's last two
--                    (so d + 1 is a whole day inside the window)
--   d7_return_rate   the same with d + 7
--   meaningful_creation_7d_rate
--                    signed-in viewers who started a generation that
--                    completed within 7 days of their first serve in the
--                    window, over signed-in viewers served
-- A return counts whichever version served the return. The eligible and
-- returned counts behind each rate come back too.
CREATE OR REPLACE FUNCTION public.feed_scorecard_viewers(p_days integer DEFAULT 7)
RETURNS TABLE (
  algorithm_version_id uuid,
  algorithm_label text,
  experiment_variant_id uuid,
  variant_key text,
  viewers bigint,
  sessions bigint,
  sessions_per_viewer double precision,
  d1_return_rate double precision,
  d7_return_rate double precision,
  meaningful_creation_7d_rate double precision,
  rendered_per_viewer double precision,
  meaningful_per_viewer double precision,
  d1_eligible_viewers bigint,
  d1_returned_viewers bigint,
  d7_eligible_viewers bigint,
  d7_returned_viewers bigint,
  signed_in_viewers bigint,
  meaningful_creators_7d bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_window_end date;
  v_window_start date;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 90 THEN
    RAISE EXCEPTION 'Feed viewer scorecard days must be between 1 and 90';
  END IF;

  v_window_end := (now() AT TIME ZONE 'UTC')::date;
  v_window_start := v_window_end - (p_days - 1);

  RETURN QUERY
  WITH viewer_days AS (
    SELECT
      daily.algorithm_version_id AS version_id,
      daily.experiment_variant_id AS variant_id,
      daily.viewer_key AS day_viewer_key,
      daily.viewer_user_id AS day_viewer_user_id,
      daily.fact_date AS day_date,
      daily.sessions AS day_sessions,
      daily.rendered AS day_rendered,
      daily.meaningful AS day_meaningful,
      daily.first_served_at AS day_first_served_at
    FROM public.feed_viewer_daily AS daily
    WHERE daily.fact_date >= v_window_start
      AND daily.fact_date <= v_window_end
      AND daily.served > 0
  ),
  served_days AS (
    SELECT DISTINCT viewer_days.day_viewer_key, viewer_days.day_date
    FROM viewer_days
  ),
  day_returns AS (
    SELECT
      viewer_days.*,
      EXISTS (
        SELECT 1
        FROM served_days AS next_day
        WHERE next_day.day_viewer_key = viewer_days.day_viewer_key
          AND next_day.day_date = viewer_days.day_date + 1
      ) AS returned_next_day,
      EXISTS (
        SELECT 1
        FROM served_days AS week_later
        WHERE week_later.day_viewer_key = viewer_days.day_viewer_key
          AND week_later.day_date = viewer_days.day_date + 7
      ) AS returned_day_seven
    FROM viewer_days
  ),
  per_viewer AS (
    SELECT
      day_returns.version_id,
      day_returns.variant_id,
      day_returns.day_viewer_key AS viewer_key,
      day_returns.day_viewer_user_id AS viewer_user_id,
      sum(day_returns.day_sessions)::bigint AS viewer_sessions,
      sum(day_returns.day_rendered)::bigint AS viewer_rendered,
      sum(day_returns.day_meaningful)::bigint AS viewer_meaningful,
      min(day_returns.day_first_served_at) AS viewer_first_served_at,
      bool_or(day_returns.day_date < v_window_end - 1) AS d1_eligible,
      bool_or(day_returns.day_date < v_window_end - 1 AND day_returns.returned_next_day) AS d1_returned,
      bool_or(day_returns.day_date < v_window_end - 7) AS d7_eligible,
      bool_or(day_returns.day_date < v_window_end - 7 AND day_returns.returned_day_seven) AS d7_returned
    FROM day_returns
    GROUP BY
      day_returns.version_id,
      day_returns.variant_id,
      day_returns.day_viewer_key,
      day_returns.day_viewer_user_id
  ),
  with_creations AS (
    SELECT
      per_viewer.*,
      (
        per_viewer.viewer_user_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.generations AS generations
          WHERE generations.user_id = per_viewer.viewer_user_id
            AND generations.status = 'completed'
            AND generations.created_at >= per_viewer.viewer_first_served_at
            AND generations.created_at < per_viewer.viewer_first_served_at + interval '7 days'
        )
      ) AS created_within_7d
    FROM per_viewer
  )
  SELECT
    with_creations.version_id,
    versions.algorithm_key || '-v' || versions.version::text,
    with_creations.variant_id,
    variants.variant_key,
    count(*)::bigint,
    sum(with_creations.viewer_sessions)::bigint,
    sum(with_creations.viewer_sessions)::double precision / count(*)::double precision,
    count(*) FILTER (WHERE with_creations.d1_returned)::double precision
      / nullif(count(*) FILTER (WHERE with_creations.d1_eligible), 0)::double precision,
    count(*) FILTER (WHERE with_creations.d7_returned)::double precision
      / nullif(count(*) FILTER (WHERE with_creations.d7_eligible), 0)::double precision,
    count(*) FILTER (WHERE with_creations.created_within_7d)::double precision
      / nullif(count(*) FILTER (WHERE with_creations.viewer_user_id IS NOT NULL), 0)::double precision,
    sum(with_creations.viewer_rendered)::double precision / count(*)::double precision,
    sum(with_creations.viewer_meaningful)::double precision / count(*)::double precision,
    count(*) FILTER (WHERE with_creations.d1_eligible)::bigint,
    count(*) FILTER (WHERE with_creations.d1_returned)::bigint,
    count(*) FILTER (WHERE with_creations.d7_eligible)::bigint,
    count(*) FILTER (WHERE with_creations.d7_returned)::bigint,
    count(*) FILTER (WHERE with_creations.viewer_user_id IS NOT NULL)::bigint,
    count(*) FILTER (WHERE with_creations.created_within_7d)::bigint
  FROM with_creations
  JOIN public.feed_algorithm_versions AS versions ON versions.id = with_creations.version_id
  LEFT JOIN public.feed_experiment_variants AS variants ON variants.id = with_creations.variant_id
  GROUP BY
    with_creations.version_id,
    versions.algorithm_key,
    versions.version,
    with_creations.variant_id,
    variants.variant_key
  ORDER BY 2, 4 NULLS FIRST;
END;
$$;

REVOKE ALL ON FUNCTION public.feed_scorecard_viewers(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_scorecard_viewers(integer)
  TO service_role;

COMMENT ON FUNCTION public.feed_scorecard_viewers(integer) IS
  'Per version and variant viewer-grain outcomes over the last 1 to 90 UTC days of feed_viewer_daily: viewers, sessions per viewer, D1 and D7 return, 7-day meaningful creation rate, rendered and meaningful per viewer, with the counts behind each rate; service role only.';

-- Outcome counts per version and variant by served position over the facts
-- served in the last p_days. Positions are zero-based; the buckets name
-- one-based slots.
CREATE OR REPLACE FUNCTION public.feed_scorecard_positions(p_days integer DEFAULT 7)
RETURNS TABLE (
  algorithm_version_id uuid,
  algorithm_label text,
  experiment_variant_id uuid,
  variant_key text,
  position_bucket text,
  served bigint,
  rendered bigint,
  meaningful bigint,
  quick_skips bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'Feed position scorecard days must be between 1 and 30';
  END IF;

  RETURN QUERY
  WITH windowed AS (
    SELECT
      facts.algorithm_version_id AS version_id,
      facts.experiment_variant_id AS variant_id,
      CASE
        WHEN facts.position < 3 THEN 1
        WHEN facts.position < 6 THEN 2
        WHEN facts.position < 12 THEN 3
        ELSE 4
      END AS bucket_rank,
      (facts.rendered_at IS NOT NULL) AS was_rendered,
      (
        facts.rendered_at IS NOT NULL
        AND coalesce(public.is_meaningful_feed_engagement(
          posts.category,
          facts.media_progress_max,
          facts.dwell_ms_max,
          facts.saved_at,
          facts.remix_started_at,
          facts.resource_opened_at,
          facts.purchased_at,
          facts.commented_at
        ), false)
      ) AS was_meaningful,
      (facts.quick_skipped_at IS NOT NULL) AS was_quick_skipped
    FROM public.feed_delivery_facts AS facts
    LEFT JOIN public.posts AS posts ON posts.id = facts.post_id
    WHERE facts.served_at >= now() - make_interval(days => p_days)
  )
  SELECT
    windowed.version_id,
    versions.algorithm_key || '-v' || versions.version::text,
    windowed.variant_id,
    variants.variant_key,
    (ARRAY['1-3', '4-6', '7-12', '13+'])[windowed.bucket_rank],
    count(*)::bigint,
    count(*) FILTER (WHERE windowed.was_rendered)::bigint,
    count(*) FILTER (WHERE windowed.was_meaningful)::bigint,
    count(*) FILTER (WHERE windowed.was_quick_skipped)::bigint
  FROM windowed
  JOIN public.feed_algorithm_versions AS versions ON versions.id = windowed.version_id
  LEFT JOIN public.feed_experiment_variants AS variants ON variants.id = windowed.variant_id
  GROUP BY
    windowed.version_id,
    versions.algorithm_key,
    versions.version,
    windowed.variant_id,
    variants.variant_key,
    windowed.bucket_rank
  ORDER BY 2, 4 NULLS FIRST, windowed.bucket_rank;
END;
$$;

REVOKE ALL ON FUNCTION public.feed_scorecard_positions(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_scorecard_positions(integer)
  TO service_role;

COMMENT ON FUNCTION public.feed_scorecard_positions(integer) IS
  'Per version, variant and position bucket (1-3, 4-6, 7-12, 13+) served, rendered, meaningful and quick-skip counts over facts served in the last 1 to 30 days; service role only.';

-- Outcome counts per version and variant by post category over the facts
-- served in the last p_days. attention_ms sums the held dwell of rendered
-- deliveries; video_half_completions counts rendered videos played past half.
CREATE OR REPLACE FUNCTION public.feed_scorecard_formats(p_days integer DEFAULT 7)
RETURNS TABLE (
  algorithm_version_id uuid,
  algorithm_label text,
  experiment_variant_id uuid,
  variant_key text,
  category text,
  rendered bigint,
  meaningful bigint,
  quick_skips bigint,
  attention_ms bigint,
  video_half_completions bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_days > 30 THEN
    RAISE EXCEPTION 'Feed format scorecard days must be between 1 and 30';
  END IF;

  RETURN QUERY
  WITH windowed AS (
    SELECT
      facts.algorithm_version_id AS version_id,
      facts.experiment_variant_id AS variant_id,
      posts.category AS post_category,
      (facts.rendered_at IS NOT NULL) AS was_rendered,
      (
        facts.rendered_at IS NOT NULL
        AND coalesce(public.is_meaningful_feed_engagement(
          posts.category,
          facts.media_progress_max,
          facts.dwell_ms_max,
          facts.saved_at,
          facts.remix_started_at,
          facts.resource_opened_at,
          facts.purchased_at,
          facts.commented_at
        ), false)
      ) AS was_meaningful,
      (facts.quick_skipped_at IS NOT NULL) AS was_quick_skipped,
      CASE WHEN facts.rendered_at IS NOT NULL THEN facts.dwell_ms_max ELSE 0 END AS attention,
      (
        facts.rendered_at IS NOT NULL
        AND posts.category = 'video'
        AND facts.media_progress_max >= 0.5
      ) AS was_video_half_completed
    FROM public.feed_delivery_facts AS facts
    LEFT JOIN public.posts AS posts ON posts.id = facts.post_id
    WHERE facts.served_at >= now() - make_interval(days => p_days)
  )
  SELECT
    windowed.version_id,
    versions.algorithm_key || '-v' || versions.version::text,
    windowed.variant_id,
    variants.variant_key,
    windowed.post_category,
    count(*) FILTER (WHERE windowed.was_rendered)::bigint,
    count(*) FILTER (WHERE windowed.was_meaningful)::bigint,
    count(*) FILTER (WHERE windowed.was_quick_skipped)::bigint,
    coalesce(sum(windowed.attention), 0)::bigint,
    count(*) FILTER (WHERE windowed.was_video_half_completed)::bigint
  FROM windowed
  JOIN public.feed_algorithm_versions AS versions ON versions.id = windowed.version_id
  LEFT JOIN public.feed_experiment_variants AS variants ON variants.id = windowed.variant_id
  GROUP BY
    windowed.version_id,
    versions.algorithm_key,
    versions.version,
    windowed.variant_id,
    variants.variant_key,
    windowed.post_category
  ORDER BY 2, 4 NULLS FIRST, 5 NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.feed_scorecard_formats(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_scorecard_formats(integer)
  TO service_role;

COMMENT ON FUNCTION public.feed_scorecard_formats(integer) IS
  'Per version, variant and post category rendered, meaningful, quick-skip, attention (summed dwell) and video half-completion counts over facts served in the last 1 to 30 days; service role only.';

-- Assignment and exposure per variant of one experiment, for a sample-ratio
-- check against allocation_basis_points. assigned_viewers counts the
-- assignment rows still held (expired ones are pruned); exposed_viewers counts
-- the distinct viewers with at least one delivery fact in the variant (facts
-- are kept 30 days).
CREATE OR REPLACE FUNCTION public.feed_experiment_assignment_counts(p_experiment_key text)
RETURNS TABLE (
  experiment_id uuid,
  experiment_key text,
  variant_id uuid,
  variant_key text,
  algorithm_version_id uuid,
  allocation_basis_points integer,
  assigned_viewers bigint,
  exposed_viewers bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_experiment_key text := btrim(p_experiment_key);
  v_experiment_id uuid;
BEGIN
  IF v_experiment_key IS NULL OR char_length(v_experiment_key) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Feed experiment key must be 1 to 100 characters';
  END IF;

  SELECT experiments.id INTO v_experiment_id
  FROM public.feed_experiments AS experiments
  WHERE experiments.experiment_key = v_experiment_key;

  IF v_experiment_id IS NULL THEN
    RAISE EXCEPTION 'Feed experiment does not exist';
  END IF;

  RETURN QUERY
  SELECT
    v_experiment_id,
    v_experiment_key,
    variants.id,
    variants.variant_key,
    variants.algorithm_version_id,
    variants.allocation_basis_points,
    (
      SELECT count(*)
      FROM public.feed_experiment_assignments AS assignments
      WHERE assignments.experiment_id = v_experiment_id
        AND assignments.variant_id = variants.id
    )::bigint,
    (
      SELECT count(DISTINCT coalesce(facts.viewer_user_id::text, 'anon:' || facts.anonymous_key_hash))
      FROM public.feed_delivery_facts AS facts
      WHERE facts.experiment_id = v_experiment_id
        AND facts.experiment_variant_id = variants.id
    )::bigint
  FROM public.feed_experiment_variants AS variants
  WHERE variants.experiment_id = v_experiment_id
  ORDER BY variants.variant_key;
END;
$$;

REVOKE ALL ON FUNCTION public.feed_experiment_assignment_counts(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.feed_experiment_assignment_counts(text)
  TO service_role;

COMMENT ON FUNCTION public.feed_experiment_assignment_counts(text) IS
  'Per variant of one experiment: allocation, assigned viewers and viewers with at least one delivery fact, for a sample-ratio check; service role only.';

-- ─── Drafting a version ──────────────────────────────────────────────────────

-- The trainer's way in: a new draft of an algorithm key at max(version) + 1.
-- A draft serves nothing; activate_feed_algorithm_version already accepts one.
-- An advisory lock per key serialises concurrent drafts, which would
-- otherwise read the same max(version) and collide on (key, version).
CREATE OR REPLACE FUNCTION public.create_feed_algorithm_version_draft(
  p_algorithm_key text,
  p_description text,
  p_weights jsonb,
  p_retrieval_config jsonb,
  p_diversity_config jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_algorithm_key text := btrim(p_algorithm_key);
  v_description text := coalesce(p_description, '');
  v_version integer;
  v_version_id uuid;
BEGIN
  IF v_algorithm_key IS NULL OR char_length(v_algorithm_key) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Feed algorithm key must be 1 to 80 characters';
  END IF;

  IF char_length(v_description) > 2000 THEN
    RAISE EXCEPTION 'Feed algorithm description must be at most 2000 characters';
  END IF;

  IF p_weights IS NULL OR jsonb_typeof(p_weights) <> 'object' THEN
    RAISE EXCEPTION 'Feed algorithm weights must be a JSON object';
  END IF;

  IF p_retrieval_config IS NULL OR jsonb_typeof(p_retrieval_config) <> 'object' THEN
    RAISE EXCEPTION 'Feed algorithm retrieval_config must be a JSON object';
  END IF;

  IF p_diversity_config IS NULL OR jsonb_typeof(p_diversity_config) <> 'object' THEN
    RAISE EXCEPTION 'Feed algorithm diversity_config must be a JSON object';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('create_feed_algorithm_version_draft:' || v_algorithm_key, 0)
  );

  SELECT coalesce(max(versions.version), 0) + 1 INTO v_version
  FROM public.feed_algorithm_versions AS versions
  WHERE versions.algorithm_key = v_algorithm_key;

  INSERT INTO public.feed_algorithm_versions (
    algorithm_key,
    version,
    status,
    description,
    weights,
    retrieval_config,
    diversity_config
  )
  VALUES (
    v_algorithm_key,
    v_version,
    'draft',
    v_description,
    p_weights,
    p_retrieval_config,
    p_diversity_config
  )
  RETURNING feed_algorithm_versions.id INTO v_version_id;

  RETURN jsonb_build_object(
    'id', v_version_id,
    'algorithm_key', v_algorithm_key,
    'version', v_version,
    'status', 'draft'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_feed_algorithm_version_draft(text, text, jsonb, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_feed_algorithm_version_draft(text, text, jsonb, jsonb, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.create_feed_algorithm_version_draft(text, text, jsonb, jsonb, jsonb) IS
  'Inserts a draft algorithm version at max(version) + 1 for its key from three JSON objects and returns its id and version; service role only.';

-- ─── The feed-embeddings job ─────────────────────────────────────────────────

-- Posts the job should send to the embed-post edge function: public, visible
-- and unarchived, with no gte-small embedding or with text edited since its
-- embedding (post_content_embeddings.updated_at holds the posts.updated_at
-- the embedding was computed from). Most recently changed first.
CREATE OR REPLACE FUNCTION public.list_posts_pending_embedding(p_limit integer DEFAULT 200)
RETURNS TABLE (post_id uuid, updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'Pending embedding limit must be between 1 and 1000';
  END IF;

  RETURN QUERY
  SELECT posts.id, posts.updated_at
  FROM public.posts AS posts
  LEFT JOIN public.post_content_embeddings AS embeddings
    ON embeddings.post_id = posts.id
  WHERE posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND posts.review_status = 'visible'
    AND (
      embeddings.post_id IS NULL
      OR embeddings.embedding_model <> 'gte-small'
      OR posts.updated_at > embeddings.updated_at
    )
  ORDER BY posts.updated_at DESC, posts.id DESC
  LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_posts_pending_embedding(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_posts_pending_embedding(integer)
  TO service_role;

COMMENT ON FUNCTION public.list_posts_pending_embedding(integer) IS
  'Up to 1000 public, visible posts with no gte-small embedding or edited since it, most recently changed first; service role only.';

-- Replaces one model's clusters in a single statement block: delete them all,
-- insert the given ones. p_clusters is [{"cluster_id": int, "centroid": [384
-- numbers], "member_count": int}]; an empty array clears the model.
CREATE OR REPLACE FUNCTION public.replace_feed_semantic_clusters(
  p_embedding_model text,
  p_clusters jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_embedding_model text := btrim(p_embedding_model);
  v_cluster jsonb;
  v_number numeric;
  v_inserted integer := 0;
BEGIN
  IF v_embedding_model IS NULL OR char_length(v_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Semantic cluster embedding model must be 1 to 160 characters';
  END IF;

  IF p_clusters IS NULL
    OR jsonb_typeof(p_clusters) <> 'array'
    OR jsonb_array_length(p_clusters) > 500
  THEN
    RAISE EXCEPTION 'Semantic clusters must be a JSON array of at most 500 clusters';
  END IF;

  FOR v_cluster IN
    SELECT cluster.value FROM jsonb_array_elements(p_clusters) AS cluster(value)
  LOOP
    IF jsonb_typeof(v_cluster) <> 'object' THEN
      RAISE EXCEPTION 'Each semantic cluster must be a JSON object';
    END IF;

    IF jsonb_typeof(v_cluster->'cluster_id') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Semantic cluster ids must be integers between 0 and 2147483647';
    END IF;
    v_number := (v_cluster->>'cluster_id')::numeric;
    IF v_number <> trunc(v_number) OR v_number < 0 OR v_number > 2147483647 THEN
      RAISE EXCEPTION 'Semantic cluster ids must be integers between 0 and 2147483647';
    END IF;

    IF jsonb_typeof(v_cluster->'member_count') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Semantic cluster member counts must be integers between 0 and 2147483647';
    END IF;
    v_number := (v_cluster->>'member_count')::numeric;
    IF v_number <> trunc(v_number) OR v_number < 0 OR v_number > 2147483647 THEN
      RAISE EXCEPTION 'Semantic cluster member counts must be integers between 0 and 2147483647';
    END IF;

    IF jsonb_typeof(v_cluster->'centroid') IS DISTINCT FROM 'array'
      OR jsonb_array_length(v_cluster->'centroid') <> 384
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_cluster->'centroid') AS component(value)
        WHERE jsonb_typeof(component.value) <> 'number'
      )
    THEN
      RAISE EXCEPTION 'Semantic cluster centroids must be arrays of 384 numbers';
    END IF;
  END LOOP;

  IF (
    SELECT count(DISTINCT (cluster.value->>'cluster_id')::numeric)
    FROM jsonb_array_elements(p_clusters) AS cluster(value)
  ) <> jsonb_array_length(p_clusters) THEN
    RAISE EXCEPTION 'Semantic cluster ids must be unique';
  END IF;

  DELETE FROM public.feed_semantic_clusters AS clusters
  WHERE clusters.embedding_model = v_embedding_model;

  INSERT INTO public.feed_semantic_clusters (
    cluster_id,
    embedding_model,
    centroid,
    member_count,
    updated_at
  )
  SELECT
    (cluster.value->>'cluster_id')::numeric::integer,
    v_embedding_model,
    (cluster.value->'centroid')::text::extensions.vector(384),
    (cluster.value->>'member_count')::numeric::integer,
    timezone('utc'::text, now())
  FROM jsonb_array_elements(p_clusters) AS cluster(value);

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_feed_semantic_clusters(text, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_feed_semantic_clusters(text, jsonb)
  TO service_role;

COMMENT ON FUNCTION public.replace_feed_semantic_clusters(text, jsonb) IS
  'Atomically replaces one embedding model''s semantic clusters with up to 500 validated {cluster_id, centroid[384], member_count} objects; returns the number inserted. Service role only.';

-- Sets post_content_embeddings.cluster_id for up to 10000 posts:
-- [{"post_id": uuid, "cluster_id": int | null}], null clearing it. Rows
-- already holding the requested cluster are left untouched; returns how many
-- changed.
CREATE OR REPLACE FUNCTION public.assign_post_semantic_clusters(p_assignments jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_assignment jsonb;
  v_number numeric;
  v_updated integer := 0;
BEGIN
  IF p_assignments IS NULL
    OR jsonb_typeof(p_assignments) <> 'array'
    OR jsonb_array_length(p_assignments) > 10000
  THEN
    RAISE EXCEPTION 'Semantic cluster assignments must be a JSON array of at most 10000 entries';
  END IF;

  FOR v_assignment IN
    SELECT assignment.value FROM jsonb_array_elements(p_assignments) AS assignment(value)
  LOOP
    IF jsonb_typeof(v_assignment) <> 'object' THEN
      RAISE EXCEPTION 'Each semantic cluster assignment must be a JSON object';
    END IF;

    IF coalesce(v_assignment->>'post_id', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Semantic cluster assignment post_id must be a uuid';
    END IF;

    IF coalesce(jsonb_typeof(v_assignment->'cluster_id'), 'null') NOT IN ('number', 'null') THEN
      RAISE EXCEPTION 'Semantic cluster assignment cluster_id must be an integer or null';
    END IF;

    IF jsonb_typeof(v_assignment->'cluster_id') = 'number' THEN
      v_number := (v_assignment->>'cluster_id')::numeric;
      IF v_number <> trunc(v_number) OR v_number < 0 OR v_number > 2147483647 THEN
        RAISE EXCEPTION 'Semantic cluster assignment cluster_id must be an integer or null';
      END IF;
    END IF;
  END LOOP;

  IF (
    SELECT count(DISTINCT (assignment.value->>'post_id')::uuid)
    FROM jsonb_array_elements(p_assignments) AS assignment(value)
  ) <> jsonb_array_length(p_assignments) THEN
    RAISE EXCEPTION 'Each post may be assigned once per call';
  END IF;

  WITH requested AS (
    SELECT
      (assignment.value->>'post_id')::uuid AS requested_post_id,
      CASE
        WHEN jsonb_typeof(assignment.value->'cluster_id') = 'number'
          THEN (assignment.value->>'cluster_id')::numeric::integer
      END AS requested_cluster_id
    FROM jsonb_array_elements(p_assignments) AS assignment(value)
  )
  UPDATE public.post_content_embeddings AS embeddings
  SET cluster_id = requested.requested_cluster_id
  FROM requested
  WHERE embeddings.post_id = requested.requested_post_id
    AND embeddings.cluster_id IS DISTINCT FROM requested.requested_cluster_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_post_semantic_clusters(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_post_semantic_clusters(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.assign_post_semantic_clusters(jsonb) IS
  'Sets or clears post_content_embeddings.cluster_id for up to 10000 posts and returns how many changed; service role only.';

-- Marks (or, with a null canonical, unmarks) near-duplicates:
-- [{"post_id": uuid, "canonical_post_id": uuid | null, "similarity": number |
-- null}]. A post is never its own canonical, and there are no chains: after
-- the call no marked post's canonical may itself be marked, so a post cannot
-- become a duplicate while it is another's canonical, nor point at one that is
-- a duplicate. A call that would break either rule changes nothing. Returns
-- how many rows changed.
CREATE OR REPLACE FUNCTION public.mark_post_near_duplicates(p_duplicates jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_duplicate jsonb;
  v_uuid_pattern constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_similarity double precision;
  v_post_ids uuid[];
  v_updated integer := 0;
BEGIN
  IF p_duplicates IS NULL
    OR jsonb_typeof(p_duplicates) <> 'array'
    OR jsonb_array_length(p_duplicates) > 10000
  THEN
    RAISE EXCEPTION 'Near-duplicate marks must be a JSON array of at most 10000 entries';
  END IF;

  FOR v_duplicate IN
    SELECT duplicate.value FROM jsonb_array_elements(p_duplicates) AS duplicate(value)
  LOOP
    IF jsonb_typeof(v_duplicate) <> 'object' THEN
      RAISE EXCEPTION 'Each near-duplicate mark must be a JSON object';
    END IF;

    IF coalesce(v_duplicate->>'post_id', '') !~* v_uuid_pattern THEN
      RAISE EXCEPTION 'Near-duplicate post_id must be a uuid';
    END IF;

    IF coalesce(jsonb_typeof(v_duplicate->'canonical_post_id'), 'null') <> 'null'
      AND coalesce(v_duplicate->>'canonical_post_id', '') !~* v_uuid_pattern
    THEN
      RAISE EXCEPTION 'Near-duplicate canonical_post_id must be a uuid or null';
    END IF;

    IF lower(v_duplicate->>'post_id') = lower(v_duplicate->>'canonical_post_id') THEN
      RAISE EXCEPTION 'A post cannot be a near-duplicate of itself';
    END IF;

    IF coalesce(jsonb_typeof(v_duplicate->'similarity'), 'null') NOT IN ('number', 'null') THEN
      RAISE EXCEPTION 'Near-duplicate similarity must be a number between -1 and 1 or null';
    END IF;

    IF jsonb_typeof(v_duplicate->'similarity') = 'number' THEN
      v_similarity := (v_duplicate->>'similarity')::double precision;
      IF v_similarity < -1 OR v_similarity > 1 THEN
        RAISE EXCEPTION 'Near-duplicate similarity must be a number between -1 and 1 or null';
      END IF;
    END IF;
  END LOOP;

  SELECT coalesce(array_agg(DISTINCT (duplicate.value->>'post_id')::uuid), ARRAY[]::uuid[])
  INTO v_post_ids
  FROM jsonb_array_elements(p_duplicates) AS duplicate(value);

  IF cardinality(v_post_ids) <> jsonb_array_length(p_duplicates) THEN
    RAISE EXCEPTION 'Each post may be marked once per call';
  END IF;

  WITH requested AS (
    SELECT
      (duplicate.value->>'post_id')::uuid AS requested_post_id,
      CASE
        WHEN jsonb_typeof(duplicate.value->'canonical_post_id') = 'string'
          THEN (duplicate.value->>'canonical_post_id')::uuid
      END AS requested_canonical_post_id,
      CASE
        WHEN jsonb_typeof(duplicate.value->'canonical_post_id') = 'string'
          AND jsonb_typeof(duplicate.value->'similarity') = 'number'
          THEN (duplicate.value->>'similarity')::double precision
      END AS requested_similarity
    FROM jsonb_array_elements(p_duplicates) AS duplicate(value)
  )
  UPDATE public.post_content_embeddings AS embeddings
  SET canonical_post_id = requested.requested_canonical_post_id,
      near_duplicate_similarity = requested.requested_similarity
  FROM requested
  WHERE embeddings.post_id = requested.requested_post_id
    AND (
      embeddings.canonical_post_id IS DISTINCT FROM requested.requested_canonical_post_id
      OR embeddings.near_duplicate_similarity IS DISTINCT FROM requested.requested_similarity
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Checked after the writes, so a chain formed inside this batch is caught as
  -- well as one with a row already marked. Only links touching this batch are
  -- examined: a call is answerable for what it changes.
  IF EXISTS (
    SELECT 1
    FROM public.post_content_embeddings AS duplicate
    JOIN public.post_content_embeddings AS canonical
      ON canonical.post_id = duplicate.canonical_post_id
    WHERE duplicate.canonical_post_id IS NOT NULL
      AND canonical.canonical_post_id IS NOT NULL
      AND (duplicate.post_id = ANY (v_post_ids) OR canonical.post_id = ANY (v_post_ids))
  ) THEN
    RAISE EXCEPTION 'A near-duplicate''s canonical post cannot itself be a near-duplicate';
  END IF;

  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_post_near_duplicates(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_post_near_duplicates(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.mark_post_near_duplicates(jsonb) IS
  'Sets or clears canonical_post_id and near_duplicate_similarity for up to 10000 posts, refusing self-references and chains; returns how many changed. Service role only.';

-- ─── The safety-label pass ───────────────────────────────────────────────────

-- [{"user_id": uuid, "label": text, "source": text, "expires_at":
-- timestamptz}], upserted on (user_id, label). A pair given twice keeps its
-- latest expiry. Returns the rows written.
CREATE OR REPLACE FUNCTION public.upsert_account_labels(p_labels jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_label jsonb;
  v_written integer := 0;
BEGIN
  IF p_labels IS NULL
    OR jsonb_typeof(p_labels) <> 'array'
    OR jsonb_array_length(p_labels) > 10000
  THEN
    RAISE EXCEPTION 'Account labels must be a JSON array of at most 10000 entries';
  END IF;

  FOR v_label IN
    SELECT label.value FROM jsonb_array_elements(p_labels) AS label(value)
  LOOP
    IF jsonb_typeof(v_label) <> 'object' THEN
      RAISE EXCEPTION 'Each account label must be a JSON object';
    END IF;

    IF coalesce(v_label->>'user_id', '')
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    THEN
      RAISE EXCEPTION 'Account label user_id must be a uuid';
    END IF;

    IF coalesce(v_label->>'label', '') NOT IN ('nsfw_account', 'negative_feedback_account', 'spam_account') THEN
      RAISE EXCEPTION 'Account label must be nsfw_account, negative_feedback_account or spam_account';
    END IF;

    IF jsonb_typeof(v_label->'source') IS DISTINCT FROM 'string'
      OR char_length(v_label->>'source') NOT BETWEEN 1 AND 80
    THEN
      RAISE EXCEPTION 'Account label source must be 1 to 80 characters';
    END IF;

    IF jsonb_typeof(v_label->'expires_at') IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION 'Account label expires_at must be a timestamp';
    END IF;
    -- Raises on a malformed timestamp.
    PERFORM (v_label->>'expires_at')::timestamptz;
  END LOOP;

  INSERT INTO public.account_labels AS labels (
    user_id,
    label,
    source,
    expires_at,
    created_at,
    updated_at
  )
  SELECT DISTINCT ON (requested.requested_user_id, requested.requested_label)
    requested.requested_user_id,
    requested.requested_label,
    requested.requested_source,
    requested.requested_expires_at,
    timezone('utc'::text, now()),
    timezone('utc'::text, now())
  FROM (
    SELECT
      (label.value->>'user_id')::uuid AS requested_user_id,
      label.value->>'label' AS requested_label,
      label.value->>'source' AS requested_source,
      (label.value->>'expires_at')::timestamptz AS requested_expires_at
    FROM jsonb_array_elements(p_labels) AS label(value)
  ) AS requested
  ORDER BY
    requested.requested_user_id,
    requested.requested_label,
    requested.requested_expires_at DESC
  ON CONFLICT (user_id, label) DO UPDATE
  SET source = EXCLUDED.source,
      expires_at = EXCLUDED.expires_at,
      updated_at = EXCLUDED.updated_at;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_account_labels(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_account_labels(jsonb)
  TO service_role;

COMMENT ON FUNCTION public.upsert_account_labels(jsonb) IS
  'Upserts up to 10000 validated account labels on (user_id, label) and returns the rows written; service role only.';

CREATE OR REPLACE FUNCTION public.delete_expired_account_labels(p_as_of timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Account label expiry timestamp is required';
  END IF;

  DELETE FROM public.account_labels AS labels
  WHERE labels.expires_at <= p_as_of;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_expired_account_labels(timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_expired_account_labels(timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.delete_expired_account_labels(timestamptz) IS
  'Deletes account labels that expired at or before p_as_of and returns how many; service role only.';

-- ─── for-you-rules v4 ────────────────────────────────────────────────────────

-- Inserted as SHADOW: nothing serves it until it is activated or referenced by
-- an experiment variant. v3's row with two weights moved: interest_match gives
-- 0.08 of its 0.24 to the new semantic_similarity (0.14 -- the rest of it is
-- new weight), the retrieval config names the v4 RPC and its six new
-- parameters, and the diversity config is v3's, whose
-- max_semantic_cluster_per_20 now has clusters to act on.
INSERT INTO public.feed_algorithm_versions (
  algorithm_key,
  version,
  status,
  description,
  weights,
  retrieval_config,
  diversity_config
)
VALUES (
  'for-you-rules',
  4,
  'shadow',
  'Industry parity: gte-small content embeddings, taste-vector semantic retrieval, cluster interests and diversity, near-duplicate canonicalisation, account labels, comment and server-written follow/remix/purchase signals.',
  jsonb_build_object(
    'interest_match', 0.16,
    'semantic_similarity', 0.14,
    'creator_affinity', 0.12,
    'smoothed_usefulness', 0.10,
    'engagement_depth', 0.22,
    'attention_seconds_norm', 0.08,
    'freshness', 0.12,
    'relevant_trend', 0.08,
    'creator_quality', 0.06,
    'exploration_ucb', 0.10,
    'exploration_bonus', 0.0,
    'quick_skip_risk', -0.30,
    'negative_feedback_risk', -2.5
  ),
  jsonb_build_object(
    'candidate_rpc', 'v4',
    'following_limit', 100,
    'interest_limit', 150,
    'trending_limit', 100,
    'recent_limit', 150,
    'exploration_limit', 100,
    'cold_limit', 50,
    'cold_max_age_hours', 168,
    'cold_impression_threshold', 60,
    'max_age_days', 365,
    'served_lookback_hours', 6,
    'trending_per_author_cap', 5,
    'seen_lookback_days', 14,
    'seen_penalty', 0.2,
    'creator_prior_cap', 0.15,
    'creator_prior_mean', 0.15,
    'exploration_confidence', 1.5,
    'session_item_limit', 60,
    'recommendation_max_post_negative_risk', 0.12,
    'recommendation_max_creator_negative_rate', 0.08,
    'semantic_limit', 150,
    'semantic_min_similarity', 0.0,
    'taste_lookback_days', 90,
    'taste_limit', 50,
    'exclude_near_duplicates', true,
    'exclude_labelled_accounts', true
  ),
  jsonb_build_object(
    'max_creator_per_20', 3,
    'max_semantic_cluster_per_20', 3,
    'exploration_per_10', 1,
    'max_paid_share', 0.20,
    'author_decay', 0.5,
    'author_decay_floor', 0.25,
    'out_of_network_multiplier', 0.75,
    'served_penalty', 0.5,
    'cold_start_slot_rank', 6,
    'cold_start_max_age_hours', 168,
    'cold_start_impression_threshold', 60,
    'cold_start_prior_mean', 0.15,
    'cold_start_prior_strength', 50
  )
)
ON CONFLICT (algorithm_key, version) DO NOTHING;
