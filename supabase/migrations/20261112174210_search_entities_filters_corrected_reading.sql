-- Search (phase 3, entities and filters): the models and tools posts are made
-- with become results of their own, Posts can be filtered, and a search says
-- when it read the query as something else.
--
-- Before this file typing 'kling' found posts made with Kling and nothing that
-- said "Kling 2.6, 14 posts"; a Posts search could not be narrowed to videos,
-- to posts with a recipe, to one model or to the people a viewer follows; and
-- a misspelling corrected by 20261111224010 came back as results for another
-- word with nothing saying so.
--
-- 1. ENTITIES. An entity is a model or a tool public posts are made with: the
--    names 20261111224010 put into post documents. One table holds them,
--    backend-owned (service role only, RLS on, no policy), and every row is
--    keyed by its post: no save writes a row another save shares.
--
--    public.post_search_entities: which entities a post has. One row per
--    post and entity, for posts that have a search document (public,
--    unarchived, visible) and for no other.
--      post_id          the post; references post_search_documents, so a
--                       row leaves with the document (ON DELETE CASCADE)
--      kind             'model' or 'tool'
--      key              the entity's key (search_entity_key): its slug, or
--                       its name where it has no slug, lowercased, every run
--                       of other characters a hyphen ('kling-2.6', 'veo-3.1',
--                       'magicbooklet')
--      label            the name THAT POST prints for it ('Kling 2.6'); the
--                       key where it prints none. A save keeps a client's
--                       own words for a tool or model the catalog does not
--                       know (save_post_source_tools_with_catalog), so two
--                       posts can print one key under different names.
--      name_vector      generated from that post's label and the key
--                       (search_term_variants: as written, split, joined):
--                       what a query is matched against
--      creator_user_id  the post's creator, so a count leaves both sides of
--                       a block out without reading the document
--
--    It is kept by a statement trigger on post_search_documents (AFTER
--    INSERT; the projection deletes and inserts a post's document on every
--    change to its title, text, creation, Made with, recipe or visibility, and
--    the delete cascades). So a post's rows follow its document whoever
--    re-creates the projection later, and this file re-creates no function of
--    20261111224010. Nothing is kept beside the posts' own rows: there is no
--    list of entities to go stale, and nothing of a post outlives its
--    document.
--
--    What a post's entities are (post_search_entity_rows):
--      tool   posts.source_tool / source_tool_slug, and each Made with row's
--             tool_label / tool_slug;
--      model  each Made with row's model_label / model_slug, and the
--             creation's model (generations.model).
--    A template result (generations.template_run_id or template_run_step_id)
--    has NO model entity, from its creation or from a Made with row: its
--    model is its template author's, public reads print none for it
--    (shownGenerationModel, src/lib/template-result.ts), and so search offers
--    none. It keeps its tool.
--
--    THE SINGLE SOURCE for "which entities exist and how many posts each has"
--    is public.search_public_entities(p_query, p_viewer_user_id, p_limit,
--    p_made_with), which /api/search calls and a typeahead can call the same
--    way. For a query it returns the entities it offers, and what it offers
--    is exactly what pressing one finds:
--      - THE POSTS OF AN OFFER are the posts search_public_posts returns for
--        that query narrowed to the entity: posts the viewer may see
--        (unlabelled, public, visible, neither side of a block) that have
--        the entity and hold the query, by the same match, written here a
--        fourth time and held to the other three by a test.
--      - AN ENTITY IS OFFERED when one of those posts names it as the query
--        does: its row's name_vector holds every word of the query (the
--        last a prefix, unstemmed). So an entity is found only by its key or
--        by a name a post the viewer may see prints right now. A name only a
--        labelled, private, hidden or deleted post printed finds nothing and
--        is shown nowhere, then or later: its row is gone with its document,
--        or is never read.
--      kind, key          as above
--      label              the name most of those posts print for it
--      post_count         how many of those posts there are, counted live
--                         and no further than 1,000: the total the Posts
--                         search for that query and entity pages through
--      post_count_capped  true when there are more than 1,000
--    ordered the entity whose name or key is the query first, then by count.
--    A query under three characters finds none: posts are searched from
--    three, and an offer must lead to posts.
--    With p_made_with ('model:kling-2.6') and no query it returns that one
--    entity, counted over every post the viewer may see that has it, for the
--    name a filter is shown under.
--    The count is PER VIEWER. A viewer who compares their count with a
--    signed-out one learns how many of those posts are by creators on either
--    side of a block with them, which post search already tells them the
--    same way.
--    Known limit: the count stops at 1,000, and so does the look for a post
--    that names the entity as the query does. An entity with more than 1,000
--    matching posts, found only by a name none of the first 1,001 prints, is
--    not offered; found by its key, it always is.
--
-- 2. FILTERS on search_public_posts, each applied before LIMIT so pages stay
--    full, and each decided on what a visitor sees:
--      p_made_with      'model:<key>' or 'tool:<key>': posts that have the
--                       entity (post_search_entities)
--      p_media_kind     'image' or 'video': posts.category, the kind the
--                       post's card and page are drawn as; a text post is
--                       neither
--      p_has_recipe     true: posts with a published recipe
--                       (post_resource_bundles.status = 'published', the
--                       recipe the document's caption rule reads)
--      p_followed_only  true: posts by creators p_viewer_user_id follows;
--                       with no viewer nothing matches (the route does not
--                       send it for a guest)
--    They combine with each other and with p_sort.
--
-- 3. THE READING. search_public_posts returns corrected_query on every row:
--    the query as the spelling correction read it, NULL when it was read as
--    typed. The decision is the one 20261111224010 made and 20261112103547
--    kept, now with the filters in it: when no post this search may show (the
--    label, the blocks and the filters included, no cursor) holds the query
--    as typed, it is read corrected. p_correct = false turns that off, for
--    "search instead for". search_recipes_corrected_query(p_query) says the
--    same of the recipes list as /api/search calls it (no filter): the
--    corrected reading list_marketplace_resource_bundles will use, or NULL.
--    That list is untouched; as it corrects only when nothing matches as
--    typed, a recipes search with correction off is the empty list, which the
--    app answers without calling it.
--
-- THE RELEASE WINDOW. Migrations apply before the new app is promoted. The
-- app live meanwhile calls search_public_posts by name with p_query,
-- p_viewer_user_id, p_after_score, p_after_id, p_limit, p_as_of, p_sort and
-- p_after_created_at, and reads post_id, creator_user_id, search_score and
-- created_at. The function is dropped and re-created in this transaction with
-- the five new parameters last, each with a default that changes nothing, and
-- one more result column, so that call resolves to it and reads what it read;
-- PostgREST sees one function of that name. A code-only rollback is the same
-- call. search_public_creators, both score functions, the documents'
-- projection, the dictionary and the recipes list are untouched.
--
-- LOCKS. The trigger and the foreign key take SHARE ROW EXCLUSIVE on
-- post_search_documents: searches read on beside it, and a post saved while
-- this file runs waits for it and then projects with the trigger in place.
-- Nothing here locks posts, so that save never holds a lock this file waits
-- for after taking its own. search_query_events is altered last.
--
-- Scores, the instant (p_as_of), the tiers and the six decimals are as
-- 20261112103547 left them. search_post_score is not re-created.
BEGIN;
SET LOCAL lock_timeout = '5s';

LOCK TABLE public.post_search_documents IN SHARE ROW EXCLUSIVE MODE;

-- ─── 1. Entities ────────────────────────────────────────────────────────────

CREATE FUNCTION public.search_entity_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT nullif(left(btrim(regexp_replace(
    lower(btrim(coalesce(p_name, ''))), '[^[:alnum:].]+', '-', 'g'
  ), '-'), 80), '');
$function$;

COMMENT ON FUNCTION public.search_entity_key(text) IS
  'A model''s or tool''s key in search: its slug or name lowercased, every run of characters other than letters, digits and dots a hyphen, at most 80 characters. NULL for an empty name.';

REVOKE ALL ON FUNCTION public.search_entity_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_entity_key(text) TO service_role;

CREATE TABLE public.post_search_entities (
  post_id uuid NOT NULL REFERENCES public.post_search_documents(post_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('model', 'tool')),
  key text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 80),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  -- STORED and generated: computed when the row is written and never again,
  -- so a migration that changes search_term_variants must end with
  --   UPDATE public.post_search_entities SET label = label;
  name_vector tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'pg_catalog.simple',
      coalesce(public.search_term_variants(label), '') || ' ' || coalesce(public.search_term_variants(key), '')
    )
  ) STORED,
  creator_user_id uuid NOT NULL,
  PRIMARY KEY (kind, key, post_id)
);

-- The cascade from a document, and the projection's delete, find a post's rows here.
CREATE INDEX post_search_entities_post_idx
  ON public.post_search_entities (post_id);

-- The entities a query names, before any post is read.
CREATE INDEX post_search_entities_name_idx
  ON public.post_search_entities USING gin (name_vector);

ALTER TABLE public.post_search_entities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.post_search_entities FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.post_search_entities TO service_role;

COMMENT ON TABLE public.post_search_entities IS
  'Backend-owned: the models and tools each post with a search document is made with, one row per post and entity, under the name that post prints. Kept by a trigger on post_search_documents; a row leaves with its document, and nothing is kept of an entity beside its posts'' rows. The made-with filter of search_public_posts reads it, and search_public_entities offers an entity only by the rows of posts the viewer may see.';

CREATE FUNCTION public.post_search_entity_rows(p_post_ids uuid[])
RETURNS TABLE(post_id uuid, creator_user_id uuid, kind text, key text, label text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  -- plpgsql, so the plan is kept: as a sql function with a SET clause this
  -- was planned anew on every call, twice per projected post, and that was
  -- most of what a projection cost (about 7 ms; 20261112174210's review).
  RETURN QUERY
  WITH subjects AS (
    SELECT
      documents.post_id,
      documents.creator_user_id,
      posts.source_tool,
      posts.source_tool_slug,
      generations.model AS creation_model,
      -- A template result's model is its template author's: no read names
      -- it (shownGenerationModel), and neither does search.
      coalesce(
        generations.template_run_id IS NOT NULL OR generations.template_run_step_id IS NOT NULL,
        false
      ) AS is_template_result
    FROM public.post_search_documents AS documents
    JOIN public.posts AS posts ON posts.id = documents.post_id
    LEFT JOIN public.generations AS generations ON generations.id = posts.generation_id
    WHERE documents.post_id = ANY (p_post_ids)
  ),
  named AS (
    SELECT
      subjects.post_id,
      subjects.creator_user_id,
      'tool'::text AS kind,
      public.search_entity_key(coalesce(nullif(btrim(subjects.source_tool_slug), ''), subjects.source_tool)) AS key,
      coalesce(nullif(btrim(subjects.source_tool), ''), btrim(subjects.source_tool_slug)) AS label
    FROM subjects
    UNION ALL
    SELECT
      subjects.post_id,
      subjects.creator_user_id,
      'tool',
      public.search_entity_key(coalesce(nullif(btrim(tools.tool_slug), ''), tools.tool_label)),
      btrim(tools.tool_label)
    FROM subjects
    JOIN public.post_source_tools AS tools ON tools.post_id = subjects.post_id
    UNION ALL
    SELECT
      subjects.post_id,
      subjects.creator_user_id,
      'model',
      public.search_entity_key(coalesce(nullif(btrim(tools.model_slug), ''), tools.model_label)),
      coalesce(nullif(btrim(tools.model_label), ''), btrim(tools.model_slug))
    FROM subjects
    JOIN public.post_source_tools AS tools ON tools.post_id = subjects.post_id
    WHERE NOT subjects.is_template_result
    UNION ALL
    SELECT
      subjects.post_id,
      subjects.creator_user_id,
      'model',
      public.search_entity_key(subjects.creation_model),
      btrim(subjects.creation_model)
    FROM subjects
    WHERE NOT subjects.is_template_result
  )
  -- One row per post and entity, under the name that says most: a name that
  -- is not just the key before one that is.
  SELECT DISTINCT ON (named.post_id, named.kind, named.key)
    named.post_id,
    named.creator_user_id,
    named.kind,
    named.key,
    left(coalesce(nullif(named.label, ''), named.key), 80) AS label
  FROM named
  WHERE named.key IS NOT NULL
  ORDER BY named.post_id, named.kind, named.key, (coalesce(nullif(named.label, ''), named.key) = named.key), named.label;
END;
$function$;

COMMENT ON FUNCTION public.post_search_entity_rows(uuid[]) IS
  'The models and tools of the given posts that have a search document, as post_search_entities holds them, each under the name that post prints. A template result has no model.';

REVOKE ALL ON FUNCTION public.post_search_entity_rows(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_search_entity_rows(uuid[]) TO service_role;

CREATE FUNCTION public.refresh_post_search_entities(p_post_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_post_ids IS NULL OR cardinality(p_post_ids) = 0 THEN
    RETURN;
  END IF;

  -- Only rows keyed by these posts are written: two saves never meet on a
  -- row, in whatever order they name their tools. Called from the documents'
  -- trigger the delete finds nothing (the rows went with the old document);
  -- it is here for a call made on posts whose documents stand.
  DELETE FROM public.post_search_entities
  WHERE post_id = ANY (p_post_ids);

  -- The rows are worked out once.
  INSERT INTO public.post_search_entities (post_id, kind, key, label, creator_user_id)
  SELECT fresh.post_id, fresh.kind, fresh.key, fresh.label, fresh.creator_user_id
  FROM public.post_search_entity_rows(p_post_ids) AS fresh;
END;
$function$;

COMMENT ON FUNCTION public.refresh_post_search_entities(uuid[]) IS
  'Makes post_search_entities hold exactly the models and tools of the given posts (none for a post with no search document). It writes rows of those posts and no other row. Called by the trigger on post_search_documents.';

REVOKE ALL ON FUNCTION public.refresh_post_search_entities(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_post_search_entities(uuid[]) TO service_role;

CREATE FUNCTION public.trg_refresh_post_search_entities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  -- Once per statement. The projection deletes a post's document (its
  -- entities go with it, by the foreign key) and inserts the new one.
  PERFORM public.refresh_post_search_entities(ARRAY(SELECT post_id FROM new_documents));
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.trg_refresh_post_search_entities()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.trg_refresh_post_search_entities() IS
  'post_search_documents trigger: stores the models and tools of each post whose document a statement inserted.';

CREATE TRIGGER post_search_documents_refresh_entities
AFTER INSERT ON public.post_search_documents
REFERENCING NEW TABLE AS new_documents
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_refresh_post_search_entities();

CREATE FUNCTION public.search_public_entities(
  p_query text DEFAULT NULL,
  p_viewer_user_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 5,
  p_made_with text DEFAULT NULL
)
RETURNS TABLE(
  kind text,
  key text,
  label text,
  post_count integer,
  post_count_capped boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- A count stops here: "1,000+" says as much as the exact figure, and one
  -- entity every post has costs no more to count than this.
  c_count_cap CONSTANT integer := 1000;
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  -- The query as post search matches a document on it, and as a name is matched.
  v_like text;
  v_tsquery tsquery;
  v_name_tsquery tsquery;
  v_entity_kind text;
  v_entity_key text;
BEGIN
  IF p_limit < 1 OR p_limit > 10 THEN
    RAISE EXCEPTION 'Entity search limit must be between 1 and 10';
  END IF;

  IF p_made_with IS NOT NULL THEN
    v_entity_kind := split_part(p_made_with, ':', 1);
    v_entity_key := substr(p_made_with, char_length(v_entity_kind) + 2);
    IF v_entity_kind NOT IN ('model', 'tool') OR v_entity_key = '' THEN
      RAISE EXCEPTION 'Entity must be model:<key> or tool:<key>';
    END IF;

    -- One entity by its key, whatever the query: every post the viewer may
    -- see that has it, and the name most of them print.
    RETURN QUERY
    WITH seen AS MATERIALIZED (
      SELECT members.label
      FROM public.post_search_entities AS members
      JOIN public.posts AS posts ON posts.id = members.post_id
      WHERE members.kind = v_entity_kind
        AND members.key = v_entity_key
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
    )
    SELECT
      v_entity_kind,
      v_entity_key,
      (
        SELECT printed.label
        FROM seen AS printed
        GROUP BY printed.label
        ORDER BY (printed.label = v_entity_key), count(*) DESC, printed.label
        LIMIT 1
      ),
      least((SELECT count(*) FROM seen), c_count_cap)::integer,
      (SELECT count(*) FROM seen) > c_count_cap
    WHERE EXISTS (SELECT 1 FROM seen);
    RETURN;
  END IF;

  -- Posts are searched from three characters, and an entity is offered only
  -- with posts to open: under three, or past the limit, a query finds none.
  IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
  v_tsquery := public.search_query_tsquery(v_query, true);
  -- Names are not stemmed.
  v_name_tsquery := public.search_query_tsquery(v_query, false);
  IF numnode(v_name_tsquery) = 0 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    -- The entities some post names as the query does, labelled posts and
    -- blocked creators' among them: only the posts counted below decide.
    SELECT DISTINCT members.kind, members.key
    FROM public.post_search_entities AS members
    WHERE members.name_vector @@ v_name_tsquery
  )
  SELECT
    candidates.kind,
    candidates.key,
    counted.label,
    least(counted.post_total, c_count_cap) AS post_count,
    counted.post_total > c_count_cap AS post_count_capped
  FROM candidates
  CROSS JOIN LATERAL (
    -- The posts search_public_posts returns for this query narrowed to this
    -- entity, for this viewer: the same label, blocks and match, so the
    -- count is the list pressing the entity opens.
    WITH seen AS MATERIALIZED (
      SELECT
        members.label,
        members.name_vector @@ v_name_tsquery AS names_it
      FROM public.post_search_entities AS members
      JOIN public.post_search_documents AS documents ON documents.post_id = members.post_id
      JOIN public.posts AS posts ON posts.id = documents.post_id
      WHERE members.kind = candidates.kind
        AND members.key = candidates.key
        AND posts.is_nsfw = false
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
      LIMIT c_count_cap + 1
    )
    SELECT
      (SELECT count(*) FROM seen)::integer AS post_total,
      -- One of those posts names the entity as the query does.
      (SELECT coalesce(bool_or(named.names_it), false) FROM seen AS named) AS named,
      (
        SELECT printed.label
        FROM seen AS printed
        GROUP BY printed.label
        ORDER BY (printed.label = candidates.key), count(*) DESC, printed.label
        LIMIT 1
      ) AS label
  ) AS counted
  WHERE counted.post_total > 0
    AND counted.named
  ORDER BY
    (lower(counted.label) = v_query OR candidates.key = v_query) DESC,
    counted.post_total DESC,
    candidates.kind,
    candidates.key
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.search_public_entities(text, uuid, integer, text) IS
  'The single source for which models and tools exist in search and how many posts each has. For p_query (three characters or more): the entities a post the viewer may see names as the query does, each with post_count, the posts search_public_posts returns for that query narrowed to it (counted live up to 1,000; post_count_capped says there are more), under the name most of those posts print; the one that is the query first, then by count. For p_made_with (model:<key> or tool:<key>) with no query: that entity over every post the viewer may see that has it. A name only a labelled, private, hidden or deleted post printed finds and names nothing. Service role only.';

REVOKE ALL ON FUNCTION public.search_public_entities(text, uuid, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_entities(text, uuid, integer, text)
  TO service_role;

-- ─── 2 and 3. Posts: the filters and the reading ────────────────────────────
--
-- Dropped and re-created: new parameters and a new result column cannot be
-- added by CREATE OR REPLACE. Both happen in this transaction, so no call
-- finds the name missing, and the eight-argument named call of the app live
-- during the release resolves to the new function through its defaults.

DROP FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz);

CREATE FUNCTION public.search_public_posts(
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
        shown.title = v_query,
        shown.title LIKE v_like || '%',
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
    CROSS JOIN LATERAL (
      -- The title as the query is read: NFKC and one space between words.
      -- Worked out only for a title that reading can change, one holding two
      -- spaces together or a character outside printable ASCII (a line break,
      -- a full-width letter): on 2,250 matches the rest saved 15 ms.
      SELECT CASE
        WHEN documents.title_normalized ~ '  |[^ -~]' THEN lower(btrim(regexp_replace(
          normalize(documents.title_normalized, NFKC), '[[:space:]]+', ' ', 'g'
        )))
        ELSE documents.title_normalized
      END AS title
    ) AS shown
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
  'Public post search. p_sort top: by search_post_score at p_as_of (the start of the UTC day without one), keyset on (search_score DESC, post_id). p_sort latest: the same matches newest first, keyset on (created_at DESC, post_id) through p_after_created_at. Filters, each before the limit: p_made_with (model:<key> or tool:<key>), p_media_kind (image or video), p_has_recipe, p_followed_only. corrected_query is the query as the spelling correction read it, NULL when read as typed; p_correct false reads it as typed. Labelled posts and both sides of a block are left out before the limit. Service role only.';

REVOKE ALL ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer, timestamptz, text, timestamptz, text, text, boolean, boolean, boolean)
  TO service_role;

-- The recipes list's reading of a query, as /api/search calls that list: no
-- access, kind or tool filter. The test is list_marketplace_resource_bundles's
-- own (20261111231942), which stays the one that decides what is listed.
CREATE FUNCTION public.search_recipes_corrected_query(p_query text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- The query as the list reads it: trimmed and lower-cased.
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_corrected text;
BEGIN
  IF char_length(v_query) < 3 THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.marketplace_bundle_listings AS listings
    JOIN public.post_resource_bundles AS bundles ON bundles.id = listings.bundle_id
    JOIN public.marketplace_bundle_search_documents AS search ON search.bundle_id = listings.bundle_id
    WHERE listings.listable
      AND (
        search.search_vector @@ public.search_query_tsquery(v_query, true)
        OR search.search_text ILIKE (
          '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
        )
      )
  ) THEN
    RETURN NULL;
  END IF;

  v_corrected := public.search_corrected_query(v_query, true);
  IF v_corrected IS NOT NULL AND v_corrected <> v_query AND char_length(v_corrected) BETWEEN 3 AND 100 THEN
    RETURN v_corrected;
  END IF;
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.search_recipes_corrected_query(text) IS
  'How list_marketplace_resource_bundles reads a search with no other filter: the corrected query when no listed recipe holds it as typed and a correction exists, NULL when it is read as typed. /api/search says so beside the recipes it returns. Service role only.';

REVOKE ALL ON FUNCTION public.search_recipes_corrected_query(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_recipes_corrected_query(text) TO service_role;

-- ─── Every post with a document gets its entities ───────────────────────────

SELECT public.refresh_post_search_entities(ARRAY(
  SELECT documents.post_id
  FROM public.post_search_documents AS documents
));

-- ─── The search log says what narrowed a search and how it was read ─────────
--
-- All nullable, NULL for a row written before this file and by the app live
-- during the release. search_query_report does not read them.

ALTER TABLE public.search_query_events
  ADD COLUMN made_with text CHECK (made_with IS NULL OR char_length(made_with) BETWEEN 1 AND 90),
  ADD COLUMN media_kind text CHECK (media_kind IS NULL OR media_kind IN ('image', 'video')),
  ADD COLUMN has_recipe boolean,
  ADD COLUMN followed_only boolean,
  ADD COLUMN corrected boolean;

COMMENT ON COLUMN public.search_query_events.made_with IS
  'A Posts search''s made-with filter (model:<key> or tool:<key>). NULL without one, for other search types and for rows written before 20261112174210.';
COMMENT ON COLUMN public.search_query_events.media_kind IS
  'A Posts search''s media filter: image or video. NULL without one.';
COMMENT ON COLUMN public.search_query_events.has_recipe IS
  'True when a Posts search asked only for posts with a recipe. NULL otherwise.';
COMMENT ON COLUMN public.search_query_events.followed_only IS
  'True when a Posts search asked only for posts by creators the viewer follows. NULL otherwise.';
COMMENT ON COLUMN public.search_query_events.corrected IS
  'Whether the answer''s posts or recipes were found on a corrected reading of the query. NULL for a Creators search and for rows written before 20261112174210.';

COMMIT;
