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

/** `.auth.signOut(` as it is written: on one line or split over two, optional chaining included. */
const SIGN_OUT_CALL = /\bauth\s*\??\.\s*signOut\s*\(/g;

type SignOutCall = { at: string; args: string; sinceLastCall: string };

/** Every sign-out the app's source makes, read once for both checks. */
const signOutCalls: SignOutCall[] = sourceFiles(sourceRoot).flatMap((file) => {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(process.cwd(), file).replaceAll(path.sep, '/');
  let since = 0;
  return [...source.matchAll(SIGN_OUT_CALL)].map((match) => {
    const start = match.index;
    const end = start + match[0].length;
    const call = {
      at: `${relative}:${source.slice(0, start).split('\n').length}`,
      args: source.slice(end, source.indexOf(')', end)),
      sinceLastCall: source.slice(since, start),
    };
    since = end;
    return call;
  });
});

describe('web sign-out scope', () => {
  it('finds the sign-outs it guards: the account menu\'s two and the account deletion\'s', () => {
    expect(signOutCalls.length).toBeGreaterThanOrEqual(3);
  });

  it('never relies on Supabase\'s default, which signs the account out on every device', () => {
    // signOut() with no scope is a global sign-out: signing out in a browser
    // also ended the account's session on the person's phone, which then had
    // every request refused until its token expired. A deliberate "sign out
    // everywhere" must say scope: 'global' out loud; everything else says
    // 'local'.
    expect(signOutCalls.filter((call) => !/\bscope\s*:/.test(call.args)).map((call) => call.at)).toEqual([]);
  });

  it('marks every sign-out for the browser\'s other tabs before it ends the session', () => {
    // Every tab hears a sign-out as the SIGNED_OUT a lapse also sends. Without the mark
    // (`markBrowserSignOut`), the other tabs take a sign-out for a lapse, and an open creator
    // page there keeps the signed-out account's form (owner, 2026-11-01: a sign-out clears it).
    // Each call needs a mark of its own, between it and the sign-out before it. The account
    // deletion's sign-in-again link signs out without one, on purpose: the same person signs
    // straight back in (`signOutHere` in `SignedInAccountDeletion.tsx`).
    expect(signOutCalls.filter((call) => !call.sinceLastCall.includes('markBrowserSignOut(')).map((call) => call.at))
      .toEqual([]);
  });
});
