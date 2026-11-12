-- What a search box shows while a person types: creators by handle or name,
-- and words that complete the one being typed.
--
-- /api/search is the only search there is, and both clients run all of it on
-- every keystroke (20261112103547 ranks it). search_suggestions is the light
-- read in front of it, for GET /api/search/suggest: one call, two short lists,
-- no page, no cursor, no log row.
--
-- 1. search_terms, the dictionary a misspelling is read against, gains two
--    counts per word: post_count, the unlabelled public posts whose own text
--    (title, caption, prompt, as public reads show them) holds the word, and
--    creator_count, the different creators among those posts.
--    rebuild_search_terms fills them in the pass it already makes. Which words
--    the table holds, its in_posts and in_recipes flags, its (added, removed)
--    answer, its lock, its rights and its grants are as 20261111231942 left
--    them, so search_corrected_query and the search-dictionary job read what
--    they read before.
-- 2. A word is offered as a completion only when creator_count is 2 or more:
--    one account cannot plant a suggestion, however many posts it makes. The
--    most-shown word comes first.
-- 3. The counts leave out a post whose tool or model name holds the word. A
--    document's text ends with those names ('magicbooklet', 'nano', 'banana',
--    'template', 'workflow'), so counted as they stand the app's own name
--    would complete every 'ma'. The names are the model and tool suggestions'
--    to offer (the entities list, see SEAM below), not a completion's. The
--    names are read exactly as the document reads them: a template result's
--    model is 'template-workflow' here as there, never its own. A count that
--    followed the hidden model would give it away: a word is offered at two
--    creators, so whether one template result counted toward it would say
--    whether its model's name holds the word. And a word is in the table only
--    because a document shows it: the documents stay the one place that says
--    what the public can read (20261111224010, 20261101124828). So no word of
--    a labelled post, a draft, a hidden post, or a paid recipe's caption or
--    prompt can be offered: none is in a document a rebuild reads.
-- 4. search_suggest_completions completes the last word typed. Of several
--    words ('cinematic po') it reads up to 100 unlabelled posts that hold the
--    earlier words as typed and a word starting 'po', and offers the words
--    those posts hold, most-shared first, each only when two different
--    creators' posts among them hold it. So 'cinematic portrait' is offered
--    because posts say both, however many commoner words start with 'po';
--    a completion never leads to an empty search (a post that holds the
--    earlier words and the word matches the phrase as search_public_posts
--    reads it); and one account cannot plant a phrase either.
-- 5. search_suggestion_denylist is how a word is withdrawn: a word in it is
--    never offered, alone or in a phrase, and no phrase is offered to a query
--    that holds it. Two accounts of one person can still plant a word, and
--    without this the only removal was to hide their posts and wait an hour.
--    It touches completions only: a creator's handle is not a word.
-- 6. search_suggest_creators finds creators whose handle or display name
--    starts with what is typed, in the order search_creator_score gives them
--    (the handle is the query, the handle starts with it, the name is the
--    query, the name starts with it; then followers, posts and a follow, as
--    Creators search orders them). Neither side of a block is offered the
--    other. A guest, a suspended account and an account being deleted are
--    never offered. All of that is settled before any cut: it then scores
--    the 200 strongest of those matches, and every match the viewer follows
--    (up to 200 more), so a follow is never lost to the cut.
-- 7. Three btree indexes in text_pattern_ops, which is what lets LIKE 'lu%'
--    read a range of an index in a database whose collation is not C: the
--    trigram indexes that were here serve '%lu%', and a prefix of one or two
--    letters is too short for them.
--
-- STALENESS: the dictionary is rebuilt hourly, so a word is offered for up to
-- an hour after the last post that showed it stopped being public. It was
-- public text when it was read, and a completion names no post.
--
-- SEAM (model and tool suggestions): search_suggestions answers
-- {creators, completions}. An `entities` list (models, tools) joins as a third
-- key, built from the single source of entities, without changing the other
-- two; the place is marked in the function.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- The rebuild's own lock first, so the rebuild at the end of this file is the
-- one that runs: a search-dictionary job that had started would hold it, wait
-- for the table below, and leave the last statement here to find the lock
-- taken and do nothing, with the new counts empty until the next hour. The
-- job takes this lock and then the table, the order taken here.
SELECT pg_advisory_xact_lock(hashtext('public.rebuild_search_terms'));

-- The creators' documents for their two indexes (SHARE, which CREATE INDEX
-- takes: reads go on, a profile or post save waits for this file), then the
-- dictionary last, as 20261111231942 takes it, for its new columns. This file
-- takes no lock on posts, the recipes or their documents, so a save that
-- holds one of those and waits here is never waited for in turn.
LOCK TABLE public.creator_search_documents IN SHARE MODE;
LOCK TABLE public.search_terms IN ACCESS EXCLUSIVE MODE;

-- ─── 1. The dictionary counts who shows a word ──────────────────────────────

ALTER TABLE public.search_terms
  ADD COLUMN post_count integer NOT NULL DEFAULT 0,
  ADD COLUMN creator_count integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT search_terms_counts_hold CHECK (
    post_count >= 0 AND creator_count >= 0 AND creator_count <= post_count
  );

COMMENT ON TABLE public.search_terms IS
  'Backend-owned dictionary for search spelling correction and typeahead completions: lowercase words of 4 to 40 letters that unlabelled public posts or listed recipes show, flagged by which and counted by how many posts and creators write them, kept to exactly those by rebuild_search_terms (the search-dictionary job). Words and counts only, never which post or recipe held them.';
COMMENT ON COLUMN public.search_terms.post_count IS
  'Unlabelled public posts whose title, caption or prompt, as public reads show them, holds the word. A post whose tool or model name holds it is not counted. 0 for a word only names or recipes show.';
COMMENT ON COLUMN public.search_terms.creator_count IS
  'The different creators among the posts post_count counts. A word is offered as a typeahead completion only at 2 or more, so one account cannot plant one.';

-- Not partial and with no count in it: an index that named post_count or
-- creator_count would end the in-place (HOT) update of a word whose count
-- moved, and every hourly rebuild would write the trigram index again for it.
CREATE INDEX search_terms_term_prefix_idx
  ON public.search_terms (term text_pattern_ops);

CREATE OR REPLACE FUNCTION public.rebuild_search_terms()
RETURNS TABLE(added integer, removed integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_added integer;
  v_removed integer;
BEGIN
  -- One rebuild at a time: a second one finds nothing left to do.
  IF NOT pg_try_advisory_xact_lock(hashtext('public.rebuild_search_terms')) THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- The words the documents of unlabelled posts show now. A document exists
  -- only for a public, unarchived, visible post, and holds its text as public
  -- reads show it, so no word comes from a paid recipe's caption or prompt.
  -- And the words listed recipes' cards show (20261111231942): a recipe's
  -- document holds only what a visitor who has not unlocked it sees, never
  -- its items or cards, and a recipe is listable only when published on a
  -- public, visible, unlabelled post and past the quality gate. Each word
  -- is flagged with the surfaces that show it.
  --
  -- A post's word is `written` when none of the post's tool or model names
  -- holds it: it then came from the title, caption or prompt, the rest of
  -- the document's text. Only written words are counted (post_count,
  -- creator_count). The names are the ones the document itself holds
  -- (refresh_post_search_documents): a template result's model is
  -- 'template-workflow', never its own, which no public read shows. Reading
  -- the real one here would let a count, and so whether a word is offered,
  -- say whether a hidden model's name holds that word. Counted by creator
  -- first and then by word: two hash aggregates, where a count of distinct
  -- creators would sort each word.
  --
  -- Which lexemes are words (letters, 4 to 40) is asked once per lexeme,
  -- after the counting, not once per post that shows it: on 5,000 posts that
  -- test was 540 ms of a 970 ms rebuild (local replay, 2026-11-12). counted
  -- is MATERIALIZED so the planner cannot push the test back under the
  -- aggregates.
  WITH post_lexemes AS (
    SELECT
      words.lexeme AS term,
      documents.creator_user_id,
      NOT (words.lexeme = ANY (names.words)) AS written
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    LEFT JOIN public.generations AS generations ON generations.id = posts.generation_id
    CROSS JOIN LATERAL (
      SELECT tsvector_to_array(to_tsvector(
        'pg_catalog.simple',
        coalesce(string_agg(public.search_term_variants(named.name), ' '), '')
      )) AS words
      FROM (
        SELECT posts.source_tool AS name
        UNION ALL
        SELECT posts.source_tool_slug
        UNION ALL
        SELECT CASE
          WHEN generations.template_run_id IS NOT NULL OR generations.template_run_step_id IS NOT NULL
            THEN 'template-workflow'
          ELSE generations.model
        END
        UNION ALL
        SELECT unnest(ARRAY[tools.tool_label, tools.tool_slug, tools.model_label, tools.model_slug])
        FROM public.post_source_tools AS tools
        WHERE tools.post_id = posts.id
      ) AS named
    ) AS names
    CROSS JOIN LATERAL unnest(to_tsvector('pg_catalog.simple', documents.search_text)) AS words
    WHERE posts.is_nsfw = false
  ),
  creator_words AS (
    SELECT
      post_lexemes.term,
      count(*) FILTER (WHERE post_lexemes.written) AS written_posts
    FROM post_lexemes
    GROUP BY post_lexemes.term, post_lexemes.creator_user_id
  ),
  counted AS MATERIALIZED (
    SELECT
      creator_words.term,
      sum(creator_words.written_posts)::integer AS post_count,
      (count(*) FILTER (WHERE creator_words.written_posts > 0))::integer AS creator_count
    FROM creator_words
    GROUP BY creator_words.term
  ),
  post_words AS (
    SELECT counted.term, counted.post_count, counted.creator_count
    FROM counted
    WHERE counted.term ~ '^[[:alpha:]]{4,40}$'
  ),
  recipe_words AS (
    SELECT DISTINCT words.lexeme AS term
    FROM public.marketplace_bundle_search_documents AS recipe_documents
    JOIN public.marketplace_bundle_listings AS listings
      ON listings.bundle_id = recipe_documents.bundle_id
      AND listings.listable
    CROSS JOIN LATERAL unnest(to_tsvector('pg_catalog.simple', recipe_documents.search_text)) AS words
    WHERE words.lexeme ~ '^[[:alpha:]]{4,40}$'
  ),
  shown AS (
    SELECT
      coalesce(post_words.term, recipe_words.term) AS term,
      coalesce(post_words.post_count, 0) AS post_count,
      coalesce(post_words.creator_count, 0) AS creator_count,
      post_words.term IS NOT NULL AS in_posts,
      recipe_words.term IS NOT NULL AS in_recipes
    FROM post_words
    FULL JOIN recipe_words ON recipe_words.term = post_words.term
  ),
  gone AS (
    DELETE FROM public.search_terms AS terms
    WHERE NOT EXISTS (SELECT 1 FROM shown WHERE shown.term = terms.term)
    RETURNING 1
  ),
  arrived AS (
    INSERT INTO public.search_terms AS terms (term, in_posts, in_recipes, post_count, creator_count)
    SELECT shown.term, shown.in_posts, shown.in_recipes, shown.post_count, shown.creator_count
    FROM shown
    ON CONFLICT (term) DO UPDATE
      SET in_posts = excluded.in_posts, in_recipes = excluded.in_recipes,
          post_count = excluded.post_count, creator_count = excluded.creator_count
      WHERE (terms.in_posts, terms.in_recipes, terms.post_count, terms.creator_count)
        IS DISTINCT FROM (excluded.in_posts, excluded.in_recipes, excluded.post_count, excluded.creator_count)
  )
  -- Every part of the statement reads the table as it stood before it, so
  -- the words added are the shown words it did not hold.
  SELECT
    (SELECT count(*) FROM shown
     WHERE NOT EXISTS (SELECT 1 FROM public.search_terms AS known WHERE known.term = shown.term)),
    (SELECT count(*) FROM gone)
  INTO v_added, v_removed;

  RETURN QUERY SELECT v_added, v_removed;
END;
$function$;

COMMENT ON FUNCTION public.rebuild_search_terms() IS
  'Makes search_terms exactly the words unlabelled public posts and listed recipes show now, with how many posts and creators write each, and says how many words it added and removed. Run by the search-dictionary backend job; no post or recipe save writes the table.';

REVOKE ALL ON FUNCTION public.rebuild_search_terms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_search_terms() TO service_role;

-- ─── 2. Completions ─────────────────────────────────────────────────────────

-- The words an operator has withdrawn from completions. Written by hand, by
-- the service role (the runbook's "Search Suggestions" gives the statement);
-- nothing in the app writes it. Small and read on every completion, by key.
CREATE TABLE public.search_suggestion_denylist (
  term text PRIMARY KEY CHECK (term ~ '^[^[:space:]]{1,40}$' AND term = lower(term)),
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.search_suggestion_denylist ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing.
REVOKE ALL ON TABLE public.search_suggestion_denylist FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.search_suggestion_denylist TO service_role;

COMMENT ON TABLE public.search_suggestion_denylist IS
  'Words withdrawn from typeahead completions by an operator: a lowercase word, why, and when. search_suggest_completions never offers one, alone or in a phrase, and offers no phrase to a query that holds one. Search itself, spelling correction and creator suggestions do not read it.';

CREATE FUNCTION public.search_suggest_completions(
  p_query text,
  p_limit integer DEFAULT 6
)
RETURNS TABLE(completion text)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  -- A completion needs two different creators (search_terms.creator_count).
  c_min_creators CONSTANT integer := 2;
  -- Of several words: how many posts that match what is typed are read for
  -- the words they hold. The ceiling on what one call can read.
  c_phrase_posts_read CONSTANT integer := 100;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_limit integer := least(greatest(coalesce(p_limit, 6), 0), 10);
  v_last text;
  v_head text;
BEGIN
  IF v_limit = 0 OR char_length(v_query) < 2 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;

  -- The word being typed, and what was typed before it.
  v_last := substring(v_query FROM '[^ ]+$');
  -- Letters only, two or more: the dictionary holds words of letters, and a
  -- %, an _ or a \ never reaches the LIKE below, so none is a wildcard.
  IF v_last IS NULL OR v_last !~ '^[[:alpha:]]{2,39}$' THEN
    RETURN;
  END IF;
  v_head := btrim(left(v_query, char_length(v_query) - char_length(v_last)));

  IF v_head = '' THEN
    -- One word: the words posts write that start with it, most-shown first.
    -- Search finds each: a document shows it (the simple reading of its text
    -- is in its vector).
    RETURN QUERY
    SELECT terms.term
    FROM public.search_terms AS terms
    WHERE terms.term LIKE v_last || '%'
      AND terms.term <> v_last
      AND terms.in_posts
      AND terms.creator_count >= c_min_creators
      AND NOT EXISTS (
        SELECT 1 FROM public.search_suggestion_denylist AS denied WHERE denied.term = terms.term
      )
    ORDER BY terms.post_count DESC, terms.creator_count DESC, terms.term
    LIMIT v_limit;
    RETURN;
  END IF;

  -- A query that holds a withdrawn word is offered no phrase: every phrase
  -- would repeat the word. Its words as documents hold them, whole and split.
  IF EXISTS (
    SELECT 1
    FROM public.search_suggestion_denylist AS denied
    WHERE denied.term = ANY (tsvector_to_array(
      to_tsvector('pg_catalog.simple', v_head)
        || to_tsvector('pg_catalog.simple', public.search_split_terms(v_head))
    ))
  ) THEN
    RETURN;
  END IF;

  -- Several words: the posts that hold the earlier words and a word starting
  -- as the last one does, and the words they hold that start so. The posts
  -- are matched on the simple reading alone (search_query_tsquery without
  -- stems: the words as typed, or split), which is what makes every phrase
  -- offered one that search finds: a post that holds the earlier words as
  -- typed and the word W matches 'earlier W' in search_public_posts' own
  -- reading, of which the simple one is a part. A word counts for a phrase
  -- when two creators' posts among those read hold it, the same rule as for
  -- a word alone, and it must be a word the dictionary offers alone.
  RETURN QUERY
  WITH matched AS (
    SELECT documents.creator_user_id, documents.search_vector
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE posts.is_nsfw = false
      AND documents.search_vector @@ public.search_query_tsquery(v_head || ' ' || v_last, false)
    LIMIT c_phrase_posts_read
  ),
  found AS (
    SELECT
      lexemes.lexeme AS term,
      count(*) AS posts,
      count(DISTINCT matched.creator_user_id) AS creators
    FROM matched
    CROSS JOIN LATERAL unnest(tsvector_to_array(matched.search_vector)) AS lexemes(lexeme)
    WHERE lexemes.lexeme LIKE v_last || '%'
      AND lexemes.lexeme <> v_last
    GROUP BY lexemes.lexeme
  )
  SELECT v_head || ' ' || found.term
  FROM found
  JOIN public.search_terms AS terms ON terms.term = found.term
  WHERE found.creators >= c_min_creators
    AND terms.in_posts
    AND terms.creator_count >= c_min_creators
    AND NOT EXISTS (
      SELECT 1 FROM public.search_suggestion_denylist AS denied WHERE denied.term = found.term
    )
  ORDER BY found.posts DESC, terms.post_count DESC, found.term
  LIMIT v_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_suggest_completions(text, integer) IS
  'Typeahead completions of the last word of a query: words that unlabelled public posts of two or more creators write (search_terms), most-shown first; of several words, the words that posts holding the earlier ones hold, each only when two creators'' posts hold it. Never a word in search_suggestion_denylist. Nothing for a last word under two letters or holding anything but letters. At most 10.';

-- ─── 3. Creators ────────────────────────────────────────────────────────────

CREATE INDEX creator_search_documents_username_prefix_idx
  ON public.creator_search_documents (username_normalized text_pattern_ops);
CREATE INDEX creator_search_documents_display_name_prefix_idx
  ON public.creator_search_documents (display_name_normalized text_pattern_ops);

-- SECURITY DEFINER: it reads auth.users (who is a guest, who is suspended),
-- which service_role may not.
CREATE FUNCTION public.search_suggest_creators(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_handles_only boolean DEFAULT false,
  p_limit integer DEFAULT 5
)
RETURNS TABLE(
  creator_user_id uuid,
  username text,
  display_name text,
  avatar_url text,
  is_following boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The strongest matches scored, and as many again of those the viewer
  -- follows: past these, the rest (the weakest tier's least active, none of
  -- them followed unless the viewer follows more than this many matches) are
  -- not scored.
  c_candidates CONSTANT integer := 200;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_limit integer := least(greatest(coalesce(p_limit, 5), 0), 10);
  v_handles_only boolean := coalesce(p_handles_only, false);
  -- LIKE patterns are built by concatenation, so a %, an _ or a \ typed
  -- must match itself: '%' must not become every creator.
  v_like text;
  v_tsquery tsquery;
BEGIN
  IF v_limit = 0 OR char_length(v_query) < 1 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- Names are not stemmed (search_public_creators).
  v_tsquery := public.search_query_tsquery(v_query, false);

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    -- Everyone the query matches who may be offered to this viewer, settled
    -- before any cut, so a list is short only when the matches are.
    SELECT
      documents.creator_user_id,
      documents.public_post_count,
      -- search_creator_score's tiers, read off the document alone.
      CASE
        WHEN documents.username_normalized = v_query THEN 4
        WHEN documents.username_normalized LIKE v_like THEN 3
        WHEN documents.display_name_normalized = v_query THEN 2
        ELSE 1
      END AS tier,
      viewer.is_following
    FROM public.creator_search_documents AS documents
    JOIN public.profiles AS profiles ON profiles.id = documents.creator_user_id
    JOIN auth.users AS users ON users.id = documents.creator_user_id
    CROSS JOIN LATERAL (
      SELECT EXISTS (
        SELECT 1
        FROM public.follows AS follows
        WHERE follows.follower_id = p_viewer_user_id
          AND follows.following_id = documents.creator_user_id
      ) AS is_following
    ) AS viewer
    WHERE (
        documents.username_normalized LIKE v_like
        OR (NOT v_handles_only AND documents.display_name_normalized LIKE v_like)
      )
      -- A creator is an account: never a guest's anonymous session, a
      -- suspended account (admin_user_sanctions sets banned_until) or one
      -- being deleted or merged away, whose page answers 404.
      AND users.is_anonymous IS NOT TRUE
      AND (users.banned_until IS NULL OR users.banned_until <= now())
      AND profiles.identity_state = 'active'
      -- Neither side of a block is offered the other
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
  ),
  candidates AS (
    -- The strongest matches, and every match the viewer follows: a follow
    -- lifts a creator in the score below, which it could not do for one the
    -- first cut had left out.
    (
      SELECT eligible.creator_user_id, eligible.is_following
      FROM eligible
      ORDER BY eligible.tier DESC, eligible.public_post_count DESC, eligible.creator_user_id
      LIMIT c_candidates
    )
    UNION
    (
      SELECT eligible.creator_user_id, eligible.is_following
      FROM eligible
      WHERE eligible.is_following
      ORDER BY eligible.tier DESC, eligible.public_post_count DESC, eligible.creator_user_id
      LIMIT c_candidates
    )
  ),
  scored AS (
    SELECT
      documents.creator_user_id,
      documents.username,
      documents.display_name,
      documents.avatar_url,
      candidates.is_following,
      -- As search_public_creators scores a creator, so the two agree on who
      -- comes first. A name is matched here from its start only.
      public.search_creator_score(
        documents.username_normalized = v_query,
        documents.username_normalized LIKE v_like,
        NOT v_handles_only AND shown.display_name = v_query,
        NOT v_handles_only AND shown.display_name LIKE v_like,
        ts_rank_cd(documents.search_vector, v_tsquery, 1 | 32),
        greatest(
          extensions.similarity(documents.username_normalized, v_query),
          extensions.similarity(documents.display_name_normalized, v_query),
          extensions.word_similarity(v_query, documents.username_normalized),
          extensions.word_similarity(v_query, documents.display_name_normalized)
        ),
        audience.follower_count,
        documents.public_post_count,
        candidates.is_following
      ) AS search_score
    FROM candidates
    JOIN public.creator_search_documents AS documents
      ON documents.creator_user_id = candidates.creator_user_id
    CROSS JOIN LATERAL (
      -- The name as the query is read (search_public_creators).
      SELECT CASE
        WHEN documents.display_name_normalized ~ '  |[^ -~]' THEN lower(btrim(regexp_replace(
          normalize(documents.display_name_normalized, NFKC), '[[:space:]]+', ' ', 'g'
        )))
        ELSE documents.display_name_normalized
      END AS display_name
    ) AS shown
    CROSS JOIN LATERAL (
      -- Counted up to 1,000, where the audience term is full (search_creator_score).
      SELECT count(*)::integer AS follower_count
      FROM (
        SELECT 1
        FROM public.follows AS followers
        WHERE followers.following_id = documents.creator_user_id
        LIMIT 1000
      ) AS counted
    ) AS audience
  )
  SELECT
    scored.creator_user_id,
    scored.username,
    scored.display_name,
    scored.avatar_url,
    scored.is_following
  FROM scored
  ORDER BY scored.search_score DESC, scored.creator_user_id ASC
  LIMIT v_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_suggest_creators(text, uuid, boolean, integer) IS
  'Typeahead creators: those whose handle or display name starts with the query (handles alone with p_handles_only), ordered by search_creator_score as Creators search orders them, the viewer''s follow marked and never lost to the candidate cut. Never a guest, a suspended account, one being deleted, or either side of a block with the viewer. At most 10.';

-- ─── 4. The one call the route makes ────────────────────────────────────────

CREATE FUNCTION public.search_suggestions(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_handles_only boolean DEFAULT false,
  p_creator_limit integer DEFAULT 5,
  p_completion_limit integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT jsonb_build_object(
    'creators', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', creators.creator_user_id,
        'username', creators.username,
        'display_name', creators.display_name,
        'avatar_url', creators.avatar_url,
        'is_following', creators.is_following
      ) ORDER BY creators.position)
      FROM public.search_suggest_creators(p_query, p_viewer_user_id, p_handles_only, p_creator_limit)
        WITH ORDINALITY AS creators(creator_user_id, username, display_name, avatar_url, is_following, position)
    ), '[]'::jsonb),
    -- A query typed as a handle ('@lu') asks for people, not words.
    'completions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('text', completions.completion) ORDER BY completions.position)
      FROM public.search_suggest_completions(p_query, p_completion_limit)
        WITH ORDINALITY AS completions(completion, position)
      WHERE NOT coalesce(p_handles_only, false)
    ), '[]'::jsonb)
    -- SEAM (model and tool suggestions): 'entities', a third key, joins here.
  );
$function$;

COMMENT ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer) IS
  'GET /api/search/suggest in one call: {creators: [{id, username, display_name, avatar_url, is_following}], completions: [{text}]}, each list in the order to show it. Creators from search_suggest_creators, completions from search_suggest_completions (none for a handles-only query).';

REVOKE ALL ON FUNCTION public.search_suggest_completions(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_suggest_creators(text, uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggest_completions(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_suggest_creators(text, uuid, boolean, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer) TO service_role;

-- ─── The dictionary, with its counts ────────────────────────────────────────

SELECT * FROM public.rebuild_search_terms();

COMMIT;
