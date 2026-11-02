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

/** Comments out, so a sentence about the route is not read as a use of it; `://` in a link stays. */
const withoutComments = (code: string) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** A string or template literal that holds the route's path, a whole address included. */
const ROUTE_LITERAL = /['"`][^'"`\n]*\/api\/remix-source/g;
/** The one fetch of the route, by name, however it is imported. */
const FETCH_NAME = /\bfetchRemixSource\b/g;
/** The one read of a remix as its form's account (the session rule, then the fetch), by name. */
const READ_NAME = /\breadRemixSource\b/g;

const FETCHES_THE_ROUTE = 'src/lib/remix-source-client.ts';
/** Holds `readRemixSource`, and reads a remix once per form through it. */
const READS_ONCE_PER_FORM = 'src/lib/use-remix-source-read.ts';
/** Reads a remix again for the links its answer signs, and puts nothing of it on the form. */
const RENEWS_LINKS = 'src/lib/use-remix-link-renewal.ts';
/** Names the route among those it admits, and fetches nothing. */
const ADMISSION_POLICY = 'src/lib/route-identity-policy.ts';

type Use = { file: string; at: string };

/** Every use of the route's path, its fetch and its read in the app's source, read once for every check. */
const uses = sourceFiles(sourceRoot).flatMap((file) => {
  const relative = path.relative(process.cwd(), file).replaceAll(path.sep, '/');
  const code = withoutComments(fs.readFileSync(file, 'utf8'));
  const line = (index: number) => code.slice(0, index).split('\n').length;
  const found = (kind: 'path' | 'fetch' | 'read', pattern: RegExp) => [...code.matchAll(pattern)]
    .map((match) => ({ kind, file: relative, at: `${relative}:${line(match.index)}` }));
  return [...found('path', ROUTE_LITERAL), ...found('fetch', FETCH_NAME), ...found('read', READ_NAME)];
});
const usesOf = (kind: 'path' | 'fetch' | 'read'): Use[] => uses.filter((use) => use.kind === kind);
const elsewhere = (found: Use[], ...allowed: string[]) => found.filter((use) => !allowed.includes(use.file)).map((use) => use.at);

// `useRemixSourceRead` reads a remix once for its form: a renewed token, a lapse's return and Strict
// Mode read nothing more, the answer is the form's while it is on the page, and the token is the
// browser's own only when it is the form's account (`readRemixSource`). A creator that fetched the
// route itself would skip all of it, as the three creators' copies of the read drifted apart before
// it was shared. The renewal of a remix page's links (`useRemixLinkRenewal`) reads it again through
// the same `readRemixSource`, for its links alone.
describe('who reads /api/remix-source', () => {
  it('finds what it guards: the fetch of the route, the read through it, and both of its readers', () => {
    expect(usesOf('path').map((use) => use.file)).toContain(FETCHES_THE_ROUTE);
    expect(usesOf('fetch').map((use) => use.file)).toContain(READS_ONCE_PER_FORM);
    expect(new Set(usesOf('read').map((use) => use.file))).toEqual(new Set([READS_ONCE_PER_FORM, RENEWS_LINKS]));
  });

  it('names the route only where it is fetched, and in the admission policy', () => {
    expect(elsewhere(usesOf('path'), FETCHES_THE_ROUTE, ADMISSION_POLICY)).toEqual([]);
  });

  it('fetches it only through `readRemixSource`, which reads as the form’s account', () => {
    expect(elsewhere(usesOf('fetch'), FETCHES_THE_ROUTE, READS_ONCE_PER_FORM)).toEqual([]);
  });

  it('reads it only in the form’s one read and the renewal of its links', () => {
    expect(elsewhere(usesOf('read'), READS_ONCE_PER_FORM, RENEWS_LINKS)).toEqual([]);
  });

  it('is read through the hook by each of the three creators', () => {
    for (const creator of ['create-image/CreateImageClient.tsx', 'create-video/CreateVideoClient.tsx', 'create-motion/CreateMotionClient.tsx']) {
      expect(withoutComments(fs.readFileSync(path.join(sourceRoot, 'app', creator), 'utf8'))).toMatch(/\buseRemixSourceRead\s*</);
    }
  });
});
