import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * What a post's page (`/showcase/[id]`, where shared links land) brings to the browser with its
 * first load, read from its imports (2026-11-19, the speed and cost loop:
 * archive/perf-loop-2026-11-19, web-baseline item 8). A CI-like production build measured the
 * route's first-load JS at 948 KB decoded, 257 KB brotli, 96 KB of it the page's own. Out of it now,
 * each loaded where it is used:
 *
 * - the browser's model tables and the outside tools' (`client-generation-models.ts`,
 *   `source-tools.ts`, about 40 KB decoded): the page's Made with is named on the server
 *   (`getPostMadeWithLabel` in `post-model-labels.ts`), the feed card that names a model is
 *   `post-feed-card.ts`, and a share asks `audio-model-ids.ts`;
 * - Report user and Block user's actions (`feed-safety-actions.ts` and the moderation client),
 *   loaded with the first reach for either row;
 * - the creator's Owner tools (`ShowcaseOwnerToolsMenu.tsx`: the lifecycle actions and the
 *   visibility menu), loaded once the session check names the creator;
 * - the not-found notice a block draws, with the design system it is drawn with, and the invite
 *   hand-off bar: each drawn in the browser only, for few readers.
 *
 * A module is browser code when a file marked 'use client' imports it, statically and all the way
 * down, or it is such a file: the server page's own imports (the post's read, its metadata, its Made
 * with) never reach the browser. `import()` makes a chunk of its own, loaded when it runs.
 */

const SRC_ROOT = path.join(process.cwd(), 'src');
const APP_ROOT = path.join(SRC_ROOT, 'app');
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
// What loads a module with its importer: a value import, a re-export, a bare import. `import type`
// and `export type` load nothing, and an `import()` anywhere in a line loads on demand.
const STATIC_IMPORT = /(?:^\s*import\s+(?!type\b)[^'"]*?from\s*|^\s*export\s+(?!type\b)[^'"]*?from\s*|^\s*import\s*)['"]([^'"]+)['"]/gm;
// The files Next draws a segment with: every level's, and the page of the route itself.
const SEGMENT_FILE = /^(?:layout|template|loading|error|not-found|forbidden|unauthorized)\.(?:tsx|jsx|ts|js)$/;
const PAGE_FILE = /^page\.(?:tsx|jsx|ts|js)$/;
// The directive as the first statement, after any comments.
const USE_CLIENT = /^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*['"]use client['"]/;

function resolveLocalImport(specifier: string, importer: string, srcRoot: string): string | null {
  const unresolved = specifier.startsWith('@/')
    ? path.join(srcRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(importer), specifier)
      : null;
  if (!unresolved) return null;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${unresolved}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(unresolved, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * The source files the entries send to the browser with them: every file marked 'use client' that
 * they reach, and everything such a file imports, statically and all the way down. A server file's
 * imports are followed only to find those.
 */
function browserImportClosure(entries: string[], srcRoot = SRC_ROOT): Set<string> {
  const browser = new Set<string>();
  const server = new Set<string>();
  const pending = entries.map((file) => ({ file, inBrowser: false }));
  while (pending.length > 0) {
    const { file, inBrowser: importedByBrowser } = pending.pop()!;
    const isSource = /\.(?:ts|tsx|js|jsx|mjs)$/.test(file);
    const source = isSource ? readFileSync(file, 'utf8') : '';
    const inBrowser = importedByBrowser || USE_CLIENT.test(source);
    const seen = inBrowser ? browser : server;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!isSource) continue;
    for (const match of source.matchAll(STATIC_IMPORT)) {
      const imported = resolveLocalImport(match[1], file, srcRoot);
      if (imported) pending.push({ file: imported, inBrowser });
    }
  }
  return browser;
}

/** A route's segment files, from the app folder down to the route's own page. */
function routeEntries(routeFolder: string): string[] {
  const parts = routeFolder.split('/');
  const levels = [APP_ROOT, ...parts.map((_, index) => path.join(APP_ROOT, ...parts.slice(0, index + 1)))];
  return levels.flatMap((level, index) => readdirSync(level, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && (SEGMENT_FILE.test(entry.name) || (index === levels.length - 1 && PAGE_FILE.test(entry.name))))
    .map((entry) => path.join(level, entry.name)));
}

const relative = (files: Iterable<string>) => [...files].map((file) => path.relative(SRC_ROOT, file)).sort();
const read = (file: string) => readFileSync(path.join(SRC_ROOT, file), 'utf8');

/** Moved out of the page's first load on 2026-11-19, each loaded where it is used. */
const LOADED_WHERE_USED = [
  'lib/client-generation-models.ts',
  'lib/source-tools.ts',
  'lib/post-model-labels.ts',
  'lib/post-feed-card.ts',
  'lib/feed-safety-actions.ts',
  'lib/moderation-client.ts',
  'lib/showcase-client-cache.ts',
  'lib/marketplace-pages-memory.ts',
  'app/showcase/[id]/ShowcaseOwnerToolsMenu.tsx',
  'components/usePostLifecycle.ts',
  'components/PostVisibilityMenu.tsx',
  'lib/post-lifecycle-client.ts',
  'app/showcase/[id]/ShowcasePostUnavailable.tsx',
  'components/DesignSystem.tsx',
  'components/InviteHandoffBar.tsx',
];

describe("what a post's page brings to the browser with its first load", () => {
  const browser = browserImportClosure(routeEntries('showcase/[id]'));

  it('is read from the page as it is drawn', () => {
    expect(relative(browser)).toEqual(expect.arrayContaining([
      'app/showcase/[id]/ShowcaseDetailBody.tsx',
      'app/showcase/[id]/ShowcaseDetailActions.tsx',
      'app/showcase/[id]/ReportPostButton.tsx',
      'app/showcase/[id]/useShowcasePostViewer.ts',
      'components/PostComments.tsx',
      'lib/post-feed-presentation.ts',
      'lib/share.ts',
    ]));
    // The server page itself is not browser code, nor what only it reads.
    expect(relative(browser)).not.toContain('app/showcase/[id]/page.tsx');
    expect(relative(browser)).not.toContain('lib/public-posts.ts');
  });

  it('leaves out what is loaded where it is used', () => {
    expect(
      LOADED_WHERE_USED.filter((file) => browser.has(path.join(SRC_ROOT, file))),
      "loaded with the page for every reader: import() it where it is used, or name it on the server",
    ).toEqual([]);
  });

  it('loads each of them with import(), where it is used', () => {
    const body = read('app/showcase/[id]/ShowcaseDetailBody.tsx');
    expect(body).toContain("import('./ShowcasePostUnavailable')");
    expect(body).toContain("import('@/components/InviteHandoffBar')");
    expect(read('app/showcase/[id]/ShowcaseDetailActions.tsx')).toContain("import('./ShowcaseOwnerToolsMenu')");
    expect(read('app/showcase/[id]/ReportPostButton.tsx')).toContain("from './safety-actions-loader'");
    expect(read('app/showcase/[id]/safety-actions-loader.ts')).toContain("import('@/lib/feed-safety-actions')");
  });

  it('names what the post was made with on the server', () => {
    expect(read('app/showcase/[id]/page.tsx')).toContain('madeWithLabel={getPostMadeWithLabel(detail)}');
    // Neither the model tables nor the outside tools' come back through the presentation rules.
    const presentation = read('lib/post-feed-presentation.ts');
    expect(presentation).not.toMatch(/from '@\/lib\/(?:client-generation-models|source-tools|post-model-labels|post-feed-card)'/);
    expect(read('lib/share.ts')).not.toContain("from '@/lib/client-generation-models'");
  });
});

// The reader above, on made-up trees: shapes where it once read a page wrong would fail here first.
describe('the browser-closure reader reads', () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'post-page-first-load-'));
  const write = (file: string, source: string) => {
    const full = path.join(fixtureRoot, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
    return full;
  };

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it("a server page's own imports as the server's, and a client file's as the browser's", () => {
    const page = write('page.tsx', [
      "import { readPost } from './read-post';",
      "import Body from './Body';",
    ].join('\n'));
    write('read-post.ts', "import { tables } from './tables';\nexport const readPost = () => tables;\n");
    write('tables.ts', 'export const tables = {};\n');
    const body = write('Body.tsx', [
      '// The post, drawn for everyone.',
      "'use client';",
      "import type { Session } from './types';",
      "import {",
      "  shown,",
      "} from './shown';",
      "export * from './again';",
      "import './side-effect';",
      "const Lazy = dynamic(() => import('./Lazy'));",
      "const load = () => import('./tables');",
    ].join('\n'));
    const shown = write('shown.ts', "import { deeper } from './deeper';\nexport const shown = deeper;\n");
    const again = write('again.ts', 'export const again = 1;\n');
    const sideEffect = write('side-effect.ts', '');
    const deeper = write('deeper.ts', 'export const deeper = 1;\n');
    write('types.ts', 'export type Session = object;\n');
    write('Lazy.tsx', "'use client';\nimport { tables } from './tables';\n");

    expect([...browserImportClosure([page], fixtureRoot)].sort())
      .toEqual([again, body, deeper, shown, sideEffect].sort());
  });

  it('a file imported by both as browser code', () => {
    const page = write('both/page.tsx', "import { tables } from './tables';\nimport Body from './Body';\n");
    const tables = write('both/tables.ts', 'export const tables = {};\n');
    const body = write('both/Body.tsx', "\"use client\";\nimport { tables } from './tables';\n");

    expect([...browserImportClosure([page], fixtureRoot)].sort()).toEqual([body, tables].sort());
  });
});
