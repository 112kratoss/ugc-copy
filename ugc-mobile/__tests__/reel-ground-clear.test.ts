import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...path: string[]) => readFileSync(join(__dirname, '..', ...path), 'utf8');
const viewer = read('app', 'viewer.tsx');
const zoom = read('components', 'media-zoom.tsx');
const layout = read('app', '_layout.tsx');
const transition = read('lib', 'media-zoom-transition.ts');

// Android shrinks the picture alone into its tile (owner, 2026-11-07: "a shadow
// appearing around the pic and that then shrinks"), filmed on the Pixel 9a
// emulator. On iOS 18, UIKit's zoom grows and shrinks the reel's page, black and
// all, as Instagram's post viewer does (filmed side by side on the owner's
// iPhone 16e, 2026-11-08): clear behind its media, the page showed UIKit's own
// ground in its bands, white in the light scheme and a black slab in the dark.
describe('the reel\'s ground as it grows out of its tile and shrinks back', () => {
  it('iOS: keeps its black, as Instagram\'s page does', () => {
    expect(viewer).toMatch(/const groundClear = Platform\.OS === 'ios'\n\s+\? false\n/);
    expect(viewer).not.toContain('setClosingSelf');
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

  // UIKit resizes the view it grows or shrinks the reel with to the window, and
  // React Native content keeps its own frames: given the tile, the tile's
  // picture dropped and a copy of the card rode over the growing reel. It is
  // given two views beside the tile instead: an empty page-shaped one for
  // opens, and one in the tile's own shape for closes, which draws the tile's
  // picture while a reel showing that picture is up and nothing otherwise
  // (2026-11-10, lib/apple-zoom-surface.ts).
  it('iOS: UIKit zooms two views beside the tile, never the tile itself', () => {
    expect(zoom).toMatch(/<AppleZoomSource identifier=\{source\.appleZoomId\} [^>]*>\s*<AppleZoomReturnPictureView returnPicture=\{source\.returnPicture\} radius=\{radius\} \/>\s*<\/AppleZoomSource>/);
    expect(zoom).toMatch(/<AppleZoomSource identifier=\{appleZoomOpenSourceId\(source\.appleZoomId\)\} [^>]*pageShaped=\{pageFrame !== null\}>\s*<View\s+pointerEvents="none"/);
    // The tile's own view, the one it measures, is not inside an AppleZoomSource.
    expect(zoom).toMatch(/<Animated\.View collapsable=\{false\} style=\{\[ZOOM_SOURCE_FILL, style, source\.hiddenStyle\]\}>\s*<View\s+ref=\{source\.ref\}/);
  });

  // Instagram keeps the rail and caption on the page as it shrinks under the
  // finger (filmed 2026-11-08); they go with it in UIKit's crossfade.
  it('iOS: the chrome stays on the page a gesture close shrinks', () => {
    expect(zoom).toContain('if (!following.value) return { opacity: 1 };');
    expect(zoom).not.toContain('nativeCloseChrome');
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
    expect(viewer).toContain('const flownBack = IOS_BACK_FLIES_PICTURE && Boolean(nativeZoomSourceId) && !onEndSlide && closesPictureAlone({');
  });

  // Filmed beside Instagram on the owner's iPhone 16e, 2026-11-08: its Back
  // shrinks the whole page into the tile from the frame after the press.
  it('iOS: Back leaves the close to UIKit\'s zoom, as Instagram\'s Back does', () => {
    expect(transition).toContain('export const IOS_BACK_FLIES_PICTURE = false;');
    expect(zoom).toContain('if (nativeZoom && (!IOS_BACK_FLIES_PICTURE || !pictureOnly)) {');
  });
});
