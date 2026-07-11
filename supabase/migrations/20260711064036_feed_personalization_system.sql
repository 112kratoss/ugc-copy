-- Feed personalization foundation.
--
-- Every table in this migration is backend-owned. Browser and mobile clients use
-- rate-limited API routes; only the service role can read or mutate this data.

CREATE TABLE IF NOT EXISTS public.feed_algorithm_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  algorithm_key text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'shadow', 'active', 'retired')),
  description text NOT NULL DEFAULT '',
  weights jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(weights) = 'object'),
  retrieval_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(retrieval_config) = 'object'),
  diversity_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(diversity_config) = 'object'),
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_algorithm_versions_key_length_check
    CHECK (char_length(algorithm_key) BETWEEN 1 AND 80),
  CONSTRAINT feed_algorithm_versions_version_check CHECK (version > 0),
  CONSTRAINT feed_algorithm_versions_lifecycle_check
    CHECK (retired_at IS NULL OR activated_at IS NULL OR retired_at >= activated_at),
  CONSTRAINT feed_algorithm_versions_key_version_key UNIQUE (algorithm_key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS feed_algorithm_versions_one_active_idx
  ON public.feed_algorithm_versions (algorithm_key)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS feed_algorithm_versions_status_created_idx
  ON public.feed_algorithm_versions (status, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS public.feed_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'paused', 'completed', 'cancelled')),
  traffic_basis_points integer NOT NULL DEFAULT 0
    CHECK (traffic_basis_points BETWEEN 0 AND 10000),
  assignment_salt text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  targeting jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(targeting) = 'object'),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_experiments_key_length_check
    CHECK (char_length(experiment_key) BETWEEN 1 AND 100),
  CONSTRAINT feed_experiments_window_check
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS feed_experiments_status_window_idx
  ON public.feed_experiments (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS public.feed_experiment_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL
    REFERENCES public.feed_experiments(id) ON DELETE CASCADE,
  variant_key text NOT NULL,
  algorithm_version_id uuid NOT NULL
    REFERENCES public.feed_algorithm_versions(id) ON DELETE RESTRICT,
  allocation_basis_points integer NOT NULL
    CHECK (allocation_basis_points BETWEEN 0 AND 10000),
  config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object'),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_experiment_variants_key_length_check
    CHECK (char_length(variant_key) BETWEEN 1 AND 80),
  CONSTRAINT feed_experiment_variants_experiment_key UNIQUE (experiment_id, variant_key),
  CONSTRAINT feed_experiment_variants_experiment_id_id_key UNIQUE (experiment_id, id)
);

CREATE INDEX IF NOT EXISTS feed_experiment_variants_algorithm_idx
  ON public.feed_experiment_variants (algorithm_version_id);

CREATE TABLE IF NOT EXISTS public.feed_experiment_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id uuid NOT NULL
    REFERENCES public.feed_experiments(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL,
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_key_hash text,
  assigned_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  expires_at timestamptz,
  CONSTRAINT feed_experiment_assignments_variant_fkey
    FOREIGN KEY (experiment_id, variant_id)
    REFERENCES public.feed_experiment_variants(experiment_id, id)
    ON DELETE CASCADE,
  CONSTRAINT feed_experiment_assignments_viewer_check
    CHECK (
      (viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL)
      OR (
        viewer_user_id IS NULL
        AND char_length(anonymous_key_hash) BETWEEN 32 AND 128
      )
    ),
  CONSTRAINT feed_experiment_assignments_expiry_check
    CHECK (expires_at IS NULL OR expires_at > assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS feed_experiment_assignments_user_idx
  ON public.feed_experiment_assignments (experiment_id, viewer_user_id)
  WHERE viewer_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS feed_experiment_assignments_anonymous_idx
  ON public.feed_experiment_assignments (experiment_id, anonymous_key_hash)
  WHERE viewer_user_id IS NULL AND anonymous_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_experiment_assignments_variant_idx
  ON public.feed_experiment_assignments (variant_id);

CREATE INDEX IF NOT EXISTS feed_experiment_assignments_expiry_idx
  ON public.feed_experiment_assignments (expires_at)
  WHERE expires_at IS NOT NULL;

INSERT INTO public.feed_algorithm_versions (
  algorithm_key,
  version,
  status,
  description,
  weights,
  retrieval_config,
  diversity_config,
  activated_at
)
VALUES (
  'for-you-rules',
  1,
  'active',
  'Initial explainable feed ranker with Bayesian quality, freshness, negative feedback, and exploration.',
  jsonb_build_object(
    'interest_match', 0.35,
    'creator_affinity', 0.15,
    'smoothed_usefulness', 0.15,
    'freshness', 0.15,
    'relevant_trend', 0.10,
    'exploration_bonus', 0.10,
    'quick_skip_risk', -0.35,
    'negative_feedback_risk', -0.80
  ),
  jsonb_build_object(
    'candidate_limit', 300,
    'session_item_limit', 60,
    'following_share', 0.20,
    'interest_share', 0.30,
    'recent_share', 0.20,
    'trending_share', 0.15,
    'exploration_share', 0.15
  ),
  jsonb_build_object(
    'max_creator_per_20', 2,
    'max_semantic_cluster_per_20', 3,
    'exploration_per_10', 1,
    'max_paid_share', 0.20
  ),
  timezone('utc'::text, now())
)
ON CONFLICT (algorithm_key, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.feed_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_key_hash text,
  surface text NOT NULL DEFAULT 'showcase',
  mode text NOT NULL DEFAULT 'for-you',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(filters) = 'object'),
  algorithm_version_id uuid NOT NULL
    REFERENCES public.feed_algorithm_versions(id) ON DELETE RESTRICT,
  experiment_assignment_id bigint
    REFERENCES public.feed_experiment_assignments(id) ON DELETE SET NULL,
  random_seed bigint NOT NULL DEFAULT (random() * 2147483647.0)::bigint,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_accessed_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  expires_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()) + interval '2 hours',
  CONSTRAINT feed_sessions_viewer_check
    CHECK (
      (viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL)
      OR (
        viewer_user_id IS NULL
        AND char_length(anonymous_key_hash) BETWEEN 32 AND 128
      )
    ),
  CONSTRAINT feed_sessions_surface_length_check
    CHECK (char_length(surface) BETWEEN 1 AND 80),
  CONSTRAINT feed_sessions_mode_length_check CHECK (char_length(mode) BETWEEN 1 AND 40),
  CONSTRAINT feed_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS feed_sessions_user_created_idx
  ON public.feed_sessions (viewer_user_id, created_at DESC, id DESC)
  WHERE viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_sessions_anonymous_created_idx
  ON public.feed_sessions (anonymous_key_hash, created_at DESC, id DESC)
  WHERE viewer_user_id IS NULL AND anonymous_key_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_sessions_algorithm_created_idx
  ON public.feed_sessions (algorithm_version_id, created_at DESC);

CREATE INDEX IF NOT EXISTS feed_sessions_expires_idx
  ON public.feed_sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.feed_session_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES public.feed_sessions(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  candidate_source text NOT NULL,
  final_score double precision NOT NULL CHECK (
    final_score > '-Infinity'::double precision
    AND final_score < 'Infinity'::double precision
    AND final_score <> 'NaN'::double precision
  ),
  score_components jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(score_components) = 'object'),
  is_exploration boolean NOT NULL DEFAULT false,
  ranked_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  served_at timestamptz,
  impression_recorded_at timestamptz,
  CONSTRAINT feed_session_items_candidate_source_length_check
    CHECK (char_length(candidate_source) BETWEEN 1 AND 80),
  CONSTRAINT feed_session_items_session_position_key UNIQUE (session_id, position),
  CONSTRAINT feed_session_items_session_post_key UNIQUE (session_id, post_id)
);

CREATE INDEX IF NOT EXISTS feed_session_items_post_ranked_idx
  ON public.feed_session_items (post_id, ranked_at DESC);

CREATE INDEX IF NOT EXISTS feed_session_items_unserved_idx
  ON public.feed_session_items (session_id, position)
  WHERE served_at IS NULL;

CREATE TABLE IF NOT EXISTS public.feed_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_event_id text NOT NULL UNIQUE,
  session_id uuid REFERENCES public.feed_sessions(id) ON DELETE SET NULL,
  session_item_id bigint REFERENCES public.feed_session_items(id) ON DELETE SET NULL,
  viewer_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_key_hash text,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
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
      'report'
    )
  ),
  source_surface text NOT NULL,
  position integer CHECK (position IS NULL OR position >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  progress double precision CHECK (
    progress IS NULL
    OR (
      progress >= 0.0::double precision
      AND progress <= 1.0::double precision
      AND progress <> 'NaN'::double precision
    )
  ),
  event_value double precision CHECK (
    event_value IS NULL
    OR (
      event_value >= 0
      AND event_value < 'Infinity'::double precision
      AND event_value <> 'NaN'::double precision
    )
  ),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(properties) = 'object'),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_events_viewer_check
    CHECK (
      (viewer_user_id IS NOT NULL AND anonymous_key_hash IS NULL)
      OR (
        viewer_user_id IS NULL
        AND char_length(anonymous_key_hash) BETWEEN 32 AND 128
      )
    ),
  CONSTRAINT feed_events_client_event_id_length_check
    CHECK (char_length(btrim(client_event_id)) BETWEEN 1 AND 128),
  CONSTRAINT feed_events_source_surface_length_check
    CHECK (char_length(btrim(source_surface)) BETWEEN 1 AND 80),
  CONSTRAINT feed_events_clock_skew_check
    CHECK (occurred_at <= received_at + interval '10 minutes')
);

CREATE INDEX IF NOT EXISTS feed_events_post_occurred_idx
  ON public.feed_events (post_id, occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS feed_events_user_occurred_idx
  ON public.feed_events (viewer_user_id, occurred_at DESC, id DESC)
  WHERE viewer_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_events_session_occurred_idx
  ON public.feed_events (session_id, occurred_at DESC, id DESC)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS feed_events_item_idx
  ON public.feed_events (session_item_id)
  WHERE session_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS feed_events_session_item_type_unique_idx
  ON public.feed_events (session_item_id, event_type)
  WHERE session_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS feed_events_user_post_signal_unique_idx
  ON public.feed_events (viewer_user_id, post_id, event_type)
  WHERE viewer_user_id IS NOT NULL
    AND event_type IN ('save', 'unsave', 'not_interested');

CREATE UNIQUE INDEX IF NOT EXISTS feed_events_user_creator_hide_unique_idx
  ON public.feed_events (viewer_user_id, creator_user_id, event_type)
  WHERE viewer_user_id IS NOT NULL
    AND event_type = 'hide_creator';

CREATE INDEX IF NOT EXISTS feed_events_type_received_idx
  ON public.feed_events (event_type, received_at DESC);

CREATE INDEX IF NOT EXISTS feed_events_received_idx
  ON public.feed_events (received_at);

CREATE TABLE IF NOT EXISTS public.post_feed_stats (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  window_key text NOT NULL CHECK (window_key IN ('24h', '7d', '30d')),
  impression_count bigint NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
  unique_viewer_count bigint NOT NULL DEFAULT 0 CHECK (unique_viewer_count >= 0),
  open_count bigint NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  dwell_ms bigint NOT NULL DEFAULT 0 CHECK (dwell_ms >= 0),
  media_progress_count bigint NOT NULL DEFAULT 0 CHECK (media_progress_count >= 0),
  quick_skip_count bigint NOT NULL DEFAULT 0 CHECK (quick_skip_count >= 0),
  save_count bigint NOT NULL DEFAULT 0 CHECK (save_count >= 0),
  share_count bigint NOT NULL DEFAULT 0 CHECK (share_count >= 0),
  follow_count bigint NOT NULL DEFAULT 0 CHECK (follow_count >= 0),
  remix_start_count bigint NOT NULL DEFAULT 0 CHECK (remix_start_count >= 0),
  remix_complete_count bigint NOT NULL DEFAULT 0 CHECK (remix_complete_count >= 0),
  resource_open_count bigint NOT NULL DEFAULT 0 CHECK (resource_open_count >= 0),
  purchase_count bigint NOT NULL DEFAULT 0 CHECK (purchase_count >= 0),
  not_interested_count bigint NOT NULL DEFAULT 0 CHECK (not_interested_count >= 0),
  hide_creator_count bigint NOT NULL DEFAULT 0 CHECK (hide_creator_count >= 0),
  report_count bigint NOT NULL DEFAULT 0 CHECK (report_count >= 0),
  usefulness_score double precision NOT NULL DEFAULT 0
    CHECK (
      usefulness_score BETWEEN 0 AND 1
      AND usefulness_score <> 'NaN'::double precision
    ),
  quick_skip_rate double precision NOT NULL DEFAULT 0
    CHECK (
      quick_skip_rate BETWEEN 0 AND 1
      AND quick_skip_rate <> 'NaN'::double precision
    ),
  negative_feedback_rate double precision NOT NULL DEFAULT 0
    CHECK (
      negative_feedback_rate BETWEEN 0 AND 1
      AND negative_feedback_rate <> 'NaN'::double precision
    ),
  last_event_at timestamptz,
  last_event_received_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (post_id, window_key)
);

CREATE INDEX IF NOT EXISTS post_feed_stats_window_usefulness_idx
  ON public.post_feed_stats (window_key, usefulness_score DESC, post_id);

CREATE INDEX IF NOT EXISTS post_feed_stats_window_impressions_idx
  ON public.post_feed_stats (window_key, impression_count, post_id);

CREATE INDEX IF NOT EXISTS post_feed_stats_last_event_received_idx
  ON public.post_feed_stats (last_event_received_at)
  WHERE last_event_received_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.user_interest_weights (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dimension_type text NOT NULL CHECK (
    dimension_type IN ('category', 'creator', 'source_tool', 'media_type', 'resource_kind')
  ),
  dimension_value text NOT NULL,
  weight double precision NOT NULL DEFAULT 0
    CHECK (weight BETWEEN -20 AND 20 AND weight <> 'NaN'::double precision),
  positive_score double precision NOT NULL DEFAULT 0
    CHECK (
      positive_score >= 0
      AND positive_score < 'Infinity'::double precision
      AND positive_score <> 'NaN'::double precision
    ),
  negative_score double precision NOT NULL DEFAULT 0
    CHECK (
      negative_score >= 0
      AND negative_score < 'Infinity'::double precision
      AND negative_score <> 'NaN'::double precision
    ),
  positive_event_count bigint NOT NULL DEFAULT 0 CHECK (positive_event_count >= 0),
  negative_event_count bigint NOT NULL DEFAULT 0 CHECK (negative_event_count >= 0),
  last_event_at timestamptz NOT NULL,
  last_event_received_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT user_interest_weights_dimension_value_check
    CHECK (char_length(dimension_value) BETWEEN 1 AND 160),
  PRIMARY KEY (user_id, dimension_type, dimension_value)
);

CREATE INDEX IF NOT EXISTS user_interest_weights_positive_idx
  ON public.user_interest_weights (user_id, dimension_type, weight DESC, dimension_value)
  WHERE weight > 0;

CREATE INDEX IF NOT EXISTS user_interest_weights_refresh_idx
  ON public.user_interest_weights (updated_at, user_id);

CREATE TABLE IF NOT EXISTS public.feed_user_post_feedback (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  feedback_type text NOT NULL DEFAULT 'not_interested'
    CHECK (feedback_type = 'not_interested'),
  is_active boolean NOT NULL DEFAULT true,
  reason text,
  first_recorded_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX IF NOT EXISTS feed_user_post_feedback_active_post_idx
  ON public.feed_user_post_feedback (post_id, user_id)
  WHERE is_active = true;

CREATE TABLE IF NOT EXISTS public.feed_user_creator_feedback (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  creator_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feedback_type text NOT NULL DEFAULT 'hide_creator'
    CHECK (feedback_type = 'hide_creator'),
  is_active boolean NOT NULL DEFAULT true,
  reason text,
  first_recorded_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT feed_user_creator_feedback_not_self_check CHECK (user_id <> creator_user_id),
  PRIMARY KEY (user_id, creator_user_id)
);

CREATE INDEX IF NOT EXISTS feed_user_creator_feedback_active_creator_idx
  ON public.feed_user_creator_feedback (creator_user_id, user_id)
  WHERE is_active = true;

-- pgvector is available on hosted Supabase projects, but can be absent from a
-- self-hosted or minimal local Postgres image. Keep the core migration usable in
-- that case and create the semantic-search table only when the extension can be
-- enabled successfully.
DO $feed_vector$
DECLARE
  v_vector_type text;
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
    BEGIN
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
    EXCEPTION
      WHEN insufficient_privilege OR undefined_file OR invalid_schema_name THEN
        RAISE NOTICE 'pgvector is unavailable; skipping post_content_embeddings';
    END;
  END IF;

  SELECT format('%I.%I', n.nspname, t.typname)
  INTO v_vector_type
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
    RAISE NOTICE 'pgvector is unavailable; semantic candidates will use metadata signals only';
    RETURN;
  END IF;

  EXECUTE format($sql$
    CREATE TABLE IF NOT EXISTS public.post_content_embeddings (
      post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
      embedding_model text NOT NULL,
      embedding_dimensions integer NOT NULL DEFAULT 1536
        CHECK (embedding_dimensions = 1536),
      content_hash text NOT NULL,
      embedding %s(1536) NOT NULL,
      embedded_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
      updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
      CONSTRAINT post_content_embeddings_model_length_check
        CHECK (char_length(embedding_model) BETWEEN 1 AND 160),
      CONSTRAINT post_content_embeddings_hash_length_check
        CHECK (char_length(content_hash) BETWEEN 32 AND 128)
    )
  $sql$, v_vector_type);

  EXECUTE 'ALTER TABLE public.post_content_embeddings ENABLE ROW LEVEL SECURITY';
  EXECUTE 'REVOKE ALL ON TABLE public.post_content_embeddings FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_content_embeddings TO service_role';
  EXECUTE 'DROP POLICY IF EXISTS "No client access to post_content_embeddings" ON public.post_content_embeddings';
  EXECUTE $policy$
    CREATE POLICY "No client access to post_content_embeddings"
      ON public.post_content_embeddings FOR ALL TO anon, authenticated
      USING (false)
      WITH CHECK (false)
  $policy$;

  BEGIN
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS post_content_embeddings_embedding_hnsw_idx '
      || 'ON public.post_content_embeddings USING hnsw (embedding %I.vector_cosine_ops)',
      split_part(v_vector_type, '.', 1)
    );
  EXCEPTION
    WHEN undefined_object OR feature_not_supported OR invalid_parameter_value THEN
      RAISE NOTICE 'HNSW indexing is unavailable; post embeddings will use exact cosine search';
  END;

  EXECUTE 'CREATE INDEX IF NOT EXISTS post_content_embeddings_model_updated_idx '
    || 'ON public.post_content_embeddings (embedding_model, updated_at DESC, post_id)';

  EXECUTE 'DROP TRIGGER IF EXISTS post_content_embeddings_set_updated_at '
    || 'ON public.post_content_embeddings';
  EXECUTE 'CREATE TRIGGER post_content_embeddings_set_updated_at '
    || 'BEFORE UPDATE ON public.post_content_embeddings '
    || 'FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column()';

  EXECUTE format($function_sql$
    CREATE OR REPLACE FUNCTION public.match_post_content_embeddings(
      p_query_embedding %s(1536),
      p_embedding_model text,
      p_match_threshold double precision DEFAULT 0.0,
      p_limit integer DEFAULT 100
    )
    RETURNS TABLE (post_id uuid, semantic_similarity double precision)
    LANGUAGE plpgsql
    STABLE
    SECURITY INVOKER
    SET search_path = public, pg_temp
    AS $function_body$
    BEGIN
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
            embeddings.embedding OPERATOR(%I.<=>) p_query_embedding
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
            embeddings.embedding OPERATOR(%I.<=>) p_query_embedding
          )
        ) >= p_match_threshold
      ORDER BY embeddings.embedding OPERATOR(%I.<=>) p_query_embedding
      LIMIT p_limit;
    END;
    $function_body$
  $function_sql$,
    v_vector_type,
    split_part(v_vector_type, '.', 1),
    split_part(v_vector_type, '.', 1),
    split_part(v_vector_type, '.', 1)
  );

  EXECUTE format(
    'REVOKE ALL ON FUNCTION public.match_post_content_embeddings(%s, text, double precision, integer) '
      || 'FROM PUBLIC, anon, authenticated',
    v_vector_type
  );
  EXECUTE format(
    'GRANT EXECUTE ON FUNCTION public.match_post_content_embeddings(%s, text, double precision, integer) '
      || 'TO service_role',
    v_vector_type
  );

  EXECUTE $comment$
    COMMENT ON TABLE public.post_content_embeddings IS
      'Optional backend-owned pgvector embeddings for semantic feed candidate retrieval.'
  $comment$;
END;
$feed_vector$;

DROP TRIGGER IF EXISTS feed_algorithm_versions_set_updated_at
  ON public.feed_algorithm_versions;
CREATE TRIGGER feed_algorithm_versions_set_updated_at
BEFORE UPDATE ON public.feed_algorithm_versions
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS feed_experiments_set_updated_at ON public.feed_experiments;
CREATE TRIGGER feed_experiments_set_updated_at
BEFORE UPDATE ON public.feed_experiments
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS feed_user_post_feedback_set_updated_at
  ON public.feed_user_post_feedback;
CREATE TRIGGER feed_user_post_feedback_set_updated_at
BEFORE UPDATE ON public.feed_user_post_feedback
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

DROP TRIGGER IF EXISTS feed_user_creator_feedback_set_updated_at
  ON public.feed_user_creator_feedback;
CREATE TRIGGER feed_user_creator_feedback_set_updated_at
BEFORE UPDATE ON public.feed_user_creator_feedback
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at_column();

ALTER TABLE public.feed_algorithm_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_experiment_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_experiment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_session_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_feed_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_interest_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_user_post_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feed_user_creator_feedback ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.feed_algorithm_versions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_experiments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_experiment_variants FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_experiment_assignments FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_sessions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_session_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.post_feed_stats FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.user_interest_weights FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_user_post_feedback FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.feed_user_creator_feedback FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_algorithm_versions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_experiments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_experiment_variants TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_experiment_assignments TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_sessions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_session_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_feed_stats TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_interest_weights TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_user_post_feedback TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.feed_user_creator_feedback TO service_role;

-- The invoker-secured candidate, validation, aggregation, and semantic-search
-- functions below read these existing application tables. BYPASSRLS does not
-- bypass ordinary table privileges, so grant the backend role the least access
-- those functions and their TypeScript callers require.
GRANT SELECT ON TABLE public.posts TO service_role;
GRANT SELECT ON TABLE public.follows TO service_role;
GRANT SELECT ON TABLE public.post_saves TO service_role;

GRANT USAGE, SELECT ON SEQUENCE public.feed_experiment_assignments_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.feed_session_items_id_seq TO service_role;

CREATE POLICY "No client access to feed_algorithm_versions"
  ON public.feed_algorithm_versions FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_experiments"
  ON public.feed_experiments FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_experiment_variants"
  ON public.feed_experiment_variants FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_experiment_assignments"
  ON public.feed_experiment_assignments FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_sessions"
  ON public.feed_sessions FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_session_items"
  ON public.feed_session_items FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_events"
  ON public.feed_events FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to post_feed_stats"
  ON public.post_feed_stats FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to user_interest_weights"
  ON public.user_interest_weights FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_user_post_feedback"
  ON public.feed_user_post_feedback FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);
CREATE POLICY "No client access to feed_user_creator_feedback"
  ON public.feed_user_creator_feedback FOR ALL TO anon, authenticated
  USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.get_ranked_feed_candidates(
  p_viewer_user_id uuid DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 300,
  p_as_of timestamptz DEFAULT timezone('utc'::text, now())
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
  candidate_source text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Feed candidate limit must be between 1 and 500';
  END IF;

  IF p_as_of IS NULL THEN
    RAISE EXCEPTION 'Feed candidate timestamp is required';
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    SELECT
      p.id,
      p.user_id AS creator_id,
      p.category,
      p.post_format,
      p.source_tool_slug,
      p.created_at
    FROM public.posts AS p
    WHERE p.visibility = 'public'
      AND p.archived_at IS NULL
      AND p.review_status = 'visible'
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
  ),
  following_pool AS (
    SELECT e.id AS post_id, 'following'::text AS source, 1 AS source_priority
    FROM eligible AS e
    JOIN public.follows AS f
      ON f.following_id = e.creator_id
     AND f.follower_id = p_viewer_user_id
    WHERE p_viewer_user_id IS NOT NULL
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT LEAST(p_limit, 100)
  ),
  interest_pool AS (
    SELECT e.id AS post_id, 'interest'::text AS source, 2 AS source_priority
    FROM eligible AS e
    WHERE p_viewer_user_id IS NOT NULL
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
    ORDER BY (
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
    LIMIT LEAST(p_limit, 150)
  ),
  trending_pool AS (
    SELECT e.id AS post_id, 'trending'::text AS source, 3 AS source_priority
    FROM eligible AS e
    JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id
     AND stats.window_key = '24h'
    ORDER BY stats.usefulness_score DESC,
      stats.impression_count DESC,
      e.created_at DESC,
      e.id DESC
    LIMIT LEAST(p_limit, 100)
  ),
  recent_pool AS (
    SELECT e.id AS post_id, 'recent'::text AS source, 4 AS source_priority
    FROM eligible AS e
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT LEAST(p_limit, 150)
  ),
  exploration_pool AS (
    SELECT e.id AS post_id, 'exploration'::text AS source, 5 AS source_priority
    FROM eligible AS e
    LEFT JOIN public.post_feed_stats AS stats
      ON stats.post_id = e.id
     AND stats.window_key = '30d'
    ORDER BY coalesce(stats.impression_count, 0) ASC,
      e.created_at DESC,
      e.id DESC
    LIMIT LEAST(p_limit, 100)
  ),
  pooled AS (
    SELECT * FROM following_pool
    UNION ALL
    SELECT * FROM interest_pool
    UNION ALL
    SELECT * FROM trending_pool
    UNION ALL
    SELECT * FROM recent_pool
    UNION ALL
    SELECT * FROM exploration_pool
  ),
  deduplicated AS (
    SELECT DISTINCT ON (pool.post_id)
      pool.post_id,
      pool.source
    FROM pooled AS pool
    ORDER BY pool.post_id, pool.source_priority
  ),
  components AS (
    SELECT
      e.id AS post_id,
      least(1.0::double precision, greatest(0.0::double precision, coalesce(interest.value, 0)))
        AS interest_match,
      least(1.0::double precision, greatest(0.0::double precision, coalesce(affinity.value, 0)))
        AS creator_affinity,
      coalesce(stats_7d.usefulness_score, 0.08::double precision)
        AS smoothed_usefulness,
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
        greatest(
          0.0::double precision,
          coalesce(stats_24h.usefulness_score, 0.0::double precision)
            * (
              ln(1.0::double precision + coalesce(stats_24h.impression_count, 0)::double precision)
              / ln(101.0::double precision)
            )
        )
      ) AS relevant_trend,
      1.0::double precision
        / sqrt(1.0::double precision + coalesce(stats_30d.impression_count, 0)::double precision / 20.0::double precision)
        AS exploration_bonus,
      least(
        1.0::double precision,
        (coalesce(stats_7d.quick_skip_count, 0)::double precision + 1.25::double precision)
          / (coalesce(stats_7d.impression_count, 0)::double precision + 5.0::double precision)
      ) AS quick_skip_risk,
      least(
        1.0::double precision,
        (
          coalesce(stats_7d.not_interested_count, 0)::double precision
          + coalesce(stats_7d.hide_creator_count, 0)::double precision
          + (2.0::double precision * coalesce(stats_7d.report_count, 0)::double precision)
          + 0.2::double precision
        ) / (coalesce(stats_7d.impression_count, 0)::double precision + 20.0::double precision)
      ) AS negative_feedback_risk,
      d.source AS candidate_source
    FROM deduplicated AS d
    JOIN eligible AS e ON e.id = d.post_id
    LEFT JOIN public.post_feed_stats AS stats_24h
      ON stats_24h.post_id = e.id AND stats_24h.window_key = '24h'
    LEFT JOIN public.post_feed_stats AS stats_7d
      ON stats_7d.post_id = e.id AND stats_7d.window_key = '7d'
    LEFT JOIN public.post_feed_stats AS stats_30d
      ON stats_30d.post_id = e.id AND stats_30d.window_key = '30d'
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
        )
    ) AS interest ON true
    LEFT JOIN LATERAL (
      SELECT least(
        1.0::double precision,
        (
          CASE WHEN EXISTS (
            SELECT 1
            FROM public.follows AS f
            WHERE f.follower_id = p_viewer_user_id
              AND f.following_id = e.creator_id
          ) THEN 0.75::double precision ELSE 0.0::double precision END
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
    ) AS affinity ON true
  )
  SELECT
    c.post_id,
    c.interest_match,
    c.creator_affinity,
    c.smoothed_usefulness,
    c.freshness,
    c.relevant_trend,
    c.exploration_bonus,
    c.quick_skip_risk,
    c.negative_feedback_risk,
    c.candidate_source
  FROM components AS c
  ORDER BY (
      0.35::double precision * c.interest_match
      + 0.15::double precision * c.creator_affinity
      + 0.15::double precision * c.smoothed_usefulness
      + 0.15::double precision * c.freshness
      + 0.10::double precision * c.relevant_trend
      + 0.10::double precision * c.exploration_bonus
      - 0.35::double precision * c.quick_skip_risk
      - 0.80::double precision * c.negative_feedback_risk
    ) DESC,
    c.post_id DESC
  LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_feed_event_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_item_session_id uuid;
  v_item_post_id uuid;
  v_item_position integer;
  v_session_user_id uuid;
  v_session_anonymous_key_hash text;
  v_creator_user_id uuid;
BEGIN
  SELECT posts.user_id
  INTO v_creator_user_id
  FROM public.posts AS posts
  WHERE posts.id = NEW.post_id;

  IF NOT FOUND OR v_creator_user_id IS DISTINCT FROM NEW.creator_user_id THEN
    RAISE EXCEPTION 'Feed event creator does not match the post owner'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.session_item_id IS NOT NULL THEN
    SELECT item.session_id, item.post_id, item.position
    INTO v_item_session_id, v_item_post_id, v_item_position
    FROM public.feed_session_items AS item
    WHERE item.id = NEW.session_item_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Feed session item was not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_item_post_id IS DISTINCT FROM NEW.post_id THEN
      RAISE EXCEPTION 'Feed event post does not match the session item'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.session_id IS NULL THEN
      NEW.session_id := v_item_session_id;
    ELSIF NEW.session_id IS DISTINCT FROM v_item_session_id THEN
      RAISE EXCEPTION 'Feed event session does not match the session item'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.position IS NULL THEN
      NEW.position := v_item_position;
    ELSIF NEW.position IS DISTINCT FROM v_item_position THEN
      RAISE EXCEPTION 'Feed event position does not match the session item'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    SELECT session.viewer_user_id, session.anonymous_key_hash
    INTO v_session_user_id, v_session_anonymous_key_hash
    FROM public.feed_sessions AS session
    WHERE session.id = NEW.session_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Feed session was not found'
        USING ERRCODE = '23503';
    END IF;

    IF v_session_user_id IS DISTINCT FROM NEW.viewer_user_id THEN
      RAISE EXCEPTION 'Feed event user does not match the session viewer'
        USING ERRCODE = '23514';
    END IF;

    IF v_session_user_id IS NULL
      AND v_session_anonymous_key_hash IS DISTINCT FROM NEW.anonymous_key_hash
    THEN
      RAISE EXCEPTION 'Feed event anonymous viewer does not match the session viewer'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS feed_events_validate_context ON public.feed_events;
CREATE TRIGGER feed_events_validate_context
BEFORE INSERT OR UPDATE OF session_id, session_item_id, viewer_user_id,
  anonymous_key_hash, post_id, creator_user_id, position
ON public.feed_events
FOR EACH ROW EXECUTE FUNCTION public.validate_feed_event_context();

CREATE OR REPLACE FUNCTION public.set_feed_post_feedback(
  p_user_id uuid,
  p_post_id uuid,
  p_is_active boolean DEFAULT true,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.feed_user_post_feedback (
    user_id,
    post_id,
    feedback_type,
    is_active,
    reason
  )
  VALUES (
    p_user_id,
    p_post_id,
    'not_interested',
    coalesce(p_is_active, true),
    nullif(left(btrim(p_reason), 500), '')
  )
  ON CONFLICT (user_id, post_id) DO UPDATE
  SET is_active = EXCLUDED.is_active,
      reason = EXCLUDED.reason,
      updated_at = timezone('utc'::text, now());
$$;

CREATE OR REPLACE FUNCTION public.set_feed_creator_feedback(
  p_user_id uuid,
  p_creator_user_id uuid,
  p_is_active boolean DEFAULT true,
  p_reason text DEFAULT NULL
)
RETURNS void
LANGUAGE sql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.feed_user_creator_feedback (
    user_id,
    creator_user_id,
    feedback_type,
    is_active,
    reason
  )
  VALUES (
    p_user_id,
    p_creator_user_id,
    'hide_creator',
    coalesce(p_is_active, true),
    nullif(left(btrim(p_reason), 500), '')
  )
  ON CONFLICT (user_id, creator_user_id) DO UPDATE
  SET is_active = EXCLUDED.is_active,
      reason = EXCLUDED.reason,
      updated_at = timezone('utc'::text, now());
$$;

CREATE OR REPLACE FUNCTION public.prune_feed_personalization_data(
  p_as_of timestamptz DEFAULT timezone('utc'::text, now()),
  p_event_retention_days integer DEFAULT 90,
  p_session_retention_days integer DEFAULT 2,
  p_limit integer DEFAULT 5000
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

  WITH doomed AS (
    SELECT sessions.id
    FROM public.feed_sessions AS sessions
    WHERE sessions.expires_at < p_as_of - make_interval(days => p_session_retention_days)
    ORDER BY sessions.expires_at ASC, sessions.id
    LIMIT p_limit
  ), deleted AS (
    DELETE FROM public.feed_sessions AS sessions
    USING doomed
    WHERE sessions.id = doomed.id
    RETURNING 1
  )
  SELECT count(*) INTO v_sessions_deleted FROM deleted;

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

  RETURN jsonb_build_object(
    'skipped', false,
    'events_deleted', v_events_deleted,
    'sessions_deleted', v_sessions_deleted,
    'assignments_deleted', v_assignments_deleted,
    'interests_deleted', v_interests_deleted,
    'post_feedback_deleted', v_post_feedback_deleted,
    'creator_feedback_deleted', v_creator_feedback_deleted
  );
END;
$$;

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
          AND recent_event.session_item_id IS NOT NULL
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
     AND events.session_item_id IS NOT NULL
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
      events.viewer_user_id AS user_id,
      min(interests.updated_at) AS last_refresh
    FROM public.feed_events AS events
    LEFT JOIN public.user_interest_weights AS interests
      ON interests.user_id = events.viewer_user_id
    WHERE events.viewer_user_id IS NOT NULL
      AND events.session_item_id IS NOT NULL
      AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
      AND events.occurred_at <= p_as_of
    GROUP BY events.viewer_user_id
    ORDER BY min(interests.updated_at) ASC NULLS FIRST, events.viewer_user_id
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
    WHERE events.viewer_user_id = ANY(v_user_ids)
      AND events.session_item_id IS NOT NULL
      AND events.occurred_at >= p_as_of - make_interval(days => p_lookback_days)
      AND events.occurred_at <= p_as_of
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

  RETURN cardinality(v_user_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.get_ranked_feed_candidates(uuid, text, integer, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_feed_event_context()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_feed_post_feedback(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_feed_creator_feedback(uuid, uuid, boolean, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_feed_personalization_data(timestamptz, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_ranked_feed_candidates(uuid, text, integer, timestamptz)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_feed_event_context()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_feed_post_feedback(uuid, uuid, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_feed_creator_feedback(uuid, uuid, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_feed_personalization_data(timestamptz, integer, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer)
  TO service_role;

COMMENT ON TABLE public.feed_algorithm_versions IS
  'Backend-owned immutable feed ranking configuration versions and rollout state.';
COMMENT ON TABLE public.feed_experiments IS
  'Backend-owned feed experiment definitions; assignment writes are deterministic in the API layer.';
COMMENT ON TABLE public.feed_experiment_variants IS
  'Backend-owned experiment variants mapped to immutable algorithm versions.';
COMMENT ON TABLE public.feed_experiment_assignments IS
  'Backend-owned sticky experiment assignments keyed by user id or a one-way anonymous key hash.';
COMMENT ON TABLE public.feed_sessions IS
  'Backend-owned ranked feed sessions used for stable pagination and reproducible ranking.';
COMMENT ON TABLE public.feed_session_items IS
  'Backend-owned ordered feed deliveries with explainable component scores.';
COMMENT ON TABLE public.feed_events IS
  'Backend-owned, idempotent qualified impressions and feed interaction telemetry.';
COMMENT ON TABLE public.post_feed_stats IS
  'Backend-owned 24-hour, 7-day, and 30-day aggregates used by the feed ranker.';
COMMENT ON TABLE public.user_interest_weights IS
  'Backend-owned, time-decayed user affinities derived from feed interactions.';
COMMENT ON TABLE public.feed_user_post_feedback IS
  'Backend-owned active not-interested exclusions for individual posts.';
COMMENT ON TABLE public.feed_user_creator_feedback IS
  'Backend-owned active hide-creator exclusions.';

COMMENT ON FUNCTION public.get_ranked_feed_candidates(uuid, text, integer, timestamptz) IS
  'Retrieves bounded multi-pool candidates and explainable score components; service role only.';
COMMENT ON FUNCTION public.refresh_post_feed_stats(timestamptz, integer) IS
  'Idempotently refreshes Bayesian-smoothed feed stats for a bounded rotating post batch.';
COMMENT ON FUNCTION public.refresh_user_interest_weights(timestamptz, integer, integer, integer) IS
  'Rebuilds bounded user-interest batches with exponential time decay.';
COMMENT ON FUNCTION public.prune_feed_personalization_data(timestamptz, integer, integer, integer) IS
  'Deletes bounded batches of expired feed telemetry, sessions, assignments, and inactive state.';

-- The repository schedules maintenance through its existing backend job routes.
-- Do not enable pg_cron here; call the refresh and prune functions with service_role.
