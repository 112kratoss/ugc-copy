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
  it('iOS: clear behind the media once the zoom push is over and the reel is in front, and through its own close', () => {
    expect(viewer).toContain("? Boolean(nativeZoomSourceId) && !reducedMotion && (closingSelf || (pushLanded && isFocused))");
    // Its own close, as against a page pushed over it: only its own begins while it is focused.
    expect(viewer).toContain("if ((reelNavigation as unknown as { isFocused: () => boolean }).isFocused()) setClosingSelf(true);");
    expect(viewer).toContain("if (event.data?.closing === false) setPushLanded(true);");
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

  it('iOS: the tile UIKit resizes to the window has no ground of its own', () => {
    expect(zoom).toMatch(/source\.appleZoomId \? \{\n\s+backgroundColor: 'transparent',/);
  });

  it('iOS: the chrome goes on the UI thread as the close begins, and comes back if it is let go of', () => {
    expect(zoom).toContain('if (!following.value) return { opacity: nativeCloseChrome.value };');
    expect(zoom).toContain('nativeCloseChrome.set(0);');
    expect(zoom.match(/nativeCloseChrome\.set\(withTiming\(1, \{ duration: NATIVE_CLOSE_CHROME_MS \}\)\)/g)).toHaveLength(2);
  });
});
