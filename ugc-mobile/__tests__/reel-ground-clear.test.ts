import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...path: string[]) => readFileSync(join(__dirname, '..', ...path), 'utf8');
const viewer = read('app', 'viewer.tsx');
const zoom = read('components', 'media-zoom.tsx');
const layout = read('app', '_layout.tsx');
const transition = read('lib', 'media-zoom-transition.ts');
const flightViews = read('components', 'reel-close-flight.ios.tsx');
const appleZoom = read('components', 'apple-zoom.ios.tsx');
const morph = read('components', 'reel-close-morph.tsx');

// Android shrinks the picture alone into its tile (owner, 2026-11-07: "a shadow
// appearing around the pic and that then shrinks"), filmed on the Pixel 9a
// emulator. On iOS 18, UIKit's zoom grows and shrinks the reel's page (filmed
// beside Instagram's on the owner's iPhone 16e, 2026-11-08). The page is clear
// behind its media there too, over the stage's one black ground, which fades
// with the chrome as a close goes on (components/reel-close-morph.tsx): left
// black, the page hung outside the tile it shrank into and faded there, over
// the feed (owner's recording, 2026-11-10).
describe('the reel\'s ground as it grows out of its tile and shrinks back', () => {
  it('iOS: clear under UIKit\'s zoom, over the stage\'s ground; black as it was where there is no zoom', () => {
    expect(viewer).toMatch(/const groundClear = Platform\.OS === 'ios'\n\s+\? isAppleZoomAvailable\(\)\n/);
    expect(viewer).not.toContain('setClosingSelf');
  });

  it('iOS: the stage\'s ground and the chrome fade as a close cuts the page down', () => {
    expect(viewer).toContain('closeMorph: closeMorph.progress,');
    expect(zoom).toMatch(/const groundStyle = useAnimatedStyle\(\(\) => \(\{\n\s+opacity: following\.value\n\s+\? [^\n]+\n\s+: 1 - morph\.value,/);
    expect(zoom).toContain('if (!following.value) return { opacity: 1 - morph.value };');
  });

  it('Android: always clear, over the stage\'s own ground, which is its black at rest and fades as a shrink runs', () => {
    expect(viewer).toMatch(/: true;\n/);
    expect(zoom).toContain("style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, stage.groundStyle]}");
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
    expect(zoom).toMatch(/<AppleZoomSource identifier=\{source\.appleZoomId\} [^>]*>\s*<AppleZoomReturnPictureView identifier=\{source\.appleZoomId\} returnPicture=\{source\.returnPicture\} radius=\{radius\} \/>\s*<\/AppleZoomSource>/);
    expect(zoom).toMatch(/<AppleZoomSource identifier=\{appleZoomOpenSourceId\(source\.appleZoomId\)\} [^>]*pageShaped=\{pageFrame !== null\}>\s*<View\s+pointerEvents="none"/);
    // The tile's own view, the one it measures, is not inside an AppleZoomSource.
    expect(zoom).toMatch(/<Animated\.View collapsable=\{false\} style=\{\[ZOOM_SOURCE_FILL, style, source\.hiddenStyle\]\}>\s*<View\s+ref=\{source\.ref\}/);
  });

  // The reel's own Back pops a snapshot of the page, so the page is cut down
  // before the pop is asked for.
  it('iOS: the reel\'s own Back cuts the page down, then pops', () => {
    expect(zoom).toMatch(/const wait = beforeNativeCloseRef\.current\?\.\(\) \?\? 0;\n\s+if \(wait > 0\) setTimeout\(leave, wait\);\n\s+else leave\(\);/);
    expect(viewer).toContain('pictureReturns && startReelCloseMorph(closeMorph, zoomSurfaceId, activeItemId) ? REEL_CLOSE_MORPH_DRAWN_MS : 0');
  });

  it('iOS: a still picture is drawn inside the clip that trims it to its tile\'s part', () => {
    expect(viewer).toMatch(/<ReelCloseMorphClip width=\{width\} height=\{height\} aspectRatio=\{mediaAspectRatio\}>\s+<FeedMediaFrame\s+kind="image"/);
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

// The bar's Back on a still picture (owner, 2026-11-10: "can you build it"):
// the picture leaves the page in the frame the finger lifts and flies home by
// itself (lib/reel-close-flight.ts). What it looks like is filmed; this is
// that its pieces are where they have to be for it to happen in that frame.
describe('iOS: a picture flies home itself when the bar\'s Back is pressed', () => {
  it('reads the press above the navigator, and draws the flight above it too', () => {
    expect(layout).toMatch(/<ReelCloseFlightTouches>\s+<View style=\{\{ flex: 1, backgroundColor: theme\.colors\.app \}\} \{\.\.\.nativeMenuTouchGuardProps\}>/);
    const stack = layout.indexOf('<Stack\n');
    const layer = layout.indexOf('<ReelCloseFlightLayer />');
    expect(stack).toBeGreaterThan(0);
    expect(layer).toBeGreaterThan(stack);
    expect(layout.indexOf('</ReelCloseFlightTouches>')).toBeGreaterThan(layer);
  });

  // The button is UIKit's: it gets the lift only once this has let go of it,
  // and by then the picture has to be off the page.
  it('takes off on the lift, then gives the touch to the button; claims nothing', () => {
    expect(flightViews).toContain('.cancelsTouchesInView(false)');
    expect(flightViews).toContain('.enabled(armed)');
    const up = flightViews.slice(flightViews.indexOf('.onTouchesUp('), flightViews.indexOf('.onTouchesCancelled('));
    expect(up.indexOf('takeOffReelCloseFlight()')).toBeGreaterThan(0);
    expect(up.indexOf('manager.fail()')).toBeGreaterThan(up.indexOf('takeOffReelCloseFlight()'));
    // A touch that does not begin on the button is let go of as it begins.
    const down = flightViews.slice(flightViews.indexOf('.onTouchesDown('), flightViews.indexOf('.onTouchesMove('));
    expect(down).toMatch(/!isInReelBackRegion\(plan\.back, touch\.absoluteX, touch\.absoluteY\)\) \{\n\s+manager\.fail\(\);/);
  });

  // A screen pushed over the reel (a creator's page) draws its own Back where
  // the reel's is, and so can a sheet over it: armed under either, a press
  // there flew the reel's picture over that screen (review of #755).
  it('only under the bar\'s Back, on the picture its tile holds, while the reel is the screen in front with nothing over it', () => {
    expect(viewer).toContain('enabled: barBack && pictureReturns && !detailsOpenForActive && isFocused && !overlayOpenItemId,');
    expect(viewer).toContain('back: reelBackButtonRegion(insets.top),');
    expect(viewer).toMatch(/\{onScreen \? <ReelCloseFlightArm postId=\{postId\} picture=\{image\} aspectRatio=\{mediaAspectRatio\} width=\{width\} height=\{height\} \/> : null\}/);
    expect(flightViews).toContain('() => wanted && isAppleZoomReturnPictureHeld(surfaceId, postId)');
  });

  it('hides the page from the frame its picture takes off', () => {
    expect(viewer).toContain('closeFlightId,');
    expect(zoom).toContain('if (closeFlightId !== 0 && reelCloseFlightHides.value === closeFlightId) return { opacity: 0 };');
    expect(viewer).toContain('useEffect(() => () => forgetReelCloseFlight(closeFlightId), [closeFlightId]);');
  });

  // UIKit draws a ground of its own behind the emptied page, in a window that
  // closes in on the view it shrinks the page into: a dark box over the feed.
  it('keeps UIKit\'s own ground from closing in on the tile', () => {
    expect(appleZoom).toContain('transform: [{ scale: identifier !== null && reelCloseFlightSource.value === identifier ? FLOWN_SOURCE_SCALE : 1 }],');
    expect(appleZoom).toMatch(/<AnimatedImage[\s\S]+?flownStyle\]\}/);
  });

  // A tile can sit partly under the tab bar, which the flight is drawn over.
  it('stops the picture at the tab bar on the tab screens', () => {
    // Worked out beside the screen's metrics, not in its JSX: there React Compiler
    // skipped the whole screen (`compiled-screens.test.ts`).
    const explore = read('app', '(tabs)', 'showcase.tsx');
    expect(explore).toContain('const tabBarCover = magicTabBarCover(width, bottomInset);');
    expect(explore).toContain('<MediaZoomSurface bottomBar={tabBarCover}>');
    expect(read('components', 'home-dashboard.tsx')).toContain('<MediaZoomSurface bottomBar={magicTabBarCover(width, bottomInset)}>');
    const profile = read('components', 'profile-dashboard.tsx');
    expect(profile).toContain('<MediaZoomSurface revealItem={revealItem} bottomBar={bottomBar}>');
    expect(profile.match(/bottomBar=\{magicTabBarCover\(width, bottomInset\)\}/g)).toHaveLength(2);
    expect(zoom).toContain('() => noteAppleZoomSurfaceBottomBar(surfaceId, { height: barHeight, capWidth: barCapWidth, capHeight: barCapHeight }),');
    expect(flightViews).toContain('...reelCloseFlightFloor(from, rect, screen, bar),');
    // The picture is not drawn over the bar, nor over the button standing up out of it.
    expect(flightViews).toContain('return { bottom: held.floor + held.cap };');
    // And a tile it covers all the way stays in sight under it.
    expect(flightViews).toContain('hidden: !reelCloseFlightCoversTile(from, rect, height, bar.height)');
  });

  it('leaves the page alone when the navigator reports that pop', () => {
    const leaving = morph.indexOf('if (leaving && navigation.isFocused()) {');
    expect(morph.slice(leaving, leaving + 400)).toContain('if (confirmReelCloseFlight(reelId)) return;');
    expect(viewer).toContain('<ReelCloseMorphCue morph={closeMorph} reelId={closeFlightId} surfaceId={zoomSurfaceId}');
  });
});
