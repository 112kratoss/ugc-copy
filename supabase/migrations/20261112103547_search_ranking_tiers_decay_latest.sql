-- Search ranking (phase 2): one score for posts and one for creators, pages
-- scored at one instant, Latest beside Top, and blocked creators left out
-- before the page is cut.
--
-- Before this file a post's score was a sum with no ceiling on its text part:
-- ts_rank_cd unnormalised grows with every repeat of a word, so a caption that
-- said "lantern glow" thirty times scored 23.6 against 1.85 for a post titled
-- "Lantern glow" (local replay, 2026-11-12), and passed the +10 an exact title
-- earned. Engagement was a lifetime count (at most +0.35), freshness was
-- epoch / 1e11 (a tie-break), and the creators a viewer had blocked, or who
-- had blocked the viewer, were dropped by the app after LIMIT, so a page came
-- back short or empty while more results existed.
--
-- THE RULE. A post's match tier always decides first; inside a tier, how well
-- the text matches, engagement decayed by the post's age, freshness and a
-- follow compete, and together they can never add up to the gap between two
-- tiers.
--
--   tier  what puts a post in it                                        base
--   3     its title is the query                                          30
--   2     its title starts with the query                                 20
--   1     its title, model or tool holds every word of the query          10
--         (the vector's A and C lexemes: title and models are A, tool
--         names are C; the last word may be a prefix), or its first
--         tool's name is the query
--   0     anything else search_public_posts matches: caption or prompt     0
--         words, the query as a run of characters, a near-miss title
--
--   inside a tier (search_post_score holds every number as a named constant):
--     text        3.0 * ts_rank_cd(vector, query, 1 | 32)       0 to 3.0
--     similarity  1.5 * trigram similarity of title or tool      0 to 1.5
--     engagement  2.5 * volume * decay                           0 to 2.5
--                   points = saves + 0.5 * comments + 2 * remixes
--                   volume = min(1, ln(1 + points) / ln(1 + 1000))
--                   decay  = 0.3 + 0.7 * 0.5 ^ (age in days / 30)
--     freshness   1.0 * 0.5 ^ (age in days / 14)                 0 to 1.0
--     follow      0.8 when the viewer follows the creator        0 or 0.8
--                                                         at most 8.8 < 10
--
--   The rank's flags: 1 divides by 1 + log(document length), 32 maps the
--   result to rank / (rank + 1), so a repeated word approaches 1 and never
--   passes it.
--
--   Worked example, the query 'lantern glow' on the pgTAP fixture
--   (supabase/tests/database/search_ranking.test.sql), no viewer, as
--   tier + text + similarity + engagement + freshness:
--     A  titled "Lantern glow", posted 60 days ago, nothing saved
--          30 + 3.0 * 0.655 + 1.5 * 1.000 + 0   + 0.051        = 33.52
--     B  titled "Lantern glow at dusk", today, nothing saved
--          20 + 3.0 * 0.555 + 1.5 * 0.619 + 0   + 1.000        = 23.59
--     C  titled "Paper lantern, soft glow", today, nothing saved
--          10 + 3.0 * 0.455 + 1.5 * 0.542 + 0   + 1.000        = 13.18
--     D  titled "Evening walk", caption "lantern glow" 30 times, today,
--        5,000 saves
--           0 + 3.0 * 0.907 + 1.5 * 0.000 + 2.5 + 1.000        =  6.22
--   D has the best text rank (47.6 unnormalised) and the most saves of the
--   four and stays last: its title, model and tool do not hold the query.
--
-- Engagement is decayed by the post's age, not by each save's: posts carry
-- lifetime counters (save_count, comment_count, remix_count, each kept by its
-- own trigger or RPC) and no dated ones. Of two equally matched posts with
-- the same counts, the one posted last week (decay 0.90) outranks the one
-- posted two months ago (decay 0.48). The floor of 0.3 keeps a year-old post
-- a third of what its saves earned, so the best-known result for a query is
-- not buried by this week's.
--
-- CREATORS, in the same spirit (search_creator_score):
--   40 the handle is the query; 30 the handle starts with it; 20 the display
--   name is the query; 10 the display name starts with it, or the handle and
--   name together hold every word; 0 a bio word or a near-miss spelling.
--   Inside a tier: 2.0 * text rank (1 | 32), 2.0 * the best trigram similarity
--   of handle and name, audience 2.5 * min(1, ln(1 + followers) / ln(1001))
--   (followers counted up to 1,000, where the term is full), activity
--   1.0 * min(1, ln(1 + public posts) / ln(101)), and 1.0 for a creator the
--   viewer follows: at most 8.5.
--
-- PAGES. The post score depends on the clock, so search_public_posts takes
-- the instant a search began (p_as_of) and scores every page of it at that
-- instant; without one it scores at now(). p_sort = 'latest' orders the same
-- matches newest first, keyset on (created_at DESC, post_id) through
-- p_after_created_at. The function now returns each row's created_at for
-- that cursor.
--
-- THE RELEASE WINDOW. Migrations apply before the new app is promoted, and
-- the app live meanwhile calls search_public_posts by name with p_query,
-- p_viewer_user_id, p_after_score, p_after_id and p_limit. The function is
-- dropped and re-created in this transaction with the three new parameters
-- last, each with a default, so that call resolves to it and reads Top at
-- now(); PostgREST sees one function of that name, never two. A cursor issued
-- before this file carries a score on the old scale: its next page is read
-- without error from that score on the new scale, and may repeat or skip
-- posts once. search_public_creators keeps its signature.
--
-- BLOCKS. Both searches leave out, before LIMIT, every creator the viewer has
-- blocked and every creator who has blocked the viewer: the two user_blocks
-- reads of loadBlockedCreatorIds (src/lib/moderation-service.ts), which the
-- app still runs over each page as before.
--
-- What a visitor cannot see still decides nothing: both functions read only
-- the search documents (a post's caption through recipe_post_public_body, a
-- template result's model as 'template-workflow', 20261111224010), the
-- public counters, follows and blocks, and labelled posts stay out. Both stay
-- SECURITY DEFINER with a pinned search path, callable by the service role
-- alone.
--
-- The search log gains a nullable sort column; search_query_report is
-- untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── 1. The scores ──────────────────────────────────────────────────────────
--
-- plpgsql, not sql: a sql function with a SET clause is never inlined and
-- cost 3.3 us a row against 1.1 us here (50,000 calls, local replay); a
-- common word scores thousands of rows.

CREATE FUNCTION public.search_post_score(
  p_title_is_query boolean,
  p_title_starts_with_query boolean,
  p_headline_holds_query boolean,
  p_text_rank double precision,
  p_similarity double precision,
  p_save_count integer,
  p_comment_count integer,
  p_remix_count integer,
  p_age_seconds double precision,
  p_viewer_follows_creator boolean
)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  -- Match tiers. Two tiers are 10 apart; the parts below add up to 8.8 at
  -- most, so nothing inside a tier reaches the next one.
  c_tier_title_is_query CONSTANT double precision := 30.0;
  c_tier_title_starts_with_query CONSTANT double precision := 20.0;
  c_tier_headline_holds_query CONSTANT double precision := 10.0;
  -- Inside a tier.
  c_text_weight CONSTANT double precision := 3.0;
  c_similarity_weight CONSTANT double precision := 1.5;
  c_engagement_weight CONSTANT double precision := 2.5;
  c_freshness_weight CONSTANT double precision := 1.0;
  c_follow_weight CONSTANT double precision := 0.8;
  -- Engagement: a save is one per account, a comment can be repeated, a
  -- finished remix cost its maker credits.
  c_save_points CONSTANT double precision := 1.0;
  c_comment_points CONSTANT double precision := 0.5;
  c_remix_points CONSTANT double precision := 2.0;
  -- The points at which engagement is full; more adds nothing.
  c_engagement_full_points CONSTANT double precision := 1000.0;
  c_engagement_half_life_days CONSTANT double precision := 30.0;
  -- What engagement keeps however old the post.
  c_engagement_floor CONSTANT double precision := 0.3;
  c_freshness_half_life_days CONSTANT double precision := 14.0;
  -- Ten years. power() raises on underflow, and an age comes from a cursor.
  c_max_age_days CONSTANT double precision := 3650.0;

  v_age_days double precision := least(
    greatest(coalesce(p_age_seconds, 0.0), 0.0) / 86400.0,
    c_max_age_days
  );
  v_points double precision :=
    c_save_points * greatest(coalesce(p_save_count, 0), 0)
    + c_comment_points * greatest(coalesce(p_comment_count, 0), 0)
    + c_remix_points * greatest(coalesce(p_remix_count, 0), 0);
BEGIN
  RETURN
    CASE
      WHEN coalesce(p_title_is_query, false) THEN c_tier_title_is_query
      WHEN coalesce(p_title_starts_with_query, false) THEN c_tier_title_starts_with_query
      WHEN coalesce(p_headline_holds_query, false) THEN c_tier_headline_holds_query
      ELSE 0.0
    END
    + c_text_weight * least(greatest(coalesce(p_text_rank, 0.0), 0.0), 1.0)
    + c_similarity_weight * least(greatest(coalesce(p_similarity, 0.0), 0.0), 1.0)
    + c_engagement_weight
      * least(1.0, ln(1.0 + v_points) / ln(1.0 + c_engagement_full_points))
      * (
        c_engagement_floor
        + (1.0 - c_engagement_floor) * power(0.5::double precision, v_age_days / c_engagement_half_life_days)
      )
    + c_freshness_weight * power(0.5::double precision, v_age_days / c_freshness_half_life_days)
    + CASE WHEN coalesce(p_viewer_follows_creator, false) THEN c_follow_weight ELSE 0.0 END;
END;
$function$;

COMMENT ON FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean) IS
  'A post''s search score, every weight a named constant: its match tier (title is the query 30, title starts with it 20, title, model or tool holds its words 10), then at most 8.8 of text rank, trigram similarity, engagement decayed by the post''s age, freshness and a follow. To retune search, re-create this function alone.';

CREATE FUNCTION public.search_creator_score(
  p_handle_is_query boolean,
  p_handle_starts_with_query boolean,
  p_name_is_query boolean,
  p_name_holds_query boolean,
  p_text_rank double precision,
  p_similarity double precision,
  p_follower_count integer,
  p_public_post_count integer,
  p_viewer_follows_creator boolean
)
RETURNS double precision
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  -- Match tiers, 10 apart; the parts below add up to 8.5 at most.
  c_tier_handle_is_query CONSTANT double precision := 40.0;
  c_tier_handle_starts_with_query CONSTANT double precision := 30.0;
  c_tier_name_is_query CONSTANT double precision := 20.0;
  c_tier_name_holds_query CONSTANT double precision := 10.0;
  -- Inside a tier.
  c_text_weight CONSTANT double precision := 2.0;
  c_similarity_weight CONSTANT double precision := 2.0;
  c_audience_weight CONSTANT double precision := 2.5;
  c_activity_weight CONSTANT double precision := 1.0;
  c_follow_weight CONSTANT double precision := 1.0;
  -- Where each term is full. search_public_creators counts followers up to
  -- this many and no further.
  c_audience_full_followers CONSTANT double precision := 1000.0;
  c_activity_full_posts CONSTANT double precision := 100.0;
BEGIN
  RETURN
    CASE
      WHEN coalesce(p_handle_is_query, false) THEN c_tier_handle_is_query
      WHEN coalesce(p_handle_starts_with_query, false) THEN c_tier_handle_starts_with_query
      WHEN coalesce(p_name_is_query, false) THEN c_tier_name_is_query
      WHEN coalesce(p_name_holds_query, false) THEN c_tier_name_holds_query
      ELSE 0.0
    END
    + c_text_weight * least(greatest(coalesce(p_text_rank, 0.0), 0.0), 1.0)
    + c_similarity_weight * least(greatest(coalesce(p_similarity, 0.0), 0.0), 1.0)
    + c_audience_weight * least(
      1.0,
      ln(1.0 + greatest(coalesce(p_follower_count, 0), 0)) / ln(1.0 + c_audience_full_followers)
    )
    + c_activity_weight * least(
      1.0,
      ln(1.0 + greatest(coalesce(p_public_post_count, 0), 0)) / ln(1.0 + c_activity_full_posts)
    )
    + CASE WHEN coalesce(p_viewer_follows_creator, false) THEN c_follow_weight ELSE 0.0 END;
END;
$function$;

COMMENT ON FUNCTION public.search_creator_score(boolean, boolean, boolean, boolean, double precision, double precision, integer, integer, boolean) IS
  'A creator''s search score, every weight a named constant: its match tier (handle is the query 40, handle starts with it 30, display name is the query 20, name starts with it or handle and name hold its words 10), then at most 8.5 of text rank, trigram similarity, followers and public posts on a log scale, and a follow.';

REVOKE ALL ON FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_creator_score(boolean, boolean, boolean, boolean, double precision, double precision, integer, integer, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.search_creator_score(boolean, boolean, boolean, boolean, double precision, double precision, integer, integer, boolean)
  TO service_role;

-- ─── 2. Creators ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_public_creators(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_after_score double precision DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS TABLE(
  creator_user_id uuid,
  username text,
  display_name text,
  bio text,
  avatar_url text,
  public_post_count integer,
  is_following boolean,
  search_score double precision
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  -- LIKE/ILIKE patterns are built by concatenation, so pattern metacharacters
  -- in user input must match literally: '%%' must not become match-everything.
  v_like text;
  v_tsquery tsquery;
BEGIN
  -- The route refuses a query outside these limits before it gets here, by
  -- its own count; where the two counts differ (a character one of them
  -- reads as a space) the query finds nothing, where it raised a 500.
  IF char_length(v_query) < 2 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  IF p_limit < 1 OR p_limit > 25 THEN
    RAISE EXCEPTION 'Creator search limit must be between 1 and 25';
  END IF;
  IF p_after_score IS NOT NULL AND p_after_id IS NULL THEN
    RAISE EXCEPTION 'Creator search cursor is incomplete';
  END IF;
  -- Names are not stemmed.
  v_tsquery := public.search_query_tsquery(v_query, false);

  RETURN QUERY
  WITH scored AS (
    SELECT
      documents.creator_user_id,
      documents.username,
      documents.display_name,
      documents.bio,
      documents.avatar_url,
      documents.public_post_count,
      viewer.is_following,
      public.search_creator_score(
        documents.username_normalized = v_query,
        documents.username_normalized LIKE v_like || '%',
        documents.display_name_normalized = v_query,
        documents.display_name_normalized LIKE v_like || '%'
          -- The handle and the name are the vector's A lexemes; the bio is C.
          OR ts_filter(documents.search_vector, '{a}') @@ v_tsquery,
        ts_rank_cd(documents.search_vector, v_tsquery, 1 | 32),
        greatest(
          extensions.similarity(documents.username_normalized, v_query),
          extensions.similarity(documents.display_name_normalized, v_query),
          extensions.word_similarity(v_query, documents.username_normalized),
          extensions.word_similarity(v_query, documents.display_name_normalized)
        ),
        audience.follower_count,
        documents.public_post_count,
        viewer.is_following
      ) AS search_score
    FROM public.creator_search_documents AS documents
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.follows
        WHERE follower_id = p_viewer_user_id
          AND following_id = documents.creator_user_id
      ) AS is_following
    ) AS viewer
    CROSS JOIN LATERAL (
      -- Counted up to 1,000, where the audience term is full
      -- (search_creator_score), so one large account costs no more to rank.
      SELECT count(*)::integer AS follower_count
      FROM (
        SELECT 1
        FROM public.follows AS followers
        WHERE followers.following_id = documents.creator_user_id
        LIMIT 1000
      ) AS counted
    ) AS audience
    WHERE (
        documents.username_normalized LIKE v_like || '%'
        OR documents.display_name_normalized LIKE v_like || '%'
        OR documents.search_vector @@ v_tsquery
        OR documents.username_normalized OPERATOR(extensions.%) v_query
        OR documents.display_name_normalized OPERATOR(extensions.%) v_query
        OR v_query OPERATOR(extensions.<%) documents.username_normalized
        OR v_query OPERATOR(extensions.<%) documents.display_name_normalized
      )
      -- Neither side of a block finds the other, before the page is cut
      -- (loadBlockedCreatorIds, src/lib/moderation-service.ts).
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = documents.creator_user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = documents.creator_user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
  )
  SELECT
    scored.creator_user_id,
    scored.username,
    scored.display_name,
    scored.bio,
    scored.avatar_url,
    scored.public_post_count,
    scored.is_following,
    scored.search_score
  FROM scored
  WHERE p_after_score IS NULL
    OR scored.search_score < p_after_score
    OR (scored.search_score = p_after_score AND scored.creator_user_id > p_after_id)
  ORDER BY scored.search_score DESC, scored.creator_user_id ASC
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_public_creators(text, uuid, double precision, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_creators(text, uuid, double precision, uuid, integer)
  TO service_role;

-- ─── 3. Posts ───────────────────────────────────────────────────────────────
--
-- Dropped and re-created: new parameters and a new result column cannot be
-- added by CREATE OR REPLACE. Both happen in this transaction, so no call
-- finds the name missing, and the five-argument named call of the app live
-- during the release resolves to the new function through its defaults.

DROP FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer);

CREATE FUNCTION public.search_public_posts(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_after_score double precision DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_as_of timestamptz DEFAULT NULL,
  p_sort text DEFAULT 'top',
  p_after_created_at timestamptz DEFAULT NULL
)
RETURNS TABLE(
  post_id uuid,
  creator_user_id uuid,
  search_score double precision,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  -- Same literal-matching rule as creator search: a query of '%%%' must not
  -- become an ILIKE full scan over every post document.
  v_like text;
  v_tsquery tsquery;
  v_corrected text;
  v_sort text := coalesce(p_sort, 'top');
  -- The instant every page of one search is scored at.
  v_as_of timestamptz := coalesce(p_as_of, now());
BEGIN
  -- As creator search: outside the limits a query finds nothing.
  IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  IF p_limit < 1 OR p_limit > 25 THEN
    RAISE EXCEPTION 'Post search limit must be between 1 and 25';
  END IF;
  IF v_sort NOT IN ('top', 'latest') THEN
    RAISE EXCEPTION 'Post search sort must be top or latest';
  END IF;
  IF (p_after_score IS NOT NULL OR p_after_created_at IS NOT NULL) AND p_after_id IS NULL THEN
    RAISE EXCEPTION 'Post search cursor is incomplete';
  END IF;
  v_tsquery := public.search_query_tsquery(v_query, true);

  -- No post this search may show the viewer holds the query as typed: read
  -- its misspelt words as the nearest known ones and search on that. The test
  -- is the match below, the label and the blocks included and no cursor, so
  -- every page of a search, in either order, reads the query the same way
  -- while the data stands still.
  IF NOT EXISTS (
    SELECT 1
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE posts.is_nsfw = false
      AND (
        documents.search_vector @@ v_tsquery
        OR documents.search_text ILIKE ('%' || v_like || '%')
        OR documents.title_normalized OPERATOR(extensions.%) v_query
        OR documents.tool_normalized OPERATOR(extensions.%) v_query
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = documents.creator_user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = documents.creator_user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
  ) THEN
    v_corrected := public.search_corrected_query(v_query);
    IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN
      v_query := v_corrected;
      v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
      v_tsquery := public.search_query_tsquery(v_query, true);
    END IF;
  END IF;

  IF v_sort = 'latest' THEN
    -- The same matches, newest first. Nothing is scored.
    RETURN QUERY
    SELECT
      documents.post_id,
      documents.creator_user_id,
      0.0::double precision AS search_score,
      documents.created_at
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE posts.is_nsfw = false
      AND (
        documents.search_vector @@ v_tsquery
        OR documents.search_text ILIKE ('%' || v_like || '%')
        OR documents.title_normalized OPERATOR(extensions.%) v_query
        OR documents.tool_normalized OPERATOR(extensions.%) v_query
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = documents.creator_user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = documents.creator_user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
      AND (
        p_after_created_at IS NULL
        OR documents.created_at < p_after_created_at
        OR (documents.created_at = p_after_created_at AND documents.post_id > p_after_id)
      )
    ORDER BY documents.created_at DESC, documents.post_id ASC
    LIMIT p_limit;
    RETURN;
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT
      documents.post_id,
      documents.creator_user_id,
      public.search_post_score(
        documents.title_normalized = v_query,
        documents.title_normalized LIKE v_like || '%',
        -- The title and the models are the vector's A lexemes, the tool
        -- names its C; the caption and the prompt are B and do not count.
        documents.tool_normalized = v_query
          OR ts_filter(documents.search_vector, '{a,c}') @@ v_tsquery,
        ts_rank_cd(documents.search_vector, v_tsquery, 1 | 32),
        greatest(
          extensions.similarity(documents.title_normalized, v_query),
          extensions.similarity(documents.tool_normalized, v_query)
        ),
        posts.save_count,
        posts.comment_count,
        posts.remix_count,
        extract(epoch FROM (v_as_of - documents.created_at)),
        EXISTS (
          SELECT 1
          FROM public.follows
          WHERE follower_id = p_viewer_user_id
            AND following_id = documents.creator_user_id
        )
      ) AS search_score,
      documents.created_at
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE posts.is_nsfw = false
      AND (
        documents.search_vector @@ v_tsquery
        OR documents.search_text ILIKE ('%' || v_like || '%')
        OR documents.title_normalized OPERATOR(extensions.%) v_query
        OR documents.tool_normalized OPERATOR(extensions.%) v_query
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = documents.creator_user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = documents.creator_user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
  )
  SELECT scored.post_id, scored.creator_user_id, scored.search_score, scored.created_at
  FROM scored
  WHERE p_after_score IS NULL
    OR scored.search_score < p_after_score
    OR (scored.search_score = p_after_score AND scored.post_id > p_after_id)
  ORDER BY scored.search_score DESC, scored.post_id ASC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz) IS
  'Public post search. p_sort top: by search_post_score at p_as_of (now() without one), keyset on (search_score DESC, post_id). p_sort latest: the same matches newest first, keyset on (created_at DESC, post_id) through p_after_created_at. Labelled posts and both sides of a block are left out before the limit. Service role only.';

REVOKE ALL ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz)
  TO service_role;

-- ─── 4. The search log says which order was asked for ───────────────────────
--
-- NULL for a row written before this file, by the app live during the
-- release, and for a Top or Creators search, which have one order.
-- search_query_report does not read it.

ALTER TABLE public.search_query_events
  ADD COLUMN sort text CHECK (sort IS NULL OR sort IN ('top', 'latest'));

COMMENT ON COLUMN public.search_query_events.sort IS
  'The order a Posts or Recipes search asked for: top or latest. NULL for Top and Creators searches and for rows written before 20261112103547.';

COMMIT;
