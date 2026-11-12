-- Search (phase 4, related posts by meaning): when a search finds few posts by
-- their words, it can add posts that mean the same.
--
-- Before this file a search matched words only (20261111224010, 20261112103547,
-- 20261112174210): 'ocean at dusk' found nothing beside a post titled 'Sea
-- after sunset'. The feed has embeddings of posts (post_content_embeddings),
-- but they are made from a post's title, description, body, PROMPT, tool and
-- category, so they hold a paid recipe's hidden caption and prompt, and search
-- must never read them. This file keeps a second embedding per post, made from
-- nothing but the text search already shows: post_search_documents.search_text,
-- the public projection of a post (the caption through
-- recipe_post_public_body, no prompt beside a published recipe, a template
-- result's model as 'template-workflow').
--
-- THE RULE every part of this file keeps: nothing a visitor cannot see may
-- change a match, a distance, a count or an order.
--
-- 1. public.post_search_embeddings: one row per post, backend-owned (RLS on,
--    no policy, the service role may only read it; every write goes through
--    the functions below).
--      post_id          the post; the row leaves with it (ON DELETE CASCADE)
--      embedding_model  'gte-small' today
--      content_hash     sha256 (hex) of the WHOLE search_text the vector was
--                       made from
--      embedding        384 dimensions; compared by cosine distance. No
--                       index: 4 says why
--      embedded_at, updated_at
--    A ROW IS READ ONLY WHILE IT IS TRUE. search_related_posts joins it to
--    the post's document as it is at that instant and requires content_hash
--    to equal the sha256 of that document's search_text. So the moment a
--    post's public text changes (an edit, a recipe published or priced, a
--    Made with change) or the post stops being searchable (private, archived,
--    hidden by review: the document is gone; labelled: is_nsfw is read), the
--    old vector matches nothing, in the same statement that reads the new
--    state. There is no trigger and no stale flag to fall behind: A POST SAVE
--    WRITES NOTHING HERE and costs nothing more than before. The
--    search-embeddings backend job re-makes the vector later
--    (list_posts_pending_search_embedding) and deletes the rows of posts that
--    left search (prune_search_embeddings).
--    A POST IS EMBEDDED ONLY IF ITS PUBLIC TEXT HAS WORDS OF ITS OWN
--    (post_search_document_has_own_words): a title that is not a placeholder
--    (marketplace_text_is_placeholder, the product's own rule: 'Untitled',
--    'Test video', nothing at all), or a word of public caption or public
--    prompt (a B lexeme of the document's search_vector). A post with
--    neither shows a visitor only its tool and model names, 'magicbooklet
--    magicbooklet kling 2.6 kling 2 6 kling26': every such post has the same
--    text, so their vectors are one point that a query naming a tool sits
--    next to, and nothing about any of them. The feed's embedder leaves such
--    posts out for the same reason. Both inputs are columns of the search
--    document, so the rule reads nothing a visitor cannot: a paid recipe's
--    hidden caption is not a caption here.
--    THE JOB'S READ (search_embedding_backlog, list_posts_pending_…) hashes
--    every document's text to find the ones whose vector is missing or out
--    of date: 15 ms at 5,200 documents on a laptop when nothing is waiting,
--    so about 0.3 s at 100,000, every ten minutes. That is the point to keep
--    the hash beside the document instead.
--
-- 2. What the embed-post Edge Function calls, in its 'search' mode:
--      post_search_embedding_texts(ids, model)   the text to embed for each
--        post search could return (unlabelled, with a document whose text
--        has words of its own): the first 2,000 characters of search_text,
--        the hash of the whole of it, and whether the stored vector is
--        already of that hash. A post it does not return has no public text
--        to embed.
--      store_post_search_embeddings(rows, model)  stores a vector only while
--        the document still has the hash the vector was made from, and says
--        which posts it stored.
--
-- 3. public.search_query_embeddings: the vector of a query, kept so the same
--    words are embedded once. Keyed by sha256 of the model and the normalised
--    query (the service's hash; the text itself is never stored), read for 7
--    days, deleted by the job after that: a week keeps what people search for
--    again and lets a burst of made-up queries go. At the service's cap of
--    2,000 new queries a day the table holds 14,000 rows at most (35,000 at
--    this file's own ceiling). public.search_query_embedding_days counts the
--    new query embeddings asked for on a UTC day.
--      search_query_embedding(hash, model)   the cached vector, or NULL. Reads
--        only: a cache hit costs nobody anything.
--      reserve_search_query_embedding(cap)   on a miss, whether one more
--        embedding may be asked for today: the count goes up by one,
--        atomically, while it is under the cap, and the cap is never above
--        c_daily_cap_ceiling (5,000) whatever a caller sends. Past it the
--        answer is "no", and search goes without related posts until the
--        next UTC day. The service asks only after the viewer's own daily
--        allowance let it (check_backend_rate_limit, scope
--        public-search:related-embedding), so one viewer cannot spend the
--        day for everyone.
--      store_search_query_embedding(hash, model, vector)
--
-- 4. public.search_related_posts(p_query_embedding, p_viewer_user_id,
--    p_exclude_post_ids, p_limit, p_embedding_model): the posts nearest a
--    query vector by cosine distance, nearest first.
--      THE CONSTANTS, in that function's DECLARE block and nowhere else:
--        c_min_similarity  0.84   a post is related only at this cosine
--                                 similarity or above. Calibrated on real
--                                 gte-small vectors (local edge runtime,
--                                 2026-11-13) of 204 post texts over 12
--                                 topics, embedded from their search_text,
--                                 and 40 queries, 5 of them about nothing in
--                                 the corpus. Of the 8 nearest posts a query:
--                                   0.83  0.900 on topic, 32 of 35 answered
--                                   0.84  0.955 on topic, 30 of 35 answered
--                                   0.85  1.000 on topic, 25 of 35 answered
--                                 and no query about nothing got a post at
--                                 0.81 or above. gte-small scores unrelated
--                                 short texts high (median 0.76, 1 in 100
--                                 above 0.818), so the bar sits in a narrow
--                                 band and a point lower returns junk.
--                                 docs/research/search-semantic-calibration-
--                                 2026-11-13.md has the table and how to redo
--                                 it.
--        c_max_limit       12     the most posts one call returns
--      WHO IS LEFT OUT, in SQL and before the limit, as search_public_posts
--      leaves them out: a post with no document (not public, archived, hidden
--      by review), a labelled post, both sides of a block with the viewer, a
--      post whose vector is not of its current text or of the asked model, and
--      the posts the caller already shows (p_exclude_post_ids).
--      THE READ IS EXACT, AND THE TABLE HAS NO VECTOR INDEX. Every vector of
--      the asked model is measured against the query; the ones inside the bar
--      are then held to the rules above, and the nearest p_limit of what is
--      left are returned. So the answer is a function of the rows this viewer
--      may see and of nothing else: a labelled, blocked, stale or deleted
--      post never costs the viewer a result or changes which posts come back.
--      An HNSW scan cannot promise that. It returns its nearest 40 rows
--      whatever becomes of them, and on this stack (pgvector 0.8.0, local
--      replay, 2026-11-13) a scan returned none of 8 live rows while the
--      index still held the entries of rows a rolled-back transaction had
--      written, with hnsw.iterative_scan on and hnsw.ef_search at 1,000; a
--      vacuum brought them back. A vector superseded by an edit leaves such
--      an entry behind until the next vacuum. Measured exactly, 5,000 vectors
--      take about 1 ms, 20,000 about 4 ms and 50,000 about 8 ms, before the
--      rules, which are read only for the rows inside the bar. So no index is
--      built: nothing would read it, and every re-embed would pay to keep it.
--      An index-backed read is worth designing when the table nears 250,000
--      vectors (about 50 ms a read at 1 ms per 5,000), and it will have to
--      apply these rules inside the scan, not after it.
--
-- 5. search_query_events gains related_count: how many related posts a
--    first-page answer held, NULL when none were looked for and for every row
--    written before this file. search_query_report does not read it.
--
-- 6. get_operational_table_growth reports post_search_embeddings and
--    search_query_embeddings beside the 27 tables it reported
--    (20261112084002); its definition is otherwise that file's.
--
-- THE RELEASE WINDOW. Migrations apply, then the Edge Functions deploy, then
-- the app is promoted. Nothing live calls anything in this file until the new
-- app does: the app and the function live meanwhile know none of these names.
-- The new app tolerates the old function: that one refuses a 'query' request
-- (search goes without related posts) and reads a 'search' request as the
-- feed's, which the job takes as unsupported and stops at.
--
-- LOCKS. The foreign key takes SHARE ROW EXCLUSIVE on posts and the new column
-- ACCESS EXCLUSIVE on search_query_events, both held to the end of this file.
-- No row of posts is read or written under it: reads of posts go on, and a
-- post saved meanwhile waits for milliseconds. search_query_events is read
-- once, to hold its rows to the new column's check (a 90-day log, as
-- 20261112174210 read it for its own columns), and it is altered last, so
-- that read is all that is done under its lock. post_search_documents is not
-- locked. No trigger is added to any table.
--
-- search_public_posts, search_public_creators, search_public_entities,
-- search_post_score, search_terms, the documents' projection,
-- marketplace_text_is_placeholder and post_content_embeddings are untouched.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- pgvector lives in the extensions schema here (20261012061058 moved the feed
-- to it and refuses to run otherwise).
DO $search_semantic_vector$
BEGIN
  IF to_regtype('extensions.vector') IS NULL THEN
    RAISE EXCEPTION 'Semantic search requires pgvector in the extensions schema';
  END IF;
END;
$search_semantic_vector$;

-- ─── 1. A post's public-text embedding ──────────────────────────────────────

CREATE TABLE public.post_search_embeddings (
  post_id uuid PRIMARY KEY REFERENCES public.posts(id) ON DELETE CASCADE,
  embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 160),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  embedding extensions.vector(384) NOT NULL,
  embedded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.post_search_embeddings ENABLE ROW LEVEL SECURITY;

-- No policy: the Data API roles see and write nothing. The service role reads;
-- every write is one of the functions below.
REVOKE ALL ON TABLE public.post_search_embeddings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.post_search_embeddings TO service_role;

COMMENT ON TABLE public.post_search_embeddings IS
  'Backend-owned gte-small embedding of a post''s public search text (post_search_documents.search_text), for search_related_posts. Never the feed''s post_content_embeddings, which hold hidden text. A row is read only while content_hash is the sha256 of the post''s current search_text. Service role only.';
COMMENT ON COLUMN public.post_search_embeddings.content_hash IS
  'sha256 (hex) of the whole post_search_documents.search_text the vector was made from. A row whose hash is not the current text''s is never read and is re-made by the search-embeddings job.';

-- A document's text has words of its own: the title is not a placeholder, or
-- the public caption or public prompt holds a word. Both are read from the
-- search document, the public projection: its title, and the B lexemes of its
-- search_vector (20261111224010 weights the caption as public reads show it
-- and the prompt no recipe covers as B, the title and model names as A, the
-- tool names as C).
CREATE FUNCTION public.post_search_document_has_own_words(
  p_title_normalized text,
  p_search_vector tsvector
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT coalesce(length(ts_filter(p_search_vector, '{b}')) > 0, false)
    OR NOT public.marketplace_text_is_placeholder(p_title_normalized);
$function$;

COMMENT ON FUNCTION public.post_search_document_has_own_words(text, tsvector) IS
  'Whether a search document says something of its post beyond tool and model names: a title that is not a placeholder (marketplace_text_is_placeholder), or a word of public caption or public prompt (a B lexeme). Only such posts are embedded for search_related_posts. Service role only.';

-- ─── 2. What the embed-post Edge Function reads and writes ──────────────────

CREATE FUNCTION public.list_posts_pending_search_embedding(
  p_embedding_model text,
  p_limit integer DEFAULT 96
)
RETURNS TABLE(post_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'Pending search embedding limit must be between 1 and 500';
  END IF;

  -- The posts search could return whose vector is missing, of another model,
  -- or of a text the post no longer shows; of those, the ones with words of
  -- their own, newest first. The rule is asked of the few candidates only
  -- (the materialised step), never of every document.
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT documents.post_id, documents.created_at, documents.title_normalized, documents.search_vector
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    LEFT JOIN public.post_search_embeddings AS embeddings ON embeddings.post_id = documents.post_id
    WHERE posts.is_nsfw = false
      AND (
        embeddings.post_id IS NULL
        OR embeddings.embedding_model <> p_embedding_model
        OR embeddings.content_hash <> encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
      )
  )
  SELECT candidates.post_id
  FROM candidates
  WHERE public.post_search_document_has_own_words(candidates.title_normalized, candidates.search_vector)
  ORDER BY candidates.created_at DESC, candidates.post_id ASC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.list_posts_pending_search_embedding(text, integer) IS
  'The posts search could return (a document, unlabelled) whose public text has words of its own and whose embedding is missing, of another model, or of a text the post no longer shows; newest first. Read by the search-embeddings job. Service role only.';

CREATE FUNCTION public.post_search_embedding_texts(
  p_post_ids uuid[],
  p_embedding_model text
)
RETURNS TABLE(post_id uuid, embedding_text text, content_hash text, unchanged boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;
  IF p_post_ids IS NULL OR cardinality(p_post_ids) < 1 OR cardinality(p_post_ids) > 25 THEN
    RAISE EXCEPTION 'Search embedding texts are read for 1 to 25 posts';
  END IF;

  -- Only the public projection is read: no column of posts but the label.
  RETURN QUERY
  SELECT
    documents.post_id,
    left(documents.search_text, 2000) AS embedding_text,
    encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex') AS content_hash,
    coalesce(
      embeddings.embedding_model = p_embedding_model
        AND embeddings.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex'),
      false
    ) AS unchanged
  FROM public.post_search_documents AS documents
  JOIN public.posts AS posts ON posts.id = documents.post_id
  LEFT JOIN public.post_search_embeddings AS embeddings ON embeddings.post_id = documents.post_id
  WHERE documents.post_id = ANY (p_post_ids)
    AND posts.is_nsfw = false
    AND public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector);
END;
$function$;

COMMENT ON FUNCTION public.post_search_embedding_texts(uuid[], text) IS
  'For each given post search could return whose public text has words of its own: the first 2,000 characters of its search text (what embed-post embeds), the sha256 of the whole text, and whether the stored vector is already of that text and model. A post it leaves out has no public text to embed. Service role only.';

CREATE FUNCTION public.store_post_search_embeddings(
  p_rows jsonb,
  p_embedding_model text
)
RETURNS TABLE(stored_post_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array'
     OR jsonb_array_length(p_rows) < 1 OR jsonb_array_length(p_rows) > 25 THEN
    RAISE EXCEPTION 'Search embeddings are stored 1 to 25 at a time';
  END IF;

  -- A vector is kept only while the post still shows the text it was made
  -- from: one made from a text read a moment before an edit is dropped here,
  -- and the post stays pending. (search_related_posts checks the hash again
  -- at read time, so a vector that slipped past this would still match
  -- nothing.)
  RETURN QUERY
  INSERT INTO public.post_search_embeddings AS stored (
    post_id, embedding_model, content_hash, embedding, embedded_at, updated_at
  )
  SELECT DISTINCT ON (documents.post_id)
    documents.post_id,
    p_embedding_model,
    incoming.content_hash,
    incoming.embedding::extensions.vector(384),
    now(),
    now()
  FROM jsonb_to_recordset(p_rows) AS incoming(post_id uuid, content_hash text, embedding text)
  JOIN public.post_search_documents AS documents ON documents.post_id = incoming.post_id
  JOIN public.posts AS posts ON posts.id = documents.post_id
  WHERE posts.is_nsfw = false
    AND incoming.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
    AND public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector)
  ORDER BY documents.post_id
  ON CONFLICT ON CONSTRAINT post_search_embeddings_pkey DO UPDATE
    SET embedding_model = EXCLUDED.embedding_model,
        content_hash = EXCLUDED.content_hash,
        embedding = EXCLUDED.embedding,
        embedded_at = EXCLUDED.embedded_at,
        updated_at = EXCLUDED.updated_at
  RETURNING stored.post_id;
END;
$function$;

COMMENT ON FUNCTION public.store_post_search_embeddings(jsonb, text) IS
  'Stores public-text embeddings ([{post_id, content_hash, embedding}], 1 to 25) for posts search could return whose current search text still has that hash and has words of its own, and returns the posts stored. Called by embed-post. Service role only.';

-- ─── 3. Query vectors: a cache and a daily count ────────────────────────────

CREATE TABLE public.search_query_embeddings (
  query_hash text PRIMARY KEY CHECK (query_hash ~ '^[0-9a-f]{64}$'),
  embedding_model text NOT NULL CHECK (char_length(embedding_model) BETWEEN 1 AND 160),
  embedding extensions.vector(384) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The prune reads by age.
CREATE INDEX search_query_embeddings_created_at_idx
  ON public.search_query_embeddings (created_at);

ALTER TABLE public.search_query_embeddings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.search_query_embeddings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.search_query_embeddings TO service_role;

COMMENT ON TABLE public.search_query_embeddings IS
  'Cache of search query vectors, keyed by sha256 of the embedding model and the normalised query (never the query text). Read for 7 days, then deleted by the search-embeddings job. Service role only.';

CREATE TABLE public.search_query_embedding_days (
  day date PRIMARY KEY,
  requested integer NOT NULL DEFAULT 0 CHECK (requested >= 0)
);

ALTER TABLE public.search_query_embedding_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.search_query_embedding_days FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.search_query_embedding_days TO service_role;

COMMENT ON TABLE public.search_query_embedding_days IS
  'How many new query embeddings search asked the embed-post function for on a UTC day (reserve_search_query_embedding counts one per cache miss it allows). The daily cap is read against it. Service role only.';

CREATE FUNCTION public.search_query_embedding(
  p_query_hash text,
  p_embedding_model text
)
RETURNS extensions.vector
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- How long a cached vector is read; prune_search_embeddings deletes by the same age.
  c_retention CONSTANT interval := interval '7 days';
  v_embedding extensions.vector;
BEGIN
  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Search query hash must be 64 lowercase hex characters';
  END IF;
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;

  SELECT cached.embedding
  INTO v_embedding
  FROM public.search_query_embeddings AS cached
  WHERE cached.query_hash = p_query_hash
    AND cached.embedding_model = p_embedding_model
    AND cached.created_at > now() - c_retention;

  RETURN v_embedding;
END;
$function$;

COMMENT ON FUNCTION public.search_query_embedding(text, text) IS
  'The cached vector of a query hash, read for 7 days, or NULL. Reads only: nothing is counted. Service role only.';

CREATE FUNCTION public.reserve_search_query_embedding(p_daily_cap integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- However many a caller asks for, never more new query embeddings a day.
  c_daily_cap_ceiling CONSTANT integer := 5000;
  v_cap integer := least(greatest(coalesce(p_daily_cap, 0), 0), c_daily_cap_ceiling);
BEGIN
  IF v_cap < 1 THEN
    RETURN false;
  END IF;

  -- One statement: two misses at once cannot both take the last place.
  INSERT INTO public.search_query_embedding_days AS days (day, requested)
  VALUES ((now() AT TIME ZONE 'UTC')::date, 1)
  ON CONFLICT ON CONSTRAINT search_query_embedding_days_pkey DO UPDATE
    SET requested = days.requested + 1
    WHERE days.requested < v_cap;
  RETURN FOUND;
END;
$function$;

COMMENT ON FUNCTION public.reserve_search_query_embedding(integer) IS
  'Whether one more new query embedding may be asked for on this UTC day: true, and the day''s count goes up by one, while it is under p_daily_cap, itself never above 5,000. Service role only.';

CREATE FUNCTION public.store_search_query_embedding(
  p_query_hash text,
  p_embedding_model text,
  p_embedding extensions.vector
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_query_hash IS NULL OR p_query_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Search query hash must be 64 lowercase hex characters';
  END IF;
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;
  IF p_embedding IS NULL OR extensions.vector_dims(p_embedding) <> 384 THEN
    RAISE EXCEPTION 'Search query embedding must have 384 dimensions';
  END IF;

  INSERT INTO public.search_query_embeddings AS cached (query_hash, embedding_model, embedding, created_at)
  VALUES (p_query_hash, p_embedding_model, p_embedding, now())
  ON CONFLICT ON CONSTRAINT search_query_embeddings_pkey DO UPDATE
    SET embedding_model = EXCLUDED.embedding_model,
        embedding = EXCLUDED.embedding,
        created_at = EXCLUDED.created_at;
END;
$function$;

COMMENT ON FUNCTION public.store_search_query_embedding(text, text, extensions.vector) IS
  'Keeps a query''s vector under its hash for search_query_embedding. Service role only.';

-- ─── The job's housekeeping ─────────────────────────────────────────────────

CREATE FUNCTION public.prune_search_embeddings(p_limit integer DEFAULT 1000)
RETURNS TABLE(post_embeddings_deleted integer, query_embeddings_deleted integer, query_days_deleted integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- As search_query_embedding reads them.
  c_retention CONSTANT interval := interval '7 days';
  -- The daily counts are kept a week, for the runbook's look at use.
  c_day_retention CONSTANT integer := 7;
  v_posts integer;
  v_queries integer;
  v_days integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'Search embedding prune limit must be between 1 and 10000';
  END IF;

  -- The vectors of posts search can no longer return: no document (private,
  -- archived, hidden by review) or labelled; and of posts whose text changed
  -- into one with no words of its own, which will not be embedded again.
  -- They were already unread. (A vector of a text that changed and still has
  -- words of its own stays: the job re-makes it.)
  WITH gone AS (
    SELECT embeddings.post_id
    FROM public.post_search_embeddings AS embeddings
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.post_search_documents AS documents
      JOIN public.posts AS posts ON posts.id = documents.post_id
      WHERE documents.post_id = embeddings.post_id
        AND posts.is_nsfw = false
        AND (
          embeddings.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
          OR public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector)
        )
    )
    LIMIT p_limit
  ),
  deleted AS (
    DELETE FROM public.post_search_embeddings AS embeddings
    USING gone
    WHERE embeddings.post_id = gone.post_id
    RETURNING 1
  )
  SELECT count(*) INTO v_posts FROM deleted;

  WITH old AS (
    SELECT cached.query_hash
    FROM public.search_query_embeddings AS cached
    WHERE cached.created_at <= now() - c_retention
    LIMIT p_limit
  ),
  deleted AS (
    DELETE FROM public.search_query_embeddings AS cached
    USING old
    WHERE cached.query_hash = old.query_hash
    RETURNING 1
  )
  SELECT count(*) INTO v_queries FROM deleted;

  WITH deleted AS (
    DELETE FROM public.search_query_embedding_days AS days
    WHERE days.day < (now() AT TIME ZONE 'UTC')::date - c_day_retention
    RETURNING 1
  )
  SELECT count(*) INTO v_days FROM deleted;

  RETURN QUERY SELECT v_posts, v_queries, v_days;
END;
$function$;

COMMENT ON FUNCTION public.prune_search_embeddings(integer) IS
  'Deletes, at most p_limit of each: the embeddings of posts search can no longer return or whose text no longer has words of its own, and cached query vectors older than 7 days; and the daily counts older than a week. Run by the search-embeddings job. Service role only.';

CREATE FUNCTION public.search_embedding_backlog(p_embedding_model text)
RETURNS TABLE(pending boolean, prunable boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  c_retention CONSTANT interval := interval '7 days';
  c_day_retention CONSTANT integer := 7;
BEGIN
  RETURN QUERY
  SELECT
    EXISTS (SELECT 1 FROM public.list_posts_pending_search_embedding(p_embedding_model, 1)),
    EXISTS (
      SELECT 1
      FROM public.post_search_embeddings AS embeddings
      WHERE NOT EXISTS (
        SELECT 1
        FROM public.post_search_documents AS documents
        JOIN public.posts AS posts ON posts.id = documents.post_id
        WHERE documents.post_id = embeddings.post_id
          AND posts.is_nsfw = false
          AND (
            embeddings.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
            OR public.post_search_document_has_own_words(documents.title_normalized, documents.search_vector)
          )
      )
    )
    OR EXISTS (
      SELECT 1
      FROM public.search_query_embeddings AS cached
      WHERE cached.created_at <= now() - c_retention
    )
    OR EXISTS (
      SELECT 1
      FROM public.search_query_embedding_days AS days
      WHERE days.day < (now() AT TIME ZONE 'UTC')::date - c_day_retention
    );
END;
$function$;

COMMENT ON FUNCTION public.search_embedding_backlog(text) IS
  'Whether the search-embeddings job has work: a post waiting for its public-text embedding (pending), or something prune_search_embeddings would delete (prunable). Service role only.';

-- ─── 4. Related posts ───────────────────────────────────────────────────────

CREATE FUNCTION public.search_related_posts(
  p_query_embedding extensions.vector,
  p_viewer_user_id uuid DEFAULT NULL,
  p_exclude_post_ids uuid[] DEFAULT NULL,
  p_limit integer DEFAULT 8,
  p_embedding_model text DEFAULT 'gte-small'
)
RETURNS TABLE(post_id uuid, creator_user_id uuid, similarity double precision)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- THE CONSTANTS (this file's header says how each was chosen).
  -- A post is related only at this cosine similarity to the query or above.
  c_min_similarity CONSTANT double precision := 0.84;
  -- The most posts one call returns.
  c_max_limit CONSTANT integer := 12;

  v_max_distance CONSTANT double precision := 1.0 - c_min_similarity;
  v_exclude uuid[] := coalesce(p_exclude_post_ids, '{}'::uuid[]);
BEGIN
  IF p_query_embedding IS NULL OR extensions.vector_dims(p_query_embedding) <> 384 THEN
    RAISE EXCEPTION 'Related post search needs a query embedding of 384 dimensions';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > c_max_limit THEN
    RAISE EXCEPTION 'Related post search limit must be between 1 and %', c_max_limit;
  END IF;
  IF cardinality(v_exclude) > 100 THEN
    RAISE EXCEPTION 'Related post search excludes at most 100 posts';
  END IF;
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;

  RETURN QUERY
  -- Every vector of the model, measured: the ones inside the bar. The table
  -- has no vector index, and this step would use none: a distance in a WHERE
  -- clause, with no ORDER BY beside it, is nothing an HNSW index answers, and
  -- the materialised step keeps the order below apart from it. A read of the
  -- whole table, and its answer is exact.
  WITH near AS MATERIALIZED (
    SELECT
      embeddings.post_id,
      embeddings.content_hash,
      (embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding)::double precision AS distance
    FROM public.post_search_embeddings AS embeddings
    WHERE embeddings.embedding_model = p_embedding_model
      AND (embeddings.embedding OPERATOR(extensions.<=>) p_query_embedding) <= v_max_distance
  )
  -- The rules, before the limit: a row is kept only if search_public_posts
  -- could return its post to this viewer and its vector is of the text that
  -- post shows now.
  SELECT
    near.post_id,
    documents.creator_user_id,
    round((1.0 - near.distance)::numeric, 6)::double precision AS similarity
  FROM near
  JOIN public.post_search_documents AS documents ON documents.post_id = near.post_id
  JOIN public.posts AS posts ON posts.id = documents.post_id
  WHERE near.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
    AND posts.is_nsfw = false
    AND NOT (near.post_id = ANY (v_exclude))
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
  ORDER BY near.distance ASC, near.post_id ASC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_related_posts(extensions.vector, uuid, uuid[], integer, text) IS
  'The posts nearest a query vector by cosine distance over post_search_embeddings (the public search text only), nearest first, at cosine similarity 0.84 or above, at most 12. Left out before the limit, as search_public_posts leaves them out: posts without a document, labelled posts, both sides of a block with the viewer; and a post whose vector is not of its current text, and p_exclude_post_ids. Service role only.';

REVOKE ALL ON FUNCTION public.list_posts_pending_search_embedding(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_search_embedding_texts(uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_post_search_embeddings(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.post_search_document_has_own_words(text, tsvector) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_query_embedding(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_search_query_embedding(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_search_query_embedding(text, text, extensions.vector) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prune_search_embeddings(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_embedding_backlog(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_related_posts(extensions.vector, uuid, uuid[], integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_posts_pending_search_embedding(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_search_embedding_texts(uuid[], text) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_post_search_embeddings(jsonb, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.post_search_document_has_own_words(text, tsvector) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_query_embedding(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_search_query_embedding(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_search_query_embedding(text, text, extensions.vector) TO service_role;
GRANT EXECUTE ON FUNCTION public.prune_search_embeddings(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_embedding_backlog(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_related_posts(extensions.vector, uuid, uuid[], integer, text) TO service_role;

-- ─── 6. Growth accounting counts the two tables that grow ───────────────────
--
-- The definition of 20261112084002 with post_search_embeddings (a row per
-- searchable post with words of its own) and search_query_embeddings (a row
-- per distinct query of the last week) added. search_query_embedding_days is
-- a row a day, kept a week, and is not counted.
CREATE OR REPLACE FUNCTION public.get_operational_table_growth()
RETURNS TABLE (
  table_name text,
  live_rows bigint,
  total_bytes bigint
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_catalog, pg_temp
AS $function$
  SELECT growth.table_name, growth.live_rows, growth.total_bytes
  FROM (
    SELECT
      stats.relname::text AS table_name,
      stats.n_live_tup AS live_rows,
      pg_catalog.pg_total_relation_size(stats.relid) AS total_bytes
    FROM pg_catalog.pg_stat_user_tables AS stats
    WHERE stats.schemaname = 'public'
      AND stats.relname = ANY (ARRAY[
        'account_merge_tickets',
        'ai_usage_events',
        'backend_job_locks',
        'backend_job_runs',
        'backend_rate_limits',
        'feed_delivery_facts',
        'feed_events',
        'feed_session_items',
        'feed_sessions',
        'feed_viewer_daily',
        'generation_completion_jobs',
        'generation_model_provider_checks',
        'mobile_notifications',
        'mobile_push_deliveries',
        'onboarding_events',
        'playback_metrics',
        'playback_metrics_daily_rollup',
        'post_search_embeddings',
        'provider_dependency_events',
        'search_query_embeddings',
        'search_query_events',
        'template_run_steps',
        'template_runs',
        'upload_byte_reservations',
        'upload_byte_user_counters',
        'upload_path_tombstones',
        'workflow_canvas_run_steps',
        'workflow_canvas_runs',
        'workflow_run_step_jobs'
      ])

    UNION ALL

    SELECT
      'auth.users',
      stats.n_live_tup,
      pg_catalog.pg_total_relation_size(stats.relid)
    FROM pg_catalog.pg_stat_user_tables AS stats
    WHERE stats.schemaname = 'auth'
      AND stats.relname = 'users'

    UNION ALL

    SELECT
      'guest_identities',
      (
        SELECT count(*)
        FROM auth.users AS guest
        WHERE guest.is_anonymous
          AND guest.deleted_at IS NULL
      ),
      0::bigint
  ) AS growth
  ORDER BY growth.total_bytes DESC, growth.table_name;
$function$;

REVOKE ALL ON FUNCTION public.get_operational_table_growth()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_operational_table_growth()
  TO service_role;

COMMENT ON FUNCTION public.get_operational_table_growth() IS
  'Row counts and byte sizes for churn-prone operational state, append-only telemetry with retention, the vectors search keeps of posts and of queries, permanent security ledgers, user-owned workflow history, auth.users and the exact count of live guest identities (bytes 0: part of auth.users). Service role only.';

-- ─── 5. The search log says whether related posts were returned ─────────────
--
-- Nullable, NULL for a row written before this file, by the app live during
-- the release, and for an answer that looked for none. search_query_report
-- does not read it.

ALTER TABLE public.search_query_events
  ADD COLUMN related_count integer CHECK (related_count IS NULL OR related_count BETWEEN 0 AND 24);

COMMENT ON COLUMN public.search_query_events.related_count IS
  'How many related posts (search_related_posts) a first-page answer held beside its own. 0 when they were looked for and none passed; NULL when they were not looked for and for rows written before 20261112215420.';

COMMIT;
