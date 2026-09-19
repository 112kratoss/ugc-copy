import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  advanceZoomFlight,
  arrivesUnderLandedZoom,
  beginTileOpen,
  beginZoomFlight,
  canOpenFromTile,
  claimTileOpen,
  clearHiddenZoomSources,
  clearPendingZoomOrigin,
  computeZoomFrame,
  coverScale,
  endTileOpen,
  getHeldZoomPicture,
  getZoomFlight,
  getZoomSource,
  holdZoomPicture,
  isReturnableRect,
  landZoomFlight,
  markZoomFlightDisplayed,
  mediaItemAspectRatio,
  mediaRectInScreen,
  peekPendingZoomOrigin,
  registerZoomSource,
  releaseZoomPicture,
  resetMediaZoomTransitions,
  reverseZoomFlightTime,
  setPendingZoomOrigin,
  setZoomSourceHidden,
  showcaseMediaZoomPreview,
  showcaseViewerMediaPicture,
  subscribeToZoomFlights,
  type ZoomFlightEvent,
  type ZoomGeometry,
  type ZoomRect,
  type ZoomSourceHandle,
} from '../lib/media-zoom-transition';
import type { ShowcaseMediaItem } from '../lib/types';

const SCREEN = { width: 402, height: 874 };

afterEach(() => {
  resetMediaZoomTransitions();
});

function handle(overrides: Partial<ZoomSourceHandle> = {}): ZoomSourceHandle {
  return {
    radius: 12,
    aspectRatio: null,
    preview: null,
    measure: (report) => report({ x: 0, y: 0, width: 10, height: 10 }),
    setHidden: () => {},
    ...overrides,
  };
}

function geometry(overrides: Partial<ZoomGeometry> = {}): ZoomGeometry {
  return {
    screen: SCREEN,
    tile: { x: 16, y: 300, width: 370, height: 462 },
    tileRadius: 0,
    aspectRatio: 9 / 16,
    ...overrides,
  };
}

/** Where the frame puts a point of the reel page, in window coordinates. */
function pageToWindow(frame: ReturnType<typeof computeZoomFrame>, point: { x: number; y: number }) {
  const pageCenterX = SCREEN.width / 2;
  const pageCenterY = SCREEN.height / 2;
  return {
    x: frame.clip.x + frame.translateX + pageCenterX + (point.x - pageCenterX) * frame.scale,
    y: frame.clip.y + frame.translateY + pageCenterY + (point.y - pageCenterY) * frame.scale,
  };
}

describe('media rectangles', () => {
  it('fits tall media inside the screen with bands above and below', () => {
    const rect = mediaRectInScreen({ width: 400, height: 800 }, 1);

    expect(rect).toEqual({ x: 0, y: 200, width: 400, height: 400 });
  });

  it('fits wide media against the side edges', () => {
    const rect = mediaRectInScreen({ width: 400, height: 800 }, 0.25);

    expect(rect).toEqual({ x: 100, y: 0, width: 200, height: 800 });
  });

  it('treats unknown media as filling the screen', () => {
    expect(mediaRectInScreen(SCREEN, null)).toEqual({ x: 0, y: 0, ...SCREEN });
  });

  it('reads the descriptor size before the record, and rejects nonsense', () => {
    expect(mediaItemAspectRatio({ width: 100, height: 400, preview: { width: 200, height: 100 } as never })).toBe(2);
    expect(mediaItemAspectRatio({ width: 100, height: 400, preview: undefined })).toBe(0.25);
    expect(mediaItemAspectRatio({ width: 0, height: 0, preview: undefined })).toBeNull();
    expect(mediaItemAspectRatio(null)).toBeNull();
  });

  it('covers a tile the way a tile crops its media', () => {
    expect(coverScale({ width: 100, height: 100 }, { width: 200, height: 400 })).toBe(0.5);
  });
});

describe('the flight from a tile to the screen', () => {
  it('starts as the tile, showing the same crop of the media the tile shows', () => {
    const state = geometry();
    const frame = computeZoomFrame(state, 0);

    expect(frame.clip).toEqual(state.tile);

    // The media, scaled into place, covers the tile exactly as the tile's own
    // `cover` crop does — the first frame of the flight is the tile's picture.
    const media = mediaRectInScreen(SCREEN, state.aspectRatio);
    const topLeft = pageToWindow(frame, { x: media.x, y: media.y });
    const bottomRight = pageToWindow(frame, { x: media.x + media.width, y: media.y + media.height });
    expect(topLeft.x).toBeLessThanOrEqual(state.tile!.x + 0.001);
    expect(topLeft.y).toBeLessThanOrEqual(state.tile!.y + 0.001);
    expect(bottomRight.x).toBeGreaterThanOrEqual(state.tile!.x + state.tile!.width - 0.001);
    expect(bottomRight.y).toBeGreaterThanOrEqual(state.tile!.y + state.tile!.height - 0.001);
    // Centred on the tile, so the crop is the middle of the picture.
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(state.tile!.x + state.tile!.width / 2, 3);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(state.tile!.y + state.tile!.height / 2, 3);
  });

  it('lands on the untouched screen', () => {
    const frame = computeZoomFrame(geometry(), 1);

    expect(frame.clip).toEqual({ x: 0, y: 0, ...SCREEN });
    expect(frame.scale).toBe(1);
    expect(frame.translateX).toBe(0);
    expect(frame.translateY).toBe(0);
    expect(frame.radius).toBe(0);
  });

  it('keeps the window over the tile for the whole flight, so the tile never peeks out', () => {
    const state = geometry({ tileRadius: 16 });

    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const { clip } = computeZoomFrame(state, progress);
      expect(clip.x).toBeLessThanOrEqual(state.tile!.x + 0.001);
      expect(clip.y).toBeLessThanOrEqual(state.tile!.y + 0.001);
      expect(clip.x + clip.width).toBeGreaterThanOrEqual(state.tile!.x + state.tile!.width - 0.001);
      expect(clip.y + clip.height).toBeGreaterThanOrEqual(state.tile!.y + state.tile!.height - 0.001);
    }
  });

  it('rounds the window off like the tile and squares it off on the screen', () => {
    const state = geometry({ tileRadius: 20 });

    expect(computeZoomFrame(state, 0).radius).toBe(20);
    expect(computeZoomFrame(state, 0.5).radius).toBe(10);
    expect(computeZoomFrame(state, 1).radius).toBe(0);
  });

  it('opens plainly when there is no tile to grow from', () => {
    const frame = computeZoomFrame(geometry({ tile: null }), 0);

    expect(frame.clip).toEqual({ x: 0, y: 0, ...SCREEN });
    expect(frame.scale).toBe(1);
  });
});

describe('which tile a reel may return to', () => {
  it('takes a tile that is on screen and refuses one that has scrolled away', () => {
    expect(isReturnableRect({ x: 16, y: 300, width: 370, height: 462 }, SCREEN)).toBe(true);
    expect(isReturnableRect({ x: 16, y: -400, width: 370, height: 462 }, SCREEN)).toBe(false);
    expect(isReturnableRect({ x: 16, y: SCREEN.height - 60, width: 370, height: 462 }, SCREEN)).toBe(false);
    expect(isReturnableRect({ x: 0, y: 0, width: 0, height: 0 }, SCREEN)).toBe(false);
    expect(isReturnableRect(null, SCREEN)).toBe(false);
  });
});

describe('the hand-off from a tapped tile', () => {
  const origin = {
    surfaceId: 'home',
    itemId: 'post-1',
    rect: { x: 0, y: 0, width: 10, height: 10 } as ZoomRect,
    radius: 0,
    aspectRatio: null,
    preview: { url: 'https://example.test/preview.webp', cacheKey: 'post-1', thumbhash: null },
    flightId: 1,
    recordedAt: 1_000,
  };

  it('is read by the post it belongs to, and by no other', () => {
    setPendingZoomOrigin(origin);

    expect(peekPendingZoomOrigin('post-1', 1_100)).toEqual(origin);
    expect(peekPendingZoomOrigin('post-2', 1_100)).toBeNull();
  });

  it('can be read twice, because React may render the reel twice', () => {
    setPendingZoomOrigin(origin);

    expect(peekPendingZoomOrigin('post-1', 1_100)).toEqual(origin);
    expect(peekPendingZoomOrigin('post-1', 1_100)).toEqual(origin);
  });

  it('goes stale, so a reel opened from a notification inherits nothing', () => {
    setPendingZoomOrigin(origin);

    expect(peekPendingZoomOrigin('post-1', 60_000)).toBeNull();
  });

  it('is dropped when the tile could not be measured', () => {
    setPendingZoomOrigin(origin);
    clearPendingZoomOrigin();

    expect(peekPendingZoomOrigin('post-1', 1_100)).toBeNull();
  });
});

describe('what a reel is pushed under', () => {
  const spec = {
    direction: 'open' as const,
    geometry: geometry(),
    preview: { url: 'https://example.test/preview.webp' },
    still: true,
  };

  function handOff(flightId: number) {
    setPendingZoomOrigin({
      surfaceId: 'home',
      itemId: 'post-1',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      radius: 0,
      aspectRatio: null,
      preview: spec.preview,
      flightId,
      recordedAt: 1_000,
    });
  }

  it('is a picture that already fills the screen once the tile’s flight has landed', () => {
    const flight = beginZoomFlight(spec);
    handOff(flight.id);
    landZoomFlight(flight.id);

    expect(arrivesUnderLandedZoom('post-1', 1_300)).toBe(true);
  });

  it('is not, while that flight is still growing — a push its deadline made early', () => {
    const flight = beginZoomFlight(spec);
    handOff(flight.id);

    expect(arrivesUnderLandedZoom('post-1', 1_300)).toBe(false);
  });

  it('is nothing for a reel opened with no tile, or on another post, or long after', () => {
    expect(arrivesUnderLandedZoom('post-1', 1_300)).toBe(false);

    const flight = beginZoomFlight(spec);
    handOff(flight.id);
    landZoomFlight(flight.id);

    expect(arrivesUnderLandedZoom('post-2', 1_300)).toBe(false);
    expect(arrivesUnderLandedZoom('post-1', 60_000)).toBe(false);
  });
});

describe('the picture a tile hands over', () => {
  function mediaItem(overrides: Partial<ShowcaseMediaItem> = {}): ShowcaseMediaItem {
    return {
      id: 'media-1',
      url: 'https://example.test/source.mp4',
      previewUrl: 'https://example.test/preview.webp',
      previewCacheKey: 'post-1',
      previewThumbhash: 'hash',
      mediaKind: 'video',
      contentType: null,
      originalName: null,
      width: 1080,
      height: 1920,
      durationSeconds: 6,
      sortOrder: 0,
      ...overrides,
    };
  }

  it('is the derivative the tile drew, under the key the tile drew it with', () => {
    expect(showcaseMediaZoomPreview(mediaItem())).toEqual({
      url: 'https://example.test/preview.webp',
      cacheKey: 'post-1',
      thumbhash: 'hash',
    });
  });

  it('falls back to an image tile’s own source, under that source’s key', () => {
    expect(showcaseMediaZoomPreview(mediaItem({
      mediaKind: 'image',
      previewUrl: null,
      url: 'https://example.test/original.png',
    }))).toEqual({
      url: 'https://example.test/original.png',
      cacheKey: 'post-1:source',
      thumbhash: 'hash',
    });
  });

  it('has nothing to hand over for a video with no poster yet', () => {
    expect(showcaseMediaZoomPreview(mediaItem({ previewUrl: null }))).toBeNull();
    expect(showcaseMediaZoomPreview(undefined)).toBeNull();
  });

  /**
   * A close that cannot shrink the reel itself shrinks a copy of what the reel
   * was showing: an image's larger rendition under the reel's own key, so it
   * comes from memory; a video's poster, which is the tile's picture anyway.
   */
  it('names the picture the reel itself draws, under the key the reel filed it with', () => {
    expect(showcaseViewerMediaPicture(mediaItem({
      mediaKind: 'image',
      url: 'https://example.test/original.png',
      displayUrl: 'https://example.test/display.webp',
    }))).toEqual({
      url: 'https://example.test/display.webp',
      cacheKey: 'post-1:display',
      thumbhash: 'hash',
    });
    expect(showcaseViewerMediaPicture(mediaItem())).toEqual(showcaseMediaZoomPreview(mediaItem()));
    expect(showcaseViewerMediaPicture(null)).toBeNull();
  });
});

describe('the picture held over the navigator', () => {
  const hold = {
    preview: { url: 'https://example.test/preview.webp' },
    geometry: geometry(),
  };

  it('is let go by the hold that put it there', () => {
    const token = holdZoomPicture(hold);
    expect(getHeldZoomPicture()).toEqual(hold);

    releaseZoomPicture(token);
    expect(getHeldZoomPicture()).toBeNull();
  });

  it('survives a release from an older hold, because a newer post is opening', () => {
    const first = holdZoomPicture(hold);
    const second = { ...hold, geometry: geometry({ tileRadius: 12 }) };
    holdZoomPicture(second);

    releaseZoomPicture(first);

    expect(getHeldZoomPicture()).toEqual(second);
  });
});

describe('the flight’s clock', () => {
  const SPAN = 200;
  // An eighth is exact in binary, so eight steps sum to precisely one span.
  const STEP = 25;
  const EASE = 3;

  function fly(closing: boolean) {
    const steps: ReturnType<typeof advanceZoomFlight>[] = [];
    let time = closing ? 1 : 0;
    for (let i = 0; i < 50; i += 1) {
      const step = advanceZoomFlight(time, closing, STEP, SPAN, EASE);
      steps.push(step);
      time = step.time;
      if (step.done) break;
    }
    return steps;
  }

  it('opens from the tile to the screen in exactly the frames its span allows', () => {
    const steps = fly(false);

    expect(steps).toHaveLength(SPAN / STEP);
    expect(steps.at(-1)).toMatchObject({ time: 1, progress: 1, done: true });
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].progress).toBeGreaterThan(steps[i - 1].progress);
    }
  });

  it('is quickest at the start and settles into the landing', () => {
    const steps = fly(false);
    const first = steps[0].progress;
    const last = steps.at(-1)!.progress - steps.at(-2)!.progress;

    expect(first).toBeGreaterThan(last * 10);
  });

  it('closes from the screen back to the tile the same way', () => {
    const steps = fly(true);

    expect(steps).toHaveLength(SPAN / STEP);
    expect(steps.at(-1)).toMatchObject({ time: 0, progress: 0, done: true });
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i].progress).toBeLessThan(steps[i - 1].progress);
    }
  });

  it('pauses rather than skips when a frame is late, because the caller caps the step', () => {
    const late = advanceZoomFlight(0, false, 34, SPAN, EASE);
    const onTime = advanceZoomFlight(0, false, 16, SPAN, EASE);

    expect(late.progress).toBeLessThan(0.5);
    expect(late.progress).toBeGreaterThan(onTime.progress);
  });

  /**
   * A close that begins while the open is still in the air must carry on from
   * where the window is. The open's clock runs one way and the close's the
   * other, so the close is given the clock that puts its first frame next to
   * the open's last, instead of at the far end of the journey.
   */
  it('lets a close cut an open short without the window jumping', () => {
    const open = fly(false)[2]; // three frames in, well short of the screen
    const closeTime = reverseZoomFlightTime(open.progress, EASE);

    // Standing still on the close's clock is exactly where the open left the window.
    expect(advanceZoomFlight(closeTime, true, 0, SPAN, EASE).progress).toBeCloseTo(open.progress, 10);
    // And its first frame moves back from there by one frame's worth.
    const firstCloseFrame = advanceZoomFlight(closeTime, true, STEP, SPAN, EASE);
    expect(firstCloseFrame.progress).toBeLessThan(open.progress);
    expect(open.progress - firstCloseFrame.progress).toBeLessThan(0.3);
    // Whereas a close that simply kept the open's clock would leap most of the way.
    const naive = advanceZoomFlight(open.time, true, STEP, SPAN, EASE);
    expect(open.progress - naive.progress).toBeGreaterThan(0.5);
  });

  it('starts a close from a landed open at the screen, and from nothing at the tile', () => {
    expect(reverseZoomFlightTime(1, EASE)).toBe(1);
    expect(reverseZoomFlightTime(0, EASE)).toBe(0);
    expect(reverseZoomFlightTime(1.5, EASE)).toBe(1);
  });
});

describe('the flight itself', () => {
  const spec = {
    direction: 'open' as const,
    geometry: geometry(),
    preview: { url: 'https://example.test/preview.webp' },
    still: true,
  };

  it('is begun by the tile, seen once its picture is drawn, and landed once', () => {
    const events: ZoomFlightEvent['type'][] = [];
    subscribeToZoomFlights((event) => events.push(event.type));

    const flight = beginZoomFlight(spec);
    expect(getZoomFlight()).toEqual({ ...flight, displayed: false });

    // The picture and the deadline that stands in for it both report; one counts.
    markZoomFlightDisplayed(flight.id);
    markZoomFlightDisplayed(flight.id);
    expect(getZoomFlight()?.displayed).toBe(true);

    expect(landZoomFlight(flight.id)).toMatchObject({ id: flight.id, displayed: true });
    expect(getZoomFlight()).toBeNull();
    expect(landZoomFlight(flight.id)).toBeNull();

    expect(events).toEqual(['begin', 'displayed', 'landed']);
  });

  it('is superseded by the next tap, whose flight the old one can neither move nor end', () => {
    const first = beginZoomFlight(spec);
    const second = beginZoomFlight({ ...spec, direction: 'close' });

    markZoomFlightDisplayed(first.id);
    expect(getZoomFlight()?.displayed).toBe(false);
    expect(landZoomFlight(first.id)).toBeNull();
    expect(getZoomFlight()).toMatchObject({ id: second.id });
    expect(second.id).toBeGreaterThan(first.id);
  });

  it('stops reporting to a listener that has left', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToZoomFlights(listener);
    unsubscribe();

    beginZoomFlight(spec);

    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * The reader tapping a tile again while the post they tapped is still on its
 * way — the picture still growing, the reel still being built underneath it —
 * used to start the whole movement over, fly the poster in place of the video
 * the first tap had lent, and push a second reel on top of the first.
 */
describe('one open at a time', () => {
  const NOW = 1_000_000;

  it('is begun by a tap, and holds every other tile off until it ends', () => {
    const open = beginTileOpen(NOW);

    expect(open).not.toBeNull();
    expect(canOpenFromTile(NOW)).toBe(false);
    expect(beginTileOpen(NOW)).toBeNull();

    endTileOpen(open);

    expect(canOpenFromTile(NOW)).toBe(true);
    expect(beginTileOpen(NOW)).not.toBeNull();
  });

  it('opens nothing while a flight is in the air, in either direction', () => {
    const flight = beginZoomFlight({
      direction: 'open',
      geometry: geometry(),
      preview: { url: 'https://example.test/preview.webp' },
      still: true,
    });

    expect(canOpenFromTile(NOW)).toBe(false);
    expect(beginTileOpen(NOW)).toBeNull();

    // A close is the reel shrinking back into its tile: the same rule holds.
    beginZoomFlight({ direction: 'close', geometry: geometry(), preview: null, still: false });
    expect(beginTileOpen(NOW)).toBeNull();

    landZoomFlight(flight.id + 1);

    expect(canOpenFromTile(NOW)).toBe(true);
  });

  it('lets go after its hold when no reel ever takes it over', () => {
    beginTileOpen(NOW, 600);

    expect(canOpenFromTile(NOW + 599)).toBe(false);
    expect(canOpenFromTile(NOW + 600)).toBe(true);
    expect(beginTileOpen(NOW + 600)).not.toBeNull();
  });

  it('is held for as long as the reel that took it over needs, however slow', () => {
    const open = beginTileOpen(NOW, 600);
    const claimed = claimTileOpen(NOW + 100);

    expect(claimed).toBe(open);
    // Well past the hold: the reel on screen is what ends it now, not the clock.
    expect(canOpenFromTile(NOW + 60_000)).toBe(false);

    endTileOpen(claimed);

    expect(canOpenFromTile(NOW + 60_000)).toBe(true);
  });

  it('cannot be taken over once its hold has run out, and is dropped instead', () => {
    beginTileOpen(NOW, 600);

    expect(claimTileOpen(NOW + 600)).toBeNull();
    expect(canOpenFromTile(NOW + 600)).toBe(true);
  });

  it('is taken over by one reel only, and ended by that one alone', () => {
    const open = beginTileOpen(NOW);

    expect(claimTileOpen(NOW)).toBe(open);
    expect(claimTileOpen(NOW)).toBeNull();

    // A later reel ending an open of its own leaves this one alone.
    endTileOpen(open! + 1);

    expect(canOpenFromTile(NOW)).toBe(false);
  });

  it('is forgotten on reset, which never reuses a serial a settle timer still holds', () => {
    const open = beginTileOpen(NOW);
    resetMediaZoomTransitions();

    expect(canOpenFromTile(NOW)).toBe(true);
    const next = beginTileOpen(NOW);
    expect(next).not.toBe(open);

    // The first open's own release, arriving late, must not end this one.
    endTileOpen(open);
    expect(canOpenFromTile(NOW)).toBe(false);
  });
});

describe('the register of tiles', () => {
  it('finds a tile by surface and post, and forgets it when it unmounts', () => {
    const tile = handle();
    const unregister = registerZoomSource('home', 'post-1', tile);

    expect(getZoomSource('home', 'post-1')).toBe(tile);
    expect(getZoomSource('explore', 'post-1')).toBeNull();

    unregister();
    expect(getZoomSource('home', 'post-1')).toBeNull();
  });

  it('hands a recycled cell the hidden state of the post it now shows', () => {
    const first = vi.fn();
    registerZoomSource('home', 'post-1', handle({ setHidden: first }));
    setZoomSourceHidden('home', 'post-1', true);
    expect(first).toHaveBeenLastCalledWith(true);

    const recycled = vi.fn();
    registerZoomSource('home', 'post-1', handle({ setHidden: recycled }));
    expect(recycled).toHaveBeenCalledWith(true);

    const other = vi.fn();
    registerZoomSource('home', 'post-2', handle({ setHidden: other }));
    expect(other).toHaveBeenCalledWith(false);
  });

  it('shows every held tile again when the reel lets go', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerZoomSource('home', 'post-1', handle({ setHidden: first }));
    registerZoomSource('home', 'post-2', handle({ setHidden: second }));
    setZoomSourceHidden('home', 'post-1', true);
    setZoomSourceHidden('home', 'post-2', true);

    clearHiddenZoomSources();

    expect(first).toHaveBeenLastCalledWith(false);
    expect(second).toHaveBeenLastCalledWith(false);
  });

  it('does not unregister a handle that has already been replaced', () => {
    const first = handle();
    const unregisterFirst = registerZoomSource('home', 'post-1', first);
    const second = handle();
    registerZoomSource('home', 'post-1', second);

    unregisterFirst();

    expect(getZoomSource('home', 'post-1')).toBe(second);
  });
});
