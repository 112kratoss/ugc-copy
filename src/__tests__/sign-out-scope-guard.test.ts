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

  it('marks every sign-out for the browser\'s other tabs before it ends the session', () => {
    // Every tab hears a sign-out as the SIGNED_OUT a lapse also sends. Without the mark
    // (`markBrowserSignOut`), the other tabs take a sign-out for a lapse, and an open creator
    // page there keeps the signed-out account's form (owner, 2026-11-01: a sign-out clears it).
    // Each call needs a mark of its own, between it and the sign-out before it.
    const offenders: string[] = [];
    let signOuts = 0;
    for (const file of sourceFiles(sourceRoot)) {
      const source = fs.readFileSync(file, 'utf8');
      let since = 0;
      for (const match of source.matchAll(/\.auth\.signOut\(/g)) {
        signOuts += 1;
        if (!source.slice(since, match.index).includes('markBrowserSignOut(')) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${path.relative(process.cwd(), file).replaceAll(path.sep, '/')}:${line}`);
        }
        since = match.index + match[0].length;
      }
    }

    // The scan found the sign-outs it guards: the account menu's two and the account deletion's.
    expect(signOuts).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });
});
