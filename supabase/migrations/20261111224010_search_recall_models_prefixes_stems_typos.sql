-- Search finds what people type: a post by its model, a word still being
-- typed, a plural, a misspelling.
--
-- search_public_posts matched whole words of a post's title, caption, prompt
-- and first tool, spelt as stored (20260827110000_public_search.sql). So:
--
--   - a creation made in the app was found by no model name. Its post names
--     the app as its tool ('Magicbooklet'); the model is the creation's
--     (generations.model, which every card prints) or a Made with row's
--     (post_source_tools, where the tools after the first live as well), and
--     the document read neither;
--   - 'veo 3' never met 'veo-3.1': the text-search parser reads that id as
--     'veo' and the number '-3.1';
--   - 'portraits' missed 'portrait', and of several words the last had to be
--     whole, so results came and went with each letter typed;
--   - a misspelling matched only a title about as long as the query, the two
--     compared whole.
--
-- 1. Three helpers say how a name and a query are read:
--    search_split_terms (letters and digits apart, every other character a
--    space: 'veo-3.1' and 'veo3' both read 'veo 3 1' / 'veo 3'),
--    search_term_variants (a tool's or model's name as written, split, and as
--    one word: 'nano-banana-pro nano banana pro nanobananapro'), and
--    search_query_tsquery (the query as typed and split, in the 'simple'
--    configuration and, for posts, 'english' as well, every word required and
--    the last one a prefix).
-- 2. refresh_post_search_documents adds to a post's document its creation's
--    model and every Made with tool and model, the models weighted as the
--    title is, and the 'english' reading of its title, caption and prompt
--    beside the 'simple' one. The caption and prompt are read as before
--    (20261101124828_post_search_public_caption.sql): as public reads show
--    them, never a paid recipe's.
-- 3. The posts trigger follows generation_id too, and post_source_tools gets
--    statement triggers, so a document follows its Made with.
-- 4. search_terms is the dictionary a misspelling is read against: the words
--    of four letters or more that unlabelled public posts show, added as
--    documents are projected. search_corrected_query reads each word of a
--    query that no known word starts with as the nearest known one
--    (trigram similarity of 0.35 or more, the same first letter, within two
--    letters of its length).
-- 5. search_public_posts and search_public_creators match on the new query.
--    Post search, when no post holds the query as typed, runs once more on
--    its corrected reading. Creator search adds word_similarity against the
--    name and handle, by the indexed operator. Their signatures, eligibility
--    (the NSFW label included), score, order, definer rights, search paths
--    and grants are kept.
-- 6. Every post document is re-projected at the end, which fills the
--    dictionary.
--
-- A misspelling is corrected against the dictionary, never matched against
-- each document: word_similarity over every document's text took 2.6 to 4 s
-- a search on 3,000 posts of 6 kB (local replay, 2026-11-12), and its
-- operator form (<%) takes its threshold from a setting this role may not
-- set for a function. The dictionary keeps a word after its last post goes;
-- a query corrected to such a word finds nothing, as it did uncorrected.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- As 20261101124828 took them: posts first. SHARE ROW EXCLUSIVE is what
-- CREATE TRIGGER takes; reads go on beside it. A post or a Made with row
-- written while this file runs waits for it, and its triggers then use the
-- new projection. The triggers are made with CREATE OR REPLACE, never DROP
-- TRIGGER, whose ACCESS EXCLUSIVE lock would stop the feed's reads of posts.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_source_tools IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. How a name and a query are read ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_split_terms(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(lower(coalesce(p_text, '')), '[^[:alnum:]]+', ' ', 'g'),
        '([[:alpha:]])([[:digit:]])', '\1 \2', 'g'
      ),
      '([[:digit:]])([[:alpha:]])', '\1 \2', 'g'
    ),
    '[[:space:]]+', ' ', 'g'
  ));
$function$;

COMMENT ON FUNCTION public.search_split_terms(text) IS
  'A name or a search query with letters and digits apart and every other character a space, lowercased: veo-3.1 and veo3.1 both read veo 3 1.';

CREATE OR REPLACE FUNCTION public.search_term_variants(p_term text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT nullif(concat_ws(
    ' ',
    nullif(lower(btrim(coalesce(p_term, ''))), ''),
    nullif(public.search_split_terms(p_term), ''),
    nullif(regexp_replace(lower(coalesce(p_term, '')), '[^[:alnum:]]+', '', 'g'), '')
  ), '');
$function$;

COMMENT ON FUNCTION public.search_term_variants(text) IS
  'A tool''s or model''s name as search documents hold it: as written, split (search_split_terms) and as one word. NULL for an empty name.';

CREATE OR REPLACE FUNCTION public.search_prefix_tsquery(p_config regconfig, p_text text)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  -- plainto_tsquery writes its lexemes quoted and joined by &, so the text
  -- ends with the last one's closing quote and ':*' makes that one a prefix.
  SELECT CASE
    WHEN numnode(parsed.query) = 0 THEN parsed.query
    ELSE (parsed.query::text || ':*')::tsquery
  END
  FROM (SELECT plainto_tsquery(p_config, coalesce(p_text, '')) AS query) AS parsed;
$function$;

COMMENT ON FUNCTION public.search_prefix_tsquery(regconfig, text) IS
  'plainto_tsquery with its last word a prefix: every word required, the one still being typed matched from its start. Empty for a text with no lexeme.';

CREATE OR REPLACE FUNCTION public.search_query_tsquery(p_query text, p_stem boolean)
RETURNS tsquery
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE
    WHEN p_stem THEN
      readings.as_typed
        || readings.split
        || public.search_prefix_tsquery('pg_catalog.english', p_query)
        || public.search_prefix_tsquery('pg_catalog.english', public.search_split_terms(p_query))
    ELSE readings.as_typed || readings.split
  END
  FROM (
    SELECT
      public.search_prefix_tsquery('pg_catalog.simple', p_query) AS as_typed,
      public.search_prefix_tsquery('pg_catalog.simple', public.search_split_terms(p_query)) AS split
  ) AS readings;
$function$;

COMMENT ON FUNCTION public.search_query_tsquery(text, boolean) IS
  'A search query as documents are matched on it: as typed or split (search_split_terms), each with its last word a prefix; with p_stem, in the english configuration as well, so a plural finds its singular.';

REVOKE ALL ON FUNCTION public.search_split_terms(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_term_variants(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_prefix_tsquery(regconfig, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_query_tsquery(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_split_terms(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_term_variants(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_prefix_tsquery(regconfig, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_query_tsquery(text, boolean) TO service_role;

-- ─── 1b. The dictionary a misspelling is read against ───────────────────────

CREATE TABLE public.search_terms (
  term text PRIMARY KEY CHECK (term ~ '^[[:alpha:]]{4,40}$')
);

CREATE INDEX search_terms_trgm_idx
  ON public.search_terms USING gin (term extensions.gin_trgm_ops);

ALTER TABLE public.search_terms ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.search_terms FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.search_terms TO service_role;

COMMENT ON TABLE public.search_terms IS
  'Backend-owned dictionary for search spelling correction: lowercase words of 4 to 40 letters that unlabelled public posts show, added by refresh_post_search_documents. Words only, never which post held them.';

CREATE OR REPLACE FUNCTION public.search_corrected_query(p_query text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT string_agg(coalesce(nearest.term, words.word), ' ' ORDER BY words.position)
  FROM regexp_split_to_table(public.search_split_terms(p_query), ' ')
    WITH ORDINALITY AS words(word, position)
  LEFT JOIN LATERAL (
    SELECT terms.term
    FROM public.search_terms AS terms
    WHERE words.word ~ '^[[:alpha:]]{4,40}$'
      -- A word some known word starts with is spelt right so far.
      AND NOT EXISTS (
        SELECT 1
        FROM public.search_terms AS known
        WHERE known.term LIKE words.word || '%'
      )
      AND terms.term OPERATOR(extensions.%) words.word
      AND extensions.similarity(terms.term, words.word) >= 0.35
      AND left(terms.term, 1) = left(words.word, 1)
      AND abs(char_length(terms.term) - char_length(words.word)) <= 2
    ORDER BY extensions.similarity(terms.term, words.word) DESC, terms.term
    LIMIT 1
  ) AS nearest ON true;
$function$;

COMMENT ON FUNCTION public.search_corrected_query(text) IS
  'A search query (split as search_split_terms reads it) with each misspelt word replaced by the nearest word of search_terms. A word is left alone when it is under four letters, holds a digit, starts a known word, or has no near neighbour.';

REVOKE ALL ON FUNCTION public.search_corrected_query(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_corrected_query(text) TO service_role;

-- ─── 2. The document holds the post's model and every Made with name ────────

CREATE OR REPLACE FUNCTION public.refresh_post_search_documents(p_post_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF p_post_ids IS NULL OR cardinality(p_post_ids) = 0 THEN
    RETURN;
  END IF;

  DELETE FROM public.post_search_documents
  WHERE post_id = ANY (p_post_ids);

  INSERT INTO public.post_search_documents (
    post_id,
    creator_user_id,
    title_normalized,
    tool_normalized,
    search_text,
    search_vector,
    created_at
  )
  SELECT
    posts.id,
    posts.user_id,
    lower(btrim(coalesce(posts.title, ''))),
    lower(btrim(concat_ws(' ', posts.source_tool, posts.source_tool_slug))),
    lower(btrim(concat_ws(
      ' ',
      posts.title,
      public.recipe_post_public_body(posts.body, bundles.access_mode),
      CASE WHEN bundles.id IS NULL THEN posts.prompt END,
      posts.source_tool,
      posts.source_tool_slug,
      made_with.tool_terms,
      made_with.model_terms
    ))),
    setweight(to_tsvector('pg_catalog.simple', coalesce(posts.title, '')), 'A')
      || setweight(to_tsvector('pg_catalog.english', coalesce(posts.title, '')), 'A')
      || setweight(to_tsvector('pg_catalog.simple', public.search_split_terms(posts.title)), 'A')
      || setweight(to_tsvector('pg_catalog.simple', coalesce(public.recipe_post_public_body(posts.body, bundles.access_mode), '')), 'B')
      || setweight(to_tsvector('pg_catalog.english', coalesce(public.recipe_post_public_body(posts.body, bundles.access_mode), '')), 'B')
      || setweight(to_tsvector('pg_catalog.simple', coalesce(CASE WHEN bundles.id IS NULL THEN posts.prompt END, '')), 'B')
      || setweight(to_tsvector('pg_catalog.english', coalesce(CASE WHEN bundles.id IS NULL THEN posts.prompt END, '')), 'B')
      || setweight(to_tsvector('pg_catalog.simple', coalesce(made_with.model_terms, '')), 'A')
      || setweight(to_tsvector(
        'pg_catalog.simple',
        concat_ws(' ', posts.source_tool, posts.source_tool_slug, made_with.tool_terms)
      ), 'C'),
    posts.created_at
  FROM public.posts AS posts
  LEFT JOIN public.post_resource_bundles AS bundles
    ON bundles.post_id = posts.id
    AND bundles.status = 'published'
  LEFT JOIN public.generations AS generations
    ON generations.id = posts.generation_id
  CROSS JOIN LATERAL (
    SELECT
      (
        SELECT string_agg(public.search_term_variants(names.name), ' ' ORDER BY names.name)
        FROM (
          SELECT lower(btrim(tools.tool_label)) AS name
          FROM public.post_source_tools AS tools
          WHERE tools.post_id = posts.id
          UNION
          SELECT lower(btrim(tools.tool_slug))
          FROM public.post_source_tools AS tools
          WHERE tools.post_id = posts.id
        ) AS names
        WHERE names.name <> ''
      ) AS tool_terms,
      (
        -- The creation's model is the one every card of the post prints.
        SELECT string_agg(public.search_term_variants(names.name), ' ' ORDER BY names.name)
        FROM (
          SELECT lower(btrim(generations.model)) AS name
          UNION
          SELECT lower(btrim(tools.model_label))
          FROM public.post_source_tools AS tools
          WHERE tools.post_id = posts.id
          UNION
          SELECT lower(btrim(tools.model_slug))
          FROM public.post_source_tools AS tools
          WHERE tools.post_id = posts.id
        ) AS names
        WHERE names.name <> ''
      ) AS model_terms
  ) AS made_with
  WHERE posts.id = ANY (p_post_ids)
    AND posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND posts.review_status = 'visible';

  -- The words these documents show, for search_corrected_query. In order, so
  -- two projections adding the same new words never wait on each other in a
  -- ring. A labelled post's words stay out: search never shows that post.
  INSERT INTO public.search_terms (term)
  SELECT DISTINCT words.lexeme
  FROM public.post_search_documents AS documents
  JOIN public.posts AS posts ON posts.id = documents.post_id
  CROSS JOIN LATERAL unnest(to_tsvector('pg_catalog.simple', documents.search_text)) AS words
  WHERE documents.post_id = ANY (p_post_ids)
    AND posts.is_nsfw = false
    AND words.lexeme ~ '^[[:alpha:]]{4,40}$'
  ORDER BY words.lexeme
  ON CONFLICT (term) DO NOTHING;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_post_search_documents(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_search_documents(uuid[]) TO service_role;

-- ─── 3. A document follows its creation and its Made with ───────────────────

-- The columns of 20260827110000, and generation_id: the creation names the model.
CREATE OR REPLACE TRIGGER posts_refresh_public_search_document
AFTER INSERT OR UPDATE OF
  title, body, prompt, source_tool, source_tool_slug, generation_id, visibility, archived_at, review_status
ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.trg_refresh_post_search_document();

CREATE OR REPLACE FUNCTION public.trg_refresh_post_search_document_for_source_tools()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_post_ids uuid[];
BEGIN
  -- Once per statement: a save replaces a post's rows together.
  IF TG_OP = 'UPDATE' THEN
    v_post_ids := ARRAY(
      SELECT post_id FROM changed_rows
      UNION
      SELECT post_id FROM replaced_rows
    );
  ELSE
    v_post_ids := ARRAY(SELECT DISTINCT post_id FROM changed_rows);
  END IF;

  IF cardinality(v_post_ids) = 0 THEN
    RETURN NULL;
  END IF;

  -- Lock the posts before projecting, as the recipe trigger does
  -- (trg_refresh_post_search_document_for_recipe): an edit of the post running
  -- at the same time then waits for these rows or is waited for, and the
  -- later of the two projects both. Rows deleted with their post find it
  -- gone: nothing to lock, and no document comes back for it.
  PERFORM 1
  FROM public.posts
  WHERE id = ANY (v_post_ids)
  ORDER BY id
  FOR NO KEY UPDATE;

  PERFORM public.refresh_post_search_documents(v_post_ids);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_refresh_post_search_document_for_source_tools()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.trg_refresh_post_search_document_for_source_tools() IS
  'Made with trigger: re-projects the search document of each post whose tools or models a statement added, changed or removed.';

CREATE OR REPLACE TRIGGER post_source_tools_refresh_post_search_insert
AFTER INSERT ON public.post_source_tools
REFERENCING NEW TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_refresh_post_search_document_for_source_tools();

CREATE OR REPLACE TRIGGER post_source_tools_refresh_post_search_update
AFTER UPDATE ON public.post_source_tools
REFERENCING OLD TABLE AS replaced_rows NEW TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_refresh_post_search_document_for_source_tools();

CREATE OR REPLACE TRIGGER post_source_tools_refresh_post_search_delete
AFTER DELETE ON public.post_source_tools
REFERENCING OLD TABLE AS changed_rows
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_refresh_post_search_document_for_source_tools();

-- ─── 5. The searches ────────────────────────────────────────────────────────

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
  IF char_length(v_query) < 2 OR char_length(v_query) > 100 THEN
    RAISE EXCEPTION 'Creator search query must contain between 2 and 100 characters';
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
      EXISTS (
        SELECT 1
        FROM public.follows
        WHERE follower_id = p_viewer_user_id
          AND following_id = documents.creator_user_id
      ) AS is_following,
      (
        CASE WHEN documents.username_normalized = v_query THEN 10.0 ELSE 0.0 END
        + CASE WHEN documents.username_normalized LIKE v_like || '%' THEN 5.0 ELSE 0.0 END
        + CASE WHEN documents.display_name_normalized = v_query THEN 6.0 ELSE 0.0 END
        + CASE WHEN documents.display_name_normalized LIKE v_like || '%' THEN 3.0 ELSE 0.0 END
        + ts_rank_cd(documents.search_vector, v_tsquery) * 2.0
        + greatest(
          extensions.similarity(documents.username_normalized, v_query),
          extensions.similarity(documents.display_name_normalized, v_query),
          extensions.word_similarity(v_query, documents.username_normalized),
          extensions.word_similarity(v_query, documents.display_name_normalized)
        ) * 1.5
        + CASE WHEN EXISTS (
          SELECT 1
          FROM public.follows
          WHERE follower_id = p_viewer_user_id
            AND following_id = documents.creator_user_id
        ) THEN 0.25 ELSE 0.0 END
        + least(0.5, ln(1 + documents.public_post_count) * 0.08)
      )::double precision AS search_score
    FROM public.creator_search_documents AS documents
    WHERE documents.username_normalized LIKE v_like || '%'
      OR documents.display_name_normalized LIKE v_like || '%'
      OR documents.search_vector @@ v_tsquery
      OR documents.username_normalized OPERATOR(extensions.%) v_query
      OR documents.display_name_normalized OPERATOR(extensions.%) v_query
      OR v_query OPERATOR(extensions.<%) documents.username_normalized
      OR v_query OPERATOR(extensions.<%) documents.display_name_normalized
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

CREATE OR REPLACE FUNCTION public.search_public_posts(
  p_query text,
  p_viewer_user_id uuid DEFAULT NULL,
  p_after_score double precision DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS TABLE(
  post_id uuid,
  creator_user_id uuid,
  search_score double precision
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
BEGIN
  IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN
    RAISE EXCEPTION 'Post search query must contain between 3 and 100 characters';
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  IF p_limit < 1 OR p_limit > 25 THEN
    RAISE EXCEPTION 'Post search limit must be between 1 and 25';
  END IF;
  IF p_after_score IS NOT NULL AND p_after_id IS NULL THEN
    RAISE EXCEPTION 'Post search cursor is incomplete';
  END IF;
  v_tsquery := public.search_query_tsquery(v_query, true);

  -- No post a search may show holds the query as typed: read its misspelt
  -- words as the nearest known ones and search on that. The test is the
  -- match below, the label included and no cursor, so every page of a search
  -- reads the query the same way.
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
  ) THEN
    v_corrected := public.search_corrected_query(v_query);
    IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN
      v_query := v_corrected;
      v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
      v_tsquery := public.search_query_tsquery(v_query, true);
    END IF;
  END IF;

  RETURN QUERY
  WITH scored AS (
    SELECT
      documents.post_id,
      documents.creator_user_id,
      (
        CASE WHEN documents.title_normalized = v_query THEN 10.0 ELSE 0.0 END
        + CASE WHEN documents.title_normalized LIKE v_like || '%' THEN 5.0 ELSE 0.0 END
        + CASE WHEN documents.tool_normalized = v_query THEN 3.0 ELSE 0.0 END
        + ts_rank_cd(documents.search_vector, v_tsquery) * 2.5
        + greatest(
          extensions.similarity(documents.title_normalized, v_query),
          extensions.similarity(documents.tool_normalized, v_query)
        ) * 1.5
        + CASE WHEN EXISTS (
          SELECT 1
          FROM public.follows
          WHERE follower_id = p_viewer_user_id
            AND following_id = documents.creator_user_id
        ) THEN 0.2 ELSE 0.0 END
        + least(
          0.35,
          ln(1 + posts.save_count + posts.comment_count + posts.remix_count) * 0.04
        )
        + extract(epoch FROM documents.created_at) / 100000000000.0
      )::double precision AS search_score
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE posts.is_nsfw = false
      AND (
        documents.search_vector @@ v_tsquery
        OR documents.search_text ILIKE ('%' || v_like || '%')
        OR documents.title_normalized OPERATOR(extensions.%) v_query
        OR documents.tool_normalized OPERATOR(extensions.%) v_query
      )
  )
  SELECT scored.post_id, scored.creator_user_id, scored.search_score
  FROM scored
  WHERE p_after_score IS NULL
    OR scored.search_score < p_after_score
    OR (scored.search_score = p_after_score AND scored.post_id > p_after_id)
  ORDER BY scored.search_score DESC, scored.post_id ASC
  LIMIT p_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_public_creators(text, uuid, double precision, uuid, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_creators(text, uuid, double precision, uuid, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer)
  TO service_role;

-- ─── 6. Every post document, as the new projection reads it ─────────────────

SELECT public.refresh_post_search_documents(ARRAY(
  SELECT posts.id
  FROM public.posts AS posts
  WHERE posts.visibility = 'public'
    AND posts.archived_at IS NULL
    AND posts.review_status = 'visible'
));

COMMIT;
