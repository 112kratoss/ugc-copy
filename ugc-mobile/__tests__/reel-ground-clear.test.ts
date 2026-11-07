import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...path: string[]) => readFileSync(join(__dirname, '..', ...path), 'utf8');
const viewer = read('app', 'viewer.tsx');
const zoom = read('components', 'media-zoom.tsx');
const layout = read('app', '_layout.tsx');

// A close shrinks the picture alone into its tile (owner, 2026-11-07: "a shadow
// appearing around the pic and that then shrinks"). Filmed frame by frame on the
// iPhone 17 Pro simulator and the Pixel 9a emulator.
describe('a reel closing into its tile shrinks only its picture', () => {
  // And as it grows out of its tile: black, the reel's page came up as a
  // see-through dark panel round the growing picture over a feed the veil had
  // not yet darkened (simulator, 2026-11-07).
  it('iOS: clear behind the media while it grows out of its tile and is in front, and through its own close', () => {
    expect(viewer).toContain("? Boolean(nativeZoomSourceId) && !reducedMotion && (closingSelf || (isFocused && (pushLanded || !arrived)))");
    // Its own close, as against a page pushed over it: only its own begins while it is focused.
    expect(viewer).toContain("if ((reelNavigation as unknown as { isFocused: () => boolean }).isFocused()) setClosingSelf(true);");
    // A page popped off it keeps it black until that pop has landed; the first push only once.
    expect(viewer).toMatch(/if \(event\.data\?\.closing === false\) \{\n\s+setPushLanded\(true\);\n\s+setArrived\(true\);/);
  });

  it('Android: always clear, over the stage\'s own ground, which is its black at rest and fades as a shrink runs', () => {
    expect(viewer).toMatch(/: true;\n/);
    expect(zoom).toContain("backgroundColor: groundClear && Platform.OS === 'ios' ? 'transparent' : '#000'");
  });

  it('clears every layer behind the media, the window and the screen included', () => {
    expect(viewer.match(/backgroundColor: ground \}/g)?.length).toBeGreaterThanOrEqual(6);
    expect(viewer).not.toMatch(/style=\{\{ width, height, backgroundColor: '#000' \}\}/);
    expect(viewer).toContain('<MediaZoomStage stage={zoom} screen={{ width, height }} groundClear={groundClear}>');
    expect(zoom).toContain("overflow: 'hidden', backgroundColor: groundClear ? 'transparent' : '#000' }");
    // A native screen took no new background once mounted, so it is clear for good.
    expect(layout).toContain("contentStyle: { backgroundColor: 'transparent' },");
  });

  it('draws no letterbox bands or solid backdrop around the picture while clear', () => {
    expect(viewer).toContain('const letterboxBands = mediaAspectRatio && !groundClear ? (');
    expect(viewer.match(/imageBackdrop=\{groundClear \? 'none' : 'solid'\}/g)).toHaveLength(2);
  });

  // UIKit resizes its source view to the window as it grows or shrinks it. The
  // tile is no longer that view: a stand-in of the picture alone is, whose
  // image view follows its bounds, and the tile's own view has no ground.
  it('iOS: the view UIKit resizes to the window is the picture alone, and the tile has no ground', () => {
    expect(zoom).toMatch(/<AppleZoomSource [^>]*>\s*<ZoomStandInImage/);
    expect(zoom).toContain("zoomed ? { borderRadius: radius, borderCurve: 'continuous', overflow: 'hidden' } : null,");
  });

  it('iOS: the chrome goes on the UI thread as the close begins, and comes back if it is let go of', () => {
    expect(zoom).toContain('if (!following.value) return { opacity: nativeCloseChrome.value };');
    expect(zoom).toContain('nativeCloseChrome.set(0);');
    expect(zoom.match(/nativeCloseChrome\.set\(withTiming\(1, \{ duration: NATIVE_CLOSE_CHROME_MS \}\)\)/g)).toHaveLength(2);
  });
});

describe('a picture closing alone', () => {
  it('starts where it sits: its clock is set after the flight has begun, which reverses from the progress it reads back', () => {
    const start = zoom.indexOf("const flight = startZoomFlight({ direction: 'close'");
    const reset = zoom.indexOf('flightTime.set(1);\n        flightProgress.set(1);');
    expect(start).toBeGreaterThan(0);
    expect(reset).toBeGreaterThan(start);
  });

  it('flies nothing from the end slide, which shows no media', () => {
    expect(viewer).toContain('activePicture: onEndSlide ? null : activeMedia.picture,');
    expect(viewer).toContain('const flownBack = Boolean(nativeZoomSourceId) && !onEndSlide && closesPictureAlone({');
  });
});
