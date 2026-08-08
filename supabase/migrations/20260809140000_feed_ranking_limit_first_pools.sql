-- F5: give every ranking pool its own bounded, index-driven row source.
--
-- The previous shape opened with `eligible AS MATERIALIZED` over every public
-- visible post and applied each pool's LIMIT afterwards. Measured against a
-- 50,000-post catalog that costs **111,150 buffers and spills to temp** to
-- return 60 candidates; the same call against production's 34 posts costs 269.
-- The cost is linear in catalog size, which is the finding this migration
-- closes.
--
-- Dropping the MATERIALIZED keyword alone was measured and changes *nothing*
-- (111,150 buffers, identical plan). Postgres only auto-inlines a CTE
-- referenced once, and `eligible` is referenced six times, so the keyword was
-- documenting what would have happened regardless. The fix has to be
-- structural: each pool now selects from `posts` directly, with the shared
-- eligibility predicates repeated inline, so the planner can walk that pool's
-- own index and stop at its LIMIT.
--
-- Every index this relies on already existed:
--   recent      -> posts_public_review_recent_idx (visibility, review_status, created_at DESC, id DESC)
--   following   -> posts_public_owner_profile_stats_idx (user_id, created_at DESC, id DESC)
--   interest    -> posts_public_category_recent_idx / posts_public_tool_recent_idx / the owner index
--   trending    -> post_feed_stats_window_usefulness_idx (window_key, usefulness_score DESC, post_id)
--   exploration -> post_feed_stats_window_impressions_idx (window_key, impression_count, post_id)
--
-- The eligibility predicates are duplicated per pool rather than hoisted. That
-- is the point: a shared CTE is exactly what forces materialisation.
--
-- The viewer's feedback lists are the one thing that *is* still materialised,
-- and deliberately. Left as correlated NOT EXISTS subqueries they were 12,500
-- index probes inside the following pool alone, evaluated before any LIMIT
-- could apply, and they forced a bitmap scan that could not stop early.
-- Materialising them is safe where materialising the catalog was not, because
-- their size is bounded by one viewer's behaviour rather than by how many posts
-- exist. Materialise the small thing, not the big one.
--
-- Scoring is reproduced verbatim from 20260711064036. A diff against that file
-- should show changed row sources and nothing else, so ranking output cannot
-- drift through this rewrite. Verified against a seeded catalog: the personalised,
-- anonymous and category-filtered calls each return the same 60 posts in the
-- same positions with the same candidate_source as the previous implementation.
--
-- Measured, seeded locally (execution buffers for one 60-candidate page):
--
--             |  50,000 posts            |  200,000 posts
--   before    |  111,150, 138 ms, spills |  445,336, 587 ms, spills + disk reads
--   after     |    5,669, 6.9 ms         |    6,171, 8.2 ms
--
-- +8.9% for a 4x catalog is the property this item asks for: cost proportional
-- to page size rather than to catalog size. Note this is invisible in
-- production's pg_stat_statements, where ~83% of the per-call figure is
-- planning -- see the F5 section of docs/scaling-audit-2026-08-08.md.
--
-- NOT COVERED: get_ranked_feed_candidates_v2 (20260728181000) has the same
-- unbounded CTE. It is still seeded `shadow` and serves no traffic, so it is
-- left alone here rather than rewritten blind -- but it is a **gate before
-- promoting v2**, alongside F13's seed-1,000-creators disjointness check.

-- The one index this work actually needed. The following pool wants "newest
-- eligible posts by this creator", and every existing owner-scoped index stops
-- short: posts_owner_archived_created_idx omits `visibility`, and
-- posts_public_owner_profile_stats_idx omits `review_status`. Missing either
-- one leaves a filter the index cannot satisfy, so the planner falls back to a
-- bitmap scan, which is unordered and therefore cannot stop at the LIMIT --
-- measured as a top-N heapsort over every one of a creator's posts.
CREATE INDEX IF NOT EXISTS posts_public_visible_owner_recent_idx
  ON public.posts (user_id, created_at DESC, id DESC)
  WHERE visibility = 'public'
    AND archived_at IS NULL
    AND review_status = 'visible';

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
  WITH
  viewer_hidden_posts AS MATERIALIZED (
    -- Materialising *this* is the point. The old shape materialised the
    -- catalog; this materialises the viewer's own suppression list, which is
    -- bounded by their behaviour rather than by how many posts exist. Left as a
    -- correlated NOT EXISTS it became 12,500 index probes inside one pool,
    -- evaluated before any LIMIT could apply, and it forced a bitmap scan that
    -- could not stop early.
    SELECT post_feedback.post_id
    FROM public.feed_user_post_feedback AS post_feedback
    WHERE p_viewer_user_id IS NOT NULL
      AND post_feedback.user_id = p_viewer_user_id
      AND post_feedback.is_active = true
  ),
  viewer_hidden_creators AS MATERIALIZED (
    SELECT creator_feedback.creator_user_id
    FROM public.feed_user_creator_feedback AS creator_feedback
    WHERE p_viewer_user_id IS NOT NULL
      AND creator_feedback.user_id = p_viewer_user_id
      AND creator_feedback.is_active = true
  ),
  following_pool AS (
    -- Bounded by the viewer's follow count, not by the catalog: one index scan
    -- per followed creator, each stopping at the pool limit.
    SELECT e.id AS post_id, 'following'::text AS source, 1 AS source_priority
    FROM public.follows AS f
    JOIN LATERAL (
      SELECT p.id, p.created_at
      FROM public.posts AS p
      WHERE p.user_id = f.following_id
        AND p.visibility = 'public'
        AND p.archived_at IS NULL
        AND p.review_status = 'visible'
        AND (p_category IS NULL OR p.category = p_category)
        AND NOT EXISTS (SELECT 1 FROM viewer_hidden_posts AS h WHERE h.post_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM viewer_hidden_creators AS h WHERE h.creator_user_id = p.user_id)
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT LEAST(p_limit, 100)
    ) AS e ON true
    WHERE p_viewer_user_id IS NOT NULL
      AND f.follower_id = p_viewer_user_id
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT LEAST(p_limit, 100)
  ),
  interest_pool AS (
    -- Driven from the viewer's interest weights rather than from the catalog.
    -- The old form scanned every eligible post and computed max(weight) per row
    -- to sort by it; this walks one bounded index scan per weight and keeps the
    -- weight alongside, which produces the same ordering key without the scan.
    SELECT ranked.post_id, 'interest'::text AS source, 2 AS source_priority
    FROM (
      SELECT
        e.id AS post_id,
        max(w.weight) AS match_weight,
        max(e.created_at) AS created_at
      FROM public.user_interest_weights AS w
      JOIN LATERAL (
        SELECT p.id, p.created_at
        FROM public.posts AS p
        WHERE p.visibility = 'public'
          AND p.archived_at IS NULL
          AND p.review_status = 'visible'
          AND (p_category IS NULL OR p.category = p_category)
          AND (
            (w.dimension_type = 'category' AND p.category = w.dimension_value)
            OR (w.dimension_type = 'media_type' AND w.dimension_value IN (p.category, p.post_format))
            OR (w.dimension_type = 'source_tool' AND p.source_tool_slug = w.dimension_value)
            OR (w.dimension_type = 'creator' AND w.dimension_value = p.user_id::text)
          )
          AND NOT EXISTS (SELECT 1 FROM viewer_hidden_posts AS h WHERE h.post_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM viewer_hidden_creators AS h WHERE h.creator_user_id = p.user_id)
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT LEAST(p_limit, 150)
      ) AS e ON true
      WHERE p_viewer_user_id IS NOT NULL
        AND w.user_id = p_viewer_user_id
        AND w.weight > 0
      GROUP BY e.id
    ) AS ranked
    ORDER BY ranked.match_weight DESC NULLS LAST, ranked.created_at DESC, ranked.post_id DESC
    LIMIT LEAST(p_limit, 150)
  ),
  trending_pool AS (
    -- Driven from the stats index in usefulness order, so the scan stops as
    -- soon as the pool is full instead of ranking the whole catalog.
    SELECT p.id AS post_id, 'trending'::text AS source, 3 AS source_priority
    FROM public.post_feed_stats AS stats
    JOIN public.posts AS p ON p.id = stats.post_id
    WHERE stats.window_key = '24h'
      AND p.visibility = 'public'
      AND p.archived_at IS NULL
      AND p.review_status = 'visible'
      AND (p_category IS NULL OR p.category = p_category)
      AND NOT EXISTS (SELECT 1 FROM viewer_hidden_posts AS h WHERE h.post_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM viewer_hidden_creators AS h WHERE h.creator_user_id = p.user_id)
    ORDER BY stats.usefulness_score DESC,
      stats.impression_count DESC,
      p.created_at DESC,
      p.id DESC
    LIMIT LEAST(p_limit, 100)
  ),
  recent_pool AS (
    SELECT p.id AS post_id, 'recent'::text AS source, 4 AS source_priority
    FROM public.posts AS p
    WHERE p.visibility = 'public'
      AND p.archived_at IS NULL
      AND p.review_status = 'visible'
      AND (p_category IS NULL OR p.category = p_category)
      AND NOT EXISTS (SELECT 1 FROM viewer_hidden_posts AS h WHERE h.post_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM viewer_hidden_creators AS h WHERE h.creator_user_id = p.user_id)
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT LEAST(p_limit, 150)
  ),
  exploration_pool AS (
    -- Least-seen first, driven from the impressions index. Posts with no stats
    -- row are the least-seen of all, so they are unioned in rather than lost to
    -- the inner join the index scan requires.
    SELECT sub.post_id, 'exploration'::text AS source, 5 AS source_priority
    FROM (
      (
      SELECT p.id AS post_id, coalesce(stats.impression_count, 0) AS impression_count,
             p.created_at, p.id AS tiebreak_id
      FROM public.post_feed_stats AS stats
      JOIN public.posts AS p ON p.id = stats.post_id
      WHERE stats.window_key = '30d'
        AND p.visibility = 'public'
        AND p.archived_at IS NULL
        AND p.review_status = 'visible'
        AND (p_category IS NULL OR p.category = p_category)
        AND NOT EXISTS (SELECT 1 FROM viewer_hidden_posts AS h WHERE h.post_id = p.id)
        AND NOT EXISTS (SELECT 1 FROM viewer_hidden_creators AS h WHERE h.creator_user_id = p.user_id)
      ORDER BY stats.impression_count ASC, p.created_at DESC, p.id DESC
      LIMIT LEAST(p_limit, 100)
      )

      UNION ALL

      (
      -- Posts with no 30d stats row are the least-seen of all, and the inner
      -- join above cannot reach them. The anti-join that finds them is bounded
      -- to the newest page of eligible posts rather than run over the catalog:
      -- unbounded it cost 151,808 buffers here to return zero rows, because it
      -- probed the stats index once per post.
      --
      -- The bound is sound rather than merely cheap: a post lacks a stats row
      -- only until `refresh_post_feed_stats` next runs, so the unrated
      -- population is by construction the most recent posts. A post old enough
      -- to fall outside this window and still have no stats row is one the
      -- refresh job has failed on, which is F13's territory and is reported by
      -- the feed-maintenance job rather than papered over by the feed.
      SELECT recent_unrated.id AS post_id, 0 AS impression_count,
             recent_unrated.created_at, recent_unrated.id AS tiebreak_id
      FROM (
        SELECT p.id, p.created_at
        FROM public.posts AS p
        WHERE p.visibility = 'public'
          AND p.archived_at IS NULL
          AND p.review_status = 'visible'
          AND (p_category IS NULL OR p.category = p_category)
          AND NOT EXISTS (SELECT 1 FROM viewer_hidden_posts AS h WHERE h.post_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM viewer_hidden_creators AS h WHERE h.creator_user_id = p.user_id)
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT LEAST(p_limit, 100)
      ) AS recent_unrated
      WHERE NOT EXISTS (
        SELECT 1 FROM public.post_feed_stats AS stats
        WHERE stats.post_id = recent_unrated.id AND stats.window_key = '30d'
      )
      ORDER BY recent_unrated.created_at DESC, recent_unrated.id DESC
      LIMIT LEAST(p_limit, 100)
      )
    ) AS sub
    ORDER BY sub.impression_count ASC, sub.created_at DESC, sub.tiebreak_id DESC
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
  candidate_posts AS (
    -- Replaces the old `eligible` CTE in the scoring stage. Eligibility was
    -- already applied by whichever pool produced the row, so this is a
    -- primary-key lookup over at most a few hundred ids.
    SELECT
      p.id,
      p.user_id AS creator_id,
      p.category,
      p.post_format,
      p.source_tool_slug,
      p.created_at
    FROM public.posts AS p
    JOIN deduplicated AS d ON d.post_id = p.id
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
    JOIN candidate_posts AS e ON e.id = d.post_id
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
