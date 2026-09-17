import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// Every draw-time blur goes through BackdropImage, which prefers the picture's
// thumbhash and asks the native loader to blur only where lib/media-blur.ts
// says it can. A bare `<Image blurRadius>` anywhere else would put RenderScript
// back on Glide's disk-cache thread on Android builds without the software
// blur patch, which is how previews starved on 2026-09-18. Ratchet: only the
// one file may pass blurRadius to expo-image.
const root = path.join(__dirname, '..');
const scanned = ['app', 'components', 'lib'];
const allowed = new Set(['components/backdrop-image.tsx']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry) ? [full] : [];
  });
}

describe('blurRadius stays inside BackdropImage', () => {
  it('no expo-image element outside components/backdrop-image.tsx is asked to blur', () => {
    const offenders: string[] = [];
    for (const dir of scanned) {
      for (const file of sourceFiles(path.join(root, dir))) {
        const relative = path.relative(root, file);
        if (allowed.has(relative)) continue;
        const source = readFileSync(file, 'utf8');
        // An opening <Image …> or <ImageBackground …> tag that carries blurRadius, across lines.
        if (/<Image(?:Background)?\b[^>]*?\bblurRadius\b/s.test(source)) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the one allowed file blurs only what nativeBlurRadius returns', () => {
    const source = readFileSync(path.join(root, 'components/backdrop-image.tsx'), 'utf8');
    expect(source).toContain('const radius = nativeBlurRadius(blurRadius);');
    expect(source).toContain('blurRadius={radius}');
    expect(source.match(/blurRadius=\{/g)).toHaveLength(1);
  });
});
