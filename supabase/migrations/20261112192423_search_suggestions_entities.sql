-- Typeahead offers models and tools: the third list of search_suggestions.
--
-- 20261112144018 left a marked place for it (SEAM); 20261112174210 built the
-- one source of which models and tools exist, search_public_entities. This
-- file fills the place from that source and from nothing else.
--
-- 1. search_suggestions keeps its five parameters and its two lists, each
--    exactly as it was, and gains `entities` between them in the answer:
--    [{kind, key, label, post_count, post_count_capped}], at most 3, in the
--    order search_public_entities gives them. The route live today reads
--    `creators` and `completions` and nothing else, so it works unchanged
--    against this function whichever is released first.
-- 2. An entity is taken from search_public_entities(p_query, p_viewer), the
--    call /api/search makes. So the rules cannot drift: it is offered only if
--    a post this viewer may see names it as the query does, its count is the
--    posts the query finds narrowed to it (pressing it opens that list, never
--    an empty one), a template result has no model, and nothing is offered
--    under three characters.
-- 3. Two more rules, which only ever take an entity out of that answer:
--    - TWO CREATORS. A typeahead row is put in front of people who did not
--      search for it, and a tool's name is whatever one creator typed into
--      Made with. So, as a completion needs two creators
--      (search_suggest_completions), an entity is suggested only when
--      unlabelled posts of two different creators are made with it. Search
--      itself still shows a one-creator entity to someone who typed its name
--      and pressed Enter. The look for a second creator reads at most 500 of
--      the entity's posts.
--    - WITHDRAWN WORDS. An entity whose name or key holds a word of
--      search_suggestion_denylist is not suggested: the same words, read as
--      the entity's own search vector reads them (as written, split, and as
--      one word). A withdrawn word in what was typed takes no entity out:
--      unlike a phrase, an entity's row does not repeat the query.
-- 4. A query typed as a handle ('@lu') asks for people: no entities, as no
--    completions.
--
-- 5. search_public_entities is steered to nested loops. For each entity it
--    counts that entity's posts whose document matches the query, inside a
--    lateral where the planner does not know which entity it is counting.
--    For some queries it then hashes the entity's posts against a sequential
--    scan of EVERY document, running the four-way match (a vector test, an
--    ILIKE and two trigram tests) on each: 35 to 50 ms on 5,000 posts where
--    the same count by the posts' keys takes 2 to 4 (local replay,
--    2026-11-12; `veo`, `nano ban`), growing with the number of posts, and on
--    every keystroke of a typeahead. With hash and merge joins off for this
--    one function the count always walks the entity's posts to their
--    documents by key. What the function returns is unchanged; its text is
--    not touched. /api/search's Top tab, which calls it too, gains the same.
--
-- No table is changed and no lock is taken beyond the functions' own.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER FUNCTION public.search_public_entities(text, uuid, integer, text) SET enable_hashjoin = off;
ALTER FUNCTION public.search_public_entities(text, uuid, integer, text) SET enable_mergejoin = off;

CREATE OR REPLACE FUNCTION public.search_suggestions(
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
    -- Models and tools: search's own answer for this query and viewer, less
    -- what a suggestion must not put in front of someone who did not ask.
    'entities', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'kind', offered.kind,
        'key', offered.key,
        'label', offered.label,
        'post_count', offered.post_count,
        'post_count_capped', offered.post_count_capped
      ) ORDER BY offered.position)
      FROM (
        SELECT found.kind, found.key, found.label, found.post_count, found.post_count_capped, found.position
        FROM public.search_public_entities(p_query, p_viewer_user_id, 10, NULL)
          WITH ORDINALITY AS found(kind, key, label, post_count, post_count_capped, position)
        WHERE NOT coalesce(p_handles_only, false)
          -- Two creators: an unlabelled post made with it by someone other
          -- than the first creator found, among the first 500 of its posts.
          AND EXISTS (
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
          -- No withdrawn word in its name or key, read as post_search_entities.name_vector reads them.
          AND NOT EXISTS (
            SELECT 1
            FROM public.search_suggestion_denylist AS denied
            WHERE denied.term = ANY (tsvector_to_array(to_tsvector(
              'pg_catalog.simple',
              coalesce(public.search_term_variants(found.label), '') || ' ' || coalesce(public.search_term_variants(found.key), '')
            )))
          )
        ORDER BY found.position
        LIMIT 3
      ) AS offered
    ), '[]'::jsonb),
    -- A query typed as a handle ('@lu') asks for people, not words.
    'completions', coalesce((
      SELECT jsonb_agg(jsonb_build_object('text', completions.completion) ORDER BY completions.position)
      FROM public.search_suggest_completions(p_query, p_completion_limit)
        WITH ORDINALITY AS completions(completion, position)
      WHERE NOT coalesce(p_handles_only, false)
    ), '[]'::jsonb)
  );
$function$;

COMMENT ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer) IS
  'GET /api/search/suggest in one call: {creators: [{id, username, display_name, avatar_url, is_following}], entities: [{kind, key, label, post_count, post_count_capped}], completions: [{text}]}, each list in the order to show it. Creators from search_suggest_creators; entities (at most 3) from search_public_entities, only those two creators'' posts are made with and whose name holds no withdrawn word; completions from search_suggest_completions. No entities or completions for a handles-only query.';

REVOKE ALL ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_suggestions(text, uuid, boolean, integer, integer) TO service_role;

COMMIT;
