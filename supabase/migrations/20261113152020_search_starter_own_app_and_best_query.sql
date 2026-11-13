-- Search starter, after its first day live (PR #785 follow-up).
--
-- 1. THE APP IS NOT A TOOL TO TRY. Every post made in the app names the app
--    as its tool (posts.source_tool_slug and the Made with row's tool_slug
--    'magicbooklet', 'emptybooklet' before the rebrand; src/lib/source-tools.ts
--    APP_SOURCE_TOOL), so the live starter's first "popular model or tool" was
--    the product itself ("magicbooklet", 27 posts). search_starter now leaves
--    the app's tool out of its candidates, read as isAppSourceToolLabel reads
--    a name (spaces and hyphens aside), before the candidate cut, so it does
--    not take another entity's place. By identity, not through
--    search_suggestion_denylist (production data, and a withdrawn word would
--    take the app out of the typeahead too). Search itself, its Top tab's
--    entities and the typeahead, are unchanged: someone who types "magic" may
--    still be offered posts made here.
--
-- 2. THE QUERY THAT OPENS MORE. A row's query was the name most of its posts
--    print. For a model, that is the catalog's name on the posts that carry a
--    Made with row ("Nano Banana 2.0", 5 posts live); the other posts made
--    with it, creations without such a row, hold only its key's forms in their
--    document ('nano-banana-2', 'nano banana 2', 'nanobanana2'), and the name's
--    "2.0" is a word they do not have, so its search opened 5 posts where a
--    search for "nano" finds 16. search_starter_entity_offer now counts the
--    search for both the printed name and the key, and sends the one that
--    opens more (the printed name on a tie). The count is still exactly that
--    query's search narrowed to the entity, for this viewer, by search's own
--    match, to 200.
--
-- Both functions keep their signatures, settings and grants: CREATE OR
-- REPLACE, so the live route calls them unchanged before and after the code.
-- No table is changed and no lock is taken beyond the functions' own.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.search_starter_entity_offer(
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
  v_candidate text;
  v_best_query text := '';
  v_best_total integer := 0;
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

  -- Two queries are tried, in this order: the name most of its posts print,
  -- and its key. The one whose search opens more of its posts is sent; on a
  -- tie, the printed name, which reads better in the box.
  FOREACH v_candidate IN ARRAY ARRAY[v_label, p_key] LOOP
    -- Read as search_public_posts reads a query.
    v_query := lower(btrim(regexp_replace(v_candidate, '[[:space:]]+', ' ', 'g')));
    CONTINUE WHEN char_length(v_query) < 3 OR char_length(v_query) > 100;
    CONTINUE WHEN v_query = v_best_query;
    v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
    v_tsquery := public.search_query_tsquery(v_query, true);
    v_name_tsquery := public.search_query_tsquery(v_query, false);
    CONTINUE WHEN numnode(v_name_tsquery) = 0;

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

    IF v_named AND v_total > v_best_total THEN
      v_best_query := v_query;
      v_best_total := v_total;
    END IF;
  END LOOP;

  IF v_best_total = 0 THEN
    RETURN;
  END IF;
  RETURN QUERY SELECT v_best_query, v_label, least(v_best_total, c_count_cap), v_best_total > c_count_cap;
END;
$function$;

COMMENT ON FUNCTION public.search_starter_entity_offer(text, text, uuid) IS
  'For search_starter: the Posts search pressing an entity runs, of two tried (the name most of its posts print, and its key, lowercased), the one whose search opens more of its posts for p_viewer_user_id (the printed name on a tie), counted as search_public_entities counts an offer (search_public_posts'' match narrowed to the entity, to 200), under the printed name. No row when neither search would find anything. Service role only.';

REVOKE ALL ON FUNCTION public.search_starter_entity_offer(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_starter_entity_offer(text, text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.search_starter(
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
            -- Never the app itself: every post made here names it as its tool
            -- (source_tool_slug 'magicbooklet', and 'emptybooklet' before the
            -- rebrand), read as isAppSourceToolLabel reads a name (spaces and
            -- hyphens aside), so it does not take a candidate's place.
            WHERE NOT (
              members.kind = 'tool'
              AND replace(members.key, '-', '') IN ('magicbooklet', 'emptybooklet')
            )
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
  'GET /api/search/starter in one call: {entities: [{kind, key, label, post_count, post_count_capped, query}], creators: [{id, username, display_name, bio, avatar_url, public_post_count, is_following}], searches: [{text}]}, each list in the order to show it. Entities and creators are read from the newest 2,000 posts search may show the viewer (at most 10,000 read to find them): entities two creators use there, never the app''s own tool, no withdrawn word, each with the query pressing it searches (its printed name or its key, whichever opens more) and the count search gives that query narrowed to it (to 200), none whose search finds nothing; creators with a post there in the last 30 days, by posts (up to 10), followers, newest post, never a guest, suspended, deleting, blocked, followed account or the viewer. Searches: p_terms, in order, each holding no withdrawn word and matching at least one post search may show. Service role only.';

REVOKE ALL ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) TO service_role;

COMMIT;
