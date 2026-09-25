import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) files.push(...sourceFiles(absolutePath));
    else if (/\.tsx?$/.test(entry)) files.push(absolutePath);
  }
  return files;
}

const files = ['app', 'components', 'lib'].flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

/**
 * Every image in the app renders through expo-image, which decodes through
 * Glide at the view's size. React Native's core `Image` decodes through Fresco
 * instead: a second image pipeline, a second cache, and the network path Google
 * Play's "bitmap image optimization" card points at. Phase 5a of
 * docs/plans/android-app-optimization-plan-2026-09-05.md retired its last two uses
 * (the unlock thumbnail and the Google sign-in button), which is what let phase
 * 5b drop Fresco's GIF and WebP add-ons from the binary. This keeps it retired:
 * a new `Image` from react-native would quietly bring the second pipeline back.
 *
 * One exception, for bundled glyphs only: `components/reel-icon.tsx` draws the
 * reel rail's 13 `require()` PNGs with the core Image. On Android an expo-image
 * is four native views (a wrapper, a frame and two image views for its
 * crossfade), and every slide builds its rail as it mounts, mid-swipe for the
 * slide beyond the one being landed on. It adds no network image and no GIF or
 * WebP, and Fresco itself starts at launch either way (`FrescoModule` is
 * `needsEagerInit`), so the cost is those icons' bitmaps in its memory cache.
 */
const BUNDLED_GLYPHS_ONLY = new Set(['components/reel-icon.tsx']);
describe('React Native core Image stays retired', () => {
  it('imports no Image or ImageBackground component from react-native', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"]react-native['"]/g)) {
        if (match[1]) continue;
        const components = match[2]
          .split(',')
          .map((specifier) => specifier.trim())
          .filter((specifier) => specifier && !specifier.startsWith('type '))
          .map((specifier) => specifier.split(/\s+as\s+/)[0]);
        const relative = path.relative(mobileRoot, file);
        if (components.includes('ImageBackground') || (components.includes('Image') && !BUNDLED_GLYPHS_ONLY.has(relative))) {
          offenders.push(relative);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('lets the rail glyphs through only with bundled sources', () => {
    // The exception above is for require() PNGs from lib/reel-icon-assets, never a URL.
    const glyphs = readFileSync(path.join(mobileRoot, 'components/reel-icon.tsx'), 'utf8');
    expect(glyphs).toContain("import { reelIconAssets } from '@/lib/reel-icon-assets';");
    expect(glyphs).toMatch(/<Image source=\{source\}/);
    expect(glyphs).not.toMatch(/uri\s*:/);
  });
});
