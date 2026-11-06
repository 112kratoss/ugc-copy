import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (...path: string[]) => readFileSync(join(__dirname, '..', ...path), 'utf8');
const viewer = read('app', 'viewer.tsx');
const zoom = read('components', 'media-zoom.tsx');

// iOS: UIKit's zoom shrinks the whole reel, so black around a picture that did
// not fill the screen shrank with it as a dark panel (owner, 2026-11-07). A reel
// zoomed out of a tile is clear behind its media once landed.
describe('the reel is clear behind its media under UIKit\'s zoom', () => {
  it('goes clear on iOS for a zoomed reel, from landing or once a close begins', () => {
    expect(viewer).toContain("const groundClear = Platform.OS === 'ios' && Boolean(nativeZoomSourceId) && (zoom.landed || leaving);");
    expect(viewer).toContain("const ground = groundClear ? 'transparent' : REEL_GROUND;");
  });

  it('clears every layer behind the media, the screen\'s own included', () => {
    // The screen root, the vertical list, each slide, its horizontal list, each page and the video page.
    expect(viewer.match(/backgroundColor: ground \}/g)?.length).toBeGreaterThanOrEqual(6);
    expect(viewer).not.toMatch(/style=\{\{ width, height, backgroundColor: '#000' \}\}/);
    expect(viewer).toContain("...(groundClear ? { contentStyle: { backgroundColor: 'transparent' } } : null),");
    expect(viewer).toContain('<MediaZoomStage stage={zoom} screen={{ width, height }} groundClear={groundClear}>');
    expect(zoom).toContain("backgroundColor: groundClear ? 'transparent' : '#000'");
  });

  it('draws no letterbox bands or solid backdrop around the picture while clear', () => {
    expect(viewer).toContain('const letterboxBands = mediaAspectRatio && !groundClear ? (');
    expect(viewer.match(/imageBackdrop=\{groundClear \? 'none' : 'solid'\}/g)).toHaveLength(2);
  });

  it('keeps its black for a reel pushed without a zoom, which fades in over the screen beneath', () => {
    expect(viewer).toContain('Boolean(nativeZoomSourceId)');
  });
});
