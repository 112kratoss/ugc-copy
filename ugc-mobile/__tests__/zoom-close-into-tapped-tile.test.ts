import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { zoomCloseItemId } from '../lib/media-zoom-transition';

const read = (name: string) => readFileSync(path.join(__dirname, '..', name), 'utf8');
const flat = (code: string) => code.replace(/\s+/g, ' ');

// Owner, 2026-11-28: "imagine we swipe to 10 media and then press back it goes
// back to the initial media", Instagram's close as filmed on their iPhone on
// 2026-09-17. Until then Back went into the tile of the post on screen: after
// five swipes the iOS reel flew off the bottom of the screen into a tile below
// the grid, and the Android reel faded out with no tile at all (emulator and
// simulator films, archive/close-into-tapped-tile-2026-11-28/).
describe('the tile a close lands in', () => {
  it('is the tapped one, however many posts the reader has moved through', () => {
    expect(zoomCloseItemId('tapped', 'tapped', true)).toBe('tapped');
    expect(zoomCloseItemId('tapped', 'fifth-post', true)).toBe('tapped');
    // On the reel's end slide no post is on screen; the tapped tile still takes the close.
    expect(zoomCloseItemId('tapped', null, true)).toBe('tapped');
  });

  it('is the post on screen once the tapped one has gone, or for a reel that came out of no tile', () => {
    // A hide or a block made from the reel took the tapped post away.
    expect(zoomCloseItemId('tapped', 'fifth-post', false)).toBe('fifth-post');
    expect(zoomCloseItemId(null, 'fifth-post', false)).toBe('fifth-post');
    expect(zoomCloseItemId(undefined, 'fifth-post', true)).toBe('fifth-post');
  });

  it('is what the Android close measures, hides and flies into', () => {
    const zoom = read('components/media-zoom.tsx');
    const dismiss = flat(zoom.slice(zoom.indexOf('const dismiss = useCallback'), zoom.indexOf('// Back was pressed after this reel was pushed')));
    // Asked of the tile registry: the tapped tile is there while it is mounted.
    expect(dismiss).toContain('const closeItemId = zoomCloseItemId( origin?.itemId, activeItemRef.current, Boolean(origin && getZoomSource(origin.surfaceId, origin.itemId)) ) ?? activeItemRef.current;');
    expect(dismiss).toContain('const handle = getZoomSource(origin.surfaceId, closeItemId);');
    expect(dismiss).toContain('hideZoomSourceUntilLanding(origin.surfaceId, closeItemId);');
    expect(dismiss).not.toContain('getZoomSource(origin.surfaceId, activeItemRef.current)');
    // Another post's picture never flies alone into the tapped tile, which shows
    // its own: the reel shrinks whole and dissolves into the tile as it lands.
    expect(dismiss).toContain('const intoAnotherPost = closeItemId !== activeItemRef.current;');
    expect(dismiss).toContain('const pictureOnly = !intoAnotherPost && closesPictureAlone(');
    expect(dismiss).toContain('const dissolves = live && (intoAnotherPost || (Boolean(activeVideoUrlRef.current) && !returnableVideo()));');
  });

  it('is what the iOS zoom is pointed at, from the post the push came out of', () => {
    const viewer = flat(read('app/viewer.tsx'));
    expect(viewer).toContain('const [zoomOriginItemId] = useState(() => parseAppleZoomSourceId(nativeZoomSourceId)?.itemId ?? null);');
    expect(viewer).toContain('const zoomOriginInReel = Boolean(zoomOriginItemId) && items.some((item) => item.id === zoomOriginItemId);');
    expect(viewer).toContain('const zoomCloseId = zoomCloseItemId(zoomOriginItemId, activeItem?.id ?? null, zoomOriginInReel);');
    expect(viewer).toContain('useAppleZoomRetarget(zoomCloseId, pictureReturns);');
    expect(viewer).not.toContain('useAppleZoomRetarget(activeItem?.id');
    // The tapped tile holds its picture for the close: on its own post while the reel shows the same
    // still picture, and on any other post, so UIKit crossfades the page into it all the way down
    // rather than fading it out at two-thirds of its size (lib/apple-zoom-surface.ts).
    expect(viewer).toContain('const onCloseTilesPost = zoomCloseId === (activeItem?.id ?? null);');
    expect(viewer).toContain('const pictureReturns = !reducedMotion && Boolean(zoomCloseId) && (onCloseTilesPost ? !onEndSlide && activeMedia.cover && Boolean(activeMedia.picture) && !activeMedia.playbackUrl : true);');
    // And the cue that lets that picture go at the landing follows the same tile.
    expect(viewer).toContain('<AppleZoomReturnLandingCue surfaceId={zoomSurfaceId} itemId={zoomCloseId} touches={reelTouches} />');
  });

  it('is the only tile an iOS close hands a player back to', () => {
    const zoom = flat(read('components/media-zoom.tsx'));
    const returnable = zoom.slice(zoom.indexOf('const returnableVideo = useCallback'), zoom.indexOf('// Under iOS\'s own zoom the reel is the thing on screen'));
    expect(returnable).toContain('&& zoomCloseItemId(origin.itemId, itemId, Boolean(getZoomSource(origin.surfaceId, origin.itemId))) === itemId');
  });
});
