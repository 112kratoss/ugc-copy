/**
 * Where a media tile is, and which tile a full-screen reel returns to.
 *
 * Opening a post reads as one movement: the tapped media grows out of its tile
 * until it fills the screen, carrying the reel's own rail and caption with it,
 * and closing shrinks it back into the tile of the post the reader ended on.
 * That is iOS's zoom transition and Material's container transform, and it is
 * how a reel opens from a grid in Instagram — the reader never sees a separate
 * page arrive.
 *
 * This module is the half with no React Native in it: the rectangles, the
 * clock a flight runs on, the hand-off from a tapped tile to the reel it
 * opens, and the register of tiles a closing reel can return to.
 * `components/media-zoom.tsx` animates them.
 */
import type { VideoPlayer } from 'expo-video';

import type { ImmersivePreviewItem } from './immersive-preview-view-model';
import { getShowcaseMediaPreviewUrl, resolveShowcaseViewerImageSource } from './showcase-media';
import type { ShowcaseMediaItem } from './types';

export interface ZoomRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ZoomSize {
  width: number;
  height: number;
}

/** The picture the tile was showing, which the reel carries while it builds. */
export interface ZoomPreview {
  url: string;
  cacheKey?: string | null;
  thumbhash?: string | null;
}

/**
 * A tile's playing video, lent to the flight out of it (`lib/video-player-loans.ts`).
 * The flight draws the video the reader was watching instead of its poster, and
 * the reel adopts the same player instead of building one — so a video post
 * neither changes picture at take-off nor stops after landing.
 */
export interface ZoomVideo {
  player: VideoPlayer;
  /** The stream it plays. The reel adopts it only for a slide playing this same file. */
  url: string;
}

/** What a tapped tile hands to the reel it is about to open. */
export interface ZoomOrigin {
  /** The screen the tile lives on. A closing reel only returns to tiles on it. */
  surfaceId: string;
  /** Reel item id — the href's `initialId`, so a stale hand-off is ignored. */
  itemId: string;
  rect: ZoomRect;
  radius: number;
  /** width / height of the media, when the tile knows it. */
  aspectRatio: number | null;
  /**
   * The tile's own picture. The reel takes a few hundred milliseconds to build
   * its first slide on a slow device, and without this the window would grow
   * around nothing for that long; with it the movement starts on the tap and
   * the reel arrives underneath.
   */
  preview: ZoomPreview | null;
  /** The tile's playing video, when it lent it; see `ZoomVideo`. */
  video?: ZoomVideo | null;
  /** The flight the tap started, which the reel joins rather than starting its own. */
  flightId: number;
  recordedAt: number;
}

/** A mounted tile the reel can measure and hide. */
export interface ZoomSourceHandle {
  radius: number;
  aspectRatio: number | null;
  /** What this tile draws, so a closing reel can leave that picture in its place. */
  preview: ZoomPreview | null;
  /** Window-relative rectangle, or null when the tile cannot be measured. */
  measure: (report: (rect: ZoomRect | null) => void) => void;
  setHidden: (hidden: boolean) => void;
}

/**
 * How long a recorded tile stays worth growing out of. Long enough for a slow
 * screen to mount, short enough that a reel opened some other way — a
 * notification, a deep link, the actions sheet — never inherits the last tile
 * somebody happened to tap.
 */
const ORIGIN_TTL_MS = 2000;

/**
 * A tile that is mostly off-screen is not somewhere to shrink into: the reel
 * would fly to an edge and vanish. Below this share of the tile being on
 * screen the reel closes the plain way instead.
 */
const MIN_RETURN_VISIBLE_FRACTION = 0.5;

let pendingOrigin: ZoomOrigin | null = null;
const sources = new Map<string, ZoomSourceHandle>();
const hiddenKeys = new Set<string>();

// ---------------------------------------------------------------------------
// The flight
// ---------------------------------------------------------------------------

export type ZoomFlightDirection = 'open' | 'close';

/**
 * One movement of the window: out of a tile to the screen, or back into one.
 *
 * A flight belongs to no screen. The tapped tile begins it before the reel
 * exists, the layer above the navigator steps it frame by frame, and the reel
 * joins it whenever it has mounted — so the picture is moving on the frame
 * after the tap however long the reel takes to arrive.
 */
export interface ZoomFlight {
  id: number;
  direction: ZoomFlightDirection;
  geometry: ZoomGeometry;
  /**
   * The picture the layer draws during the flight, and leaves in the tile's
   * place for a moment after a close has landed. Null flies unseen.
   */
  preview: ZoomPreview | null;
  /** A playing video the layer draws in place of `preview`; see `ZoomVideo`. */
  video?: ZoomVideo | null;
  /** The post itself, whose rail and caption an open carries; see `ZoomStill.post`. */
  post?: ImmersivePreviewItem | null;
  /**
   * Whether the layer draws `preview` while the flight runs. A close that
   * shrinks the live reel itself flies under nothing; the picture appears only
   * once it has landed.
   */
  still: boolean;
  /** The layer has drawn `preview`: the flight can be seen, so it may move. */
  displayed: boolean;
}

export type ZoomFlightEvent =
  | { type: 'begin'; flight: ZoomFlight }
  | { type: 'displayed'; flight: ZoomFlight }
  | { type: 'landed'; flight: ZoomFlight };

let flight: ZoomFlight | null = null;
let flightSerial = 0;
const flightListeners = new Set<(event: ZoomFlightEvent) => void>();

function emitZoomFlight(event: ZoomFlightEvent) {
  flightListeners.forEach((listener) => listener(event));
}

/** Begins a flight, superseding whatever was in the air. */
export function beginZoomFlight(spec: Omit<ZoomFlight, 'id' | 'displayed'>): ZoomFlight {
  flightSerial += 1;
  flight = { ...spec, id: flightSerial, displayed: false };
  emitZoomFlight({ type: 'begin', flight });
  return flight;
}

export function getZoomFlight() {
  return flight;
}

/**
 * The layer has the flight's picture on screen. Reported once per flight,
 * whether by the picture itself or by the deadline that stands in for a
 * picture that never arrives.
 */
export function markZoomFlightDisplayed(id: number) {
  if (!flight || flight.id !== id || flight.displayed) return;
  flight = { ...flight, displayed: true };
  emitZoomFlight({ type: 'displayed', flight });
}

/** Ends the flight, unless another has begun since; returns the one that landed. */
export function landZoomFlight(id: number): ZoomFlight | null {
  if (!flight || flight.id !== id) return null;
  const landed = flight;
  flight = null;
  emitZoomFlight({ type: 'landed', flight: landed });
  return landed;
}

export function subscribeToZoomFlights(listener: (event: ZoomFlightEvent) => void) {
  flightListeners.add(listener);
  return () => {
    flightListeners.delete(listener);
  };
}

/**
 * One frame of a flight.
 *
 * `time` is the flight's own clock: 0 at the tile and 1 at the screen in both
 * directions, advanced by however long the frame actually took. `progress` is
 * the eased position the window is drawn at. The two are kept apart so that a
 * close can start from wherever an open had got to.
 */
export interface ZoomFlightStep {
  time: number;
  progress: number;
  done: boolean;
}

export function advanceZoomFlight(
  time: number,
  closing: boolean,
  stepMs: number,
  spanMs: number,
  easePower: number
): ZoomFlightStep {
  'worklet';
  const phase = Math.min(1, (closing ? 1 - time : time) + stepMs / spanMs);
  const eased = 1 - (1 - phase) ** easePower;
  return {
    time: closing ? 1 - phase : phase,
    progress: closing ? 1 - eased : eased,
    done: phase >= 1,
  };
}

/**
 * The clock a close starts on so that its first frame carries on from
 * `progress` instead of jumping — for a close that cuts an open short, and,
 * trivially, for one that starts from a landed open (1 → 1).
 */
export function reverseZoomFlightTime(progress: number, easePower: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return clamped ** (1 / easePower);
}

// ---------------------------------------------------------------------------
// The picture above the navigator
// ---------------------------------------------------------------------------

/**
 * What the layer above every screen draws: a picture, inside the window
 * `computeZoomFrame` gives it for the flight's current progress.
 *
 * A pushed screen cannot draw anything until its first commit lands, which on
 * a slow device is a few hundred milliseconds after the tap; a popped one is
 * gone the moment the pop commits. Holding the picture up here keeps the media
 * on screen and moving across both gaps, so the reel appears to grow out of
 * something that never left, and to shrink back into it.
 */
export interface ZoomStill {
  preview: ZoomPreview;
  geometry: ZoomGeometry;
  /** Drawn instead of `preview` when the tile lent its playing video. */
  video?: ZoomVideo | null;
  /**
   * The post as the reel lists it, when the tile knows it. The layer draws the
   * reel's own rail, caption and controls over the picture, so the post grows
   * out of its tile whole, from the first frame, rather than as a bare picture
   * the reel dresses once it has landed. Instagram draws its reel that way.
   */
  post?: ImmersivePreviewItem | null;
  /**
   * Held, out of sight, for as long as an open reel may close onto it — not
   * for a finger that may never lift — so the layer never lets it go on a timer.
   */
  standing?: boolean;
}

let still: ZoomStill | null = null;
let stillToken = 0;
const stillListeners = new Set<() => void>();

/** Holds `next` and returns a token that identifies this particular hold. */
export function holdZoomPicture(next: ZoomStill | null) {
  still = next;
  stillToken += 1;
  stillListeners.forEach((listener) => listener());
  return stillToken;
}

/**
 * Releases a hold, unless something has been held since. A reel that has just
 * closed leaves its picture behind for a moment and then lets go — but if the
 * reader has already opened another post, that one's picture stays.
 */
export function releaseZoomPicture(token: number) {
  if (token !== stillToken) return;
  holdZoomPicture(null);
}

export function getHeldZoomPicture() {
  return still;
}

export function getHeldZoomPictureToken() {
  return stillToken;
}

export function subscribeToHeldZoomPicture(listener: () => void) {
  stillListeners.add(listener);
  return () => {
    stillListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The hand-off and the register of tiles
// ---------------------------------------------------------------------------

function sourceKey(surfaceId: string, itemId: string) {
  return `${surfaceId} ${itemId}`;
}

export function setPendingZoomOrigin(origin: ZoomOrigin) {
  pendingOrigin = origin;
}

export function clearPendingZoomOrigin() {
  pendingOrigin = null;
}

/**
 * The hand-off for `itemId`, when there is a fresh one.
 *
 * Reading does not consume it: the reel reads this while rendering (a lazy
 * `useState` initializer), and React may run that twice. The reel clears it
 * once it has mounted.
 */
export function peekPendingZoomOrigin(itemId: string | null | undefined, now: number): ZoomOrigin | null {
  if (!pendingOrigin || !itemId || pendingOrigin.itemId !== itemId) return null;
  if (now - pendingOrigin.recordedAt > ORIGIN_TTL_MS) return null;
  return pendingOrigin;
}

/**
 * Whether the reel opening on `itemId` is pushed under a tile's picture that
 * already fills the screen: a fresh hand-off whose flight has landed. Whatever
 * the navigator animates then plays unseen beneath that picture, and only holds
 * back the moment the reel can be uncovered.
 */
export function arrivesUnderLandedZoom(itemId: string | null | undefined, now: number): boolean {
  const origin = peekPendingZoomOrigin(itemId, now);
  return origin !== null && flight?.id !== origin.flightId;
}

/** Registers a mounted tile; the returned function unregisters exactly this handle. */
export function registerZoomSource(surfaceId: string, itemId: string, handle: ZoomSourceHandle) {
  const key = sourceKey(surfaceId, itemId);
  sources.set(key, handle);
  // A list cell recycled onto a post whose reel is open must arrive hidden, or
  // the tile would show through the moment the reader drags the reel aside.
  handle.setHidden(hiddenKeys.has(key));
  return () => {
    if (sources.get(key) === handle) sources.delete(key);
  };
}

export function getZoomSource(surfaceId: string | null | undefined, itemId: string | null | undefined) {
  if (!surfaceId || !itemId) return null;
  return sources.get(sourceKey(surfaceId, itemId)) ?? null;
}

/**
 * Hides or shows the tile a reel currently stands for. The hidden state lives
 * here rather than in the tile, so a recycled cell — or a list that remounts
 * while the reel is open — cannot forget it.
 */
export function setZoomSourceHidden(
  surfaceId: string | null | undefined,
  itemId: string | null | undefined,
  hidden: boolean
) {
  if (!surfaceId || !itemId) return;
  const key = sourceKey(surfaceId, itemId);
  if (hidden) hiddenKeys.add(key);
  else hiddenKeys.delete(key);
  sources.get(key)?.setHidden(hidden);
}

/** Shows every tile again — the reel's last word, however it left. */
export function clearHiddenZoomSources() {
  hiddenKeys.forEach((key) => sources.get(key)?.setHidden(false));
  hiddenKeys.clear();
}

/** Test seam: this module's state is deliberately global, so tests reset it. */
export function resetMediaZoomTransitions() {
  pendingOrigin = null;
  still = null;
  stillToken = 0;
  stillListeners.clear();
  flight = null;
  flightSerial = 0;
  flightListeners.clear();
  sources.clear();
  hiddenKeys.clear();
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/**
 * The picture a tile is showing for this media, under the cache key the tile
 * loaded it with — so the reel's copy of it is served from memory rather than
 * fetched again, and lands on screen in the same frame as the tap.
 */
export function showcaseMediaZoomPreview(item: ShowcaseMediaItem | null | undefined): ZoomPreview | null {
  if (!item) return null;
  const previewUrl = getShowcaseMediaPreviewUrl(item);
  const cacheKey = item.preview?.cacheKey ?? item.previewCacheKey ?? null;
  const thumbhash = item.preview?.thumbhash ?? item.previewThumbhash ?? null;
  if (previewUrl) return { url: previewUrl, cacheKey, thumbhash };
  // No derivative yet: only an image tile draws the source itself, and it files
  // it under its own key (see ShowcaseMediaSlide).
  if (item.mediaKind !== 'image' || !item.url) return null;
  return { url: item.url, cacheKey: cacheKey ? `${cacheKey}:source` : null, thumbhash };
}

/**
 * The picture the reel itself draws for this media — an image's display or
 * source rendition, a video's poster — under the key the reel filed it with.
 * A close that has to leave the reel behind shrinks this, so what shrinks is
 * what the reader was looking at, served from memory.
 */
export function showcaseViewerMediaPicture(item: ShowcaseMediaItem | null | undefined): ZoomPreview | null {
  if (!item) return null;
  if (item.mediaKind !== 'image') return showcaseMediaZoomPreview(item);
  // The same choice the image slide makes (`ImmersiveMedia`), so the copy is
  // the rendition already in memory.
  const source = resolveShowcaseViewerImageSource(item);
  if (!source.url) return null;
  return {
    url: source.url,
    cacheKey: source.cacheKey ?? null,
    thumbhash: item.preview?.thumbhash ?? item.previewThumbhash ?? null,
  };
}

/** The media's own shape, when the descriptor or the record knows it. */
export function mediaItemAspectRatio(
  item: Pick<ShowcaseMediaItem, 'width' | 'height' | 'preview'> | null | undefined
) {
  const width = item?.preview?.width ?? item?.width ?? null;
  const height = item?.preview?.height ?? item?.height ?? null;
  if (!width || !height || width <= 0 || height <= 0) return null;
  return width / height;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Where `contain`-fitted media of `aspectRatio` lands on the screen — the
 * rectangle the reel actually draws the picture in, which is what has to line
 * up with the tile. An unknown shape means the whole screen.
 */
export function mediaRectInScreen(screen: ZoomSize, aspectRatio: number | null | undefined): ZoomRect {
  'worklet';
  const { width, height } = screen;
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0 || width <= 0 || height <= 0) {
    return { x: 0, y: 0, width, height };
  }
  if (aspectRatio >= width / height) {
    const mediaHeight = width / aspectRatio;
    return { x: 0, y: (height - mediaHeight) / 2, width, height: mediaHeight };
  }
  const mediaWidth = height * aspectRatio;
  return { x: (width - mediaWidth) / 2, y: 0, width: mediaWidth, height };
}

/**
 * The scale at which `media` covers `tile` — what a tile's `cover` crop shows.
 * Matching it is what makes the first frame of the flight and the tile the same
 * picture rather than two croppings of it.
 */
export function coverScale(tile: ZoomSize, media: ZoomSize): number {
  'worklet';
  if (media.width <= 0 || media.height <= 0) return 1;
  return Math.max(tile.width / media.width, tile.height / media.height);
}

export interface ZoomGeometry {
  screen: ZoomSize;
  /** The tile to grow from or return to; null when the reel has none. */
  tile: ZoomRect | null;
  tileRadius: number;
  /** width / height of the media on screen, so the flight lands on the picture. */
  aspectRatio: number | null;
}

export interface ZoomFrame {
  /** The window onto the reel, in window coordinates. */
  clip: ZoomRect;
  radius: number;
  /** Scale of the reel page inside that window. */
  scale: number;
  translateX: number;
  translateY: number;
}

function lerp(from: number, to: number, progress: number) {
  'worklet';
  return from + (to - from) * progress;
}

/**
 * The reel's frame at `progress`: 0 is the tile, 1 is the whole screen.
 *
 * The window onto the reel travels from the tile's rectangle to the screen's
 * while the page inside it scales from "the media covers the tile" to 1, both
 * centred on the window. The picture therefore never moves relative to the
 * window it is seen through, and the rail and caption are revealed by the
 * window opening rather than arriving after it.
 */
export function computeZoomFrame(geometry: ZoomGeometry, progress: number): ZoomFrame {
  'worklet';
  const { screen, tile } = geometry;
  const media = mediaRectInScreen(screen, geometry.aspectRatio);
  const from = tile ?? { x: 0, y: 0, width: screen.width, height: screen.height };
  const startScale = tile ? coverScale(from, media) : 1;

  const width = lerp(from.width, screen.width, progress);
  const height = lerp(from.height, screen.height, progress);

  return {
    clip: {
      x: lerp(from.x, 0, progress),
      y: lerp(from.y, 0, progress),
      width,
      height,
    },
    radius: lerp(tile ? geometry.tileRadius : 0, 0, progress),
    scale: lerp(startScale, 1, progress),
    // The page keeps its full-screen size inside the window, centred on it.
    translateX: width / 2 - screen.width / 2,
    translateY: height / 2 - screen.height / 2,
  };
}

/** Whether a measured tile is enough on screen to be worth shrinking into. */
export function isReturnableRect(rect: ZoomRect | null | undefined, screen: ZoomSize): rect is ZoomRect {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const visibleWidth = Math.min(rect.x + rect.width, screen.width) - Math.max(rect.x, 0);
  const visibleHeight = Math.min(rect.y + rect.height, screen.height) - Math.max(rect.y, 0);
  if (visibleWidth <= 0 || visibleHeight <= 0) return false;
  const visible = (visibleWidth * visibleHeight) / (rect.width * rect.height);
  return visible >= MIN_RETURN_VISIBLE_FRACTION;
}
