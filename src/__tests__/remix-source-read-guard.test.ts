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

const FETCHES_THE_ROUTE = 'src/lib/remix-source-client.ts';
const READS_ONCE_PER_FORM = 'src/lib/use-remix-source-read.ts';
/** Names the route among those it admits, and fetches nothing. */
const ADMISSION_POLICY = 'src/lib/route-identity-policy.ts';

type Use = { file: string; at: string };

/** Every use of the route's path and of its fetch in the app's source, read once for every check. */
const uses = sourceFiles(sourceRoot).flatMap((file) => {
  const relative = path.relative(process.cwd(), file).replaceAll(path.sep, '/');
  const code = withoutComments(fs.readFileSync(file, 'utf8'));
  const line = (index: number) => code.slice(0, index).split('\n').length;
  return [
    ...[...code.matchAll(ROUTE_LITERAL)].map((match) => ({ kind: 'path' as const, file: relative, at: `${relative}:${line(match.index)}` })),
    ...[...code.matchAll(FETCH_NAME)].map((match) => ({ kind: 'fetch' as const, file: relative, at: `${relative}:${line(match.index)}` })),
  ];
});
const pathUses: Use[] = uses.filter((use) => use.kind === 'path');
const fetchUses: Use[] = uses.filter((use) => use.kind === 'fetch');

// `useRemixSourceRead` reads a remix once for its form: a renewed token, a lapse's return and Strict
// Mode read nothing more, the answer is the form's while it is on the page, and the token is the
// browser's own only when it is the form's account. A creator that fetched the route itself would
// skip all of it, as the three creators' copies of the read drifted apart before it was shared.
describe('who reads /api/remix-source', () => {
  it('finds what it guards: the fetch of the route, and the hook calling it', () => {
    expect(pathUses.map((use) => use.file)).toContain(FETCHES_THE_ROUTE);
    expect(fetchUses.map((use) => use.file)).toContain(READS_ONCE_PER_FORM);
  });

  it('names the route only where it is fetched, and in the admission policy', () => {
    expect(pathUses.filter((use) => use.file !== FETCHES_THE_ROUTE && use.file !== ADMISSION_POLICY).map((use) => use.at))
      .toEqual([]);
  });

  it('fetches it only through the hook that reads a remix once per form', () => {
    expect(fetchUses.filter((use) => use.file !== FETCHES_THE_ROUTE && use.file !== READS_ONCE_PER_FORM).map((use) => use.at))
      .toEqual([]);
  });

  it('is read through the hook by each of the three creators', () => {
    for (const creator of ['create-image/CreateImageClient.tsx', 'create-video/CreateVideoClient.tsx', 'create-motion/CreateMotionClient.tsx']) {
      expect(withoutComments(fs.readFileSync(path.join(sourceRoot, 'app', creator), 'utf8'))).toMatch(/\buseRemixSourceRead\s*</);
    }
  });
});
