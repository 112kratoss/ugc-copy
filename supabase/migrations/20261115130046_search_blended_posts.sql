-- Search (hybrid ranking): the Posts order can be the word matches and the
-- meaning matches merged into one list.
--
-- Before this file a search ordered posts by their words alone
-- (search_public_posts, 20261112103547 and 20261112174210), and the posts
-- that mean what a query says without holding its words were a group of
-- their own, shown only beside a thin answer (search_related_posts,
-- 20261112215420). 'ocean at dusk' found one post by its words, three more
-- under "Related posts", and nothing said that the best of the four was
-- under the wrong heading. Search engines built on a word index add
-- embeddings as one more input to the same ranking; Supabase's own hybrid
-- search guide does it in Postgres with two lists merged by reciprocal rank
-- fusion (https://supabase.com/docs/guides/ai/hybrid-search). This file does
-- that for posts.
--
-- THE RULE every part of this file keeps: nothing a visitor cannot see may
-- change a match, a score, a count or an order.
--
-- public.search_blended_posts(p_query, p_query_hash, p_query_embedding,
--   p_viewer_user_id, p_as_of, p_after_position, p_limit, p_made_with,
--   p_media_kind, p_has_recipe, p_followed_only, p_embedding_model,
--   p_after_post_id)
--
-- 1. TWO LISTS, for one viewer, one instant and one set of filters.
--    THE WORD LIST is the first c_word_window rows of search_public_posts,
--    read by calling search_public_posts itself, a page of 25 (its own
--    maximum) at a time, each from the keyset place the one before ended at.
--    So the word list is today's order by construction: its match, its score
--    at p_as_of, its reading of the query, its filters, and who it leaves
--    out. Nothing of that is written a second time here.
--    THE MEANING LIST is the c_meaning_window posts nearest the query's
--    vector at cosine similarity c_min_similarity or above, over
--    post_search_embeddings: the vectors made from a post's public search
--    text and from nothing else (never the feed's post_content_embeddings,
--    which hold hidden prompt text). It is read as search_related_posts
--    reads it and held to the same rules, before its limit: a post with no
--    document (not public, archived, hidden by review), a labelled post, both
--    sides of a block with the viewer, and a post whose vector is not of the
--    text it shows now or of the asked model are left out; and the filters
--    (made-with, media kind, a published recipe, followed creators) are
--    applied to it as search_public_posts applies them to the word list.
--    THE READ IS EXACT, and no vector index is added: every vector of the
--    model is measured, for the reasons 20261112215420 gives (an HNSW scan
--    returns its nearest rows and only then are the rules applied, so a
--    labelled or blocked post would cost the viewer a result). On 3,900
--    vectors the scan takes 0.9 ms (local replay, 2026-11-15).
--    docs/search-ranking-operations.md says at what size an index is worth
--    building and how.
--
-- 2. ONE ORDER, by reciprocal rank fusion. A post's blended score is the
--    sum, over the lists that hold it, of weight / (c_rrf_k + its rank in
--    that list):
--      c_rrf_k           50    the guide's constant
--      c_word_weight     1.0
--      c_meaning_weight  0.9
--    A post in both lists adds both terms and rises; a post in one list has
--    one. What 0.9 means: a post only the meaning list holds, at its rank m,
--    comes before a post only the word list holds at rank r when
--    0.9 / (50 + m) > 1 / (50 + r), which is r > 5.56 + 1.11 m. So the
--    nearest meaning-only post (m = 1) comes after the sixth word row and
--    before the seventh: while a search has six word matches, the number
--    under which the product already calls an answer thin
--    (SEARCH_RELATED_THIN_POST_COUNT), none of them is displaced by a post
--    that holds no word of the query, and from there the two interleave
--    about one for one. With the weights equal the first word row and the
--    first meaning-only post would tie; under 0.9 no such pair ties.
--    POSTS WHOSE TITLE IS THE QUERY STAY FIRST, in the word order, whatever
--    the lists say: c_exact_title_score is search_post_score's first tier
--    (30; nothing else reaches it), and a row at or above it is placed
--    ahead of the fusion. A title match with no vector yet (a post made a
--    minute ago) would otherwise fall behind a post in both lists.
--    Ties go to the better word rank, then the better meaning rank, then the
--    post id.
--    HOW THE NUMBERS WERE CHOSEN. On the relevance set
--    (config/search-relevance/, 123 synthetic posts, 75 queries graded by
--    hand, real gte-small vectors from the local edge runtime, 2026-11-15),
--    by similarity floor, meaning weight 0.9:
--      floor  nDCG@10  relevant post in top 5  wrong posts in top 10  posts for queries about nothing
--      words  0.5410   0.7286                  0.30                   0
--      0.80   0.8536   0.9857                  3.74                   1
--      0.81   0.8264   0.9857                  2.64                   0
--      0.82   0.7837   0.9714                  1.90                   0
--      0.83   0.7558   0.9714                  1.11                   0
--      0.84   0.6700   0.8857                  0.60                   0
--    The floor is 0.82: the lowest at which no query about nothing is
--    answered with room to spare (the nearest post to such a query scored
--    0.805 here and 0.81 in the calibration of 20261112215420). It is lower
--    than the related group's 0.84 because a meaning-only post here is ranked
--    behind the word matches and says how it matched, where there it stood
--    alone under a heading; the cost is the wrong posts, near in vocabulary
--    and not in subject, which 0.82 lets in at almost two in ten.
--    The weight barely moves these numbers (at 0.82, weights from 0.5 to 0.95
--    score 0.7836 to 0.7841 and 1.0 scores 0.7833): word lists of several
--    words are short on a corpus this size, so the weight is set by the rule
--    above and not by the table. The meaning window does not move them at all (no list
--    at 0.82 is longer than 30).
--
-- 3. THE WINDOW AND AFTER IT. The merged lists are the window: at most
--    c_word_window + c_meaning_window = 80 posts, each at a place counted
--    from 1 (blend_position). Past the window the list is the word order
--    again, from the row after the word list's last, so every post that
--    holds the words is reached once and posts found by meaning alone live
--    only inside the window. A page that reaches the window's end is filled
--    from the word order after it.
--    A post near the query in meaning can hold its words too, further down
--    the word order than the window reads. It keeps its place there and is
--    left out of the meaning list, so no post is in the list twice and
--    matched_by 'meaning' is only ever said of a post that holds none of the
--    words. That one question (does this candidate hold the words?) is
--    search_public_posts's match written once more, asked only when the word
--    list is full, and held to the original by a test.
--    PAGES. The window is a function of the query, the viewer, p_as_of, the
--    filters and the vector, so a page is asked for by its place:
--    p_after_position rows are skipped. The window is rebuilt from the rows
--    as they are at each request (a post published, removed or saved in
--    between moves every place after it), so a page is also asked for by the
--    last post shown, p_after_post_id: where the window still holds that
--    post, the page starts after it, wherever it now stands, and the place
--    is used only when the post is gone. What is left is a post that moves
--    across that line between two pages: it can be shown twice, or once
--    passed over. A CLIENT LEAVES OUT, BY ITS ID, A POST IT HAS ALREADY
--    SHOWN.
--    Each row also names its FLOOR (floor_score, floor_post_id): the last
--    row of the unbroken run of the word order, from its top, shown up to
--    and including that row. Word ranks 1, 3, 2 shown in that order have
--    the floors 1, 1, 3. A row shown before the first word row has no floor.
--    A cursor carries the place, the last post and the floor. When the blend
--    cannot be made for a later page (the query's vector has left the cache,
--    the lookup is switched off, the app is rolled back to code that knows
--    no place), search_public_posts read from the floor continues the list,
--    or from its top when there is no floor. That read passes over no post
--    that holds the words: every word row before the floor has been shown.
--    It repeats the word rows shown from further down, which posts in both
--    lists are (such a post outranks every post the word list alone holds:
--    1/100 + 0.9/80 is more than 1/51, so a first page can be made of them
--    alone and its floor be none), and it drops the meaning-only posts not
--    yet shown. Repeats are the client's to leave out; a skipped word match
--    would be nobody's to find. Past the window a cursor carries the floor
--    alone and is an ordinary Top cursor.
--
-- 4. WHEN IT DOES NOT BLEND, the rows are search_public_posts's own, in its
--    order, each its own floor, in_window false, and blend_state says why:
--      'no_vector'  no vector was handed over and the cache holds none for
--                   p_query_hash (read as search_query_embedding reads it:
--                   this model, seven days). The service then asks for one
--                   under the viewer's allowance, the day's cap and a short
--                   wait, and calls again with it, or answers with these rows.
--      'corrected'  the word search read the query corrected. The vector is
--                   of the words as typed and the posts found are of other
--                   words: the answer is the corrected word order.
--    Past the first page such a call returns nothing: its caller pages the
--    word order from its cursor's floor, or from its top without one. Nothing here asks the embedding
--    function for anything, counts anything or writes anything.
--    The service asks only for a search of two words or more in the ranked
--    order, not a handle and not read as typed, by a client that sent
--    blend=1 (src/lib/search-blended-posts.ts,
--    ugc-mobile/lib/public-search-policy/search-blend.ts).
--
-- WHAT IT COSTS. The word list is read by calling search_public_posts once
-- per 25 rows, and each call scores every match again. On 4,000 posts and
-- 3,900 real vectors (local replay, 2026-11-15), a first page of 21 rows,
-- median of 25 calls in one connection, eight queries:
--   under 25 posts hold the words   plain 20 ms, blended 24 ms    (one word read)
--   25 or more do                   plain 18 to 25 ms, blended 40 to 58 ms
--                                                                 (two word reads)
--   no cached vector                the plain read, within half a millisecond
-- The scan of every vector takes 0.9 ms of that and the merge less. If the
-- second word read becomes the cost that matters, the word list can be read
-- in one pass here; that means a second copy of search_public_posts's match
-- and score, which this file chose not to keep.
--
-- 5. THE SEARCH LOG SAYS WHEN AN ANSWER WAS BLENDED. search_query_events
--    gains blended (boolean, false unless a row says otherwise). A blended
--    answer's posts are not all word matches, so its row counts them apart:
--    post_count is the posts that hold the words (matched by words or by
--    both), related_count the posts found by meaning alone, as it already
--    counts the related group. "The words found nothing" therefore still
--    reads post_count = 0 whichever way the answer was ordered, and the
--    report's zero-result test keeps its meaning; blended lets a report
--    split the two orders later. search_query_report is not touched.
--
-- THE RELEASE WINDOW. Migrations apply before the new app is promoted.
-- Nothing live calls this function until the new app does, and no existing
-- function is changed: search_public_posts, search_related_posts,
-- search_post_score, the documents, the embeddings and their job are
-- untouched, so the app live meanwhile, and the new app after a code-only
-- rollback, read what they read before. The app live meanwhile writes its
-- log rows without the new column, which takes its default.
--
-- LOCKS. The new column takes ACCESS EXCLUSIVE on search_query_events for a
-- catalog change only (a constant default rewrites no row), under the
-- 5-second lock timeout. No other table is locked, and no index or trigger
-- is added.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.search_blended_posts(
  p_query text,
  p_query_hash text DEFAULT NULL,
  p_query_embedding extensions.vector DEFAULT NULL,
  p_viewer_user_id uuid DEFAULT NULL,
  p_as_of timestamptz DEFAULT NULL,
  p_after_position integer DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_made_with text DEFAULT NULL,
  p_media_kind text DEFAULT NULL,
  p_has_recipe boolean DEFAULT false,
  p_followed_only boolean DEFAULT false,
  p_embedding_model text DEFAULT 'gte-small',
  p_after_post_id uuid DEFAULT NULL
)
RETURNS TABLE(
  post_id uuid,
  creator_user_id uuid,
  search_score double precision,
  created_at timestamptz,
  corrected_query text,
  blend_state text,
  matched_by text,
  blend_position integer,
  in_window boolean,
  floor_score double precision,
  floor_post_id uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- THE CONSTANTS (this file's header says how each was chosen). To retune the
  -- blend, re-create this function alone.
  -- Reciprocal rank fusion: a post's blended score is the sum, over the lists
  -- that hold it, of weight / (c_rrf_k + its rank in that list).
  c_rrf_k CONSTANT integer := 50;
  c_word_weight CONSTANT double precision := 1.0;
  c_meaning_weight CONSTANT double precision := 0.9;
  -- The word list: the first rows of search_public_posts, in its order.
  c_word_window CONSTANT integer := 50;
  -- The meaning list: the nearest posts at or above the similarity floor.
  c_meaning_window CONSTANT integer := 30;
  c_min_similarity CONSTANT double precision := 0.82;
  -- search_post_score's first tier (c_tier_title_is_query): a post whose
  -- title is the query scores this or more and nothing else does. Such posts
  -- stay first, in the word order.
  c_exact_title_score CONSTANT double precision := 30.0;
  -- The most rows one call of search_public_posts returns.
  c_word_page CONSTANT integer := 25;

  v_max_distance CONSTANT double precision := 1.0 - c_min_similarity;
  v_after integer := coalesce(p_after_position, 0);
  v_has_recipe boolean := coalesce(p_has_recipe, false);
  v_followed_only boolean := coalesce(p_followed_only, false);
  v_entity_kind text;
  v_entity_key text;
  v_embedding extensions.vector := p_query_embedding;
  -- The word list, in its order.
  v_ids uuid[] := '{}'::uuid[];
  v_creators uuid[] := '{}'::uuid[];
  v_scores double precision[] := '{}'::double precision[];
  v_created timestamptz[] := '{}'::timestamptz[];
  v_page_ids uuid[];
  v_page_creators uuid[];
  v_page_scores double precision[];
  v_page_created timestamptz[];
  v_read_as text;
  v_take integer;
  -- The query as search_public_posts matches it, for the one question asked
  -- of a meaning-list candidate when the word list is full: does it hold the
  -- words too, further down the word order than the window reads?
  v_query text := lower(btrim(regexp_replace(coalesce(p_query, ''), '[[:space:]]+', ' ', 'g')));
  v_like text;
  v_tsquery tsquery;
  v_word_list_full boolean;
  -- The window, in the blended order.
  v_window_ids uuid[];
  v_window_creators uuid[];
  v_window_scores double precision[];
  v_window_created timestamptz[];
  v_window_matched text[];
  v_window_floor integer[];
  v_window_size integer;
  v_needed integer;
BEGIN
  -- As search_public_posts: outside the limits a query finds nothing, by
  -- words or by meaning.
  IF char_length(v_query) < 3 OR char_length(v_query) > 100 THEN
    RETURN;
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > c_word_page THEN
    RAISE EXCEPTION 'Blended post search limit must be between 1 and %', c_word_page;
  END IF;
  IF v_after < 0 OR v_after > c_word_window + c_meaning_window THEN
    RAISE EXCEPTION 'Blended post search position must be between 0 and %', c_word_window + c_meaning_window;
  END IF;
  IF p_embedding_model IS NULL OR char_length(p_embedding_model) NOT BETWEEN 1 AND 160 THEN
    RAISE EXCEPTION 'Search embedding model must be 1 to 160 characters';
  END IF;
  IF v_embedding IS NOT NULL AND extensions.vector_dims(v_embedding) <> 384 THEN
    RAISE EXCEPTION 'Blended post search needs a query embedding of 384 dimensions';
  END IF;
  IF p_made_with IS NOT NULL THEN
    v_entity_kind := split_part(p_made_with, ':', 1);
    v_entity_key := substr(p_made_with, char_length(v_entity_kind) + 2);
    IF v_entity_kind NOT IN ('model', 'tool') OR v_entity_key = '' THEN
      RAISE EXCEPTION 'Post search made-with filter must be model:<key> or tool:<key>';
    END IF;
  END IF;

  -- The query's vector: the one handed over, or the cached one (read as
  -- search_query_embedding reads it: seven days, this model). Nothing is
  -- counted and nothing is asked of the embedding function here.
  IF v_embedding IS NULL AND p_query_hash IS NOT NULL THEN
    v_embedding := public.search_query_embedding(p_query_hash, p_embedding_model);
  END IF;

  -- The first rows of the word list: search_public_posts itself, so this list
  -- is today's order by construction, the reading of the query included.
  SELECT
    coalesce(array_agg(words.post_id ORDER BY words.ord), '{}'::uuid[]),
    coalesce(array_agg(words.creator_user_id ORDER BY words.ord), '{}'::uuid[]),
    coalesce(array_agg(words.search_score ORDER BY words.ord), '{}'::double precision[]),
    coalesce(array_agg(words.created_at ORDER BY words.ord), '{}'::timestamptz[]),
    max(words.corrected_query)
  INTO v_ids, v_creators, v_scores, v_created, v_read_as
  FROM public.search_public_posts(
    p_query, p_viewer_user_id, NULL, NULL, c_word_page, p_as_of, 'top', NULL,
    p_made_with, p_media_kind, v_has_recipe, v_followed_only, true
  ) WITH ORDINALITY AS words(post_id, creator_user_id, search_score, created_at, corrected_query, ord);

  -- No vector, or the query was read corrected (the vector is of the words as
  -- typed, and the posts found are of other words): today's order, as it is.
  -- Past the first page there is no place in that order to continue from
  -- here: the caller pages search_public_posts from its cursor's floor.
  IF v_embedding IS NULL OR v_read_as IS NOT NULL THEN
    IF v_after > 0 THEN
      RETURN;
    END IF;
    RETURN QUERY
    SELECT
      words.post_id, words.creator_user_id, words.search_score, words.created_at, v_read_as,
      CASE WHEN v_read_as IS NOT NULL THEN 'corrected' ELSE 'no_vector' END,
      'words'::text, words.ord::integer, false, words.search_score, words.post_id
    FROM unnest(v_ids, v_creators, v_scores, v_created) WITH ORDINALITY
      AS words(post_id, creator_user_id, search_score, created_at, ord)
    ORDER BY words.ord
    LIMIT p_limit;
    RETURN;
  END IF;

  -- The rest of the word list, a page of search_public_posts at a time, each
  -- from the keyset place the one before ended at.
  WHILE cardinality(v_ids) < c_word_window AND cardinality(v_ids) % c_word_page = 0 AND cardinality(v_ids) > 0 LOOP
    v_take := least(c_word_page, c_word_window - cardinality(v_ids));
    SELECT
      coalesce(array_agg(words.post_id ORDER BY words.ord), '{}'::uuid[]),
      coalesce(array_agg(words.creator_user_id ORDER BY words.ord), '{}'::uuid[]),
      coalesce(array_agg(words.search_score ORDER BY words.ord), '{}'::double precision[]),
      coalesce(array_agg(words.created_at ORDER BY words.ord), '{}'::timestamptz[])
    INTO v_page_ids, v_page_creators, v_page_scores, v_page_created
    FROM public.search_public_posts(
      p_query, p_viewer_user_id, v_scores[cardinality(v_scores)], v_ids[cardinality(v_ids)], v_take, p_as_of, 'top', NULL,
      p_made_with, p_media_kind, v_has_recipe, v_followed_only, true
    ) WITH ORDINALITY AS words(post_id, creator_user_id, search_score, created_at, corrected_query, ord);
    EXIT WHEN cardinality(v_page_ids) = 0;
    v_ids := v_ids || v_page_ids;
    v_creators := v_creators || v_page_creators;
    v_scores := v_scores || v_page_scores;
    v_created := v_created || v_page_created;
    EXIT WHEN cardinality(v_page_ids) < v_take;
  END LOOP;

  -- The word order goes on past the window: a post near the query in meaning
  -- may hold its words too, at a place the window did not read. Such a post
  -- keeps that place (the list reaches it in the word order) and is left out
  -- of the meaning list, so it is never in the list twice and "meaning" is
  -- only ever said of a post that holds none of the words. The match is
  -- search_public_posts's own, written here once more and held to it by a
  -- test; when the word list is not full there is nothing past it to ask of.
  v_word_list_full := cardinality(v_ids) >= c_word_window;
  IF v_word_list_full THEN
    v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');
    v_tsquery := public.search_query_tsquery(v_query, true);
  END IF;

  -- The window: the word list and the meaning list, merged.
  WITH words AS (
    SELECT listed.post_id, listed.creator_user_id, listed.search_score, listed.created_at, listed.ord::integer AS word_rank
    FROM unnest(v_ids, v_creators, v_scores, v_created) WITH ORDINALITY
      AS listed(post_id, creator_user_id, search_score, created_at, ord)
  ),
  -- Every vector of the model, measured: the ones at or above the floor. An
  -- exact read of the whole table, as search_related_posts makes it and for
  -- its reasons (20261112215420): no index is read, and none would be.
  near AS MATERIALIZED (
    SELECT
      embeddings.post_id,
      embeddings.content_hash,
      (embeddings.embedding OPERATOR(extensions.<=>) v_embedding)::double precision AS distance
    FROM public.post_search_embeddings AS embeddings
    WHERE embeddings.embedding_model = p_embedding_model
      AND (embeddings.embedding OPERATOR(extensions.<=>) v_embedding) <= v_max_distance
  ),
  -- The rules and the filters, before the limit: a row is kept only if
  -- search_public_posts could return its post to this viewer under these
  -- filters and its vector is of the text that post shows now.
  meaning AS (
    SELECT
      near.post_id,
      documents.creator_user_id,
      documents.created_at,
      row_number() OVER (ORDER BY near.distance ASC, near.post_id ASC)::integer AS meaning_rank
    FROM near
    JOIN public.post_search_documents AS documents ON documents.post_id = near.post_id
    JOIN public.posts AS posts ON posts.id = documents.post_id
    WHERE near.content_hash = encode(sha256(convert_to(documents.search_text, 'UTF8')), 'hex')
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
        NOT v_word_list_full
        OR near.post_id = ANY (v_ids)
        OR NOT (
          documents.search_vector @@ v_tsquery
          OR documents.search_text ILIKE ('%' || v_like || '%')
          OR documents.title_normalized OPERATOR(extensions.%) v_query
          OR documents.tool_normalized OPERATOR(extensions.%) v_query
        )
      )
    ORDER BY near.distance ASC, near.post_id ASC
    LIMIT c_meaning_window
  ),
  fused AS (
    SELECT
      coalesce(words.post_id, meaning.post_id) AS post_id,
      coalesce(words.creator_user_id, meaning.creator_user_id) AS creator_user_id,
      words.search_score,
      coalesce(words.created_at, meaning.created_at) AS created_at,
      words.word_rank,
      meaning.meaning_rank,
      coalesce(words.search_score >= c_exact_title_score, false) AS pinned,
      coalesce(c_word_weight / (c_rrf_k + words.word_rank), 0.0)
        + coalesce(c_meaning_weight / (c_rrf_k + meaning.meaning_rank), 0.0) AS fused_score
    FROM words
    FULL JOIN meaning ON meaning.post_id = words.post_id
  ),
  placed AS (
    SELECT
      fused.*,
      row_number() OVER (
        ORDER BY
          fused.pinned DESC,
          CASE WHEN fused.pinned THEN fused.word_rank END ASC NULLS LAST,
          fused.fused_score DESC,
          fused.word_rank ASC NULLS LAST,
          fused.meaning_rank ASC NULLS LAST,
          fused.post_id ASC
      )::integer AS place
    FROM fused
  ),
  -- For each word row, the place by which it and every word row before it
  -- have been shown.
  reached AS (
    SELECT
      placed.word_rank,
      max(placed.place) OVER (ORDER BY placed.word_rank ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS by_place
    FROM placed
    WHERE placed.word_rank IS NOT NULL
  ),
  floored AS (
    SELECT
      placed.*,
      -- The end of the unbroken run of the word order, from its top, shown
      -- up to this row: NULL while the first word row is still to come.
      (SELECT max(reached.word_rank) FROM reached WHERE reached.by_place <= placed.place) AS floor_rank
    FROM placed
  )
  SELECT
    coalesce(array_agg(floored.post_id ORDER BY floored.place), '{}'::uuid[]),
    coalesce(array_agg(floored.creator_user_id ORDER BY floored.place), '{}'::uuid[]),
    coalesce(array_agg(floored.search_score ORDER BY floored.place), '{}'::double precision[]),
    coalesce(array_agg(floored.created_at ORDER BY floored.place), '{}'::timestamptz[]),
    coalesce(array_agg(
      CASE
        WHEN floored.word_rank IS NULL THEN 'meaning'
        WHEN floored.meaning_rank IS NULL THEN 'words'
        ELSE 'both'
      END ORDER BY floored.place
    ), '{}'::text[]),
    coalesce(array_agg(floored.floor_rank ORDER BY floored.place), '{}'::integer[])
  INTO v_window_ids, v_window_creators, v_window_scores, v_window_created, v_window_matched, v_window_floor
  FROM floored;

  v_window_size := cardinality(v_window_ids);
  -- The page starts after the last post shown, where the window still holds
  -- it: its place may have moved since the cursor was issued. Without it,
  -- at the place given; and a place past the window (the window was longer
  -- then) goes on from the window's end.
  IF v_after > 0 AND p_after_post_id IS NOT NULL THEN
    v_after := coalesce(array_position(v_window_ids, p_after_post_id), v_after);
  END IF;
  v_after := least(v_after, v_window_size);

  RETURN QUERY
  SELECT
    listed.post_id, listed.creator_user_id, listed.search_score, listed.created_at, NULL::text,
    'fused'::text, listed.matched_by, listed.ord::integer, true,
    v_scores[listed.floor_rank], v_ids[listed.floor_rank]
  FROM unnest(v_window_ids, v_window_creators, v_window_scores, v_window_created, v_window_matched, v_window_floor)
    WITH ORDINALITY AS listed(post_id, creator_user_id, search_score, created_at, matched_by, floor_rank, ord)
  WHERE listed.ord > v_after
  ORDER BY listed.ord
  LIMIT p_limit;

  -- Past the window the list is the word order again, from the row after the
  -- word list's last: a page that reaches the window's end is filled from it.
  v_needed := v_after + p_limit - v_window_size;
  IF v_needed > 0 AND v_word_list_full THEN
    RETURN QUERY
    SELECT
      words.post_id, words.creator_user_id, words.search_score, words.created_at, NULL::text,
      'fused'::text, 'words'::text, (v_window_size + words.ord)::integer, false,
      words.search_score, words.post_id
    FROM public.search_public_posts(
      p_query, p_viewer_user_id, v_scores[c_word_window], v_ids[c_word_window], least(v_needed, c_word_page), p_as_of, 'top', NULL,
      p_made_with, p_media_kind, v_has_recipe, v_followed_only, true
    ) WITH ORDINALITY AS words(post_id, creator_user_id, search_score, created_at, corrected_query, ord)
    ORDER BY words.ord;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_blended_posts(text, text, extensions.vector, uuid, timestamptz, integer, integer, text, text, boolean, boolean, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_blended_posts(text, text, extensions.vector, uuid, timestamptz, integer, integer, text, text, boolean, boolean, text, uuid)
  TO service_role;

-- ─── 5. The search log says when an answer was blended ──────────────────────
--
-- False for every row written before this file, by the app live during the
-- release, and for every answer in the word order.
ALTER TABLE public.search_query_events
  ADD COLUMN blended boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.search_query_events.blended IS
  'True when the answer''s posts were in the blended order (search_blended_posts). On such a row post_count is the posts that hold the words (matched by words or by both lists) and related_count the posts found by meaning alone. False for rows written before 20261115130046 and for answers in the word order.';

COMMENT ON FUNCTION public.search_blended_posts(text, text, extensions.vector, uuid, timestamptz, integer, integer, text, text, boolean, boolean, text, uuid) IS
  'The blended Posts order: the first 50 rows of search_public_posts (the word list) and the 30 posts nearest the query vector at cosine similarity 0.82 or above over post_search_embeddings (the meaning list, public text only), merged by reciprocal rank fusion (k 50, word weight 1, meaning weight 0.9), posts whose title is the query first. Rows from p_after_position on, or from after p_after_post_id where the window holds it; past the window, the word order. Each row names its floor, the end of the unbroken run of the word order shown up to it. The vector is p_query_embedding or the cached one for p_query_hash; without one, or for a query read corrected, the rows are search_public_posts''s own (blend_state no_vector or corrected). Labelled posts, both sides of a block, stale vectors and posts outside the filters are left out of both lists before any limit. Service role only.';

COMMIT;
