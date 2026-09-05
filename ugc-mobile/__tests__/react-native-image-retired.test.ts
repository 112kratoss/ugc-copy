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
 * docs/android-app-optimization-plan-2026-09-05.md retired its last two uses
 * (the unlock thumbnail and the Google sign-in button), which is what let phase
 * 5b drop Fresco's GIF and WebP add-ons from the binary. This keeps it retired:
 * a new `Image` from react-native would quietly bring the second pipeline back.
 */
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
        if (components.includes('Image') || components.includes('ImageBackground')) {
          offenders.push(path.relative(mobileRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
