import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const projectRoot = join(__dirname, '..');
const patch = readFileSync(join(projectRoot, 'patches/react-native+0.83.10.patch'), 'utf8');

/** The lines a patch adds to one file, without the `+` marks. */
function addedTo(file: string): string {
  const sections = patch.split(/^diff --git /m);
  const section = sections.find((part) => part.startsWith(`a/node_modules/react-native/${file} `));
  expect(section, file).toBeDefined();
  return (section ?? '')
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
}

const scrollDir = 'ReactAndroid/src/main/java/com/facebook/react/views/scroll';

/**
 * React Native 0.83's Android `ReactScrollView` pulls its offset back inside
 * shrunken content only from `onLayoutChange`, and only `if (isShown())`. A
 * Profile grid or card feed whose query was cut to its first page while a
 * screen sat over it (a publish, a block, an edit) came back scrolled past its
 * end with nothing drawn, because its own frame had not changed and nothing
 * laid it out again (2026-11-06, the owner's S24). The horizontal view had no
 * clamp at all (Home's shelves). iOS is unaffected: UIKit clamps by itself.
 *
 * Shipped from store build 0.1.9: both views clamp when they or a parent
 * become visible again (`onVisibilityAggregated`, which also runs as a view is
 * attached), and the horizontal one also as its content shrinks. React Native
 * is compiled from source on Android (`plugins/withAndroidReleaseSafety.js`),
 * which is what lets a Java patch take effect. The JS guard
 * `lib/use-scroll-within-content.ts` stays for binaries before 0.1.9.
 */
describe('Android scroll views pull back inside their content', () => {
  it('clamps the vertical view when it becomes visible again', () => {
    const added = addedTo(`${scrollDir}/ReactScrollView.java`);
    expect(added).toContain('public void onVisibilityAggregated(boolean isVisible) {');
    expect(added).toContain('super.onVisibilityAggregated(isVisible);');
    expect(added).toContain('clampScrollYToContent();');
    expect(added).toMatch(/if \(getScrollY\(\) > maxScrollY\) \{\s+scrollTo\(getScrollX\(\), maxScrollY\);/);
  });

  it('keeps the shown-only clamp on a layout change', () => {
    const added = addedTo(`${scrollDir}/ReactScrollView.java`);
    expect(added).toMatch(/if \(isShown\(\)\) \{\s+clampScrollYToContent\(\);/);
  });

  it('gives the horizontal view a clamp, left to right only', () => {
    const added = addedTo(`${scrollDir}/ReactHorizontalScrollView.java`);
    expect(added).toContain('public void onVisibilityAggregated(boolean isVisible) {');
    expect(added).toContain('getLayoutDirection() == LAYOUT_DIRECTION_RTL');
    expect(added).toContain('Math.max(0, computeHorizontalScrollRange() - getWidth())');
    expect(added).toMatch(/if \(isShown\(\)\) \{\s+clampScrollXToContent\(\);/);
  });

  it('is in the shipped React Native patch, which the Android build compiles from source', () => {
    const plugin = readFileSync(join(projectRoot, 'plugins/withAndroidReleaseSafety.js'), 'utf8');
    expect(plugin).toContain("includeBuild('../node_modules/react-native')");
  });
});
