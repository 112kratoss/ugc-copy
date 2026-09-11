import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = path.resolve(process.cwd(), 'src');
const testsRoot = path.join(sourceRoot, '__tests__');

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root)) {
    const absolutePath = path.join(root, entry);
    if (absolutePath === testsRoot) continue;
    if (fs.statSync(absolutePath).isDirectory()) {
      files.push(...sourceFiles(absolutePath));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(absolutePath);
    }
  }
  return files;
}

describe('web sign-out scope', () => {
  it('never relies on Supabase\'s default, which signs the account out on every device', () => {
    // signOut() with no scope is a global sign-out: signing out in a browser
    // also ended the account's session on the person's phone, which then had
    // every request refused until its token expired. A deliberate "sign out
    // everywhere" must say scope: 'global' out loud; everything else says
    // 'local'.
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\.auth\.signOut\(([^)]*)\)/g)) {
        if (!/\bscope\s*:/.test(match[1])) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(process.cwd(), file).replaceAll(path.sep, '/')}:${line}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
