-- The web feed at /feed is a new place a post can be shared from. Share events
-- carry a constrained source surface so analytics can attribute reach per
-- surface; without 'feed' in the allow-list every share from the feed would be
-- rejected by the check constraint, or silently mislabelled as 'showcase'.

ALTER TABLE public.generation_share_events
  DROP CONSTRAINT IF EXISTS generation_share_events_source_surface_check;

ALTER TABLE public.generation_share_events
  ADD CONSTRAINT generation_share_events_source_surface_check
    CHECK (source_surface IN (
      'create-image',
      'create-video',
      'create-motion',
      'my-creations',
      'creator-profile',
      'showcase',
      'detail-page',
      'feed'
    ));

ALTER TABLE public.post_share_events
  DROP CONSTRAINT IF EXISTS post_share_events_source_surface_check;

ALTER TABLE public.post_share_events
  ADD CONSTRAINT post_share_events_source_surface_check
    CHECK (source_surface IN (
      'create-image',
      'create-video',
      'create-motion',
      'my-creations',
      'creator-profile',
      'showcase',
      'detail-page',
      'feed'
    ));
