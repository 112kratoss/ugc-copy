import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
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

/**
 * A file's code as TypeScript reads it, so that comments are skipped as the compiler skips them: a
 * sentence about the route is not a use of it, and an `accept="image/*"` opens no comment.
 */
function parse(relative: string, source: string): ts.SourceFile {
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Every node of a file's code, comments being none. */
function nodesOf(file: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return nodes;
}

/** The route's path, in a string or a template literal, a whole address included. */
const ROUTE_PATH = '/api/remix-source';
/** The one fetch of the route, by name, however it is imported. */
const FETCH_NAME = 'fetchRemixSource';
/** The one read of a remix as its form's account (the session rule, then the fetch), by name. */
const READ_NAME = 'readRemixSource';

const FETCHES_THE_ROUTE = 'src/lib/remix-source-client.ts';
/** Holds `readRemixSource`, and reads a remix once per form through it. */
const READS_ONCE_PER_FORM = 'src/lib/use-remix-source-read.ts';
/** Reads a remix again for the links its answer signs, and puts nothing of it on the form. */
const RENEWS_LINKS = 'src/lib/use-remix-link-renewal.ts';
/** Names the route among those it admits, and fetches nothing. */
const ADMISSION_POLICY = 'src/lib/route-identity-policy.ts';

type Use = { kind: 'path' | 'fetch' | 'read'; file: string; at: string };

/** Each use of the route's path, its fetch and its read in one file's code. */
function usesIn(relative: string, source: string): Use[] {
  const file = parse(relative, source);
  const at = (node: ts.Node) => `${relative}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`;
  return nodesOf(file).flatMap((node): Use[] => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      return node.text.includes(ROUTE_PATH) ? [{ kind: 'path', file: relative, at: at(node) }] : [];
    }
    if (ts.isIdentifier(node) && (node.text === FETCH_NAME || node.text === READ_NAME)) {
      return [{ kind: node.text === FETCH_NAME ? 'fetch' : 'read', file: relative, at: at(node) }];
    }
    return [];
  });
}

/** Whether a file calls the hook with its type of fields, `useRemixSourceRead<…>(…)`. */
function callsTheReadHook(relative: string, source: string): boolean {
  return nodesOf(parse(relative, source)).some((node) => (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'useRemixSourceRead'
    && Boolean(node.typeArguments?.length)
  ));
}

/** Every use of the route's path, its fetch and its read in the app's source, read once for every check. */
const uses = sourceFiles(sourceRoot).flatMap((file) => (
  usesIn(path.relative(process.cwd(), file).replaceAll(path.sep, '/'), fs.readFileSync(file, 'utf8'))
));
const usesOf = (kind: 'path' | 'fetch' | 'read'): Use[] => uses.filter((use) => use.kind === kind);
const elsewhere = (found: Use[], ...allowed: string[]) => found.filter((use) => !allowed.includes(use.file)).map((use) => use.at);

// `useRemixSourceRead` reads a remix once for its form: a renewed token, a lapse's return and Strict
// Mode read nothing more, the answer is the form's while it is on the page, and the token is the
// browser's own only when it is the form's account (`readRemixSource`). A creator that fetched the
// route itself would skip all of it, as the three creators' copies of the read drifted apart before
// it was shared. The renewal of a remix page's links (`useRemixLinkRenewal`) reads it again through
// the same `readRemixSource`, for its links alone.
describe('who reads /api/remix-source', () => {
  // A positive control: "image/*" opens no comment. A regex for block comments ran from an
  // `accept="image/*"` to the next real `*/`, and about 880 lines of the creators went unread.
  it('reads the code after an `accept="image/*"` up to the next comment', () => {
    const fixture = [
      'const picker = <input type="file" accept="image/*" />;',
      "const read = () => fetch('/api/remix-source?id=1');",
      'const fetched = fetchRemixSource;',
      '/* A real comment, which says /api/remix-source and fetchRemixSource. */',
      '// So does this one: /api/remix-source',
    ].join('\n');

    expect(usesIn('fixture.tsx', fixture).map((use) => `${use.kind} ${use.at}`)).toEqual(['path fixture.tsx:2', 'fetch fixture.tsx:3']);
  });

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
      expect(callsTheReadHook(creator, fs.readFileSync(path.join(sourceRoot, 'app', creator), 'utf8'))).toBe(true);
    }
  });
});
