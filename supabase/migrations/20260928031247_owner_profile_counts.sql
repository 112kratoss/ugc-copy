-- The owner's profile header (Creations, Posts, Saved) used to report how many
-- cards the app had paged in so far, plus a "+"; the Wallet card read a
-- summary off the Posts library's first page; the side menu fetched the sales
-- total on its own. /api/profile now says the totals once, from this function,
-- with the same rules the library lists apply, so a header number and the grid
-- below it agree and the app's saved profile copy carries them across launches.
-- Rules and fixtures: docs/plans/profile-counts-2026-09-28.md.

CREATE OR REPLACE FUNCTION public.owner_profile_counts(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH owner_ids AS (
    -- The creations list resolves the owner through the guest profiles merged
    -- into this account (lib/owner-generations-route-service.ts), so the count
    -- does too. Posts and saves are written against the account itself.
    SELECT p_user_id AS id
    UNION
    SELECT profiles.id
    FROM public.profiles AS profiles
    WHERE profiles.merged_into_user_id = p_user_id
  ),
  blocked_creators AS (
    -- Both directions, as loadBlockedCreatorIds applies to the Saved list.
    SELECT blocks.blocked_user_id AS id
    FROM public.user_blocks AS blocks
    WHERE blocks.blocker_user_id = p_user_id
    UNION
    SELECT blocks.blocker_user_id
    FROM public.user_blocks AS blocks
    WHERE blocks.blocked_user_id = p_user_id
  ),
  creations AS (
    -- isCreationLibraryMember in ugc-mobile/lib/creation-library.ts: a
    -- finished, unarchived run that has an output or has lost its source (that
    -- plate is still a tile); plus the studio-visibility rule the owner list
    -- applies to template-run steps. The app's text-kind branch has no row
    -- here: generations_category_check allows only image, video and audio.
    SELECT count(*)::integer AS total
    FROM public.generations AS generations
    WHERE generations.user_id IN (SELECT owner_ids.id FROM owner_ids)
      AND generations.archived_at IS NULL
      AND generations.status = 'succeeded'
      AND (
        (generations.template_run_id IS NULL AND generations.template_run_step_id IS NULL)
        OR generations.studio_visible
      )
      AND (
        generations.source_unavailable_at IS NOT NULL
        OR generations.output_url IS NOT NULL
      )
  ),
  posts AS (
    -- The owner list shows every visibility and review status to its owner;
    -- only archiving moves a post between the two scopes.
    SELECT
      count(*) FILTER (WHERE posts.archived_at IS NULL)::integer AS active,
      count(*) FILTER (WHERE posts.archived_at IS NOT NULL)::integer AS archived
    FROM public.posts AS posts
    WHERE posts.user_id = p_user_id
  ),
  saved AS (
    -- The Saved list reads post_saves, and falls back to the legacy
    -- showcase_saves only for a person with no post_saves rows at all
    -- (lib/showcase-saved-media-service.ts). A saved post shows only while it
    -- is public or unlisted, visible, unarchived, and not by a blocked creator.
    SELECT CASE
      WHEN EXISTS (SELECT 1 FROM public.post_saves AS saves WHERE saves.user_id = p_user_id) THEN (
        SELECT count(*)::integer
        FROM public.post_saves AS saves
        JOIN public.posts AS posts ON posts.id = saves.post_id
        WHERE saves.user_id = p_user_id
          AND posts.visibility IN ('public', 'unlisted')
          AND posts.review_status = 'visible'
          AND posts.archived_at IS NULL
          AND posts.user_id NOT IN (SELECT blocked_creators.id FROM blocked_creators)
      )
      ELSE (
        SELECT count(*)::integer
        FROM public.showcase_saves AS saves
        JOIN public.posts AS posts ON posts.generation_id = saves.generation_id
        WHERE saves.user_id = p_user_id
          AND posts.visibility IN ('public', 'unlisted')
          AND posts.review_status = 'visible'
          AND posts.archived_at IS NULL
          AND posts.user_id NOT IN (SELECT blocked_creators.id FROM blocked_creators)
      )
    END AS total
  )
  SELECT jsonb_build_object(
    'creations', (SELECT creations.total FROM creations),
    'posts', (SELECT posts.active FROM posts),
    'archivedPosts', (SELECT posts.archived FROM posts),
    'saved', (SELECT saved.total FROM saved)
  );
$$;

REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.owner_profile_counts(uuid) TO service_role;

COMMENT ON FUNCTION public.owner_profile_counts(uuid) IS
  'Totals for the owner''s profile header (creations, posts, archivedPosts, saved), counted with the same rules the profile library lists apply. Service role only; read by /api/profile.';
