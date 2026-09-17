/**
 * Presentation for every feed-side `VideoView` — the feed tile's, the reel's,
 * and the zoom layer's view of a video a tile lent it — so none of them can
 * drift. `useExoShutter: false` means ExoPlayer draws no black shutter before
 * the first frame — the caller's poster is the only cover, so a consumer that
 * drops its poster early will show the bare surface. It also means a view a
 * player has moved away from keeps its last frame rather than going black,
 * which the zoom's video hand-off relies on.
 *
 * Its own module, free of imports, so the zoom can share it without pulling in
 * the whole media stack behind `components/feed-media-frame.tsx`.
 */
export const FEED_VIDEO_VIEW_PROPS = {
  allowsPictureInPicture: false,
  fullscreenOptions: { enable: false },
  nativeControls: false,
  startsPictureInPictureAutomatically: false,
  surfaceType: 'textureView' as const,
  useExoShutter: false,
};
