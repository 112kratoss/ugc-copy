import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Nothing in the app asks expo-image to blur. On Android, expo-image 55 blurs
// through RenderScript on Glide's single disk-cache thread, and on 2026-09-18 a
// RenderScript teardown hung there and starved every later image load until a
// restart. Backdrops and letterbox bands have been plain black since 2026-09-25,
// so the budget is zero: a new `blurRadius` needs expo-image 56's software blur
// (or a patch carrying it) first.
const root = path.join(__dirname, '..');
const scanned = ['app', 'components', 'lib'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry) ? [full] : [];
  });
}

describe('no blurRadius in the app', () => {
  it('scans real source files', () => {
    // A positive control: the scan must see the files it guards.
    const files = scanned.flatMap((dir) => sourceFiles(path.join(root, dir)).map((file) => path.relative(root, file)));
    expect(files).toContain('components/feed-media-frame.tsx');
    expect(files).toContain('components/letterbox-bands.tsx');
  });

  it('asks no image in app/, components/ or lib/ to blur', () => {
    const offenders: string[] = [];
    for (const dir of scanned) {
      for (const file of sourceFiles(path.join(root, dir))) {
        if (/\bblurRadius\b/.test(readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
