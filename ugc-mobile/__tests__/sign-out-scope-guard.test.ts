import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(__dirname, '..');
const sourceRoots = ['app', 'components', 'lib'] as const;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('sign-out scope', () => {
  it('never relies on Supabase\'s default, which signs the account out on every device', () => {
    // signOut() with no scope is a global sign-out. Every other phone on the
    // account then kept sending a token the server refused, and showed errors on
    // every screen until that token expired. A deliberate "sign out everywhere"
    // must say scope: 'global' out loud; everything else says 'local'.
    const offenders: string[] = [];
    for (const file of sourceRoots.flatMap((root) => sourceFiles(path.join(mobileRoot, root)))) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\.auth\.signOut\(([^)]*)\)/g)) {
        if (!/\bscope\s*:/.test(match[1])) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(mobileRoot, file).replaceAll(path.sep, '/')}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
