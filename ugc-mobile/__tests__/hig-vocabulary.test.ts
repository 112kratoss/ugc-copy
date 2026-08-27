import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (root: string) => {
    for (const entry of readdirSync(root)) {
      const absolute = path.join(root, entry);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else if (/\.tsx?$/.test(entry)) files.push(absolute);
    }
  };
  for (const root of ['app', 'components', 'lib']) walk(path.join(mobileRoot, root));
  return files;
}

describe('app vocabularies (HIG X2, X3)', () => {
  it('routes every haptic through the vocabulary in lib/haptics.ts', () => {
    // Playing haptics: "build clear cause-and-effect relationships"; the
    // vocabulary's semantic names (select/light/soft/medium/success/error) are
    // that relationship, and a direct expo-haptics call is a second dialect
    // waiting to drift.
    const offenders = sourceFiles()
      .filter((file) => !file.endsWith(`lib${path.sep}haptics.ts`))
      .filter((file) => /from 'expo-haptics'/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('writes ellipses as the typographic character, never three periods', () => {
    // Writing: UI strings use "…" — three periods render as three periods and
    // wrap badly. The regex targets string literals whose visible text ends in
    // "...", not spread syntax or code.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, 'utf8');
      if (/[A-Za-z]\.\.\.['"`]/.test(source)) {
        offenders.push(path.relative(mobileRoot, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
