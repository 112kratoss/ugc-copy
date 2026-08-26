import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');
const sourceRoots = ['app', 'components'] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.tsx$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function relativePath(filePath: string) {
  return path.relative(mobileRoot, filePath).replaceAll(path.sep, '/');
}

const screenFiles = sourceRoots.flatMap((root) => sourceFiles(path.join(mobileRoot, root)));

/**
 * Files that render a text field but legitimately do not host their own
 * avoidance, because an ancestor already provides it.
 */
const PROVIDED_BY_ANCESTOR = new Set([
  // The shared primitive itself; screens opt in via `<Screen keyboardAware>`.
  'components/ui.tsx',
]);

const AVOIDANCE_MARKERS = [
  'KeyboardAvoidingArea',
  'KeyboardLift',
  '<Screen keyboardAware',
];

/**
 * Android 15 forces edge-to-edge, which stopped the window resizing for the
 * keyboard, and iOS never resized it at all. A screen that takes text input and
 * does nothing about the keyboard will cover its own focused field — the field
 * still accepts typing, so this fails silently and only shows up on a device.
 */
describe('keyboard avoidance coverage', () => {
  it('gives every text-entry screen a way to clear the keyboard', () => {
    const unprotected = screenFiles
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      .filter(({ source }) => /<TextInput|<AppTextInput|<ProfileTextField|<ComposerInput|<WorkspaceInput/.test(source))
      .filter(({ filePath }) => !PROVIDED_BY_ANCESTOR.has(relativePath(filePath)))
      .filter(({ source }) => !AVOIDANCE_MARKERS.some((marker) => source.includes(marker)))
      .map(({ filePath }) => relativePath(filePath));

    expect(unprotected).toEqual([]);
  });

  it('pairs the iOS opt-out with the native prop it defers to', () => {
    // `iosScrollViewAdjustsInsets` makes the wrapper contribute nothing on iOS,
    // on the promise that a ScrollView inside carries
    // `automaticallyAdjustKeyboardInsets`. Half of that pairing is worse than
    // neither: the field simply stays under the keyboard on iOS.
    const mismatched = screenFiles
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      .filter(({ source }) => source.includes('iosScrollViewAdjustsInsets')
        && !source.includes('automaticallyAdjustKeyboardInsets'))
      .map(({ filePath }) => relativePath(filePath));

    expect(mismatched).toEqual([]);
  });

  it('keeps the avoidance geometry in one place', () => {
    // Two mechanisms drifting apart is how the original bug survived: several
    // screens each hand-rolled a keyboardDidShow listener and only some worked.
    const handRolled = screenFiles
      .map((filePath) => ({ filePath, source: readFileSync(filePath, 'utf8') }))
      // The shared module is where the listener belongs.
      .filter(({ filePath }) => relativePath(filePath) !== 'components/keyboard-aware.tsx')
      .filter(({ source }) => /addListener\(\s*['"]keyboard(Will|Did)(Show|Hide)['"]/.test(source))
      .map(({ filePath }) => relativePath(filePath));

    expect(handRolled).toEqual([]);
  });
});
