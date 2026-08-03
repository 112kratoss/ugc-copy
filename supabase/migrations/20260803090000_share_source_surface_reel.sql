-- Every mobile share reported 'detail-page' regardless of where it came from,
-- because the mobile API client hardcoded that value. The reel is a genuinely
-- distinct origin from the showcase grid, and 'showcase-reel' is already the
-- vocabulary the feed-event and moderation-report surfaces use for it. Widening
-- the allow-list is what lets both clients send the truth instead of collapsing
-- three mobile surfaces onto the web detail page.
--
-- Additive by construction: every previously accepted value stays accepted, so
-- mobile builds still in the wild keep recording successfully while the new
-- build works its way through store review.

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
      'showcase-reel',
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
      'showcase-reel',
      'detail-page',
      'feed'
    ));
