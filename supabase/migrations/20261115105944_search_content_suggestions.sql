-- Suggestions and popular lists made from content (search benchmark
-- 2026-11-15, gaps 1, 2, 3 and 7).
--
-- The box felt empty: `suggest?q=por` answered one completion, `q=ne` none,
-- and the start screen was two models, four creators and eight hand-picked
-- words with no picture. The products it was measured against fill theirs
-- from search logs; ours has almost no search traffic, so everything here is
-- made from what public posts show, and from nothing else.
--
-- 1. PHRASES. public.search_phrases holds the two- and three-word phrases
--    unlabelled public posts show, and the names of the models and tools they
--    are made with, each only while posts of two different creators hold it
--    (the rule a word already follows: one account cannot plant a
--    suggestion). A table of its own, not rows of search_terms: that table is
--    the spelling dictionary, held to single words of letters by a check and
--    read whole by search_corrected_query, which must never correct a word
--    to a phrase.
--      phrase            lowercase words, one space between them
--      words             its words as a vector (generated): what typed text
--                        is matched against, every typed word in it and the
--                        last a prefix of any of its words
--      core              the phrase less its stop words
--      in_text, is_name  whether posts write it, and whether it is a model's
--                        or tool's name
--      post_count, creator_count
--                        the unlabelled public posts that hold it, and the
--                        different creators among them (2 or more)
--      recent_weight     those posts counted with a 30-day half-life
--      week_activity     what those posts gained in the last 7 days (below)
--      picture_post_ids  up to 8 of those posts that have a picture, the
--                        most saved, commented and remixed first
--    WHERE A PHRASE COMES FROM. search_text_phrases reads the first 500
--    characters of a post's search document text (post_search_documents.
--    search_text: the title, the caption and the prompt exactly as public
--    reads show them, 20261101124828 and 20261111224010), so no phrase comes
--    from a labelled, private, hidden or archived post, or from a paid
--    recipe's caption or prompt: none of that is in a document a rebuild
--    reads. Words next to each other inside one run of text between
--    punctuation; a phrase neither starts nor ends on a stop word, and no
--    word of it is one of that post's own tool or model names (read as the
--    dictionary reads them: a template result's model is 'template-workflow',
--    never its own). A name comes from post_search_entities, which holds no
--    model for a template result, and never the app's own name.
--
-- 2. POPULARITY. public.search_popularity holds, for each model, tool and
--    creator, one row per creator: their unlabelled public posts, what those
--    gained in the last 7 days (new posts, counted to 10 a creator, plus the
--    saves and the commenters they received from other accounts; there is no
--    separate like: a save is the heart a card shows) and a week's average
--    over the three weeks before, and that creator's best pictured post.
--    Kept per creator so a list is added up for one viewer without the
--    creators on either side of a block with them.
--
-- 3. rebuild_search_phrases makes both tables exactly that, adding, changing
--    and removing. The search-dictionary job calls it after
--    rebuild_search_terms, as a call of its own: the app live before this
--    file's code does not call it, and reads neither table.
--
-- 4. COMPLETIONS (search_suggest_completions). Words as before, and now
--    phrases: every typed word is in the phrase and the last is a prefix of
--    one of its words ('port' and 'cinematic po' both offer 'cinematic
--    portrait'). A phrase the typed text starts comes first, then by
--    recent_weight; at most three single words stand ahead of the phrases.
--    When nothing completes the text as typed, its misspelt words are read
--    as search reads them (search_corrected_query) and that reading is
--    completed. Never a phrase that holds a withdrawn word
--    (search_suggestion_denylist). For a viewer with a block, each completion
--    is offered only while two posts that viewer may see hold its words.
--
-- 5. CREATORS (search_suggest_creators) are also found by any word of the
--    display name, from two typed characters. A handle query (@x) is still
--    the handle's start alone. Models and tools were already matched on any
--    word of their name (post_search_entities.name_vector).
--
-- 6. PICTURES. search_post_picture answers the cover preview of a post a
--    search may show the viewer (public, visible, unarchived, unlabelled,
--    with a search document, neither side of a block): the stored preview's
--    path, thumbhash and size, which the route turns into the same URL a
--    post result carries. search_suggestions gives each entity one,
--    search_starter each entity and each search. A picture is read from the
--    candidates a rebuild kept and checked again at the read, so it is
--    always of a post pressing the row finds now.
--
-- 7. POPULAR THIS WEEK (search_starter). Models and tools, and creators, are
--    ordered by their week against their own three weeks before; with fewer
--    than three rows active this week a list is the all-time one it was.
--    Searches are the phrases with the most activity, then the hand-picked
--    terms until there are six. `periods` says which each list is. Every
--    field the route live today reads keeps its name and meaning.
--
-- 8. RELATED SEARCHES (search_related_searches): the phrases and names at
--    least two posts of a result page hold, for /api/search?relatedSearches=1.
--    A function of its own, so search_public_posts is not touched.
--
-- 9. CATALOG MODELS IN THE TYPEAHEAD (owner, 2026-11-15: typing "see" must
--    offer Seedance). `suggest?q=see` answered nothing while a search for
--    "seedance" found a tool one creator names and our own Seedance model on
--    another creator's post: a typeahead entity needed unlabelled posts of
--    two creators (20261112192423), and each had one. That rule is there so
--    one account cannot plant a made-up name; a model of the product's own
--    public catalog is ours and already public, so it is exempt. The source
--    is the catalog's public projection as /api/model-catalog/v1 reads it:
--    the entries of the active release (the newest by schema version) that
--    are enabled on the web or in the app, by their public displayName. A
--    model no longer in that release, or switched off on both, is not a
--    catalog model here. search_suggestions gains a sixth parameter:
--      p_catalog = false (the code and the apps live today): a catalog model
--        search itself answers for the query is offered though one creator
--        alone uses it. Nothing else changes, so a row still opens posts.
--      p_catalog = true (a client that sends catalog=1 and knows what to do
--        with a row that has no posts): every catalog model with a word of
--        its name or id starting with the typed text is offered, from two
--        characters, with the posts this viewer may see that are made with
--        it (0 when none) and the `query` whose Posts search, narrowed to
--        it, opens exactly those.
--    Every entity row says `in_catalog`, and a catalog model's row its id,
--    kind and platforms. A catalog model the text starts stands first, then
--    the rest, most posts first. The word "seedance" is still no completion
--    there, by the dictionary's own rule: a word is counted only where a
--    post writes it, never where it is the post's tool or model name, so
--    both posts count for nothing; the entity row is what offers it.
--
-- THE RELEASE WINDOW. Migrations apply before the new app is promoted. The
-- app live meanwhile calls search_suggestions and search_starter by name
-- with the parameters they keep, and reads the keys they keep; the new keys
-- (`thumbnail`, `periods`, `in_catalog`, `catalog_model`, `query`) are
-- additions it does not read. search_suggestions is dropped and re-created
-- in this transaction with p_catalog last and false by default, so the
-- five-argument named call resolves to it and PostgREST sees one function.
-- search_suggest_completions gains a third parameter with a default; only
-- search_suggestions calls it. rebuild_search_terms is untouched.
--
-- STALENESS. Both tables are rebuilt hourly, so a phrase is offered, and a
-- week's order stands, for up to an hour after the posts behind it changed.
-- A phrase was public text when it was read and names no post; a picture is
-- checked against the post as it is at the read.
--
-- LOCKS. The index on creator_search_documents takes SHARE (reads go on, a
-- profile save waits for this file). Nothing here locks posts.
BEGIN;
SET LOCAL lock_timeout = '5s';

LOCK TABLE public.creator_search_documents IN SHARE MODE;

-- ─── 1. The tables ──────────────────────────────────────────────────────────

CREATE TABLE public.search_phrases (
  phrase text PRIMARY KEY CHECK (
    phrase = lower(phrase)
    AND char_length(phrase) BETWEEN 2 AND 60
    AND phrase ~ '^[^[:space:]]+( [^[:space:]]+){0,3}$'
  ),
  -- STORED and generated: what typed text is matched against.
  words tsvector GENERATED ALWAYS AS (to_tsvector('pg_catalog.simple', phrase)) STORED,
  core text NOT NULL CHECK (char_length(core) BETWEEN 1 AND 60),
  in_text boolean NOT NULL,
  is_name boolean NOT NULL,
  post_count integer NOT NULL CHECK (post_count >= 2),
  creator_count integer NOT NULL CHECK (creator_count >= 2),
  recent_weight real NOT NULL CHECK (recent_weight >= 0),
  week_activity real NOT NULL CHECK (week_activity >= 0),
  picture_post_ids uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT search_phrases_counts_hold CHECK (creator_count <= post_count),
  CONSTRAINT search_phrases_from_somewhere CHECK (in_text OR is_name)
);

-- No count in it: an index that named one would end the in-place update of a
-- phrase whose count moved (search_terms_term_prefix_idx, 20261112144018).
CREATE INDEX search_phrases_words_idx
  ON public.search_phrases USING gin (words);

ALTER TABLE public.search_phrases ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing.
REVOKE ALL ON TABLE public.search_phrases FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.search_phrases TO service_role;

COMMENT ON TABLE public.search_phrases IS
  'Backend-owned: the two- and three-word phrases unlabelled public posts show and the names of the models and tools they are made with, each held by posts of two or more creators, with how many posts hold it, how recent they are, what they gained this week and up to 8 of them that have a picture. Kept to exactly that by rebuild_search_phrases (the search-dictionary job). Typeahead completions, the starter''s searches and related searches read it.';
COMMENT ON COLUMN public.search_phrases.core IS
  'The phrase less its english stop words (the phrase itself when every word is one).';
COMMENT ON COLUMN public.search_phrases.recent_weight IS
  'The posts that hold the phrase, each counted 0.5 ^ (its age in days / 30).';
COMMENT ON COLUMN public.search_phrases.week_activity IS
  'What the posts that hold the phrase gained in the 7 days before the rebuild: 1 for a post made then, plus the saves and the commenters it received then from accounts other than its creator.';
COMMENT ON COLUMN public.search_phrases.picture_post_ids IS
  'Up to 8 of the posts that hold the phrase whose cover has a ready preview, the most saved, commented and remixed first. A read checks each again before it draws one.';

CREATE TABLE public.search_popularity (
  subject text NOT NULL CHECK (subject IN ('model', 'tool', 'creator')),
  -- A model's or tool's key (post_search_entities.key); '*' on a creator's own row.
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 80),
  creator_user_id uuid NOT NULL,
  post_count integer NOT NULL CHECK (post_count >= 1),
  week_activity real NOT NULL CHECK (week_activity >= 0),
  base_activity real NOT NULL CHECK (base_activity >= 0),
  picture_post_id uuid,
  picture_score real NOT NULL DEFAULT 0,
  PRIMARY KEY (subject, key, creator_user_id),
  CONSTRAINT search_popularity_creator_key CHECK ((subject = 'creator') = (key = '*'))
);

ALTER TABLE public.search_popularity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.search_popularity FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.search_popularity TO service_role;

COMMENT ON TABLE public.search_popularity IS
  'Backend-owned: for each model and tool unlabelled public posts are made with, and for each creator of such posts, one row per creator: their posts, what those gained in the last 7 days, a week''s average over the 3 weeks before, and their best pictured post. Kept to exactly that by rebuild_search_phrases (the search-dictionary job), so a row of a deleted account is gone within the hour; no read shows a row without reading the account and the post as they are. The starter''s weekly lists and the pictures of models and tools read it, added up for one viewer without the creators blocked with them.';
COMMENT ON COLUMN public.search_popularity.week_activity IS
  'In the 7 days before the rebuild: the creator''s new posts (counted to 10), plus the saves and the commenters those posts received from other accounts.';
COMMENT ON COLUMN public.search_popularity.base_activity IS
  'The same over the 21 days before that (new posts counted to 30), divided by 3: an average week.';
COMMENT ON COLUMN public.search_popularity.picture_post_id IS
  'The creator''s post for this model or tool whose cover has a ready preview and that is saved, commented and remixed most. NULL on a creator''s own row and when none has a picture.';

-- ─── 2. How text is read into phrases ───────────────────────────────────────

-- plpgsql, so its plan is kept: a rebuild calls it once per post, and as a
-- sql function with a SET clause it would be planned anew at every call
-- (post_search_entity_rows, 20261112174210).
CREATE FUNCTION public.search_text_phrases(p_text text)
RETURNS TABLE(phrase text)
LANGUAGE plpgsql
STABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
DECLARE
  -- How much of a text is read: its title and the start of its caption or
  -- prompt. A prompt can run to thousands of words, and every word read is
  -- two rows for a rebuild to count.
  c_chars CONSTANT integer := 500;
  v_text text := lower(coalesce(p_text, ''));
BEGIN
  IF char_length(v_text) > c_chars THEN
    -- Cut at a space, never inside a word.
    v_text := regexp_replace(left(v_text, c_chars), '[^[:space:]]*$', '');
  END IF;
  -- An apostrophe is part of its word; a hyphen, an underscore and a slash
  -- part words. Every other character that is not a letter, a digit or a
  -- space ends a run: no phrase crosses a comma, a full stop or a line break.
  v_text := regexp_replace(regexp_replace(v_text, '[''’]', '', 'g'), '[-_/]', ' ', 'g');

  RETURN QUERY
  WITH tokens AS (
    SELECT
      runs.run,
      spoken.place,
      spoken.word,
      -- A word of a phrase is letters only: a number ('8k', '2025') ends one.
      spoken.word ~ '^[[:alpha:]]{2,24}$' AS is_word
    FROM regexp_split_to_table(v_text, '[^[:alnum:] ]+') WITH ORDINALITY AS runs(content, run)
    CROSS JOIN LATERAL regexp_split_to_table(btrim(runs.content), ' +') WITH ORDINALITY AS spoken(word, place)
    WHERE spoken.word <> ''
  ),
  marked AS (
    SELECT
      tokens.run,
      tokens.place,
      tokens.word,
      tokens.is_word,
      -- Not a stop word: the english configuration keeps a lexeme of it.
      tokens.is_word AND length(to_tsvector('pg_catalog.english', tokens.word)) > 0 AS is_content
    FROM tokens
  ),
  chained AS (
    SELECT
      marked.word,
      marked.is_content,
      lead(marked.word, 1) OVER following AS second_word,
      lead(marked.is_word, 1) OVER following AS second_is_word,
      lead(marked.is_content, 1) OVER following AS second_is_content,
      lead(marked.word, 2) OVER following AS third_word,
      lead(marked.is_content, 2) OVER following AS third_is_content
    FROM marked
    WINDOW following AS (PARTITION BY marked.run ORDER BY marked.place)
  )
  SELECT DISTINCT found.gram
  FROM (
    -- Two words, neither a stop word.
    SELECT chained.word || ' ' || chained.second_word AS gram
    FROM chained
    WHERE chained.is_content AND chained.second_is_content AND chained.word <> chained.second_word
    UNION ALL
    -- Three words: the outer two are not stop words, the middle one may be
    -- ('queen of hearts').
    SELECT chained.word || ' ' || chained.second_word || ' ' || chained.third_word
    FROM chained
    WHERE chained.is_content AND chained.second_is_word AND chained.third_is_content
      AND NOT (chained.word = chained.second_word AND chained.second_word = chained.third_word)
  ) AS found;
END;
$function$;

COMMENT ON FUNCTION public.search_text_phrases(text) IS
  'The two- and three-word phrases of a text''s first 500 characters, lowercased: words of letters next to each other inside one run between punctuation, neither end a stop word, each phrase once. A rebuild of search_phrases and related searches read a post''s public search text with it.';

CREATE FUNCTION public.search_entity_phrase(p_kind text, p_key text, p_label text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE
    -- Never the app itself (20261113152020: every post made here names it).
    WHEN p_kind = 'tool' AND replace(coalesce(p_key, ''), '-', '') IN ('magicbooklet', 'emptybooklet') THEN NULL
    WHEN named.phrase ~ '^[[:alnum:]][[:alnum:].+]*( [[:alnum:]][[:alnum:].+]*){0,3}$'
      AND char_length(named.phrase) BETWEEN 3 AND 40 THEN named.phrase
  END
  FROM (
    SELECT CASE
      -- A post that prints no name of its own is known by its key: read as
      -- words when it is only letters ('nano-banana-pro'), left out when it
      -- holds a number ('veo-3.1' reads 'veo 3 1').
      WHEN lower(btrim(coalesce(p_label, ''))) = p_key THEN
        CASE WHEN p_key ~ '^[[:alpha:]]+(-[[:alpha:]]+)*$' THEN replace(p_key, '-', ' ') END
      ELSE lower(btrim(regexp_replace(coalesce(p_label, ''), '[[:space:]]+', ' ', 'g')))
    END AS phrase
  ) AS named;
$function$;

COMMENT ON FUNCTION public.search_entity_phrase(text, text, text) IS
  'A model''s or tool''s name as a search to offer: the name a post prints for it, lowercased with one space between words (its key''s words where the post prints none and the key is letters only), of 3 to 40 characters and at most four words of letters, digits, dots and plus signs. NULL otherwise, and for the app''s own tool.';

REVOKE ALL ON FUNCTION public.search_text_phrases(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_entity_phrase(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_text_phrases(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_entity_phrase(text, text, text) TO service_role;

-- ─── 3. The rebuild ─────────────────────────────────────────────────────────

CREATE FUNCTION public.rebuild_search_phrases()
RETURNS TABLE(phrases integer, subjects integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- A phrase is kept when posts of this many different creators hold it.
  c_min_creators CONSTANT integer := 2;
  -- The pictured posts kept for a phrase.
  c_pictures CONSTANT integer := 8;
  -- A post counts half toward recent_weight at this age.
  c_half_life_days CONSTANT numeric := 30;
  -- A creator's new posts count toward a week up to this many.
  c_week_posts CONSTANT integer := 10;
  v_now timestamptz := now();
  v_week timestamptz := now() - interval '7 days';
  v_month timestamptz := now() - interval '28 days';
  v_read bigint;
BEGIN
  -- One rebuild at a time: a second one finds nothing left to do, and says
  -- what the tables hold.
  IF pg_try_advisory_xact_lock(hashtext('public.rebuild_search_phrases')) THEN
    -- The documents of unlabelled posts, as rebuild_search_terms reads them:
    -- a document exists only for a public, unarchived, visible post and holds
    -- its text as public reads show it. name_words are the post's own tool
    -- and model names, as its document holds them (a template result's model
    -- is 'template-workflow', never its own).
    WITH shown AS MATERIALIZED (
      SELECT
        documents.post_id,
        documents.creator_user_id,
        documents.created_at,
        documents.search_text,
        (posts.save_count + posts.comment_count + posts.remix_count) AS engagement,
        names.words AS name_words,
        coalesce(cover.ready, false) AS pictured
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
      LEFT JOIN LATERAL (
        -- The post's cover, as a card draws it: its first media row, and
        -- only when that row's own preview is ready in the public bucket.
        SELECT (
          media.preview_status = 'ready'
          AND media.preview_storage_path IS NOT NULL
          AND media.preview_storage_path NOT LIKE 'private-posts/%'
          AND media.source_unavailable_at IS NULL
        ) AS ready
        FROM public.post_media AS media
        WHERE media.post_id = documents.post_id
        ORDER BY media.sort_order
        LIMIT 1
      ) AS cover ON true
      WHERE posts.is_nsfw = false
    ),
    saved AS (
      SELECT
        saves.post_id,
        count(*) FILTER (WHERE saves.created_at >= v_week) AS this_week,
        count(*) FILTER (WHERE saves.created_at < v_week) AS earlier
      FROM public.post_saves AS saves
      JOIN shown ON shown.post_id = saves.post_id
      WHERE saves.created_at >= v_month
        AND saves.user_id <> shown.creator_user_id
      GROUP BY saves.post_id
    ),
    commented AS (
      -- Commenters, not comments: a thread between two people is two.
      SELECT
        comments.post_id,
        count(DISTINCT comments.user_id) FILTER (WHERE comments.created_at >= v_week) AS this_week,
        count(DISTINCT comments.user_id) FILTER (WHERE comments.created_at < v_week) AS earlier
      FROM public.post_comments AS comments
      JOIN shown ON shown.post_id = comments.post_id
      WHERE comments.created_at >= v_month
        AND comments.status = 'active'
        AND comments.user_id <> shown.creator_user_id
      GROUP BY comments.post_id
    ),
    active AS MATERIALIZED (
      SELECT
        shown.post_id,
        shown.creator_user_id,
        shown.created_at,
        shown.engagement,
        shown.pictured,
        (shown.created_at >= v_week)::integer AS new_this_week,
        (shown.created_at >= v_month AND shown.created_at < v_week)::integer AS new_earlier,
        (coalesce(saved.this_week, 0) + coalesce(commented.this_week, 0))::integer AS received_this_week,
        (coalesce(saved.earlier, 0) + coalesce(commented.earlier, 0))::integer AS received_earlier
      FROM shown
      LEFT JOIN saved ON saved.post_id = shown.post_id
      LEFT JOIN commented ON commented.post_id = shown.post_id
    ),
    occurrences AS MATERIALIZED (
      SELECT
        found.post_id,
        found.creator_user_id,
        found.phrase,
        bool_or(found.is_name) AS is_name,
        bool_or(NOT found.is_name) AS in_text
      FROM (
        -- What the post writes. Never a phrase with one of its own tool or
        -- model names in it: a document's text ends with those names, and
        -- they are offered as names, below.
        SELECT shown.post_id, shown.creator_user_id, grams.phrase, false AS is_name
        FROM shown
        CROSS JOIN LATERAL public.search_text_phrases(shown.search_text) AS grams
        WHERE NOT (string_to_array(grams.phrase, ' ') && shown.name_words)
        UNION ALL
        -- What the post is made with, under the name it prints. A template
        -- result has no model here (post_search_entities holds none).
        SELECT members.post_id, members.creator_user_id, named.phrase, true
        FROM public.post_search_entities AS members
        JOIN shown ON shown.post_id = members.post_id
        CROSS JOIN LATERAL (
          SELECT public.search_entity_phrase(members.kind, members.key, members.label) AS phrase
        ) AS named
        WHERE named.phrase IS NOT NULL
      ) AS found
      GROUP BY found.post_id, found.creator_user_id, found.phrase
    ),
    -- By creator first and then by phrase: two hash aggregates, where a count
    -- of distinct creators would sort each phrase (rebuild_search_terms).
    by_creator AS (
      SELECT
        occurrences.phrase,
        count(*) AS posts,
        bool_or(occurrences.is_name) AS is_name,
        bool_or(occurrences.in_text) AS in_text
      FROM occurrences
      GROUP BY occurrences.phrase, occurrences.creator_user_id
    ),
    kept AS MATERIALIZED (
      SELECT
        by_creator.phrase,
        sum(by_creator.posts)::integer AS post_count,
        count(*)::integer AS creator_count,
        bool_or(by_creator.is_name) AS is_name,
        bool_or(by_creator.in_text) AS in_text
      FROM by_creator
      GROUP BY by_creator.phrase
      HAVING count(*) >= c_min_creators
    ),
    fresh AS MATERIALIZED (
      SELECT
        kept.phrase,
        coalesce((
          SELECT string_agg(parts.word, ' ' ORDER BY parts.place)
          FROM unnest(string_to_array(kept.phrase, ' ')) WITH ORDINALITY AS parts(word, place)
          WHERE length(to_tsvector('pg_catalog.english', parts.word)) > 0
        ), kept.phrase) AS core,
        kept.in_text,
        kept.is_name,
        kept.post_count,
        kept.creator_count,
        measured.recent_weight,
        measured.week_activity,
        measured.picture_post_ids
      FROM kept
      JOIN (
        SELECT
          occurrences.phrase,
          round(sum(power(
            0.5::double precision,
            (greatest(extract(epoch FROM (v_now - active.created_at)), 0) / 86400.0 / c_half_life_days)::double precision
          ))::numeric, 2)::real AS recent_weight,
          sum(active.new_this_week + active.received_this_week)::real AS week_activity,
          coalesce((array_agg(
            occurrences.post_id ORDER BY active.engagement DESC, active.created_at DESC, occurrences.post_id
          ) FILTER (WHERE active.pictured))[1:c_pictures], '{}'::uuid[]) AS picture_post_ids
        FROM occurrences
        JOIN active ON active.post_id = occurrences.post_id
        WHERE EXISTS (SELECT 1 FROM kept AS wanted WHERE wanted.phrase = occurrences.phrase)
        GROUP BY occurrences.phrase
      ) AS measured ON measured.phrase = kept.phrase
    ),
    gone_phrases AS (
      DELETE FROM public.search_phrases AS stored
      WHERE NOT EXISTS (SELECT 1 FROM fresh WHERE fresh.phrase = stored.phrase)
      RETURNING 1
    ),
    put_phrases AS (
      INSERT INTO public.search_phrases AS stored (
        phrase, core, in_text, is_name, post_count, creator_count, recent_weight, week_activity, picture_post_ids
      )
      SELECT
        fresh.phrase, fresh.core, fresh.in_text, fresh.is_name, fresh.post_count, fresh.creator_count,
        fresh.recent_weight, fresh.week_activity, fresh.picture_post_ids
      FROM fresh
      ON CONFLICT (phrase) DO UPDATE
        SET core = excluded.core, in_text = excluded.in_text, is_name = excluded.is_name,
            post_count = excluded.post_count, creator_count = excluded.creator_count,
            recent_weight = excluded.recent_weight, week_activity = excluded.week_activity,
            picture_post_ids = excluded.picture_post_ids
        WHERE (stored.core, stored.in_text, stored.is_name, stored.post_count, stored.creator_count,
               stored.recent_weight, stored.week_activity, stored.picture_post_ids)
          IS DISTINCT FROM (excluded.core, excluded.in_text, excluded.is_name, excluded.post_count,
               excluded.creator_count, excluded.recent_weight, excluded.week_activity, excluded.picture_post_ids)
      RETURNING 1
    ),
    popular AS MATERIALIZED (
      -- A model or tool, by creator.
      SELECT
        members.kind AS subject,
        members.key,
        members.creator_user_id,
        count(*)::integer AS post_count,
        (least(sum(active.new_this_week), c_week_posts) + sum(active.received_this_week))::real AS week_activity,
        ((least(sum(active.new_earlier), c_week_posts * 3) + sum(active.received_earlier)) / 3.0)::real AS base_activity,
        (array_agg(
          members.post_id ORDER BY active.engagement DESC, active.created_at DESC, members.post_id
        ) FILTER (WHERE active.pictured))[1] AS picture_post_id,
        coalesce(max(active.engagement) FILTER (WHERE active.pictured), 0)::real AS picture_score
      FROM public.post_search_entities AS members
      JOIN active ON active.post_id = members.post_id
      GROUP BY members.kind, members.key, members.creator_user_id
      UNION ALL
      -- A creator.
      SELECT
        'creator',
        '*',
        active.creator_user_id,
        count(*)::integer,
        (least(sum(active.new_this_week), c_week_posts) + sum(active.received_this_week))::real,
        ((least(sum(active.new_earlier), c_week_posts * 3) + sum(active.received_earlier)) / 3.0)::real,
        NULL::uuid,
        0::real
      FROM active
      GROUP BY active.creator_user_id
    ),
    gone_popular AS (
      DELETE FROM public.search_popularity AS stored
      WHERE NOT EXISTS (
        SELECT 1
        FROM popular
        WHERE popular.subject = stored.subject
          AND popular.key = stored.key
          AND popular.creator_user_id = stored.creator_user_id
      )
      RETURNING 1
    ),
    put_popular AS (
      INSERT INTO public.search_popularity AS stored (
        subject, key, creator_user_id, post_count, week_activity, base_activity, picture_post_id, picture_score
      )
      SELECT
        popular.subject, popular.key, popular.creator_user_id, popular.post_count, popular.week_activity,
        popular.base_activity, popular.picture_post_id, popular.picture_score
      FROM popular
      ON CONFLICT (subject, key, creator_user_id) DO UPDATE
        SET post_count = excluded.post_count, week_activity = excluded.week_activity,
            base_activity = excluded.base_activity, picture_post_id = excluded.picture_post_id,
            picture_score = excluded.picture_score
        WHERE (stored.post_count, stored.week_activity, stored.base_activity, stored.picture_post_id, stored.picture_score)
          IS DISTINCT FROM (excluded.post_count, excluded.week_activity, excluded.base_activity,
               excluded.picture_post_id, excluded.picture_score)
      RETURNING 1
    )
    SELECT count(*) INTO v_read FROM shown;
  END IF;

  RETURN QUERY
  SELECT
    (SELECT count(*) FROM public.search_phrases)::integer,
    (SELECT count(*) FROM public.search_popularity)::integer;
END;
$function$;

COMMENT ON FUNCTION public.rebuild_search_phrases() IS
  'Makes search_phrases and search_popularity exactly what unlabelled public posts show now (phrases and names two creators'' posts hold; each model''s, tool''s and creator''s week), and says how many rows each holds. Run by the search-dictionary backend job after rebuild_search_terms; no post save writes either table.';

REVOKE ALL ON FUNCTION public.rebuild_search_phrases() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_search_phrases() TO service_role;

-- ─── 4. Pictures and the two-post floor ─────────────────────────────────────

-- plpgsql throughout this section, for the kept plan: each is called once per
-- row of an answer.
CREATE FUNCTION public.search_post_picture(
  p_post_id uuid,
  p_viewer_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RETURN (
    SELECT jsonb_build_object(
      'post_id', posts.id,
      'path', cover.preview_storage_path,
      'thumbhash', cover.preview_thumbhash,
      'width', cover.width,
      'height', cover.height,
      'media_kind', cover.media_kind
    )
    FROM public.posts AS posts
    -- A post search can show: it has a document.
    JOIN public.post_search_documents AS documents ON documents.post_id = posts.id
    CROSS JOIN LATERAL (
      -- Its cover, as a card draws it: the first media row. A video's
      -- preview is its poster.
      SELECT
        media.preview_storage_path,
        media.preview_thumbhash,
        media.preview_status,
        media.source_unavailable_at,
        media.width,
        media.height,
        media.media_kind
      FROM public.post_media AS media
      WHERE media.post_id = posts.id
      ORDER BY media.sort_order
      LIMIT 1
    ) AS cover
    WHERE posts.id = p_post_id
      AND posts.visibility = 'public'
      AND posts.review_status = 'visible'
      AND posts.archived_at IS NULL
      AND posts.is_nsfw = false
      AND cover.preview_status = 'ready'
      AND cover.preview_storage_path IS NOT NULL
      -- A labelled post's media is moved to the private bucket; nothing of
      -- that bucket is a picture here, whatever the post says now.
      AND cover.preview_storage_path NOT LIKE 'private-posts/%'
      AND cover.source_unavailable_at IS NULL
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
  );
END;
$function$;

COMMENT ON FUNCTION public.search_post_picture(uuid, uuid) IS
  'The cover preview of a post, for a search row to draw: {post_id, path, thumbhash, width, height, media_kind} from its first media row, a video''s poster included. NULL unless the post is one search may show p_viewer_user_id (public, visible, unarchived, unlabelled, with a search document, neither side of a block) and that row''s preview is ready in the public bucket. Service role only.';

CREATE FUNCTION public.search_entity_picture(
  p_kind text,
  p_key text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_query text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- How many creators' best posts are tried before the row has no picture.
  c_tries CONSTANT integer := 4;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_tsquery tsquery;
  v_post_id uuid;
  v_picture jsonb;
BEGIN
  IF v_query <> '' THEN
    v_tsquery := public.search_query_tsquery(v_query, true);
  END IF;

  FOR v_post_id IN
    SELECT stats.picture_post_id
    FROM public.search_popularity AS stats
    WHERE stats.subject = p_kind
      AND stats.key = p_key
      AND stats.picture_post_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = p_viewer_user_id
          AND blocks.blocked_user_id = stats.creator_user_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_blocks AS blocks
        WHERE blocks.blocker_user_id = stats.creator_user_id
          AND blocks.blocked_user_id = p_viewer_user_id
      )
    ORDER BY stats.picture_score DESC, stats.creator_user_id
    LIMIT c_tries
  LOOP
    -- The candidate is as old as the last rebuild: the post must still be
    -- made with it, and with a query still be one that query's search finds.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1
      FROM public.post_search_entities AS members
      WHERE members.kind = p_kind
        AND members.key = p_key
        AND members.post_id = v_post_id
    );
    CONTINUE WHEN v_tsquery IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.post_search_documents AS documents
      WHERE documents.post_id = v_post_id
        AND documents.search_vector @@ v_tsquery
    );
    v_picture := public.search_post_picture(v_post_id, p_viewer_user_id);
    IF v_picture IS NOT NULL THEN
      RETURN v_picture;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.search_entity_picture(text, text, uuid, text) IS
  'A picture for a model''s or tool''s row: search_post_picture of the most saved, commented and remixed pictured post made with it that p_viewer_user_id may see, tried over the best posts of up to 4 creators not blocked with them (search_popularity), each still made with it and, with p_query, still found by that query''s search. NULL when none. Service role only.';

CREATE FUNCTION public.search_query_post_floor(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_floor integer DEFAULT 2
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
  -- Every word as written, lowercased: no prefix, no stem
  -- (search_starter_term_finds_post, whose plan settings these are).
  v_tsquery tsquery := plainto_tsquery('pg_catalog.simple', coalesce(p_query, ''));
  v_floor integer := least(greatest(coalesce(p_floor, 2), 1), 10);
BEGIN
  IF numnode(v_tsquery) = 0 THEN
    RETURN false;
  END IF;
  RETURN (
    SELECT count(*) >= v_floor
    FROM (
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
      LIMIT v_floor
    ) AS held
  );
END;
$function$;

COMMENT ON FUNCTION public.search_query_post_floor(text, uuid, integer) IS
  'Whether at least p_floor posts search_public_posts may show p_viewer_user_id (unlabelled, neither side of a block) hold every word of p_query as written, each of which search_public_posts then finds: a phrase this says yes to never opens a page of fewer. The documents'' word index only, read no further than p_floor posts. Service role only.';

CREATE FUNCTION public.search_query_picture(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_search boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- How many of the best posts are tried for one with a picture.
  c_results CONSTANT integer := 6;
  -- How many posts that hold a hand-picked search's words are read.
  c_posts_read CONSTANT integer := 300;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_tsquery tsquery := plainto_tsquery('pg_catalog.simple', v_query);
  v_post_id uuid;
  v_picture jsonb;
BEGIN
  IF numnode(v_tsquery) = 0 THEN
    RETURN NULL;
  END IF;

  -- A phrase: the pictured posts its last rebuild kept, best first, each
  -- still holding its words.
  FOR v_post_id IN
    SELECT kept.post_id
    FROM public.search_phrases AS phrases
    CROSS JOIN LATERAL unnest(phrases.picture_post_ids) WITH ORDINALITY AS kept(post_id, place)
    WHERE phrases.phrase = v_query
    ORDER BY kept.place
  LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1
      FROM public.post_search_documents AS documents
      WHERE documents.post_id = v_post_id
        AND documents.search_vector @@ v_tsquery
    );
    v_picture := public.search_post_picture(v_post_id, p_viewer_user_id);
    IF v_picture IS NOT NULL THEN
      RETURN v_picture;
    END IF;
  END LOOP;

  -- Any other text (a hand-picked search): of the posts search may show this
  -- viewer that hold every word of it as written (each one its search
  -- finds), the most saved, commented and remixed that has a picture. No
  -- more than c_posts_read of them are read, in no order, so the cost does
  -- not grow with a common word (search_starter_entity_offer reads its 201
  -- the same way); scoring the whole search for one picture took 28 ms a
  -- term on 5,000 posts.
  IF coalesce(p_search, false) THEN
    FOR v_post_id IN
      SELECT held.post_id
      FROM (
        SELECT
          documents.post_id,
          documents.created_at,
          (posts.save_count + posts.comment_count + posts.remix_count) AS engagement
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
        LIMIT c_posts_read
      ) AS held
      ORDER BY held.engagement DESC, held.created_at DESC, held.post_id
      LIMIT c_results
    LOOP
      v_picture := public.search_post_picture(v_post_id, p_viewer_user_id);
      IF v_picture IS NOT NULL THEN
        RETURN v_picture;
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.search_query_picture(text, uuid, boolean) IS
  'A picture for a search''s row: search_post_picture of the best pictured post that holds the phrase (search_phrases.picture_post_ids, each still holding its words) and that p_viewer_user_id may see; for a text that is no kept phrase and with p_search, of the most saved, commented and remixed of up to 300 posts they may see that hold every word of it as written. NULL when none. Service role only.';

CREATE FUNCTION public.search_week_score(p_week double precision, p_base double precision)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  -- This week's activity, lifted or lowered by how it stands against the
  -- subject's own average week: the square root of the ratio, held between a
  -- half and three, so a steady favourite stays near its volume and a small
  -- subject is not carried to the top by one post.
  SELECT coalesce(p_week, 0) * sqrt(least(greatest(
    (coalesce(p_week, 0) + 1) / (coalesce(p_base, 0) + 1), 0.25
  ), 9));
$function$;

COMMENT ON FUNCTION public.search_week_score(double precision, double precision) IS
  'How a model, tool or creator is ordered in "popular this week": its week''s activity times the square root of (week + 1) / (its average week + 1), that ratio held between 0.25 and 9.';

REVOKE ALL ON FUNCTION public.search_post_picture(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_entity_picture(text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_query_post_floor(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_query_picture(text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_week_score(double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_post_picture(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_entity_picture(text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_query_post_floor(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_query_picture(text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_week_score(double precision, double precision) TO service_role;

-- ─── 5. Completions ─────────────────────────────────────────────────────────
--
-- Dropped and re-created for its third parameter. Only search_suggestions
-- calls it, by position, and is re-created below in this transaction.

DROP FUNCTION public.search_suggest_completions(text, integer);

CREATE FUNCTION public.search_suggest_completions(
  p_query text,
  p_limit integer DEFAULT 6,
  p_viewer_user_id uuid DEFAULT NULL
)
RETURNS TABLE(completion text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- A completion needs two different creators (search_terms.creator_count,
  -- and every row of search_phrases).
  c_min_creators CONSTANT integer := 2;
  -- Of several words: how many posts that match what is typed are read for
  -- the words they hold. The ceiling on what one call can read.
  c_phrase_posts_read CONSTANT integer := 100;
  -- How many single words may stand ahead of the phrases.
  c_words_first CONSTANT integer := 3;
  -- How many of the phrases a text matches are weighed.
  c_phrases_weighed CONSTANT integer := 40;
  -- A completion opens a page of at least this many posts.
  c_post_floor CONSTANT integer := 2;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_limit integer := least(greatest(coalesce(p_limit, 6), 0), 10);
  -- The text being completed: the query, then its corrected reading.
  v_text text;
  v_is_corrected boolean := false;
  v_last text;
  v_head text;
  v_last_is_word boolean;
  v_head_withdrawn boolean;
  v_like text;
  v_phrase_tsquery tsquery;
  v_corrected text;
  v_found integer;
  -- A viewer with a block: the counts a rebuild made include posts they may
  -- not see, so each completion is checked against the posts they may.
  v_viewer_has_blocks boolean := p_viewer_user_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.user_blocks AS blocks
    WHERE blocks.blocker_user_id = p_viewer_user_id
       OR blocks.blocked_user_id = p_viewer_user_id
  );
BEGIN
  IF v_limit = 0 OR char_length(v_query) < 2 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;

  v_text := v_query;
  LOOP
    -- The word being typed, and what was typed before it.
    v_last := substring(v_text FROM '[^ ]+$');
    EXIT WHEN v_last IS NULL;
    v_head := btrim(left(v_text, char_length(v_text) - char_length(v_last)));
    -- The dictionary holds words of letters, and only such a word reaches a
    -- LIKE below, so a %, an _ or a \ is never a wildcard there.
    v_last_is_word := v_last ~ '^[[:alpha:]]{2,39}$';
    -- A query that holds a withdrawn word before the one being typed is
    -- offered no phrase: every phrase would repeat the word.
    v_head_withdrawn := v_head <> '' AND EXISTS (
      SELECT 1
      FROM public.search_suggestion_denylist AS denied
      WHERE denied.term = ANY (tsvector_to_array(
        to_tsvector('pg_catalog.simple', v_head)
          || to_tsvector('pg_catalog.simple', public.search_split_terms(v_head))
      ))
    );
    -- A phrase is matched through plainto_tsquery, which takes any text and
    -- drops what is not a letter or a digit: so only a text of letters,
    -- digits, spaces, dots and plus signs (what a phrase or a name holds) is
    -- matched, and 'amb%' is not read as 'amb'.
    v_phrase_tsquery := CASE
      WHEN v_text ~ '^[[:alnum:] .+]+$' THEN public.search_prefix_tsquery('pg_catalog.simple', v_text)
    END;
    v_like := replace(replace(replace(v_text, '\', '\\'), '%', '\%'), '_', '\_') || '%';

    RETURN QUERY
    WITH single_words AS (
      -- One word typed: the words posts write that start with it, most-shown
      -- first. Search finds each: a document shows it.
      SELECT terms.term AS offer, terms.post_count::real AS weight
      FROM public.search_terms AS terms
      WHERE v_head = ''
        AND v_last_is_word
        AND terms.term LIKE v_last || '%'
        AND (v_is_corrected OR terms.term <> v_last)
        AND terms.in_posts
        AND terms.creator_count >= c_min_creators
        AND NOT EXISTS (
          SELECT 1 FROM public.search_suggestion_denylist AS denied WHERE denied.term = terms.term
        )
      ORDER BY terms.post_count DESC, terms.creator_count DESC, terms.term
      LIMIT v_limit
    ),
    matched AS (
      -- Several words typed: the posts that hold the earlier words and a
      -- word starting as the last one does (20261112144018), matched on the
      -- simple reading alone, which makes every offer one that search finds.
      SELECT documents.creator_user_id, documents.search_vector
      FROM public.post_search_documents AS documents
      JOIN public.posts AS posts ON posts.id = documents.post_id
      WHERE v_head <> ''
        AND v_last_is_word
        AND NOT v_head_withdrawn
        AND posts.is_nsfw = false
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
        AND (v_is_corrected OR lexemes.lexeme <> v_last)
      GROUP BY lexemes.lexeme
    ),
    continued AS (
      SELECT v_head || ' ' || found.term AS offer, found.posts::real AS weight
      FROM found
      JOIN public.search_terms AS terms ON terms.term = found.term
      WHERE found.creators >= c_min_creators
        AND terms.in_posts
        AND terms.creator_count >= c_min_creators
        AND NOT EXISTS (
          SELECT 1 FROM public.search_suggestion_denylist AS denied WHERE denied.term = found.term
        )
      ORDER BY found.posts DESC, terms.post_count DESC, found.term
      LIMIT v_limit
    ),
    phrased AS (
      -- Phrases and names: every typed word is in it, the last a prefix of
      -- one of its words. Never one that holds a withdrawn word, read as a
      -- name's words are (as written, split and joined): asked of the
      -- strongest c_phrases_weighed only, not of every phrase a short prefix
      -- matches.
      SELECT strongest.offer, strongest.weight, strongest.starts, strongest.core
      FROM (
        SELECT
          phrases.phrase AS offer,
          phrases.recent_weight AS weight,
          phrases.phrase LIKE v_like AS starts,
          phrases.core
        FROM public.search_phrases AS phrases
        WHERE v_phrase_tsquery IS NOT NULL
          AND numnode(v_phrase_tsquery) > 0
          AND NOT v_head_withdrawn
          AND phrases.words @@ v_phrase_tsquery
          AND (v_is_corrected OR phrases.phrase <> v_text)
        ORDER BY (phrases.phrase LIKE v_like) DESC, phrases.recent_weight DESC, phrases.phrase
        LIMIT c_phrases_weighed
      ) AS strongest
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.search_suggestion_denylist AS denied
        WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
          'pg_catalog.simple', coalesce(public.search_term_variants(strongest.offer), '')
        )))
      )
    ),
    candidates AS (
      SELECT single_words.offer, single_words.weight, true AS starts, 1 AS source,
        row_number() OVER (ORDER BY single_words.weight DESC, single_words.offer) AS place
      FROM single_words
      UNION ALL
      SELECT continued.offer, continued.weight, true, 2, 0
      FROM continued
      UNION ALL
      SELECT phrased.offer, phrased.weight, phrased.starts, 3, 0
      FROM phrased
      -- A phrase that only adds a stop word to a word is that word again.
      WHERE position(' ' IN phrased.core) > 0
        OR NOT (
          phrased.core = v_text
          OR EXISTS (SELECT 1 FROM single_words WHERE single_words.offer = phrased.core)
        )
    ),
    distinct_offers AS (
      -- One row per set of words: 'lanterns amberglow', made by completing
      -- what was typed, and the phrase posts write, 'amberglow lanterns', are
      -- one search. The phrase as posts write it is the one kept.
      SELECT DISTINCT ON (keyed.word_set)
        keyed.offer, keyed.weight, keyed.starts, keyed.source, keyed.place
      FROM (
        SELECT
          candidates.offer, candidates.weight, candidates.starts, candidates.source, candidates.place,
          (
            SELECT string_agg(parts.word, ' ' ORDER BY parts.word)
            FROM unnest(string_to_array(candidates.offer, ' ')) AS parts(word)
          ) AS word_set
        FROM candidates
      ) AS keyed
      ORDER BY keyed.word_set, keyed.source DESC, keyed.offer
    ),
    ordered AS (
      SELECT
        distinct_offers.offer,
        row_number() OVER (
          ORDER BY
            -- Past the first few, single words wait behind the phrases.
            (distinct_offers.source = 1 AND distinct_offers.place > c_words_first),
            distinct_offers.starts DESC,
            distinct_offers.weight DESC,
            distinct_offers.offer
        ) AS position
      FROM distinct_offers
    )
    SELECT ordered.offer
    FROM (
      SELECT ordered.offer, ordered.position
      FROM ordered
      ORDER BY ordered.position
      LIMIT CASE WHEN v_viewer_has_blocks THEN v_limit * 3 ELSE v_limit END
    ) AS ordered
    WHERE NOT v_viewer_has_blocks
      OR public.search_query_post_floor(ordered.offer, p_viewer_user_id, c_post_floor)
    ORDER BY ordered.position
    LIMIT v_limit;

    GET DIAGNOSTICS v_found = ROW_COUNT;
    EXIT WHEN v_found > 0 OR v_is_corrected;

    -- Nothing completes the text as typed: read its misspelt words as search
    -- reads them, and complete that. The corrected text itself is offered.
    v_corrected := public.search_corrected_query(v_query);
    EXIT WHEN v_corrected IS NULL
      OR v_corrected = public.search_split_terms(v_query)
      OR char_length(v_corrected) < 2
      OR char_length(v_corrected) > 100;
    v_text := v_corrected;
    v_is_corrected := true;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.search_suggest_completions(text, integer, uuid) IS
  'Typeahead completions. Of one word: the words unlabelled public posts of two or more creators write that start with it (search_terms). Of several: the words that posts holding the earlier ones hold, each only when two creators'' posts hold it. And phrases and names (search_phrases) that hold every typed word, the last as a prefix of any of their words: one the text starts first, then by recent_weight, with at most three single words ahead of them. When nothing completes the text as typed, its corrected reading (search_corrected_query) is completed instead and offered itself. Never a word or phrase holding a word of search_suggestion_denylist; for a viewer with a block, only what two posts they may see hold. At most 10.';

REVOKE ALL ON FUNCTION public.search_suggest_completions(text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggest_completions(text, integer, uuid) TO service_role;

-- ─── 6. Creators, by any word of the name ───────────────────────────────────

CREATE INDEX creator_search_documents_display_name_words_idx
  ON public.creator_search_documents
  USING gin (to_tsvector('pg_catalog.simple', display_name_normalized));

CREATE OR REPLACE FUNCTION public.search_suggest_creators(
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
  -- Every typed word in the name, the last a prefix of any of its words.
  -- From two characters: one letter starts a word of most names.
  v_words tsquery;
BEGIN
  IF v_limit = 0 OR char_length(v_query) < 1 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  -- Names are not stemmed (search_public_creators).
  v_tsquery := public.search_query_tsquery(v_query, false);
  -- Only of letters, digits and spaces: the text-search parser drops every
  -- other character, so 'ar%' would be read as 'ar' and match where the
  -- person typed something no name holds.
  IF NOT v_handles_only AND char_length(v_query) >= 2 AND v_query ~ '^[[:alnum:] ]+$' THEN
    v_words := public.search_prefix_tsquery('pg_catalog.simple', v_query);
    IF numnode(v_words) = 0 THEN
      v_words := NULL;
    END IF;
  END IF;

  RETURN QUERY
  WITH eligible AS MATERIALIZED (
    -- Everyone the query matches who may be offered to this viewer, settled
    -- before any cut, so a list is short only when the matches are.
    SELECT
      documents.creator_user_id,
      documents.public_post_count,
      -- search_creator_score's tiers, read off the document alone; a name
      -- matched by a later word comes last.
      CASE
        WHEN documents.username_normalized = v_query THEN 4
        WHEN documents.username_normalized LIKE v_like THEN 3
        WHEN documents.display_name_normalized = v_query THEN 2
        WHEN documents.display_name_normalized LIKE v_like THEN 1
        ELSE 0
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
        OR (
          v_words IS NOT NULL
          AND to_tsvector('pg_catalog.simple', documents.display_name_normalized) @@ v_words
        )
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
      -- comes first: a name holds the query when it starts with it or one of
      -- its words does.
      public.search_creator_score(
        documents.username_normalized = v_query,
        documents.username_normalized LIKE v_like,
        NOT v_handles_only AND shown.display_name = v_query,
        NOT v_handles_only AND (
          shown.display_name LIKE v_like
          OR (
            v_words IS NOT NULL
            AND to_tsvector('pg_catalog.simple', documents.display_name_normalized) @@ v_words
          )
        ),
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
      ) AS search_score,
      -- A name the query starts stands ahead of one matched by a later word.
      (
        documents.username_normalized LIKE v_like
        OR (NOT v_handles_only AND shown.display_name LIKE v_like)
      ) AS starts
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
  ORDER BY scored.starts DESC, scored.search_score DESC, scored.creator_user_id ASC
  LIMIT v_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_suggest_creators(text, uuid, boolean, integer) IS
  'Typeahead creators: those whose handle or display name starts with the query, and from two characters those with any word of the display name starting with its last word and holding the others (handles alone with p_handles_only), a start first, then by search_creator_score as Creators search orders them, the viewer''s follow marked and never lost to the candidate cut. Never a guest, a suspended account, one being deleted, or either side of a block with the viewer. At most 10.';

REVOKE ALL ON FUNCTION public.search_suggest_creators(text, uuid, boolean, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggest_creators(text, uuid, boolean, integer) TO service_role;

-- ─── 7. The one call the suggest route makes ────────────────────────────────

-- The product's own models a typed text names: the public projection of the
-- catalog (the active release's entries enabled on a platform), matched as an
-- entity's name is (every typed word, the last a prefix, against the name and
-- the id as written, split and joined). No posts are read here.
CREATE FUNCTION public.search_suggest_catalog_models(p_query text)
RETURNS TABLE(
  key text,
  model_id text,
  model_kind text,
  label text,
  web boolean,
  mobile boolean,
  starts boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_like text;
  v_tsquery tsquery;
BEGIN
  -- From two characters: one letter starts a word of most names.
  IF char_length(v_query) < 2 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  -- Names are not stemmed (search_public_entities).
  v_tsquery := public.search_query_tsquery(v_query, false);
  IF numnode(v_tsquery) = 0 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  RETURN QUERY
  SELECT
    named.key,
    entries.model_id,
    models.kind,
    named.label,
    entries.web_enabled,
    entries.mobile_enabled,
    -- The name or the id starts with what is typed.
    (lower(named.label) LIKE v_like OR named.key LIKE v_like)
  FROM (
    -- The release /api/model-catalog/v1 serves (read_model_catalog_v1_current).
    SELECT releases.id
    FROM public.generation_model_catalog_releases AS releases
    WHERE releases.status = 'active'
    ORDER BY releases.schema_version DESC, releases.activated_at DESC
    LIMIT 1
  ) AS current_release
  JOIN public.generation_model_catalog_entries AS entries ON entries.release_id = current_release.id
  JOIN public.generation_models AS models ON models.model_id = entries.model_id
  CROSS JOIN LATERAL (
    SELECT
      public.search_entity_key(entries.model_id) AS key,
      left(coalesce(nullif(btrim(entries.public_descriptor ->> 'displayName'), ''), entries.model_id), 80) AS label
  ) AS named
  -- Offered to someone: a model switched off on the web and in the app is not public.
  WHERE (entries.web_enabled OR entries.mobile_enabled)
    AND named.key IS NOT NULL
    AND to_tsvector(
      'pg_catalog.simple',
      coalesce(public.search_term_variants(named.label), '') || ' ' || coalesce(public.search_term_variants(entries.model_id), '')
    ) @@ v_tsquery;
END;
$function$;

COMMENT ON FUNCTION public.search_suggest_catalog_models(text) IS
  'The product''s own models a typed text names, for the typeahead: the entries of the active catalog release enabled on the web or in the app (the public projection /api/model-catalog/v1 reads), by their public displayName, where every typed word is in the name or the id and the last starts one of their words; from two characters. key is the model''s search key (search_entity_key of its id), starts whether the name or the id starts with the text. Only public descriptor fields are read: no provider mapping, no price. Service role only.';

REVOKE ALL ON FUNCTION public.search_suggest_catalog_models(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggest_catalog_models(text) TO service_role;

-- Dropped and re-created for its sixth parameter, in this transaction: the
-- five-argument named call of the code live during the release resolves to
-- the new function through the default, and reads the keys it read.
DROP FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer);

CREATE FUNCTION public.search_suggestions(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_handles_only boolean DEFAULT false,
  p_creator_limit integer DEFAULT 5,
  p_completion_limit integer DEFAULT 6,
  p_catalog boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  WITH catalog AS MATERIALIZED (
    -- A query typed as a handle ('@lu') asks for people: no models.
    SELECT models.key, models.model_id, models.model_kind, models.label, models.web, models.mobile, models.starts
    FROM public.search_suggest_catalog_models(p_query) AS models
    WHERE NOT coalesce(p_handles_only, false)
  ),
  found AS MATERIALIZED (
    -- Models and tools: search's own answer for this query and viewer.
    SELECT answered.kind, answered.key, answered.label, answered.post_count, answered.post_count_capped, answered.position
    FROM public.search_public_entities(p_query, p_viewer_user_id, 10, NULL)
      WITH ORDINALITY AS answered(kind, key, label, post_count, post_count_capped, position)
    WHERE NOT coalesce(p_handles_only, false)
  ),
  candidates AS (
    -- What search answers, less what a suggestion must not put in front of
    -- someone who did not ask.
    SELECT
      -- A catalog model under the catalog's own name; anything else under
      -- the name most of its posts print.
      found.kind, found.key, coalesce(catalog.label, found.label) AS label,
      found.post_count, found.post_count_capped, found.position,
      catalog.model_id, catalog.model_kind, catalog.web, catalog.mobile,
      coalesce(catalog.starts, false) AS starts,
      false AS added
    FROM found
    LEFT JOIN catalog ON found.kind = 'model' AND catalog.key = found.key
    WHERE (
      -- A model of the product's own catalog: ours, and already public.
      catalog.model_id IS NOT NULL
      -- Anything else, two creators: an unlabelled post made with it by
      -- someone other than the first creator found, among the first 500 of
      -- its posts.
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT members.creator_user_id
          FROM public.post_search_entities AS members
          JOIN public.posts AS posts ON posts.id = members.post_id
          WHERE members.kind = found.kind
            AND members.key = found.key
            AND posts.is_nsfw = false
          LIMIT 500
        ) AS makers
        WHERE makers.creator_user_id <> (
          SELECT members.creator_user_id
          FROM public.post_search_entities AS members
          JOIN public.posts AS posts ON posts.id = members.post_id
          WHERE members.kind = found.kind
            AND members.key = found.key
            AND posts.is_nsfw = false
          LIMIT 1
        )
      )
    )
    UNION ALL
    -- For a client that asked (p_catalog): the catalog models search did not
    -- answer, because no post this viewer may see is made with one, or the
    -- text is too short to search posts by. Counted here to order them; the
    -- count a row states is made below, with the search that opens it.
    SELECT
      'model', catalog.key, catalog.label, visible.post_count, false, NULL::bigint,
      catalog.model_id, catalog.model_kind, catalog.web, catalog.mobile,
      catalog.starts,
      true
    FROM catalog
    CROSS JOIN LATERAL (
      -- The posts this viewer may see that are made with it. A template
      -- result has no model here (post_search_entities holds none).
      SELECT count(*)::integer AS post_count
      FROM (
        SELECT 1
        FROM public.post_search_entities AS members
        JOIN public.posts AS posts ON posts.id = members.post_id
        WHERE members.kind = 'model'
          AND members.key = catalog.key
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
        LIMIT 201
      ) AS seen
    ) AS visible
    WHERE coalesce(p_catalog, false)
      AND NOT EXISTS (
        SELECT 1 FROM found WHERE found.kind = 'model' AND found.key = catalog.key
      )
  ),
  offered AS (
    SELECT
      candidates.kind, candidates.key, candidates.label, candidates.post_count, candidates.post_count_capped,
      candidates.model_id, candidates.model_kind, candidates.web, candidates.mobile, candidates.added,
      row_number() OVER (
        ORDER BY
          -- A catalog model the text starts, then the rest: the one whose
          -- name is the text, then the most posts, then search's own order.
          (candidates.model_id IS NOT NULL AND candidates.starts) DESC,
          (lower(candidates.label) = lower(btrim(coalesce(p_query, ''))) OR candidates.key = lower(btrim(coalesce(p_query, '')))) DESC,
          candidates.post_count DESC,
          candidates.position NULLS LAST,
          candidates.kind,
          candidates.key
      ) AS place
    FROM candidates
    -- No withdrawn word in its name or key, read as post_search_entities.name_vector reads them.
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.search_suggestion_denylist AS denied
      WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
        'pg_catalog.simple',
        coalesce(public.search_term_variants(candidates.label), '') || ' ' || coalesce(public.search_term_variants(candidates.key), '')
      )))
    )
  )
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
    'entities', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', chosen.kind,
        'key', chosen.key,
        'label', chosen.label,
        -- What pressing the row opens: for a row search answered, the posts
        -- the typed text finds narrowed to it; for a catalog model added
        -- here, the posts `query` finds narrowed to it, none when it has no
        -- post this viewer may see.
        'post_count', CASE WHEN chosen.added THEN coalesce(opened.post_count, 0) ELSE chosen.post_count END,
        'post_count_capped', CASE WHEN chosen.added THEN coalesce(opened.post_count_capped, false) ELSE chosen.post_count_capped END,
        -- A picture of a post made with it that this viewer may see, or null.
        'thumbnail', public.search_entity_picture(chosen.kind, chosen.key, p_viewer_user_id, NULL),
        'in_catalog', chosen.model_id IS NOT NULL,
        'catalog_model', CASE WHEN chosen.model_id IS NOT NULL THEN jsonb_build_object(
          'id', chosen.model_id,
          'kind', chosen.model_kind,
          'web', chosen.web,
          'mobile', chosen.mobile
        ) END,
        'query', opened.query
      ) ORDER BY chosen.place)
      FROM (
        SELECT offered.kind, offered.key, offered.label, offered.post_count, offered.post_count_capped,
          offered.model_id, offered.model_kind, offered.web, offered.mobile, offered.added, offered.place
        FROM offered
        ORDER BY offered.place
        LIMIT 3
      ) AS chosen
      -- Only for the rows added here, at most three: the search pressing one
      -- runs and what it finds for this viewer (search_starter_entity_offer).
      LEFT JOIN LATERAL public.search_starter_entity_offer(chosen.kind, chosen.key, p_viewer_user_id) AS opened
        ON chosen.added
    ), '[]'::jsonb),
    -- A query typed as a handle ('@lu') asks for people, not words.
    'completions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('text', completions.completion) ORDER BY completions.position)
      FROM public.search_suggest_completions(p_query, p_completion_limit, p_viewer_user_id)
        WITH ORDINALITY AS completions(completion, position)
      WHERE NOT coalesce(p_handles_only, false)
    ), '[]'::jsonb)
  );
$function$;

COMMENT ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer, boolean) IS
  'GET /api/search/suggest in one call: {creators: [{id, username, display_name, avatar_url, is_following}], entities: [{kind, key, label, post_count, post_count_capped, thumbnail, in_catalog, catalog_model, query}], completions: [{text}]}, each list in the order to show it. Creators from search_suggest_creators. Entities (at most 3): search_public_entities'' answer for the query and the viewer, each kept when it is a model of the public catalog (search_suggest_catalog_models) or two creators'' posts are made with it; with p_catalog, also every catalog model the text names that search did not answer, from two characters, with the posts the viewer may see made with it (0 when none) and the query whose search opens them. None whose name holds a withdrawn word. A catalog model the text starts first, then the most posts. Completions from search_suggest_completions for this viewer. No entities or completions for a handles-only query.';

REVOKE ALL ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer, boolean) TO service_role;

-- ─── 8. The starter: popular this week ──────────────────────────────────────
--
-- CREATE OR REPLACE: the signature, the settings and the grants of
-- 20261113152020 are kept, and so is every key the route live today reads.
-- search_starter_entity_offer and search_starter_term_finds_post are not
-- touched: a row still opens exactly the posts it counts.
--
-- ENTITIES and CREATORS are first read as this week's (search_popularity,
-- added up without the creators on either side of a block with the viewer,
-- ordered by search_week_score). A list with fewer than three rows active
-- this week is the all-time one of 20261113152020, text unchanged, and
-- `periods` says 'all' for it. The app is never a tool in either.
--
-- SEARCHES are the phrases posts write (never a model's or tool's name: those
-- have their own list), the most active this week first, then by
-- recent_weight; no two share a word; each holds no withdrawn word and is
-- held by two posts this viewer may see. When six of them were active this
-- week the list is those and `periods.searches` is 'week'. Otherwise the
-- hand-picked terms (p_terms) follow until there are six, as 20261113100423
-- offered them, and it is 'all'.
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
  -- The newest posts the all-time entity and creator lists are read from.
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
  -- A list is "this week's" with at least this many rows active this week.
  c_week_rows CONSTANT integer := 3;
  -- Searches: this many active this week make the list theirs; with fewer,
  -- the hand-picked terms fill it to this many.
  c_search_rows CONSTANT integer := 6;
  -- The most phrases looked at for the searches.
  c_phrase_candidates CONSTANT integer := 40;
  -- A phrase is offered when this many posts the viewer may see hold it.
  c_post_floor CONSTANT integer := 2;
  v_entity_limit integer := least(greatest(coalesce(p_entity_limit, 8), 0), 10);
  v_creator_limit integer := least(greatest(coalesce(p_creator_limit, 6), 0), 10);
  v_search_limit integer := least(greatest(coalesce(p_search_limit, 8), 0), 10);
  v_entities jsonb := '[]'::jsonb;
  v_creators jsonb := '[]'::jsonb;
  v_searches jsonb := '[]'::jsonb;
  v_entities_period text := 'all';
  v_creators_period text := 'all';
  v_searches_period text := 'all';
  v_week jsonb;
  v_week_rows integer;
  v_all_time_entities jsonb;
  v_all_time_creators jsonb;
  v_phrase record;
  v_used_words text[] := ARRAY[]::text[];
  v_every_search_this_week boolean := true;
  v_term text;
  v_term_query text;
  v_seen text[] := ARRAY[]::text[];
  v_offered integer := 0;
BEGIN
  -- ── Models and tools, this week ──
  IF v_entity_limit > 0 THEN
    SELECT
      coalesce(jsonb_agg(jsonb_build_object(
        'kind', offered.kind,
        'key', offered.key,
        'label', offered.label,
        'post_count', offered.post_count,
        'post_count_capped', offered.post_count_capped,
        'query', offered.query,
        'thumbnail', public.search_entity_picture(offered.kind, offered.key, p_viewer_user_id, offered.query)
      ) ORDER BY offered.score DESC, offered.kind, offered.key), '[]'::jsonb),
      count(*)
    INTO v_week, v_week_rows
    FROM (
      SELECT
        candidates.kind,
        candidates.key,
        candidates.score,
        counted.query,
        counted.label,
        counted.post_count,
        counted.post_count_capped
      FROM (
        SELECT
          weekly.kind,
          weekly.key,
          public.search_week_score(weekly.week_activity, weekly.base_activity) AS score
        FROM (
          SELECT
            stats.subject AS kind,
            stats.key,
            sum(stats.week_activity) AS week_activity,
            sum(stats.base_activity) AS base_activity
          FROM public.search_popularity AS stats
          WHERE stats.subject IN ('model', 'tool')
            -- Never the app itself (20261113152020).
            AND NOT (
              stats.subject = 'tool'
              AND replace(stats.key, '-', '') IN ('magicbooklet', 'emptybooklet')
            )
            -- Neither side of a block with the viewer counts for anything.
            AND NOT EXISTS (
              SELECT 1
              FROM public.user_blocks AS blocks
              WHERE blocks.blocker_user_id = p_viewer_user_id
                AND blocks.blocked_user_id = stats.creator_user_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.user_blocks AS blocks
              WHERE blocks.blocker_user_id = stats.creator_user_id
                AND blocks.blocked_user_id = p_viewer_user_id
            )
          GROUP BY stats.subject, stats.key
          -- Two creators' unlabelled posts are made with it, and it gained
          -- something this week.
          HAVING count(*) >= 2 AND sum(stats.week_activity) > 0
        ) AS weekly
        ORDER BY public.search_week_score(weekly.week_activity, weekly.base_activity) DESC, weekly.kind, weekly.key
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
      ORDER BY candidates.score DESC, candidates.kind, candidates.key
      LIMIT v_entity_limit
    ) AS offered;

    IF v_week_rows >= c_week_rows THEN
      v_entities := v_week;
      v_entities_period := 'week';
    END IF;
  END IF;

  -- ── Creators, this week ──
  IF v_creator_limit > 0 THEN
    SELECT
      coalesce(jsonb_agg(jsonb_build_object(
        'id', ranked.creator_user_id,
        'username', ranked.username,
        'display_name', ranked.display_name,
        'bio', ranked.bio,
        'avatar_url', ranked.avatar_url,
        'public_post_count', ranked.public_post_count,
        'is_following', false
      ) ORDER BY ranked.score DESC, ranked.creator_user_id), '[]'::jsonb),
      count(*)
    INTO v_week, v_week_rows
    FROM (
      SELECT
        stats.creator_user_id,
        documents.username,
        documents.display_name,
        documents.bio,
        documents.avatar_url,
        documents.public_post_count,
        public.search_week_score(stats.week_activity, stats.base_activity) AS score
      FROM public.search_popularity AS stats
      -- Found by creator search: has a document, and a public post still.
      JOIN public.creator_search_documents AS documents
        ON documents.creator_user_id = stats.creator_user_id
      JOIN public.profiles AS profiles ON profiles.id = stats.creator_user_id
      JOIN auth.users AS users ON users.id = stats.creator_user_id
      WHERE stats.subject = 'creator'
        AND stats.key = '*'
        AND stats.week_activity > 0
        AND documents.public_post_count > 0
        -- Never the viewer, nor someone they already follow.
        AND stats.creator_user_id IS DISTINCT FROM p_viewer_user_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.follows AS follows
          WHERE follows.follower_id = p_viewer_user_id
            AND follows.following_id = stats.creator_user_id
        )
        -- An account: never a guest, a suspended account, or one being
        -- deleted or merged away (search_suggest_creators' rule).
        AND users.is_anonymous IS NOT TRUE
        AND (users.banned_until IS NULL OR users.banned_until <= now())
        AND profiles.identity_state = 'active'
        -- Neither side of a block with the viewer.
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = p_viewer_user_id
            AND blocks.blocked_user_id = stats.creator_user_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_blocks AS blocks
          WHERE blocks.blocker_user_id = stats.creator_user_id
            AND blocks.blocked_user_id = p_viewer_user_id
        )
      ORDER BY public.search_week_score(stats.week_activity, stats.base_activity) DESC, stats.creator_user_id
      LIMIT v_creator_limit
    ) AS ranked;

    IF v_week_rows >= c_week_rows THEN
      v_creators := v_week;
      v_creators_period := 'week';
    END IF;
  END IF;

  -- ── Whichever of the two has no week: the all-time list, as it was ──
  IF (v_entity_limit > 0 AND v_entities_period = 'all')
    OR (v_creator_limit > 0 AND v_creators_period = 'all') THEN
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
      CASE WHEN v_entity_limit = 0 OR v_entities_period <> 'all' THEN NULL ELSE (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'kind', offered.kind,
          'key', offered.key,
          'label', offered.label,
          'post_count', offered.post_count,
          'post_count_capped', offered.post_count_capped,
          'query', offered.query,
          'thumbnail', public.search_entity_picture(offered.kind, offered.key, p_viewer_user_id, offered.query)
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
      CASE WHEN v_creator_limit = 0 OR v_creators_period <> 'all' THEN NULL ELSE (
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
    INTO v_all_time_entities, v_all_time_creators;

    IF v_entities_period = 'all' THEN
      v_entities := coalesce(v_all_time_entities, '[]'::jsonb);
    END IF;
    IF v_creators_period = 'all' THEN
      v_creators := coalesce(v_all_time_creators, '[]'::jsonb);
    END IF;
  END IF;

  -- ── Searches ──
  IF v_search_limit > 0 THEN
    -- What posts write, the most active this week first.
    FOR v_phrase IN
      SELECT phrases.phrase, phrases.core, phrases.week_activity
      FROM public.search_phrases AS phrases
      WHERE phrases.in_text
        AND NOT phrases.is_name
        AND char_length(phrases.phrase) BETWEEN 3 AND 100
      ORDER BY phrases.week_activity DESC, phrases.recent_weight DESC, phrases.phrase
      LIMIT c_phrase_candidates
    LOOP
      EXIT WHEN v_offered >= v_search_limit;
      -- The week's phrases are done. Enough of them: the list is theirs.
      EXIT WHEN v_phrase.week_activity <= 0 AND v_every_search_this_week AND v_offered >= c_search_rows;
      -- One search per subject: none that shares a word with one offered.
      CONTINUE WHEN string_to_array(v_phrase.core, ' ') && v_used_words;
      -- No withdrawn word, as written, split or joined.
      CONTINUE WHEN EXISTS (
        SELECT 1
        FROM public.search_suggestion_denylist AS denied
        WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
          'pg_catalog.simple',
          coalesce(public.search_term_variants(v_phrase.phrase), '')
        )))
      );
      -- Two posts search may show this viewer hold it.
      CONTINUE WHEN NOT public.search_query_post_floor(v_phrase.phrase, p_viewer_user_id, c_post_floor);
      v_searches := v_searches || jsonb_build_array(jsonb_build_object(
        'text', v_phrase.phrase,
        'thumbnail', public.search_query_picture(v_phrase.phrase, p_viewer_user_id, false)
      ));
      v_used_words := v_used_words || string_to_array(v_phrase.core, ' ');
      v_seen := v_seen || v_phrase.phrase;
      v_offered := v_offered + 1;
      IF v_phrase.week_activity <= 0 THEN
        v_every_search_this_week := false;
      END IF;
    END LOOP;

    IF v_every_search_this_week AND v_offered >= least(c_search_rows, v_search_limit) THEN
      v_searches_period := 'week';
    ELSE
      -- Fewer than six from content: the hand-picked terms fill the list.
      FOREACH v_term IN ARRAY coalesce(p_terms[1:c_term_cap], ARRAY[]::text[]) LOOP
        EXIT WHEN v_offered >= least(c_search_rows, v_search_limit);
        -- Read as search_public_posts reads a query.
        v_term_query := lower(btrim(regexp_replace(coalesce(v_term, ''), '[[:space:]]+', ' ', 'g')));
        CONTINUE WHEN char_length(v_term_query) < 3 OR char_length(v_term_query) > 100;
        -- A term listed twice, in any case or spacing, or offered already as
        -- a phrase, is read once.
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
          'text', btrim(regexp_replace(v_term, '[[:space:]]+', ' ', 'g')),
          'thumbnail', public.search_query_picture(v_term_query, p_viewer_user_id, true)
        ));
        v_offered := v_offered + 1;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'entities', v_entities,
    'creators', v_creators,
    'searches', v_searches,
    'periods', jsonb_build_object(
      'entities', v_entities_period,
      'creators', v_creators_period,
      'searches', v_searches_period
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) IS
  'GET /api/search/starter in one call: {entities: [{kind, key, label, post_count, post_count_capped, query, thumbnail}], creators: [{id, username, display_name, bio, avatar_url, public_post_count, is_following}], searches: [{text, thumbnail}], periods: {entities, creators, searches}}, each list in the order to show it and each period ''week'' or ''all''. Entities and creators are this week''s when three or more were active in the last 7 days (search_popularity without the creators blocked with the viewer, by search_week_score), else the all-time lists of 20261113152020 read from the newest 2,000 posts search may show the viewer; entities two creators use, never the app''s own tool, no withdrawn word, each with the query pressing it searches and the count search gives it (to 200); creators never a guest, suspended, deleting, blocked, followed account or the viewer. Searches: phrases posts write (search_phrases), the most active this week first, no two sharing a word, each held by two posts the viewer may see, then p_terms until there are six. A thumbnail is search_post_picture''s answer or null. Service role only.';

REVOKE ALL ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_starter(uuid, text[], integer, integer, integer) TO service_role;

-- ─── 9. Related searches ────────────────────────────────────────────────────

CREATE FUNCTION public.search_related_searches(
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
  v_said := string_to_array(v_query, ' ')
    || string_to_array(public.search_split_terms(v_query), ' ')
    || coalesce(string_to_array(v_corrected, ' '), ARRAY[]::text[]);

  FOR v_candidate IN
    WITH seen AS MATERIALIZED (
      -- The result page's posts, each read again as search reads one: a
      -- document, unlabelled, neither side of a block with the viewer.
      SELECT documents.post_id, documents.search_text
      FROM public.post_search_documents AS documents
      JOIN public.posts AS posts ON posts.id = documents.post_id
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
        )
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
    -- mostly share a model, and its name would lead every list.
    ORDER BY (phrases.is_name AND NOT phrases.in_text), counted.posts DESC, phrases.recent_weight DESC, phrases.phrase
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
  'Related searches for a result page (/api/search?relatedSearches=1): the phrases and model or tool names (search_phrases) that at least two of p_post_ids hold, each post read again as search reads one for p_viewer_user_id (a document, unlabelled, neither side of a block; at most 30): what the posts write first, most-held first, then at most two names. Never the query or its corrected reading, one whose every word the query says, one holding a withdrawn word, or one that only widens or narrows another offered. Each is held by two posts the viewer may see, which its own search then finds. At most 10. Service role only.';

REVOKE ALL ON FUNCTION public.search_related_searches(text, uuid, uuid[], text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_related_searches(text, uuid, uuid[], text, integer) TO service_role;

-- ─── Both tables, from the posts as they are ────────────────────────────────

SELECT * FROM public.rebuild_search_phrases();

COMMIT;
