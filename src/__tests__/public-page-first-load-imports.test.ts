import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * What three public pages bring with their first load, read from their imports (2026-11-19, the
 * speed and cost loop: archive/perf-loop-2026-11-19, web-static item 1 and 10, web-baseline item 4).
 * The production build measured, decoded / brotli:
 *
 * - a creator's page, 1,224 / 323 KB, carried the Supabase client (about 203 / 45), framer-motion
 *   (130 / 38) and the owner's profile editor for every visitor, all imported up front by
 *   `ProfileActions.tsx`. Who is looking now comes from the page's auth provider, and the owner's
 *   Edit profile dialog loads with import() (`creator-profile-edit-sheet-loader.ts`);
 * - `/search`, 977 / 248 KB, and `/pricing`, 884 / 226 KB, carried the Supabase client for their
 *   session reads (the search page, its open log and its Follow; the pricing page and the packs'
 *   checkout): it loads with import() at the read now (`browser-session.ts`), and not at all for a
 *   browser with no session cookie.
 *
 * A module is in a page's first load when anything the route's segment files import, statically and
 * all the way down, imports it statically. `import()` makes a chunk of its own, loaded when it runs.
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
/** What the browser loads on every page without a segment of its own. */
const BROWSER_ENTRIES = ['instrumentation-client.ts'];

const SUPABASE_CLIENT = path.join(SRC_ROOT, 'lib', 'supabase.ts');

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

/** The source files the entries load with them, and the packages each of those imports. */
function staticImportClosure(entries: string[], srcRoot = SRC_ROOT) {
  const files = new Set<string>();
  const packages = new Map<string, Set<string>>();
  const pending = [...entries];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(?:ts|tsx|js|jsx|mjs)$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
      const specifier = match[1];
      const imported = resolveLocalImport(specifier, file, srcRoot);
      if (imported) {
        if (!files.has(imported)) pending.push(imported);
      } else if (!specifier.startsWith('.') && !specifier.startsWith('@/')) {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        packages.set(name, (packages.get(name) ?? new Set()).add(path.relative(srcRoot, file)));
      }
    }
  }
  return { files, packages };
}

/** A route's segment files, from the app folder down to the route's own page. */
function routeEntries(routeFolder: string): string[] {
  const parts = routeFolder.split('/');
  const levels = [APP_ROOT, ...parts.map((_, index) => path.join(APP_ROOT, ...parts.slice(0, index + 1)))];
  return levels.flatMap((level, index) => readdirSync(level, { withFileTypes: true })
    .filter((entry) => entry.isFile()
      && (SEGMENT_FILE.test(entry.name) || (index === levels.length - 1 && PAGE_FILE.test(entry.name))))
    .map((entry) => path.join(level, entry.name)))
    .concat(BROWSER_ENTRIES.map((entry) => path.join(SRC_ROOT, entry)).filter((entry) => existsSync(entry)));
}

const relative = (files: Iterable<string>) => [...files].map((file) => path.relative(SRC_ROOT, file)).sort();

describe('what a public page brings with its first load', () => {
  it("leaves a creator's page without the Supabase client, framer-motion and the owner's editor", () => {
    const { files, packages } = staticImportClosure(routeEntries('creators/[username]'));
    expect(relative(files)).toEqual(expect.arrayContaining([
      'app/creators/[username]/page.tsx',
      'app/creators/[username]/ProfileActions.tsx',
      'app/creators/[username]/creator-profile-edit-sheet-loader.ts',
      'components/AuthProvider.tsx',
      'lib/browser-session.ts',
    ]));

    const heavy = [
      SUPABASE_CLIENT,
      path.join(APP_ROOT, 'creations', 'CreatorProfileCard.tsx'),
      path.join(APP_ROOT, 'creators', '[username]', 'CreatorProfileEditSheet.tsx'),
    ];
    expect(
      relative(heavy.filter((file) => files.has(file))),
      'loaded with the page for every visitor: import() them where they are needed',
    ).toEqual([]);
    expect([...(packages.get('framer-motion') ?? [])], 'framer-motion is the editor\'s, loaded with it').toEqual([]);
    // The dialog, framer-motion and the editor are one import() away, for the owner alone.
    expect(readFileSync(path.join(APP_ROOT, 'creators', '[username]', 'creator-profile-edit-sheet-loader.ts'), 'utf8'))
      .toContain("import('./CreatorProfileEditSheet')");
    expect(readFileSync(path.join(APP_ROOT, 'creators', '[username]', 'CreatorProfileEditSheet.tsx'), 'utf8'))
      .toMatch(/^import \{ AnimatePresence, motion \} from 'framer-motion';$/m);
  });

  it.each(['search', 'pricing'])('leaves /%s without the Supabase client', (route) => {
    const { files } = staticImportClosure(routeEntries(route));
    expect(relative(files)).toEqual(expect.arrayContaining(['lib/browser-session.ts']));
    expect(
      relative([...files].filter((file) => file === SUPABASE_CLIENT)),
      'a static import of @/lib/supabase in the route\'s closure: read the session through browser-session.ts',
    ).toEqual([]);
  });

  it('loads the Supabase client on demand, and never for a browser with no session cookie', () => {
    const browserSession = readFileSync(path.join(SRC_ROOT, 'lib', 'browser-session.ts'), 'utf8');
    expect(browserSession).toContain("import('@/lib/supabase')");
    expect(browserSession).toMatch(/if \(!hasSupabaseAuthCookie\(\)\) return null;/);
  });
});

// The reader above, on made-up trees: shapes where it once read a page wrong would fail here first.
describe('the first-load reader reads', () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'public-page-first-load-'));
  const write = (file: string, source: string) => {
    const full = path.join(fixtureRoot, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, source);
    return full;
  };

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('static imports, re-exports and bare imports, and not types or import()', () => {
    const page = write('page.tsx', [
      "import type { Session } from './types';",
      "import {",
      "  shown,",
      "} from './shown';",
      "export * from './again';",
      "import './side-effect';",
      "import { motion } from 'framer-motion';",
      "import { useState } from 'react';",
      "const Lazy = lazy(() => import('./lazy'));",
      "export type Client = typeof import('./client')['client'];",
      "const load = () => import('@/lib/heavy');",
    ].join('\n'));
    const shown = write('shown.ts', "export const shown = 1;\nimport { deeper } from './deeper';\n");
    const again = write('again.ts', 'export const again = 1;\n');
    const sideEffect = write('side-effect.ts', '');
    const deeper = write('deeper.ts', 'export const deeper = 1;\n');
    write('types.ts', 'export type Session = object;\n');
    write('lazy.tsx', "import 'heavy-package';\n");
    write('client.ts', 'export const client = 1;\n');
    write('lib/heavy.ts', "import 'another-heavy-package';\n");

    const { files, packages } = staticImportClosure([page], fixtureRoot);
    expect([...files].sort()).toEqual([again, deeper, page, shown, sideEffect].sort());
    expect([...packages.keys()].sort()).toEqual(['framer-motion', 'react']);
  });
});
