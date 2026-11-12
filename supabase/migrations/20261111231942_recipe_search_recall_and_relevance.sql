-- Recipe search reads a query as post search does, and unified search lists
-- recipes by relevance.
--
-- list_marketplace_resource_bundles matched a search as one run of characters
-- in a recipe's search document (search_text ILIKE '%query%',
-- 20261031100330_marketplace_search_indexes_public_text.sql) and ordered the
-- matches by the list's sort. So 'dancer neon' missed "Neon dancer", a plural
-- missed its singular, 'veo3' missed 'Veo-3.1', a misspelling found nothing,
-- and the Recipes tab of /api/search showed the newest match first, however
-- loosely it matched.
--
-- 1. marketplace_search_vector reads a text as post documents are read
--    (20261111224010): in the 'simple' and 'english' configurations, split
--    (search_split_terms: letters and digits apart), and with the characters
--    between letters and digits taken out ('nano-banana-pro' also reads
--    'nanobananapro'). The document gains search_vector, a column GENERATED
--    from its search_text by that function: it holds the words of the text
--    and nothing else, so it can hold no word the text does not, and the text
--    is unchanged (the visible fields refresh_marketplace_bundle_search_documents
--    projects, never a recipe's items, cards or a paid recipe's setup
--    caption).
-- 2. The list matches a search on search_query_tsquery (every word, in any
--    order, the last one a prefix, as typed and split, stemmed as well) or, as
--    before, on the query as one run of characters, so every recipe found
--    before is still found. When no recipe the list may show matches as
--    typed, with the same filters and no offset, the query is read once more
--    as search_corrected_query reads it against recipes' words, by its words
--    only: every page of a search reads it the same way. Its signature, its
--    other sorts, its grants and its three-character floor are kept; a sort
--    it does not know still reads as 'recent'.
-- 3. A new sort, 'relevance', used by unified search: the text's rank
--    (ts_rank_cd, damped by length and held below 1, so repeating words in a
--    caption gains almost nothing), plus a lift when the recipe's title as its card shows it is
--    the query or starts with it, then the recency tie-break and bundle_id as
--    'recent' orders them. Without a query it reads as 'recent'.
-- 4. marketplace_search_texts_match is the app's recheck
--    (getMarketplaceResourceListBase, src/lib/post-resource-bundles-server.ts):
--    given the text the app shows a visitor for each listed recipe, it says
--    whether that text holds the query as the list reads it, as typed or
--    corrected. The app drops a row whose shown text does not.
-- 5. rebuild_search_terms, which makes search_terms (the dictionary a
--    misspelling is read against) exactly the words shown now, also takes the
--    words of listed recipes' documents, each word flagged with the surfaces
--    that show it (in_posts, in_recipes): post search is corrected only to
--    posts' words, as before (search_corrected_query(text)), and recipe search
--    only to recipes' (search_corrected_query(text, true)). No recipe save writes the table, as
--    no post save does (20261111224010 says why); the hourly search-dictionary
--    job and the end of this file rebuild it. A recipe that is not listable (a
--    draft, a labelled or hidden post, a failed quality check) adds no word,
--    and its items never reach its document, so they never reach the
--    dictionary.
--
-- A misspelling is corrected against the dictionary, never matched against
-- each document (20261111224010 says why).
BEGIN;
SET LOCAL lock_timeout = '5s';

-- posts first, then the recipes, in the order 20261111224010 takes them (it
-- takes Made with first, which this file does not touch): the order the
-- publish and edit routes take. Then the search documents their triggers
-- write: adding the generated column rewrites them (one row per recipe) under
-- ACCESS EXCLUSIVE, which only searches read, for the length of this file. A
-- recipe or post saved meanwhile waits on the first two locks, so it never
-- holds a document's lock while this file waits for it. Last the dictionary,
-- which gains its surface flags: only searches and the dictionary job (which
-- takes nothing above) touch it. Nothing here drops a trigger or a function.
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_resource_bundles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.marketplace_bundle_search_documents IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.search_terms IN ACCESS EXCLUSIVE MODE;

-- ─── 1. The document's vector ───────────────────────────────────────────────
--
-- search_vector is a STORED generated column: Postgres computes it when a row
-- is written and never again, so replacing this function or
-- search_split_terms leaves every stored vector as the old one read it. A
-- migration that changes either must end with
--   UPDATE public.marketplace_bundle_search_documents SET search_text = search_text;
-- to recompute them.

CREATE OR REPLACE FUNCTION public.marketplace_search_vector(p_text text)
RETURNS tsvector
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT to_tsvector('pg_catalog.simple', coalesce(p_text, ''))
    || to_tsvector('pg_catalog.english', coalesce(p_text, ''))
    || to_tsvector('pg_catalog.simple', public.search_split_terms(p_text))
    || to_tsvector('pg_catalog.simple', regexp_replace(coalesce(p_text, ''), '[^[:alnum:][:space:]]+', '', 'g'));
$function$;

COMMENT ON FUNCTION public.marketplace_search_vector(text) IS
  'A recipe search document''s text as searches read it: simple and english, split (search_split_terms), and with the characters between letters and digits taken out. Built from the text alone.';

REVOKE ALL ON FUNCTION public.marketplace_search_vector(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_search_vector(text) TO service_role;

ALTER TABLE public.marketplace_bundle_search_documents
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (public.marketplace_search_vector(search_text)) STORED;

COMMENT ON COLUMN public.marketplace_bundle_search_documents.search_vector IS
  'Generated from search_text by marketplace_search_vector: the words of the visible text the document holds, and nothing else.';

CREATE INDEX marketplace_bundle_search_documents_vector_idx
  ON public.marketplace_bundle_search_documents
  USING gin (search_vector);

-- ─── 4. The app's recheck ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.marketplace_search_texts_match(p_texts text[], p_query text)
RETURNS boolean[]
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $function$
DECLARE
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_corrected text;
  v_matches boolean[];
BEGIN
  IF char_length(v_query) < 3 THEN
    RETURN ARRAY(SELECT false FROM unnest(p_texts));
  END IF;

  -- As the list matches a document: its words, or the query as one run of
  -- characters, in the text lower-cased as the document holds it.
  SELECT coalesce(array_agg(
    public.marketplace_search_vector(lower(coalesce(texts.text, ''))) @@ public.search_query_tsquery(v_query, true)
      OR lower(coalesce(texts.text, '')) ILIKE (
        '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
    ORDER BY texts.position
  ), '{}')
  INTO v_matches
  FROM unnest(p_texts) WITH ORDINALITY AS texts(text, position);

  -- The list read the query corrected when nothing matched it as typed, by
  -- its words: a text that holds them holds what that row matched.
  IF false = ANY (v_matches) THEN
    v_corrected := public.search_corrected_query(v_query, true);
    IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN
      SELECT array_agg(
        texts.matched
          OR public.marketplace_search_vector(lower(coalesce(texts.text, ''))) @@ public.search_query_tsquery(v_corrected, true)
        ORDER BY texts.position
      )
      INTO v_matches
      FROM unnest(p_texts, v_matches) WITH ORDINALITY AS texts(text, matched, position);
    END IF;
  END IF;

  RETURN v_matches;
END;
$function$;

COMMENT ON FUNCTION public.marketplace_search_texts_match(text[], text) IS
  'For each text the app shows a visitor for a listed recipe, whether it holds the query as list_marketplace_resource_bundles reads it, as typed or corrected. The app''s recheck of a searched page.';

REVOKE ALL ON FUNCTION public.marketplace_search_texts_match(text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_search_texts_match(text[], text) TO service_role;

-- ─── 5. A listed recipe's words join the dictionary ─────────────────────────
--
-- One table, a flag per surface: a search is corrected only to a word its own
-- results show, so a post search is never read as a word only a recipe shows
-- (and finds nothing), nor a recipe search as a post's. The rows already here
-- are posts' words, as the defaults say.
ALTER TABLE public.search_terms
  ADD COLUMN in_posts boolean NOT NULL DEFAULT true,
  ADD COLUMN in_recipes boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT search_terms_on_a_surface CHECK (in_posts OR in_recipes);

COMMENT ON TABLE public.search_terms IS
  'Backend-owned dictionary for search spelling correction: lowercase words of 4 to 40 letters that unlabelled public posts or listed recipes show, flagged by which, kept to exactly those by rebuild_search_terms (the search-dictionary job). Words only, never which post or recipe held them.';
COMMENT ON COLUMN public.search_terms.in_posts IS
  'An unlabelled public post shows the word: post search may be corrected to it.';
COMMENT ON COLUMN public.search_terms.in_recipes IS
  'A listed recipe''s card shows the word: recipe search may be corrected to it.';

CREATE OR REPLACE FUNCTION public.search_corrected_query(p_query text, p_in_recipes boolean)
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
      AND CASE WHEN p_in_recipes THEN terms.in_recipes ELSE terms.in_posts END
      -- A word some known word starts with is spelt right so far.
      AND NOT EXISTS (
        SELECT 1
        FROM public.search_terms AS known
        WHERE known.term LIKE words.word || '%'
          AND CASE WHEN p_in_recipes THEN known.in_recipes ELSE known.in_posts END
      )
      AND terms.term OPERATOR(extensions.%) words.word
      AND extensions.similarity(terms.term, words.word) >= 0.35
      AND left(terms.term, 1) = left(words.word, 1)
      AND abs(char_length(terms.term) - char_length(words.word)) <= 2
    ORDER BY extensions.similarity(terms.term, words.word) DESC, terms.term
    LIMIT 1
  ) AS nearest ON true;
$function$;

COMMENT ON FUNCTION public.search_corrected_query(text, boolean) IS
  'A search query (split as search_split_terms reads it) with each misspelt word replaced by the nearest word of search_terms that recipes show (p_in_recipes) or posts show. A word is left alone when it is under four letters, holds a digit, starts a known word of that surface, or has no near neighbour.';

-- Post search (search_public_posts) keeps calling the one-argument form.
CREATE OR REPLACE FUNCTION public.search_corrected_query(p_query text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $function$
  SELECT public.search_corrected_query(p_query, false);
$function$;

COMMENT ON FUNCTION public.search_corrected_query(text) IS
  'A post search query with each misspelt word replaced by the nearest word posts show: search_corrected_query(p_query, false).';

REVOKE ALL ON FUNCTION public.search_corrected_query(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.search_corrected_query(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_corrected_query(text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_corrected_query(text) TO service_role;

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
  WITH post_words AS (
    SELECT DISTINCT words.lexeme AS term
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    CROSS JOIN LATERAL unnest(to_tsvector('pg_catalog.simple', documents.search_text)) AS words
    WHERE posts.is_nsfw = false
      AND words.lexeme ~ '^[[:alpha:]]{4,40}$'
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
    INSERT INTO public.search_terms AS terms (term, in_posts, in_recipes)
    SELECT shown.term, shown.in_posts, shown.in_recipes
    FROM shown
    ON CONFLICT (term) DO UPDATE
      SET in_posts = excluded.in_posts, in_recipes = excluded.in_recipes
      WHERE (terms.in_posts, terms.in_recipes) IS DISTINCT FROM (excluded.in_posts, excluded.in_recipes)
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
  'Makes search_terms exactly the words unlabelled public posts and listed recipes show now, and says how many it added and removed. Run by the search-dictionary backend job; no post or recipe save writes the table.';

REVOKE ALL ON FUNCTION public.rebuild_search_terms() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebuild_search_terms() TO service_role;

-- ─── 2 and 3. The listing ───────────────────────────────────────────────────
--
-- As 20261031100330 left it but for the search: its match, its correction and
-- the relevance sort. The filters, the other sorts, the paging and the
-- returned columns are unchanged.
CREATE OR REPLACE FUNCTION public.list_marketplace_resource_bundles(
  p_access_filter text DEFAULT 'all',
  p_resource_filter text DEFAULT 'all',
  p_tool_slug text DEFAULT NULL,
  p_query text DEFAULT NULL,
  p_sort text DEFAULT 'recent',
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 24
)
RETURNS TABLE(
  id uuid, post_id uuid, owner_user_id uuid, legacy_asset_id uuid,
  access_mode text, status text, title text, summary text, preview_text text,
  prompt_text text, notes_markdown text, workflow_share_url text,
  workflow_snapshot jsonb, attachments jsonb, allow_remix boolean,
  resource_sections jsonb, resource_items jsonb, price_usd_cents integer,
  sales_count integer, free_unlock_count integer, earnings_usd_cents integer, created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- The query as the list read it before: trimmed and lower-cased.
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_searching boolean := lower(btrim(coalesce(p_query, ''))) <> '';
  v_tsquery tsquery;
  v_like text;
  v_title_like text;
  v_corrected text;
  v_found boolean;
  v_order text;
  v_search_join text := '';
  v_search_filter text := '';
  v_from text;
BEGIN
  IF v_searching THEN
    v_search_join := '
      JOIN public.marketplace_bundle_search_documents search
        ON search.bundle_id = listings.bundle_id';
    -- Its words, or, as before, the query as one run of characters.
    v_search_filter := '
      AND char_length($9) >= 3
      AND (search.search_vector @@ $7 OR search.search_text ILIKE $8)';
  END IF;

  v_from := format($sql$
    FROM public.marketplace_bundle_listings listings
    JOIN public.post_resource_bundles bundles ON bundles.id = listings.bundle_id
    %s
    WHERE listings.listable
      AND ($1 IS NULL OR $1 = 'all' OR listings.access_mode = $1)
      AND (
        $2 IS NULL OR $2 = 'all'
        OR ($2 = 'prompt' AND listings.has_prompt)
        OR ($2 = 'workflow' AND listings.has_workflow)
        OR ($2 = 'files' AND listings.has_files)
        OR ($2 = 'notes' AND listings.has_notes)
        OR ($2 = 'remix' AND listings.has_remix)
      )
      AND (coalesce(nullif($3, ''), '') = '' OR listings.tool_slug = $3)
      %s
  $sql$, v_search_join, v_search_filter);

  IF v_searching AND char_length(v_query) >= 3 THEN
    v_tsquery := public.search_query_tsquery(v_query, true);
    v_like := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

    -- No recipe this list may show, with these filters, holds the query as
    -- typed: read its misspelt words as the nearest known ones. The test has
    -- no offset, so every page of a search reads the query the same way.
    EXECUTE 'SELECT EXISTS (SELECT 1 ' || v_from || ')'
      INTO v_found
      USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit,
        v_tsquery, v_like, v_query;

    IF NOT v_found THEN
      v_corrected := public.search_corrected_query(v_query, true);
      IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN
        -- By its words only: the corrected query is split, and as one run
        -- of characters would read a typed _ or % as a space.
        v_query := v_corrected;
        v_tsquery := public.search_query_tsquery(v_query, true);
        v_like := NULL;
      END IF;
    END IF;
  END IF;
  v_title_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  IF p_sort = 'relevance' AND v_searching THEN
    -- The text's rank, lifted when the title the card shows is the query or
    -- starts with it; then as 'recent' orders. The rank is damped by the
    -- text's length (1) and held below 1 (32), so a caption repeating the
    -- query, read four ways in the vector, can never outrank a title lift.
    v_order := $order$
      ts_rank_cd(search.search_vector, $7, 1 | 32)
        + CASE
          WHEN lower(CASE
            WHEN lower(btrim(coalesce(bundles.title, ''))) IN ('', 'attached unlock') THEN 'Recipe'
            ELSE btrim(bundles.title)
          END) = $9 THEN 1.0
          WHEN lower(CASE
            WHEN lower(btrim(coalesce(bundles.title, ''))) IN ('', 'attached unlock') THEN 'Recipe'
            ELSE btrim(bundles.title)
          END) LIKE $10 THEN 0.5
          ELSE 0.0
        END DESC,
      listings.created_at DESC, listings.bundle_id DESC$order$;
  ELSE
    v_order := CASE coalesce(p_sort, 'recent')
      WHEN 'top-sales' THEN 'listings.sales_count DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
      WHEN 'price-low' THEN 'listings.price_usd_cents ASC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
      WHEN 'price-high' THEN 'listings.price_usd_cents DESC NULLS LAST, listings.created_at DESC, listings.bundle_id DESC'
      ELSE 'listings.created_at DESC, listings.bundle_id DESC'
    END;
  END IF;

  RETURN QUERY EXECUTE format($sql$
    SELECT
      bundles.id, bundles.post_id, bundles.owner_user_id, bundles.legacy_asset_id,
      bundles.access_mode, bundles.status, bundles.title, bundles.summary,
      bundles.preview_text, bundles.prompt_text, bundles.notes_markdown,
      bundles.workflow_share_url, bundles.workflow_snapshot, bundles.attachments,
      bundles.allow_remix, bundles.resource_sections, bundles.resource_items,
      bundles.price_usd_cents, bundles.sales_count, bundles.free_unlock_count, bundles.earnings_usd_cents,
      bundles.created_at, bundles.updated_at
    %s
    ORDER BY %s
    OFFSET greatest(coalesce($5, 0), 0)
    LIMIT greatest(coalesce($6, 24), 1)
  $sql$, v_from, v_order)
  USING p_access_filter, p_resource_filter, p_tool_slug, p_query, p_offset, p_limit,
    v_tsquery, v_like, v_query, v_title_like;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer)
  TO service_role;

COMMENT ON FUNCTION public.list_marketplace_resource_bundles(text, text, text, text, text, integer, integer) IS
  'Marketplace listing backed by page-sized sort indexes and a trigger-maintained search document of visible text. A search matches every word (the last a prefix, stemmed, tools split and joined) or the query as one run of characters, is corrected once when nothing matches, and sorts by relevance on p_sort = ''relevance''. Public callers must require at least three search characters.';

COMMENT ON TABLE public.marketplace_bundle_search_documents IS
  'Derived, trigger-maintained text searched by list_marketplace_resource_bundles: a recipe''s visible fields and kinds only, and search_vector generated from that text. It avoids an O(catalog) concat/JSON expansion for every public search.';

-- ─── The dictionary, with the listed recipes' words ─────────────────────────

SELECT * FROM public.rebuild_search_terms();

COMMIT;
