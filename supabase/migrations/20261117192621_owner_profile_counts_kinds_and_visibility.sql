-- Studio's media filters (Images · Videos · Audio) and the Post Library's
-- visibility filters (Public · Unlisted · Private) said a number only once
-- every page of their list was loaded (#836, #860): the server counted the
-- totals they split, the Active creations and the live posts, but not the
-- splits. The owner asked for them on 2026-11-17, and the function now counts
-- them with the rules the lists apply:
--   creationsByKind: the Active creations (`creations`: the same owner ids,
--     merged guests included, and the same studio, status, archive and output
--     rule) under the media filter Studio files each one under. The owner
--     list sends a creation's kind as its category
--     (lib/owner-generations-route-service.ts), read from its file first,
--     inferVisualContentType (a video, then a picture, then a sound, by the
--     extension or the storage folder of the stored output_url), then
--     classifyVisualMedia (lib/media-contract.ts): audio for an audio
--     category or a sound file, videos for a video category or a video file,
--     images for anything else; Studio's filters read that category
--     (getMediaKind in app/creations/page.tsx). So a creation with no category
--     is filed by its file here as in the grid (such a creation is a video
--     known by its file). generations_category_check allows image,
--     video and audio, so motion (stored as video since 20260619133531) needs
--     no branch. The list also reads a run of an audio model as audio
--     (isAudioModel): every audio start stores category 'audio'
--     (lib/generation-services.ts), so the model list stays in the code.
--   postsByVisibility: the live posts (`posts`: every review status,
--     archived_at unset) by their stored visibility, as the owner list's
--     visibility filters page them (lib/owner-posts.ts). Unlisted is stored as
--     private since 20261017144307; a row stored unlisted is counted all the
--     same, as the list still pages it.
-- Each split adds up to its total. The other keys are unchanged. No index: the
-- splits are counted in the scans of one person's rows that count their
-- totals. Rules and fixtures: docs/plans/profile-counts-2026-09-28.md and
-- supabase/tests/database/owner_profile_counts.test.sql.

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
    -- finished run that has an output or has lost its source (that plate is
    -- still a tile), counted in the Active or the Archived scope; plus the
    -- studio-visibility rule the owner list applies to template-run steps.
    -- The app's text-kind branch has no row here: generations_category_check
    -- allows only image, video and audio.
    SELECT
      count(*) FILTER (
        WHERE generations.archived_at IS NULL
          AND generations.status = 'succeeded'
          AND (
            generations.source_unavailable_at IS NOT NULL
            OR generations.output_url IS NOT NULL
          )
      )::integer AS active,
      count(*) FILTER (
        WHERE generations.archived_at IS NOT NULL
          AND generations.status = 'succeeded'
          AND (
            generations.source_unavailable_at IS NOT NULL
            OR generations.output_url IS NOT NULL
          )
      )::integer AS archived,
      -- The Failed scope. The list admits a template-run step only once it
      -- succeeded (authorizeOwnerStudioProjection), so a failed one is not
      -- counted.
      count(*) FILTER (
        WHERE generations.archived_at IS NULL
          AND generations.status = 'failed'
          AND generations.template_run_id IS NULL
          AND generations.template_run_step_id IS NULL
      )::integer AS failed,
      -- Studio's media filters: the Active creations, each under the filter
      -- its kind files it under (media, below).
      count(*) FILTER (
        WHERE generations.archived_at IS NULL
          AND generations.status = 'succeeded'
          AND (
            generations.source_unavailable_at IS NOT NULL
            OR generations.output_url IS NOT NULL
          )
          AND media.studio_filter = 'images'
      )::integer AS active_images,
      count(*) FILTER (
        WHERE generations.archived_at IS NULL
          AND generations.status = 'succeeded'
          AND (
            generations.source_unavailable_at IS NOT NULL
            OR generations.output_url IS NOT NULL
          )
          AND media.studio_filter = 'videos'
      )::integer AS active_videos,
      count(*) FILTER (
        WHERE generations.archived_at IS NULL
          AND generations.status = 'succeeded'
          AND (
            generations.source_unavailable_at IS NOT NULL
            OR generations.output_url IS NOT NULL
          )
          AND media.studio_filter = 'audio'
      )::integer AS active_audio
    FROM public.generations AS generations
    -- The kind of its file, as inferVisualContentType reads the stored
    -- output_url: a video, then a picture, then a sound, by the extension or
    -- the storage folder; none for any other address or for no file.
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN generations.output_url ~* '\.(mp4|mov|m4v|webm)(\?|$)'
          OR starts_with(generations.output_url, 'generated_videos/') THEN 'video'
        WHEN generations.output_url ~* '\.(avif|gif|jpe?g|png|webp)(\?|$)'
          OR starts_with(generations.output_url, 'generated_images/') THEN 'image'
        WHEN generations.output_url ~* '\.(mp3|m4a|wav|aac)(\?|$)'
          OR starts_with(generations.output_url, 'generated_audio/') THEN 'audio'
      END AS file_kind
    ) AS output_file
    -- The filter that files it, as classifyVisualMedia reads its category and
    -- its file: a sound first, then a video, and a picture for anything else.
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN generations.category = 'audio' OR output_file.file_kind = 'audio' THEN 'audio'
        WHEN generations.category = 'video' OR output_file.file_kind = 'video' THEN 'videos'
        ELSE 'images'
      END AS studio_filter
    ) AS media
    WHERE generations.user_id IN (SELECT owner_ids.id FROM owner_ids)
      AND (
        (generations.template_run_id IS NULL AND generations.template_run_step_id IS NULL)
        OR generations.studio_visible
      )
  ),
  posts AS (
    -- The owner list shows every visibility and review status to its owner;
    -- only archiving moves a post between the two scopes. The Post Library's
    -- visibility filters page the live ones by their stored visibility, which
    -- posts_visibility_check holds to these three.
    SELECT
      count(*) FILTER (WHERE posts.archived_at IS NULL)::integer AS active,
      count(*) FILTER (WHERE posts.archived_at IS NOT NULL)::integer AS archived,
      count(*) FILTER (WHERE posts.archived_at IS NULL AND posts.visibility = 'public')::integer AS active_public,
      count(*) FILTER (WHERE posts.archived_at IS NULL AND posts.visibility = 'unlisted')::integer AS active_unlisted,
      count(*) FILTER (WHERE posts.archived_at IS NULL AND posts.visibility = 'private')::integer AS active_private
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
    'creations', (SELECT creations.active FROM creations),
    'creationsByKind', (
      SELECT jsonb_build_object(
        'images', creations.active_images,
        'videos', creations.active_videos,
        'audio', creations.active_audio
      )
      FROM creations
    ),
    'failedCreations', (SELECT creations.failed FROM creations),
    'archivedCreations', (SELECT creations.archived FROM creations),
    'posts', (SELECT posts.active FROM posts),
    'postsByVisibility', (
      SELECT jsonb_build_object(
        'public', posts.active_public,
        'unlisted', posts.active_unlisted,
        'private', posts.active_private
      )
      FROM posts
    ),
    'archivedPosts', (SELECT posts.archived FROM posts),
    'saved', (SELECT saved.total FROM saved)
  );
$$;

REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_profile_counts(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.owner_profile_counts(uuid) TO service_role;

COMMENT ON FUNCTION public.owner_profile_counts(uuid) IS
  'Totals for the owner''s profile header, scope chips and Studio''s filters (creations, creationsByKind, failedCreations, archivedCreations, posts, postsByVisibility, archivedPosts, saved), counted with the same rules the profile library lists and Studio''s filters apply. Service role only; read by /api/profile.';
