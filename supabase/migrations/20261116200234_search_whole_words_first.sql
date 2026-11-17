-- Search: a post that holds the query's words whole comes before one that
-- holds them only inside longer words, and related searches are read from the
-- posts about the search.
--
-- THE DEFECT (a live sweep of production, 2026-11-17, build 941e2a55b). A
-- search for "cat" put two posts about no cat among the first four of its
-- Posts ("Monsoon girl — a chibi sticker…", "Minnal Vanitha in the rain"), and
-- the related searches over it were phrases of such posts: "minnal murali",
-- "atmospheric village", "backdrop at dusk", "blue color", "cinematic
-- lighting".
--
-- WHY. A one-word search is never blended (searchBlendApplies, search-blend.ts),
-- so neither the similarity floor nor the blend's weights placed those posts:
-- the word order alone did. search_public_posts matches a post on the query
-- read with its last word a prefix ('cat':* holds catching, category,
-- cathedral, catwalk: 20261111224010, so results do not come and go with each
-- letter typed), on the query as a run of characters anywhere in the post's
-- text (ILIKE '%cat%': delicate, intricate, location, scattered) and on a
-- near-miss title or tool. Each is kept: a word still being typed must find
-- its posts. But search_post_score's tiers (20261112103547) did not tell those
-- matches from whole words:
--   - a title starting with "catching" or "category" was "title starts with
--     the query" (20), beside "Cat on a windowsill";
--   - a title holding "cathedral" was "title holds the words" (10), beside
--     "Chibi cat cafe";
--   - a caption holding "delicate" was a caption match (0) beside a prompt
--     about a Persian cat, and inside that tier the text rank of one word in a
--     long prompt is small while freshness (up to 1.0) and engagement (up to
--     2.5) are not: a new or saved post that holds "delicate" outranked every
--     older post whose caption or prompt is about a cat.
-- On the relevance set extended with such posts, "cat" put "Category winners"
-- and "Catching the bus" first and "Cat-eye sunglasses" fourth, and "car" put
-- "Streetwear lookbook" (cargo trousers) first and "Skincare flat lay" fifth.
-- Related searches (20261115105944) are the phrases two posts of the result
-- page hold, whatever matched them, so the page's wrong posts chose them.
--
-- THE RULE. A post that holds the query's words whole (each a word of its own,
-- or its english stem: "cats" holds "cat", "catwalk" does not) keeps the tier
-- it had. A post that matches only inside longer words, or by a near-miss,
-- falls 30 under the tier its match would have had:
--
--   holds the words whole           only inside longer words or a near-miss
--   30  title is the query           -
--   20  title starts with the query  -10  title starts with its letters ("Catwalk")
--   10  title, model or tool         -20  a word of the title, model or tool starts with it ("Gothic cathedral")
--    0  caption or prompt            -30  the rest ("delicate", a near-miss title)
--
-- A title starts with the query when what follows it is no letter, digit or
-- hyphen: a hyphen joins a compound, so "Cat-eye sunglasses" does not start
-- with "cat" and holds it only as the parser splits the compound (10), under
-- "Cat on a windowsill" (20).
--
-- Every tier is still 10 from the next and the parts inside one add 8.8 at
-- most, so every whole-word match ranks before every partial one, and the
-- partial matches of a word still being typed ("portr") keep the order they
-- had among themselves. Nothing is found or lost: the same rows match, so
-- Latest, the counts of models and tools, the blend's word list and the
-- spelling correction's test are unchanged, and a title that is the query
-- still scores 30 or more and nothing else does (search_blended_posts'
-- c_exact_title_score).
--
-- RELATED SEARCHES leave out, once a post of the page holds the query's words
-- whole (as the posts were read, corrected where they were), the posts search
-- found only by a part of a word, a run of characters or a near-miss: their
-- phrases say nothing of the search. A post that matches no word is one a
-- blended answer brought by meaning and is still read ("sea after sunset":
-- its title post and the seascapes found by meaning). While no post of the
-- page holds the words whole (a word still being typed, or a page found by
-- meaning alone) every post is read, as before. And a phrase that holds the
-- query ("black cat" for "cat") is offered before one that leads away from
-- it. Everything else is as 20261115105944 made it.
--
-- WHAT IS RE-CREATED. search_query_whole_tsquery is new (the query with no
-- word a prefix, in the readings search_query_tsquery makes). search_post_score
-- is dropped and made again with an eleventh parameter, p_whole_words,
-- DEFAULT true, so a call of ten arguments scores as before; it is read only
-- by search_public_posts. search_public_posts and search_related_searches
-- are replaced with their signatures, results, definer rights, search paths
-- and grants kept.
--
-- THE RELEASE WINDOW. All of it is one transaction, and no app code changes
-- with it: the app live calls search_public_posts and search_related_searches
-- by name with the same arguments. A Top posts cursor issued before this file
-- carries a score on the old scale. Every post not yet shown scored under it
-- then and scores no higher now (a whole match the same, a partial one 30
-- less), so the next page passes over none; it can repeat a partial match
-- already shown, which clients leave out by id (searchPublicContent.laterPages).
-- A blended page continues after the post shown last wherever it stands now,
-- and a post the new order moved above it from below is passed over, once,
-- for a search open while this applied.
--
-- MEASURED with the relevance check (docs/search-ranking-operations.md) on a
-- local stack with real gte-small vectors (2026-11-17). On the set as it was
-- recorded on 2026-11-15, nDCG@10 by words 0.5410 to 0.5452 and blended
-- 0.7837 to 0.7863, a relevant post in the top five by words 0.7286 to
-- 0.7429, wrong posts in the top ten and posts for queries about nothing
-- unchanged. On the set extended with "cat", "car" and four posts that hold
-- "cat" inside other words: by words 0.5376 to 0.5468, blended 0.7736 to
-- 0.7813; "cat" 0.4784 to 0.7375 (0.6003 without the hyphen rule, which
-- moves no other query of either set), "car" 0.3589 to 0.4738, "studio light"
-- 0.3358 to 0.5293 by words and 0.4316 to 0.4887 blended, "city night" 0.1064
-- to 0.2076 and 0.2219 to 0.3429. No query scores lower in either order. The
-- cost: post search took 1.4 to 5.5 ms more (median, 5 to 14%, two
-- interleaved runs) on 5,000 synthetic posts (scripts/ops/search-coverage-seed.sql,
-- local replay).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ─── 1. The query read whole ────────────────────────────────────────────────

CREATE FUNCTION public.search_query_whole_tsquery(p_query text)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  -- search_query_tsquery's four readings (as typed and split, in the simple
  -- and the english configurations), every word required and none a prefix.
  SELECT plainto_tsquery('pg_catalog.simple', coalesce(p_query, ''))
    || plainto_tsquery('pg_catalog.simple', public.search_split_terms(p_query))
    || plainto_tsquery('pg_catalog.english', coalesce(p_query, ''))
    || plainto_tsquery('pg_catalog.english', public.search_split_terms(p_query));
$function$;

COMMENT ON FUNCTION public.search_query_whole_tsquery(text) IS
  'A search query as a post holds it whole: search_query_tsquery''s readings (as typed and split, simple and english) with every word required and none a prefix, so ''cat'' is held by cat and cats, never by catwalk or category.';

REVOKE ALL ON FUNCTION public.search_query_whole_tsquery(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_query_whole_tsquery(text) TO service_role;

-- ─── 2. The score: whole words first ────────────────────────────────────────
--
-- Dropped and made again: a new parameter cannot be added by CREATE OR
-- REPLACE, and two functions of the name would make a call of ten arguments
-- ambiguous. search_public_posts, replaced below in this transaction, is its
-- only caller.

DROP FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean);

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
  p_viewer_follows_creator boolean,
  -- The post holds the query's words whole (each a word of its own, or its
  -- english stem). Left out, a post is taken to: the call of 20261112103547.
  p_whole_words boolean DEFAULT true
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
  -- A post that holds the query only inside longer words ('cat' in catwalk,
  -- category or delicate), or by a near-miss, falls this far under the tier
  -- its match would have: its best (a title starting with the letters, 20)
  -- lands at -10, a whole tier under the least whole match (a caption, 0),
  -- and its tiers stay 10 apart, so the parts below cross none of them.
  c_partial_words_drop CONSTANT double precision := 30.0;
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
  -- Six decimals: see SCORES TRAVEL AS TEXT in 20261112103547.
  RETURN round((
    CASE
      WHEN coalesce(p_title_is_query, false) THEN c_tier_title_is_query
      WHEN coalesce(p_title_starts_with_query, false) THEN c_tier_title_starts_with_query
      WHEN coalesce(p_headline_holds_query, false) THEN c_tier_headline_holds_query
      ELSE 0.0
    END
    -- A title that is the query holds its words whole, whatever the caller says.
    - CASE
      WHEN coalesce(p_whole_words, true) OR coalesce(p_title_is_query, false) THEN 0.0
      ELSE c_partial_words_drop
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
    + CASE WHEN coalesce(p_viewer_follows_creator, false) THEN c_follow_weight ELSE 0.0 END
  )::numeric, 6)::double precision;
END;
$function$;

COMMENT ON FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean, boolean) IS
  'A post''s search score, every weight a named constant: its match tier (title is the query 30, title starts with it 20, title, model or tool holds its words 10, a caption or prompt 0), 30 lower for a post that holds the query''s words only inside longer words (p_whole_words false), then at most 8.8 of text rank, trigram similarity, engagement decayed by the post''s age, freshness and a follow. To retune search, re-create this function alone.';

REVOKE ALL ON FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_post_score(boolean, boolean, boolean, double precision, double precision, integer, integer, integer, double precision, boolean, boolean)
  TO service_role;

-- ─── 3. Posts: where the query is held, whole or not ───────────────────────

CREATE OR REPLACE FUNCTION public.search_public_posts(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_after_score double precision DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_as_of timestamptz DEFAULT NULL,
  p_sort text DEFAULT 'top',
  p_after_created_at timestamptz DEFAULT NULL,
  p_made_with text DEFAULT NULL,
  p_media_kind text DEFAULT NULL,
  p_has_recipe boolean DEFAULT false,
  p_followed_only boolean DEFAULT false,
  p_correct boolean DEFAULT true
)
RETURNS TABLE(
  post_id uuid,
  creator_user_id uuid,
  search_score double precision,
  created_at timestamptz,
  corrected_query text
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
  -- The same query with no word a prefix: what a post holds when it holds the
  -- query's words whole (search_query_whole_tsquery).
  v_whole tsquery;
  v_corrected text;
  -- The query as the correction read it; NULL while it is read as typed.
  v_read_as text;
  v_sort text := coalesce(p_sort, 'top');
  -- The instant every page of one search is scored at. A caller that sends
  -- none gets the start of the UTC day, so its pages agree with each other
  -- (20261112103547).
  v_as_of timestamptz := coalesce(p_as_of, date_trunc('day', now(), 'UTC'));
  v_entity_kind text;
  v_entity_key text;
  v_has_recipe boolean := coalesce(p_has_recipe, false);
  v_followed_only boolean := coalesce(p_followed_only, false);
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
  IF p_media_kind IS NOT NULL AND p_media_kind NOT IN ('image', 'video') THEN
    RAISE EXCEPTION 'Post search media kind must be image or video';
  END IF;
  IF p_made_with IS NOT NULL THEN
    v_entity_kind := split_part(p_made_with, ':', 1);
    v_entity_key := substr(p_made_with, char_length(v_entity_kind) + 2);
    IF v_entity_kind NOT IN ('model', 'tool') OR v_entity_key = '' THEN
      RAISE EXCEPTION 'Post search made-with filter must be model:<key> or tool:<key>';
    END IF;
  END IF;
  v_tsquery := public.search_query_tsquery(v_query, true);
  v_whole := public.search_query_whole_tsquery(v_query);

  -- No post this search may show the viewer holds the query as typed: read
  -- its misspelt words as the nearest known ones and search on that. The test
  -- is the match below, the label, the blocks and the filters included and no
  -- cursor, so every page of a search, in either order, reads the query the
  -- same way while the data stands still. p_correct = false reads the query
  -- as typed whatever it finds.
  IF coalesce(p_correct, true) AND NOT EXISTS (
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
      AND (p_media_kind IS NULL OR posts.category = p_media_kind)
      AND (NOT v_has_recipe OR EXISTS (
        SELECT 1
        FROM public.post_resource_bundles AS recipes
        WHERE recipes.post_id = documents.post_id
          AND recipes.status = 'published'
      ))
      AND (NOT v_followed_only OR EXISTS (
        SELECT 1
        FROM public.follows AS followed
        WHERE followed.follower_id = p_viewer_user_id
          AND followed.following_id = documents.creator_user_id
      ))
      AND (v_entity_key IS NULL OR EXISTS (
        SELECT 1
        FROM public.post_search_entities AS members
        WHERE members.kind = v_entity_kind
          AND members.key = v_entity_key
          AND members.post_id = documents.post_id
      ))
  ) THEN
    v_corrected := public.search_corrected_query(v_query);
    IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN
      v_query := v_corrected;
      v_read_as := v_corrected;
      v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
      v_tsquery := public.search_query_tsquery(v_query, true);
      v_whole := public.search_query_whole_tsquery(v_query);
    END IF;
  END IF;

  IF v_sort = 'latest' THEN
    -- The same matches, newest first. Nothing is scored.
    RETURN QUERY
    SELECT
      documents.post_id,
      documents.creator_user_id,
      0.0::double precision AS search_score,
      documents.created_at,
      v_read_as AS corrected_query
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
      AND (p_media_kind IS NULL OR posts.category = p_media_kind)
      AND (NOT v_has_recipe OR EXISTS (
        SELECT 1
        FROM public.post_resource_bundles AS recipes
        WHERE recipes.post_id = documents.post_id
          AND recipes.status = 'published'
      ))
      AND (NOT v_followed_only OR EXISTS (
        SELECT 1
        FROM public.follows AS followed
        WHERE followed.follower_id = p_viewer_user_id
          AND followed.following_id = documents.creator_user_id
      ))
      AND (v_entity_key IS NULL OR EXISTS (
        SELECT 1
        FROM public.post_search_entities AS members
        WHERE members.kind = v_entity_kind
          AND members.key = v_entity_key
          AND members.post_id = documents.post_id
      ))
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
        matched.title_is_query,
        -- A post that holds the query's words whole is placed by where it
        -- holds them whole, and one that does not by where it holds them
        -- at all, a tier under every whole match (search_post_score).
        CASE WHEN matched.whole_words THEN matched.title_starts_whole ELSE matched.title_starts END,
        CASE WHEN matched.whole_words THEN matched.headline_whole ELSE matched.headline_holds END,
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
        ),
        matched.whole_words
      ) AS search_score,
      documents.created_at
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    CROSS JOIN LATERAL (
      -- Where the post holds the query, read as typed (its last word may be
      -- one still being typed: 'cat' as in catwalk, 20261111224010) and read
      -- whole (every word a word of the post's own, or its english stem:
      -- 'cats' holds 'cat', 'catwalk' does not).
      SELECT
        holds.*,
        holds.title_is_query OR holds.title_starts_whole OR holds.headline_whole OR holds.body_whole AS whole_words
      FROM (
        SELECT
          shown.title = v_query AS title_is_query,
          shown.title LIKE v_like || '%' AS title_starts,
          -- The title starts with the query and goes on, if at all, after a
          -- character that is no letter, digit or hyphen: 'cat on a sill' and
          -- 'cat''s toy' start with 'cat'; 'catwalk' only with its letters,
          -- and 'cat-eye' with the first part of a word of its own (a hyphen
          -- joins a compound: cat-eye sunglasses are no cat). Such a title
          -- still holds 'cat' among its words, as the parser splits it
          -- (title holds the words, 10), under 'cat on a sill'.
          shown.title LIKE v_like || '%'
            AND substr(shown.title, char_length(v_query) + 1, 1) !~ '[[:alnum:]-]' AS title_starts_whole,
          -- The title and the models are the vector's A lexemes, the tool
          -- names its C; the caption and the prompt are B and do not count.
          documents.tool_normalized = v_query OR shown.headline @@ v_tsquery AS headline_holds,
          documents.tool_normalized = v_query OR shown.headline @@ v_whole AS headline_whole,
          documents.search_vector @@ v_whole AS body_whole
        FROM (
          SELECT
            -- The title as the query is read: NFKC and one space between words.
            -- Worked out only for a title that reading can change, one holding two
            -- spaces together or a character outside printable ASCII (a line break,
            -- a full-width letter): on 2,250 matches the rest saved 15 ms.
            CASE
              WHEN documents.title_normalized ~ '  |[^ -~]' THEN lower(btrim(regexp_replace(
                normalize(documents.title_normalized, NFKC), '[[:space:]]+', ' ', 'g'
              )))
              ELSE documents.title_normalized
            END AS title,
            ts_filter(documents.search_vector, '{a,c}') AS headline
          -- OFFSET 0 keeps each value one per row: flattened, the planner
          -- copied the title and ts_filter into every place that reads them
          -- (ts_filter five times a row), and post search took half as long
          -- again on 5,000 posts (local replay, 2026-11-17).
          OFFSET 0
        ) AS shown
        OFFSET 0
      ) AS holds
    ) AS matched
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
      AND (p_media_kind IS NULL OR posts.category = p_media_kind)
      AND (NOT v_has_recipe OR EXISTS (
        SELECT 1
        FROM public.post_resource_bundles AS recipes
        WHERE recipes.post_id = documents.post_id
          AND recipes.status = 'published'
      ))
      AND (NOT v_followed_only OR EXISTS (
        SELECT 1
        FROM public.follows AS followed
        WHERE followed.follower_id = p_viewer_user_id
          AND followed.following_id = documents.creator_user_id
      ))
      AND (v_entity_key IS NULL OR EXISTS (
        SELECT 1
        FROM public.post_search_entities AS members
        WHERE members.kind = v_entity_kind
          AND members.key = v_entity_key
          AND members.post_id = documents.post_id
      ))
  )
  SELECT scored.post_id, scored.creator_user_id, scored.search_score, scored.created_at, v_read_as AS corrected_query
  FROM scored
  WHERE p_after_score IS NULL
    OR scored.search_score < p_after_score
    OR (scored.search_score = p_after_score AND scored.post_id > p_after_id)
  ORDER BY scored.search_score DESC, scored.post_id ASC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean) IS
  'Public post search. p_sort top: by search_post_score at p_as_of (the start of the UTC day without one), keyset on (search_score DESC, post_id); a post that holds the query''s words whole (each a word of its own or its english stem) before every post that holds them only inside longer words, a near-miss or a run of characters. p_sort latest: the same matches newest first, keyset on (created_at DESC, post_id) through p_after_created_at. Filters, each before the limit: p_made_with (model:<key> or tool:<key>), p_media_kind (image or video), p_has_recipe, p_followed_only. corrected_query is the query as the spelling correction read it, NULL when read as typed; p_correct false reads it as typed. Labelled posts and both sides of a block are left out before the limit. Service role only.';

REVOKE ALL ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean)
  TO service_role;

-- ─── 4. Related searches: from the posts about the search ──────────────────

CREATE OR REPLACE FUNCTION public.search_related_searches(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_post_ids uuid[] DEFAULT ARRAY[]::uuid[],
  p_corrected_query text DEFAULT NULL,
  p_limit integer DEFAULT 6
)
RETURNS TABLE(related text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The most posts of a result page read.
  c_posts CONSTANT integer := 30;
  -- A related search is held by this many of them.
  c_min_posts CONSTANT integer := 2;
  -- How many are weighed before the list is cut to ones that differ.
  c_candidates CONSTANT integer := 24;
  -- At most this many are names of models and tools.
  c_names CONSTANT integer := 2;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_corrected text := nullif(lower(btrim(regexp_replace(coalesce(p_corrected_query, ''), '[[:space:]]+', ' ', 'g'))), '');
  v_limit integer := least(greatest(coalesce(p_limit, 6), 0), 10);
  -- The words the search already says, as typed and as corrected.
  v_said text[];
  -- The query as the posts were read (corrected where they were), as a LIKE
  -- pattern, whole and with its last word a prefix, and whether it has a
  -- word to read them by.
  v_read text;
  v_like text;
  v_whole tsquery;
  v_typing tsquery;
  v_has_words boolean;
  -- The page's posts this reads: once one holds the query's words whole,
  -- every post but those search found only by a part of a word, a run of
  -- characters or a near-miss; while none does, every post of the page.
  v_page_ids uuid[];
  v_whole_ids uuid[];
  v_kept_ids uuid[];
  v_read_ids uuid[];
  v_candidate record;
  v_words text[];
  v_chosen text[] := ARRAY[]::text[];
  v_offered integer := 0;
  v_names integer := 0;
  v_repeats boolean;
  v_other text;
BEGIN
  IF v_limit = 0 OR v_query = '' OR p_post_ids IS NULL OR cardinality(p_post_ids) = 0 THEN
    RETURN;
  END IF;
  -- Only kept phrases are offered, and they are as old as the last rebuild.
  IF NOT public.search_phrases_are_fresh() THEN
    RETURN;
  END IF;
  v_said := string_to_array(v_query, ' ')
    || string_to_array(public.search_split_terms(v_query), ' ')
    || coalesce(string_to_array(v_corrected, ' '), ARRAY[]::text[]);
  v_read := coalesce(v_corrected, v_query);
  v_like := replace(replace(replace(v_read, '\', '\\'), '%', '\%'), '_', '\_');
  v_whole := public.search_query_whole_tsquery(v_read);
  v_typing := public.search_query_tsquery(v_read, true);
  v_has_words := numnode(v_typing) > 0;

  -- The result page's posts, each read again as search reads one (a
  -- document, unlabelled, neither side of a block with the viewer), and
  -- whether each holds the query's words whole, or matches them only as
  -- search_public_posts' partial reading does (a word still being typed, a
  -- run of characters, a near-miss title or tool). Once a post of the page
  -- holds the words whole, a post found only that way ('delicate' for 'cat')
  -- is never read: its phrases say nothing of the search. A post that
  -- matches no word at all is a post a blended answer brought by meaning,
  -- and is read beside the whole-word ones ("sea after sunset": its title
  -- post and the seascapes found by meaning). While no post of the page
  -- holds the words whole (a word still being typed, or a page found by
  -- meaning alone) every post is read, as before.
  SELECT
    coalesce(array_agg(documents.post_id), ARRAY[]::uuid[]),
    coalesce(array_agg(documents.post_id) FILTER (WHERE matched.whole), ARRAY[]::uuid[]),
    coalesce(array_agg(documents.post_id) FILTER (WHERE matched.whole OR NOT matched.lexical), ARRAY[]::uuid[])
  INTO v_page_ids, v_whole_ids, v_kept_ids
  FROM public.post_search_documents AS documents
  JOIN public.posts AS posts ON posts.id = documents.post_id
  CROSS JOIN LATERAL (
    SELECT
      CASE WHEN v_has_words THEN documents.search_vector @@ v_whole ELSE false END AS whole,
      CASE WHEN v_has_words THEN documents.search_vector @@ v_typing ELSE false END
        OR documents.search_text ILIKE ('%' || v_like || '%')
        OR documents.title_normalized OPERATOR(extensions.%) v_read
        OR documents.tool_normalized OPERATOR(extensions.%) v_read AS lexical
  ) AS matched
  WHERE documents.post_id = ANY (p_post_ids[1:c_posts])
    AND posts.is_nsfw = false
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
    );
  v_read_ids := CASE WHEN cardinality(v_whole_ids) > 0 THEN v_kept_ids ELSE v_page_ids END;
  IF cardinality(v_read_ids) < c_min_posts THEN
    RETURN;
  END IF;

  FOR v_candidate IN
    WITH seen AS MATERIALIZED (
      -- The posts chosen above, read just now.
      SELECT documents.post_id, documents.search_text
      FROM public.post_search_documents AS documents
      WHERE documents.post_id = ANY (v_read_ids)
    ),
    held AS (
      -- What each writes, and what each is made with: read as a rebuild
      -- reads them, so only phrases search_phrases can hold come out.
      SELECT seen.post_id, grams.phrase
      FROM seen
      CROSS JOIN LATERAL public.search_text_phrases(seen.search_text) AS grams
      UNION
      SELECT members.post_id, public.search_entity_phrase(members.kind, members.key, members.label)
      FROM public.post_search_entities AS members
      JOIN seen ON seen.post_id = members.post_id
    ),
    counted AS (
      SELECT held.phrase, count(*) AS posts
      FROM held
      WHERE held.phrase IS NOT NULL
      GROUP BY held.phrase
      HAVING count(*) >= c_min_posts
    )
    SELECT phrases.phrase, phrases.is_name
    FROM counted
    -- A kept phrase: two creators' posts hold it.
    JOIN public.search_phrases AS phrases ON phrases.phrase = counted.phrase
    WHERE phrases.phrase <> v_query
      AND phrases.phrase IS DISTINCT FROM v_corrected
      -- It says something the search does not: a word of its own.
      AND NOT (string_to_array(phrases.phrase, ' ') <@ v_said)
      AND NOT EXISTS (
        SELECT 1
        FROM public.search_suggestion_denylist AS denied
        WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
          'pg_catalog.simple', coalesce(public.search_term_variants(phrases.phrase), '')
        )))
      )
    -- What the posts write before what they are made with: a page's posts
    -- mostly share a model, and its name would lead every list. Then a
    -- phrase that holds the query ('black cat' for 'cat'), which narrows the
    -- search, before one that leads away from it ('soft lighting').
    ORDER BY
      (phrases.is_name AND NOT phrases.in_text),
      (to_tsvector('pg_catalog.simple', phrases.phrase) || to_tsvector('pg_catalog.english', phrases.phrase)) @@ v_whole DESC,
      counted.posts DESC,
      phrases.recent_weight DESC,
      phrases.phrase
    LIMIT c_candidates
  LOOP
    EXIT WHEN v_offered >= v_limit;
    CONTINUE WHEN v_candidate.is_name AND v_names >= c_names;
    -- None that only widens or narrows one already offered.
    v_words := string_to_array(v_candidate.phrase, ' ');
    v_repeats := false;
    FOREACH v_other IN ARRAY v_chosen LOOP
      IF v_words <@ string_to_array(v_other, ' ') OR string_to_array(v_other, ' ') <@ v_words THEN
        v_repeats := true;
        EXIT;
      END IF;
    END LOOP;
    CONTINUE WHEN v_repeats;
    IF v_candidate.is_name THEN
      v_names := v_names + 1;
    END IF;
    v_chosen := v_chosen || v_candidate.phrase;
    v_offered := v_offered + 1;
    related := v_candidate.phrase;
    RETURN NEXT;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.search_related_searches(text, uuid, uuid[], text, integer) IS
  'Related searches for a result page (/api/search?relatedSearches=1): the phrases and model or tool names (search_phrases) that at least two of p_post_ids hold, each post read again as search reads one for p_viewer_user_id (a document, unlabelled, neither side of a block; at most 30), and, once one of them holds the query''s words whole (as corrected by p_corrected_query), none that search_public_posts found only by a part of a word, a run of characters or a near-miss; a post that matches no word (found by meaning) is read, and while none holds the words whole every post is. What the posts write first, a phrase holding the query first, most-held first, then at most two names. Never the query or its corrected reading, one whose every word the query says, one holding a withdrawn word, or one that only widens or narrows another offered. Each is held by two posts the viewer may see, which its own search then finds. None while the last rebuild of search_phrases is over three hours old. At most 10. Service role only.';

REVOKE ALL ON FUNCTION public.search_related_searches(text, uuid, uuid[], text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_related_searches(text, uuid, uuid[], text, integer) TO service_role;

COMMIT;
