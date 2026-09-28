import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The black a screen is covered in while UIKit's zoom grows a reel out of one
 * of its tiles or shrinks it back (lib/zoom-veil.ts): what puts it up, what
 * takes it down, and the deadline for a veil no reel ever claims.
 */
vi.mock('../lib/apple-zoom-available', () => ({ isAppleZoomAvailable: () => available }));
let available = true;

import {
  claimZoomVeil,
  clearZoomVeil,
  closeZoomVeilHole,
  dropZoomVeil,
  holdZoomVeil,
  liftZoomVeil,
  resetZoomVeil,
  releaseZoomVeil,
  ZOOM_VEIL_DEADLINE_MS,
  zoomVeil,
  zoomVeilHole,
} from '../lib/zoom-veil';
import { bindNativeZoomVeil, getNativeZoomVeilOpacity } from '../lib/native-zoom-veil';

const TILE = { x: 16, y: 300, width: 370, height: 460 };

afterEach(() => {
  resetZoomVeil();
  available = true;
  vi.useRealTimers();
});

describe('the veil under the zoom', () => {
  it('waits for native opening progress instead of blacking out the feed while the route mounts', () => {
    dropZoomVeil(TILE);
    expect(getNativeZoomVeilOpacity()).toBe(0);
    const opacity = {} as Parameters<typeof bindNativeZoomVeil>[0];
    const unbind = bindNativeZoomVeil(opacity);
    expect(getNativeZoomVeilOpacity()).toBe(opacity);
    unbind();
  });

  it('lets the Back fade finish after React unmounts the viewer', () => {
    vi.useFakeTimers();
    dropZoomVeil(TILE);
    claimZoomVeil();
    liftZoomVeil();
    const set = vi.spyOn(zoomVeil, 'set');
    releaseZoomVeil();
    expect(set).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(set).toHaveBeenCalledWith(0);
    set.mockRestore();
  });

  it('goes up around the tile at the tap, covers it once the push begins, and comes down as the close begins', () => {
    vi.useFakeTimers();
    dropZoomVeil(TILE);
    // The test double resolves every timing at once.
    expect(zoomVeil.get()).toBe(1);
    expect(zoomVeilHole.get()).toEqual(TILE);
    claimZoomVeil();
    closeZoomVeilHole();
    expect(zoomVeilHole.get()).toBeNull();
    vi.advanceTimersByTime(ZOOM_VEIL_DEADLINE_MS + 1);
    expect(zoomVeil.get()).toBe(1);
    liftZoomVeil();
    expect(zoomVeil.get()).toBe(0);
  });

  it('comes down by itself when no reel claims it', () => {
    vi.useFakeTimers();
    dropZoomVeil(TILE);
    vi.advanceTimersByTime(ZOOM_VEIL_DEADLINE_MS - 1);
    expect(zoomVeil.get()).toBe(1);
    vi.advanceTimersByTime(1);
    expect(zoomVeil.get()).toBe(0);
    expect(zoomVeilHole.get()).toBeNull();
  });

  it('goes back up, whole, when a close is let go of, and clears when the reel has gone', () => {
    dropZoomVeil(TILE);
    claimZoomVeil();
    liftZoomVeil();
    holdZoomVeil();
    expect(zoomVeil.get()).toBe(1);
    expect(zoomVeilHole.get()).toBeNull();
    clearZoomVeil();
    expect(zoomVeil.get()).toBe(0);
  });

  it('does nothing where the zoom does not run', () => {
    available = false;
    dropZoomVeil(TILE);
    holdZoomVeil();
    expect(zoomVeil.get()).toBe(0);
    expect(zoomVeilHole.get()).toBeNull();
  });
});
