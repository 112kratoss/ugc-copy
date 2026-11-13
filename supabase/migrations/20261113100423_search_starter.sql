-- Search before anything is typed: GET /api/search/starter in one call.
--
-- Until this file the search screen opened empty on the web and in the app
-- (search UX audit 2026-11-13, findings 2 and 8): search_public_entities,
-- search_suggestions and every search read find nothing under three typed
-- characters, by design. This file adds one read that fills the screen with
-- three short lists, each decided on what a visitor can see, and each bounded
-- however many posts there are.
--
-- public.search_starter(p_viewer_user_id, p_terms, p_entity_limit,
--   p_creator_limit, p_search_limit) RETURNS jsonb:
--   {entities: [{kind, key, label, post_count, post_count_capped, query}],
--    creators: [{id, username, display_name, bio, avatar_url,
--                public_post_count, is_following}],
--    searches: [{text}]}
-- each list in the order to show it.
--
-- THE WINDOW. Entities and creators are read from the newest 2,000 posts a
-- search may show this viewer (c_window): public, visible, unarchived, with a
-- search document, unlabelled, neither side of a block with the viewer, cut
-- after those rules, found through posts_public_review_recent_idx in
-- created_at order. To find them it reads at most the newest 10,000 public,
-- visible, unarchived posts (c_scan_ceiling): when more of those than 8,000
-- are labelled, without a document or blocked with the viewer, the window is
-- the fewer posts that pass, and the lists are read from them (shorter, or
-- empty). So the window's cost does not grow with the posts table. While
-- there are fewer than 2,000 such posts the window is all of them.
--
-- 1. ENTITIES (Popular models and tools). The models and tools with the most
--    posts in the window, most first, under the rules a suggestion already
--    holds an entity to (20261112192423, search-typeahead-ui decisions 1 and
--    2), since this list too is put in front of people who did not ask:
--      - TWO CREATORS: unlabelled posts of two different creators in the
--        window are made with it;
--      - WITHDRAWN WORDS: no word of search_suggestion_denylist in its name
--        or key, read as post_search_entities.name_vector reads them;
--      - a template result has no model (post_search_entities never holds
--        one for it), so a template's hidden model is never offered.
--    Pressing one runs a Posts search for the name most of its posts print,
--    lowercased ('qwen3', 'kling 2.6'), returned as `query`, narrowed to it
--    with the made-with filter. The c_entity_candidates strongest by window
--    count are counted for that search (search_starter_entity_offer) as
--    search_public_entities counts an offer for this viewer: the posts
--    search_public_posts returns for the query narrowed to the entity, by its
--    own match, named as the query names it, to 200. So the count shown is
--    the list the press opens, and one that search finds nothing for is not
--    offered. It is shown by that count, most first. Not the name a client
--    draws: a catalog's name ('Qwen Image 3.0' for qwen3) can hold words its
--    posts do not, and searched it opened fewer posts than the count, or none
--    (PR #785 review). Each count reads at most 201 rows of its entity.
--
-- 2. CREATORS (Creators to follow). Accounts with an unlabelled public post
--    in the window posted in the last 30 days, ordered by
--      their posts in that window and period, counted up to 10, so one
--      heavy poster does not outrank everyone by volume alone; then their
--      followers (counted up to 1,000, as search_creator_score counts them);
--      then their newest post; then their id.
--    Only the 50 most active by the first and third keys are counted for
--    followers (c_creator_candidates), so a follower count is read at most
--    50 times. Never a guest's anonymous session, a suspended account, one
--    being deleted or merged away, one without a creator search document,
--    one on either side of a block with the viewer, one the viewer already
--    follows, or the viewer. In the shape a creator search result has;
--    is_following is therefore always false, kept so the shape is one.
--
-- 3. SEARCHES (Try searching for). p_terms is a hand-picked list kept in
--    code (SEARCH_STARTER_SUGGESTED_SEARCHES, src/lib/search-starter.ts), in
--    the order to offer it. A term is offered, as listed with one space
--    between words, when, read as search_public_posts reads a query
--    (lowercased, one space between words), it is 3 to 100 characters, was
--    not already read (any case or spacing), holds no word of
--    search_suggestion_denylist (as written, split or joined:
--    search_term_variants), and at least one post search may show this
--    viewer holds every word of it as written
--    (search_starter_term_finds_post): a post search_public_posts finds for
--    it, so an offer never opens an empty search. At most 20 terms are read.
--
-- COST. The window reads at most 10,000 index entries; each entity count
-- reads at most 1,001 rows of its own entity (never every entity its query
-- names), for at most 12 entities; followers are counted at most 1,000 per creator, for
-- at most 50. The searches list is NOT bounded the same way: a term's check
-- reads the word index's posting list of each of its words, which grows with
-- the posts that hold the word (about 2.5 ms for 'portrait' in 25,000 of
-- 50,000 posts, so tens of ms a common word at a million), for at most 20
-- terms. Timings: docs/production-deployment-runbook.md, "Search Starter".
--
-- No search log, and no hidden, private, archived or labelled post, is read
-- for any list's order or presence; a viewer's blocks and follows only ever
-- take a row out.
--
-- THE RELEASE WINDOW. A new function only: nothing live calls it, and the
-- code that calls it is promoted after this file is applied. No table is
-- changed and no lock is taken.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Whether at least one post search_public_posts may show the viewer holds
-- every word of a query as written: unlabelled, neither side of a block. Any
-- such post is one search_public_posts finds for the query (its word match
-- reads every word, the last as a prefix of a word, and a post holding the
-- word itself matches), so a term this says yes to never opens an empty
-- search. It may say no to a term search would find another way (a run of
-- characters inside a word, a near-miss title): such a term is left out,
-- never offered empty.
--
-- Only the documents' word index is read, for whole words (no prefix, no
-- stems): a prefix or the search's other three tests read posting lists
-- that grow with the posts (10 to 45 ms a term on 50,000 posts, local replay
-- 2026-11-13); this reads one list per word, 0.1 to 3 ms a term on the same
-- seed, where 'portrait' is in 25,000 documents. A function of its own for
-- the two planner settings: asked "is there one?", the planner otherwise
-- reads every document in key order until it finds one (28 to 70 ms for a
-- term with none on 5,000 posts).
CREATE FUNCTION public.search_starter_term_finds_post(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET enable_seqscan = off
SET enable_indexscan = off
AS $function$
DECLARE
  -- Every word as written, lowercased: no prefix, no stem. Worked out once,
  -- not at each row the match rechecks.
  v_tsquery tsquery := plainto_tsquery('pg_catalog.simple', coalesce(p_query, ''));
BEGIN
  -- A query of nothing but punctuation holds no word, and finds nothing here.
  IF numnode(v_tsquery) = 0 THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE posts.is_nsfw = false
      AND documents.search_vector @@ v_tsquery
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
  );
END;
$function$;

COMMENT ON FUNCTION public.search_starter_term_finds_post(text, uuid) IS
  'For search_starter: whether at least one post search_public_posts may show p_viewer_user_id (unlabelled, neither side of a block) holds every word of p_query as written, which search_public_posts then finds. The documents'' word index only. Service role only.';

REVOKE ALL ON FUNCTION public.search_starter_term_finds_post(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_starter_term_finds_post(text, uuid) TO service_role;

-- One entity's row in the starter, for a viewer: the Posts search pressing
-- it runs, and what that search finds.
--
-- THE QUERY is the name most of its posts print, lowercased with one space
-- between words ('kling 2.6', or its key where posts print none). Search reads
-- a query as typed and split alike, and a post's document holds that name: as
-- written where the post's own Made with field holds it, and as written,
-- split and joined where a Made with row or the creation names it. Not the
-- name a client draws: a catalog's name ('Qwen Image 3.0' for qwen3) can hold
-- words the posts do not, and searched that way opened fewer posts than the
-- count shown, or none (PR #785 review). Not the key's words either: 'kling 2
-- 6' misses a post whose own Made with field says 'Kling 2.6'.
--
-- THE COUNT is search_public_entities' for an offer: the posts
-- search_public_posts returns for the query narrowed to the entity, for this
-- viewer, by its own match (the same text, held equal by
-- search-starter-migration.test.ts), offered only when one of them names it
-- as the query does. It stops at 200 ("200+ posts" says as much on a starter
-- row as the exact figure). No row when that search would find nothing (a
-- name under three characters, or of no word, or no such post).
--
-- Read by the entity's key, not through search_public_entities(query), which
-- first finds every entity row the query names (16,000 for 'runway' on 50,000
-- posts, 10 to 20 ms a call). plpgsql planned for each call's own values
-- (written into search_starter's one statement, the planner could not see
-- the key and read every entity row for each: 265 ms on 50,000 posts; and a
-- generic plan, which plpgsql moves to after five calls, took 12 ms a count
-- against 3), held to nested loops as search_public_entities is (with a hash
-- join it hashed the entity's posts against every document: 1.1 s), and to
-- one process (a parallel Gather cost more to start, about 3 ms, than the
-- 201 rows it read).
CREATE FUNCTION public.search_starter_entity_offer(
  p_kind text,
  p_key text,
  p_viewer_user_id uuid DEFAULT NULL
)
RETURNS TABLE(
  query text,
  label text,
  post_count integer,
  post_count_capped boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
SET enable_hashjoin = off
SET enable_mergejoin = off
SET max_parallel_workers_per_gather = 0
SET plan_cache_mode = force_custom_plan
AS $function$
DECLARE
  c_count_cap CONSTANT integer := 200;
  v_label text;
  v_query text;
  v_like text;
  v_tsquery tsquery;
  v_name_tsquery tsquery;
  v_total integer;
  v_named boolean;
BEGIN
  -- The name most of the posts the viewer may see print for it (as the
  -- made-with filter names it), read from at most 201 of them.
  SELECT printed.label INTO v_label
  FROM (
    SELECT members.label
    FROM public.post_search_entities AS members
    JOIN public.posts AS posts ON posts.id = members.post_id
    WHERE members.kind = p_kind
      AND members.key = p_key
      AND posts.is_nsfw = false
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = members.creator_user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = members.creator_user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
    LIMIT c_count_cap + 1
  ) AS printed
  GROUP BY printed.label
  ORDER BY (printed.label = p_key), count(*) DESC, printed.label
  LIMIT 1;
  IF v_label IS NULL THEN
    RETURN;
  END IF;

  -- Read as search_public_posts reads a query.
  v_query := lower(btrim(regexp_replace(v_label, '[[:space:]]+', ' ', 'g')));
  IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_tsquery := public.search_query_tsquery(v_query, true);
  v_name_tsquery := public.search_query_tsquery(v_query, false);
  IF numnode(v_name_tsquery) = 0 THEN
    RETURN;
  END IF;

  WITH seen AS MATERIALIZED (
    SELECT members.name_vector @@ v_name_tsquery AS names_it
    FROM public.post_search_entities AS members
    JOIN public.post_search_documents AS documents ON documents.post_id = members.post_id
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE members.kind = p_kind
      AND members.key = p_key
      AND posts.is_nsfw = false AND ( documents.search_vector @@ v_tsquery OR documents.search_text ILIKE ('%' || v_like || '%') OR documents.title_normalized OPERATOR(extensions.%) v_query OR documents.tool_normalized OPERATOR(extensions.%) v_query )
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
    LIMIT c_count_cap + 1
  )
  SELECT count(*)::integer, coalesce(bool_or(seen.names_it), false)
  INTO v_total, v_named
  FROM seen;

  IF v_total = 0 OR NOT v_named THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_query, v_label, least(v_total, c_count_cap), v_total > c_count_cap;
END;
$function$;

COMMENT ON FUNCTION public.search_starter_entity_offer(text, text, uuid) IS
  'For search_starter: the Posts search pressing an entity runs (the name most of its posts print, lowercased) and what that search finds for p_viewer_user_id narrowed to the entity, counted as search_public_entities counts an offer, to 200, under that name. No row when the search would find nothing. Service role only.';

REVOKE ALL ON FUNCTION public.search_starter_entity_offer(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_starter_entity_offer(text, text, uuid) TO service_role;

CREATE FUNCTION public.search_starter(
  p_viewer_user_id uuid DEFAULT NULL,
  p_terms text[] DEFAULT ARRAY[]::text[],
  p_entity_limit integer DEFAULT 8,
  p_creator_limit integer DEFAULT 6,
  p_search_limit integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The newest posts the entity and creator lists are read from.
  c_window CONSTANT integer := 2000;
  -- The most index entries read to find them.
  c_scan_ceiling CONSTANT integer := 10000;
  -- How many entities are counted in full before the list is cut.
  c_entity_candidates CONSTANT integer := 12;
  -- How many of the most active creators have their followers counted.
  c_creator_candidates CONSTANT integer := 50;
  -- A creator's posts in the window count for this much at most.
  c_creator_post_cap CONSTANT integer := 10;
  -- A creator is offered for a post this recent.
  c_creator_period CONSTANT interval := interval '30 days';
  -- The most hand-picked terms read.
  c_term_cap CONSTANT integer := 20;
  v_entity_limit integer := least(greatest(coalesce(p_entity_limit, 8), 0), 10);
  v_creator_limit integer := least(greatest(coalesce(p_creator_limit, 6), 0), 10);
  v_search_limit integer := least(greatest(coalesce(p_search_limit, 8), 0), 10);
  v_entities jsonb := '[]'::jsonb;
  v_creators jsonb := '[]'::jsonb;
  v_searches jsonb := '[]'::jsonb;
  v_term text;
  v_term_query text;
  v_seen text[] := ARRAY[]::text[];
  v_offered integer := 0;
BEGIN
  IF v_entity_limit > 0 OR v_creator_limit > 0 THEN
    WITH recent AS MATERIALIZED (
      SELECT posts.id AS post_id, posts.user_id AS creator_user_id, posts.created_at
      FROM (
        -- The newest public posts by the index's own order, cut before any
        -- other rule is read: however many of them are labelled, without a
        -- document or blocked, no more than this many are looked at.
        SELECT scanned.id, scanned.user_id, scanned.created_at, scanned.is_nsfw
        FROM public.posts AS scanned
        WHERE scanned.visibility = 'public'
          AND scanned.review_status = 'visible'
          AND scanned.archived_at IS NULL
        ORDER BY scanned.created_at DESC, scanned.id DESC
        LIMIT c_scan_ceiling
      ) AS posts
      WHERE posts.is_nsfw = false
        -- A post search can show: it has a document.
        AND EXISTS (
          SELECT 1
          FROM public.post_search_documents AS documents
          WHERE documents.post_id = posts.id
        )
        -- Neither side of a block with the viewer.
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = p_viewer_user_id
            AND blocks.blocked_user_id = posts.user_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = posts.user_id
            AND blocks.blocked_user_id = p_viewer_user_id
        )
      ORDER BY posts.created_at DESC, posts.id DESC
      LIMIT c_window
    )
    SELECT
      CASE WHEN v_entity_limit = 0 THEN '[]'::jsonb ELSE (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'kind', offered.kind,
          'key', offered.key,
          'label', offered.label,
          'post_count', offered.post_count,
          'post_count_capped', offered.post_count_capped,
          'query', offered.query
        ) ORDER BY offered.post_count DESC, offered.window_posts DESC, offered.kind, offered.key), '[]'::jsonb)
        FROM (
          SELECT
            candidates.kind,
            candidates.key,
            candidates.window_posts,
            counted.query,
            counted.label,
            counted.post_count,
            counted.post_count_capped
          FROM (
            SELECT
              members.kind,
              members.key,
              count(*) AS window_posts
            FROM recent
            JOIN public.post_search_entities AS members ON members.post_id = recent.post_id
            GROUP BY members.kind, members.key
            -- Two creators' unlabelled posts in the window are made with it.
            HAVING count(DISTINCT members.creator_user_id) >= 2
            ORDER BY count(*) DESC, members.kind, members.key
            LIMIT c_entity_candidates
          ) AS candidates
          -- The search pressing it runs and what it finds for this viewer
          -- (search_starter_entity_offer): no row when it finds nothing.
          CROSS JOIN LATERAL public.search_starter_entity_offer(
            candidates.kind,
            candidates.key,
            p_viewer_user_id
          ) AS counted
          -- No withdrawn word in its name or key, read as name_vector reads them.
          WHERE NOT EXISTS (
            SELECT 1
            FROM public.search_suggestion_denylist AS denied
            WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
              'pg_catalog.simple',
              coalesce(public.search_term_variants(counted.label), '') || ' '
                || coalesce(public.search_term_variants(candidates.key), '')
            )))
          )
          ORDER BY counted.post_count DESC, candidates.window_posts DESC, candidates.kind, candidates.key
          LIMIT v_entity_limit
        ) AS offered
      ) END,
      CASE WHEN v_creator_limit = 0 THEN '[]'::jsonb ELSE (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', ranked.creator_user_id,
          'username', ranked.username,
          'display_name', ranked.display_name,
          'bio', ranked.bio,
          'avatar_url', ranked.avatar_url,
          'public_post_count', ranked.public_post_count,
          'is_following', false
        ) ORDER BY ranked.position), '[]'::jsonb)
        FROM (
          SELECT
            active.creator_user_id,
            documents.username,
            documents.display_name,
            documents.bio,
            documents.avatar_url,
            documents.public_post_count,
            row_number() OVER (
              ORDER BY active.recent_posts DESC, audience.follower_count DESC, active.latest_post_at DESC, active.creator_user_id
            ) AS position
          FROM (
            SELECT
              recent.creator_user_id,
              least(count(*), c_creator_post_cap) AS recent_posts,
              max(recent.created_at) AS latest_post_at
            FROM recent
            JOIN public.profiles AS profiles ON profiles.id = recent.creator_user_id
            JOIN auth.users AS users ON users.id = recent.creator_user_id
            WHERE recent.created_at >= now() - c_creator_period
              -- Never the viewer, nor someone they already follow.
              AND recent.creator_user_id IS DISTINCT FROM p_viewer_user_id
              AND NOT EXISTS (
                SELECT 1
                FROM public.follows AS follows
                WHERE follows.follower_id = p_viewer_user_id
                  AND follows.following_id = recent.creator_user_id
              )
              -- An account: never a guest, a suspended account, or one being
              -- deleted or merged away (search_suggest_creators' rule).
              AND users.is_anonymous IS NOT TRUE
              AND (users.banned_until IS NULL OR users.banned_until <= now())
              AND profiles.identity_state = 'active'
              -- Found by creator search: has a document.
              AND EXISTS (
                SELECT 1
                FROM public.creator_search_documents AS documents
                WHERE documents.creator_user_id = recent.creator_user_id
              )
            GROUP BY recent.creator_user_id
            ORDER BY least(count(*), c_creator_post_cap) DESC, max(recent.created_at) DESC, recent.creator_user_id
            LIMIT c_creator_candidates
          ) AS active
          JOIN public.creator_search_documents AS documents
            ON documents.creator_user_id = active.creator_user_id
          CROSS JOIN LATERAL (
            -- Counted up to 1,000, as search_creator_score counts them.
            SELECT count(*)::integer AS follower_count
            FROM (
              SELECT 1
              FROM public.follows AS followers
              WHERE followers.following_id = active.creator_user_id
              LIMIT 1000
            ) AS counted
          ) AS audience
        ) AS ranked
        WHERE ranked.position <= v_creator_limit
      ) END
    INTO v_entities, v_creators;
  END IF;

  IF v_search_limit > 0 THEN
    FOREACH v_term IN ARRAY coalesce(p_terms[1:c_term_cap], ARRAY[]::text[]) LOOP
      EXIT WHEN v_offered >= v_search_limit;
      -- Read as search_public_posts reads a query.
      v_term_query := lower(btrim(regexp_replace(coalesce(v_term, ''), '[[:space:]]+', ' ', 'g')));
      CONTINUE WHEN char_length(v_term_query) < 3 OR char_length(v_term_query) > 100;
      -- A term listed twice, in any case or spacing, is read once.
      CONTINUE WHEN v_term_query = ANY (v_seen);
      v_seen := v_seen || v_term_query;
      -- No withdrawn word, as written, split or joined.
      CONTINUE WHEN EXISTS (
        SELECT 1
        FROM public.search_suggestion_denylist AS denied
        WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
          'pg_catalog.simple',
          coalesce(public.search_term_variants(v_term_query), '')
        )))
      );
      -- At least one post search may show this viewer holds it as typed.
      CONTINUE WHEN NOT public.search_starter_term_finds_post(v_term_query, p_viewer_user_id);
      -- Offered as listed, one space between words.
      v_searches := v_searches || jsonb_build_array(jsonb_build_object(
        'text', btrim(regexp_replace(v_term, '[[:space:]]+', ' ', 'g'))
      ));
      v_offered := v_offered + 1;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'entities', v_entities,
    'creators', v_creators,
    'searches', v_searches
  );
END;
$function$;

COMMENT ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) IS
  'GET /api/search/starter in one call: {entities: [{kind, key, label, post_count, post_count_capped, query}], creators: [{id, username, display_name, bio, avatar_url, public_post_count, is_following}], searches: [{text}]}, each list in the order to show it. Entities and creators are read from the newest 2,000 posts search may show the viewer (at most 10,000 read to find them): entities two creators use there, no withdrawn word, each with the query pressing it searches (the name most of its posts print) and the count search gives that query narrowed to it (to 200), none whose search finds nothing; creators with a post there in the last 30 days, by posts (up to 10), followers, newest post, never a guest, suspended, deleting, blocked, followed account or the viewer. Searches: p_terms, in order, each holding no withdrawn word and matching at least one post search may show. Service role only.';

REVOKE ALL ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) TO service_role;

COMMIT;
