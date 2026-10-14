-- Search leaves NSFW-labelled posts out for every viewer (signed out, signed
-- in, the owner too), as Explore's media lanes and recipe search already do.
-- It used to match a labelled post on its real title, body and prompt and
-- answer with the covered "Mature content" card and its creator, so a word
-- from a hidden prompt showed that a mature post by that creator contained it.
--
-- The label is read from posts when the query runs, not kept out of
-- post_search_documents: the document trigger does not watch is_nsfw, so a
-- post labelled after it was indexed drops out at once and an unlabelled one
-- comes back, with no re-index or backfill. The condition sits inside the
-- scored set, before the keyset comparison and the LIMIT, so a hidden post
-- never leaves a page short and every cursor is a row the caller was given.
-- Text posts stay searchable: only the label filters.
--
-- Only the WHERE clause differs from the 20260827110000_public_search.sql
-- definition; its signature, scoring, order, definer rights, search path and
-- grants are kept.

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

  RETURN QUERY
  WITH scored AS (
    SELECT
      documents.post_id,
      documents.creator_user_id,
      (
        CASE WHEN documents.title_normalized = v_query THEN 10.0 ELSE 0.0 END
        + CASE WHEN documents.title_normalized LIKE v_like || '%' THEN 5.0 ELSE 0.0 END
        + CASE WHEN documents.tool_normalized = v_query THEN 3.0 ELSE 0.0 END
        + ts_rank_cd(documents.search_vector, plainto_tsquery('simple', v_query)) * 2.5
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
        documents.search_vector @@ plainto_tsquery('simple', v_query)
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

REVOKE ALL ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_public_posts(text, uuid, double precision, uuid, integer)
  TO service_role;
