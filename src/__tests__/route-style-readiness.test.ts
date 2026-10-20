import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const APP_ROOT = path.join(SRC_ROOT, 'app');
const SUPPLEMENT_IMPORT = "import '@/app/non-public-utilities.css';";
const SUPPLEMENT_IMPORT_PATTERN = /import\s+['"][^'"]*non-public-utilities\.css['"]/;
// Every route a signed-out visitor can land on: the marketing and SEO pages,
// the policy pages (the store listings link account deletion), share landings
// (`/creators/[username]`, `/r/[code]`), the
// template catalog, the sign-in/auth screens and Alerts, whose sign-in card a
// signed-out visitor reaches from the shell on every page (its signed-in half
// is a lazy boundary, below). A full load of these routes
// carries the root `globals.css` alone (a client navigation from a route that
// links the supplement keeps the supplement, which is why it scans every
// route). With `experimental.inlineCss` on, a public route that also linked the
// supplement would inline both sheets twice per response.
// Signed-in-only pages that live inside these directories (`/templates/mine`,
// `/templates/new`, `/creators/[username]` actions) are scanned by the public
// sheet too; their component closure is already part of it. `/delete-account`'s
// signed-in deletion form rides on the public sheet the same way, and so does a
// file of a signed-in folder that a public page draws (the profile editor an
// owner opens on their creator page): globals.css names each one. `/post` is not
// public: it holds only the composer and the edit page.
const PUBLIC_ROUTE_DIRECTORIES = new Set([
  'ai-image-generator',
  'ai-motion-transfer',
  'ai-video-generator',
  'ai-workflow-builder',
  'alternatives',
  'auth',
  'blog',
  'cancellation',
  'child-safety',
  'contact',
  'creators',
  'delete-account',
  'feed',
  'login',
  'marketplace',
  'models',
  'notifications',
  'pricing',
  'privacy',
  'r',
  'showcase',
  'templates',
  'terms',
]);
// Every other route folder: the signed-in surfaces, each with a layout that
// links the supplement. Search also draws for a signed-out visitor (its
// results) and keeps it. A folder in neither list fails: one left out used to
// count as signed-in, so a new public page built on a signed-in layout passed
// and inlined both sheets.
const SIGNED_IN_ROUTE_DIRECTORIES = new Set([
  'admin',
  'create',
  'create-image',
  'create-motion',
  'create-video',
  'create-workflow',
  'creations',
  'credits',
  'home',
  'invite',
  'post',
  'profile',
  'search',
  'template-runs',
  'unlocks',
  'welcome-reward',
]);
// A public page's signed-in half that brings the supplement itself, loaded with
// import() only once a reader is known: Alerts is the shell's tab on every
// page, so a signed-out visitor opens it, and its layout used to give every
// such visit the signed-in sheet. Each is relative to src/app; globals.css
// skips it (`@source not`), and the public import closure stops there: what it
// draws is drawn with the sheet it brings.
const LAZY_SUPPLEMENT_BOUNDARIES = new Set([
  'notifications/SignedInAlerts.tsx',
]);
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DYNAMIC_UTILITY_STRING = /['"`](?:[^'"`]*\s)?(?:from|via|to|bg|text|border|ring|shadow)-(?:\[[^\]]+\]|[a-z]+-\d{2,3})(?:\s+[^'"`]*)?['"`]/;

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

function resolveLocalImport(specifier: string, importer: string): string | null {
  const unresolvedPath = specifier.startsWith('@/')
    ? path.join(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(importer), specifier)
      : null;

  if (!unresolvedPath) {
    return null;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${unresolvedPath}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(unresolvedPath, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

/**
 * Every file the entries import, and what those import. An `import()` of a file
 * in `lazyBoundaries` is not followed: it loads on demand, with the sheet it
 * brings. A static import of one is followed, so the boundary and what it draws
 * land in the closure, where the supplement checks name them: for a while the
 * wall stood whatever the import form, and a page importing its half with
 * `from` passed the closure checks.
 */
function collectImportClosure(entryFiles: string[], lazyBoundaries: ReadonlySet<string> = new Set()): Set<string> {
  const pendingFiles = [...entryFiles];
  const visitedFiles = new Set<string>();

  while (pendingFiles.length > 0) {
    const file = pendingFiles.pop();
    if (!file || visitedFiles.has(file)) {
      continue;
    }

    visitedFiles.add(file);
    const source = readFileSync(file, 'utf8');
    const importPattern = /(from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(importPattern)) {
      const importedFile = resolveLocalImport(match[2], file);
      if (!importedFile || visitedFiles.has(importedFile)) {
        continue;
      }
      const onDemand = match[1].startsWith('import') && lazyBoundaries.has(importedFile);
      if (!onDemand) {
        pendingFiles.push(importedFile);
      }
    }
  }

  return visitedFiles;
}

// `from '…'`, wherever it is, and a bare `import '…'`: both load the module with
// its importer. `import('…')` loads it on demand.
const STATIC_IMPORT_PATTERN = /(?:\bfrom\s*|^\s*import\s*)['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"]([^'"]+)['"]/g;

/** The files among `candidates` with an import matching `pattern` that resolves to `file`, relative to src. */
function importersOf(file: string, pattern: RegExp, candidates: string[]): string[] {
  return candidates
    .filter((importer) => [...readFileSync(importer, 'utf8').matchAll(pattern)]
      .some((match) => resolveLocalImport(match[1], importer) === file))
    .map((importer) => path.relative(SRC_ROOT, importer));
}

/** Every source file of src but the tests: a static import of a lazy boundary from anywhere loads it with its importer. */
function listSourceFiles(): string[] {
  const testsRoot = path.join(SRC_ROOT, '__tests__') + path.sep;
  return walkFiles(SRC_ROOT).filter((file) => !file.startsWith(testsRoot) && /\.(?:ts|tsx|js|jsx)$/.test(file));
}

/**
 * The root folder's own markup: the layout around every route, the home page
 * and the not-found that any address with no page draws, all public.
 */
function listRootMarkupFiles(): string[] {
  return readdirSync(APP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:tsx|jsx)$/.test(entry.name))
    .map((entry) => path.join(APP_ROOT, entry.name))
    .sort();
}

/**
 * What a public route draws with globals.css alone: it stops where a lazy
 * supplement boundary is loaded with import(). A boundary is no entry of its
 * own, though its folder is public: it draws only once loaded.
 */
function collectPublicImportClosure(): Set<string> {
  const boundaries = new Set([...LAZY_SUPPLEMENT_BOUNDARIES].map((boundary) => path.join(APP_ROOT, boundary)));
  const routeSources = [...PUBLIC_ROUTE_DIRECTORIES].flatMap((directory) => (
    walkFiles(path.join(APP_ROOT, directory)).filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file) && !boundaries.has(file))
  ));

  return collectImportClosure([...listRootMarkupFiles(), ...routeSources], boundaries);
}

/** Every file any route can draw: the root's own files and every route folder, with what they import. */
function collectRouteImportClosure(): Set<string> {
  const routeSources = readdirSync(APP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'api')
    .flatMap((entry) => walkFiles(path.join(APP_ROOT, entry.name)))
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file));

  return collectImportClosure([...listRootMarkupFiles(), ...routeSources]);
}

// The files Next draws a segment with. A file with markup alone draws no route.
const SEGMENT_FILE = /^(?:page|layout|template|default|loading|error|not-found|forbidden|unauthorized)\.(?:tsx|jsx|ts|js)$/;

/** Whether a folder holds a segment file, at any depth outside a private `_folder` (which Next leaves out of routing). */
function drawsRoute(directory: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).some((entry) => (
    entry.isDirectory()
      ? !entry.name.startsWith('_') && drawsRoute(path.join(directory, entry.name))
      : SEGMENT_FILE.test(entry.name)
  ));
}

/**
 * The folders of src/app that draw a route: every one with a segment file in
 * it, but the API routes. A private folder (`_shared`) is no route, and nor is
 * a route group that holds only components. Parallel-route slots (`@modal`) are
 * not route boundaries: they render inside whichever route is already on
 * screen, public or not, so they cannot own a stylesheet (the slot test below
 * keeps markup out of them).
 */
function listRouteDirectories(appRoot = APP_ROOT): string[] {
  return readdirSync(appRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'api' && !/^[@_]/.test(entry.name))
    .filter((entry) => drawsRoute(path.join(appRoot, entry.name)))
    .map((entry) => entry.name)
    .sort();
}

// Tailwind reads either quote, and a folder with or without a trailing slash;
// `./` keeps its own.
function normalizeSource(source: string): string {
  return source.replace(/([^./])\/+$/, '$1');
}

function getDeclaredSources(stylesheet: string): string[] {
  return [...stylesheet.matchAll(/@source\s+(["'])([^"']+)\1\s*;/g)].map((match) => normalizeSource(match[2]));
}

function getExcludedSources(stylesheet: string): string[] {
  return [...stylesheet.matchAll(/@source\s+not\s+(["'])([^"']+)\1\s*;/g)].map((match) => normalizeSource(match[2]));
}

/** Whether a sheet's source lines reach `file`: a line naming it or a folder above it, and no `not` line doing the same. */
function isScannedBy(stylesheet: string, file: string): boolean {
  const reaches = (source: string) => {
    const scanned = path.resolve(APP_ROOT, source);
    return file === scanned || file.startsWith(`${scanned}${path.sep}`);
  };
  return getDeclaredSources(stylesheet).some(reaches) && !getExcludedSources(stylesheet).some(reaches);
}

describe('route utility stylesheet readiness', () => {
  it('classifies every route folder as public or signed-in', () => {
    const routeDirectories = listRouteDirectories();
    expect(
      routeDirectories.filter((directory) => (
        !PUBLIC_ROUTE_DIRECTORIES.has(directory) && !SIGNED_IN_ROUTE_DIRECTORIES.has(directory)
      )),
      'route folders in neither list: one a signed-out visitor can land on goes in PUBLIC_ROUTE_DIRECTORIES and '
        + 'globals.css, any other in SIGNED_IN_ROUTE_DIRECTORIES with a layout that links the supplement',
    ).toEqual([]);
    expect(
      [...PUBLIC_ROUTE_DIRECTORIES].filter((directory) => SIGNED_IN_ROUTE_DIRECTORIES.has(directory)),
      'route folders in both lists',
    ).toEqual([]);
    expect(
      [...PUBLIC_ROUTE_DIRECTORIES, ...SIGNED_IN_ROUTE_DIRECTORIES].filter((directory) => !routeDirectories.includes(directory)),
      'listed folders that draw no route',
    ).toEqual([]);
  });

  it('links the supplemental utility sheet from every signed-in route layout', () => {
    const supplementalCss = readFileSync(path.join(APP_ROOT, 'non-public-utilities.css'), 'utf8');

    // A page made for signed-out visitors (marketing, policy, a landing) belongs
    // in PUBLIC_ROUTE_DIRECTORIES and globals.css instead. A signed-in surface
    // that also draws a signed-out state keeps the supplement (Search), or
    // loads it with its signed-in half (Alerts, LAZY_SUPPLEMENT_BOUNDARIES).
    for (const directory of [...SIGNED_IN_ROUTE_DIRECTORIES].sort()) {
      const layoutPath = path.join(APP_ROOT, directory, 'layout.tsx');
      expect(existsSync(layoutPath), `${directory} is signed-in, so it needs a route layout`).toBe(true);
      expect(readFileSync(layoutPath, 'utf8'), `${directory} is signed-in, so its layout must link the supplement`)
        .toContain(SUPPLEMENT_IMPORT);
    }

    expect(supplementalCss).toContain('@import "tailwindcss/theme.css" theme(reference);');
    expect(supplementalCss).toContain('@import "tailwindcss/utilities.css" layer(utilities) source(none);');

    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    const publicSources = new Set(getDeclaredSources(globalsCss));
    for (const publicDirectory of PUBLIC_ROUTE_DIRECTORIES) {
      expect(publicSources.has(`./${publicDirectory}`), `${publicDirectory} must be scanned by globals.css`)
        .toBe(true);
    }
    // And no other route folder: one left in globals.css after its route went
    // signed-in would put that route's utilities on every public page.
    const scannedRouteDirectories = [...publicSources]
      .filter((source) => /^\.\/[^./]+$/.test(source))
      .map((source) => source.slice('./'.length))
      .sort();
    expect(scannedRouteDirectories, 'route folders globals.css scans').toEqual([...PUBLIC_ROUTE_DIRECTORIES].sort());
    // Nothing a public route draws links the supplement: a page, a nested
    // layout or a component it imports would inline both sheets twice as surely
    // as its layout would. The import walker does not follow a bare CSS
    // import, so every file is read; any other import form puts the sheet
    // itself in the closure. The closure stops only at an import() of a lazy
    // boundary: a public file importing one with `from` brings it in, and it
    // fails here. The next case holds every importer in src to import().
    const publicClosure = collectPublicImportClosure();
    expect(publicClosure.has(path.join(APP_ROOT, 'non-public-utilities.css')), 'a public route imports the supplement')
      .toBe(false);
    for (const file of publicClosure) {
      expect(readFileSync(file, 'utf8'), `${path.relative(SRC_ROOT, file)} must not link the supplement`)
        .not.toMatch(SUPPLEMENT_IMPORT_PATTERN);
    }
    // An address with no page draws the root's files with globals.css alone,
    // and the not-found rides in every page's payload: none links the supplement.
    const rootMarkupFiles = listRootMarkupFiles().map((file) => path.basename(file));
    expect(rootMarkupFiles).toEqual(expect.arrayContaining(['layout.tsx', 'not-found.tsx', 'page.tsx']));
    for (const file of rootMarkupFiles) {
      expect(publicSources.has(`./${file}`), `${file} must be scanned by globals.css`).toBe(true);
      expect(readFileSync(path.join(APP_ROOT, file), 'utf8'), `${file} must not link the supplement`)
        .not.toContain('non-public-utilities.css');
    }
  });

  // A static import of a boundary would put the supplement among the page's
  // own stylesheets for every visitor again, and a globals.css line reaching
  // it would put its utilities on every public page: import() alone loads it,
  // and only the supplement scans it.
  it('loads each lazy supplement boundary with import() alone, and only the supplement scans it', () => {
    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    const supplementalCss = readFileSync(path.join(APP_ROOT, 'non-public-utilities.css'), 'utf8');
    const sourceFiles = listSourceFiles();

    for (const boundary of LAZY_SUPPLEMENT_BOUNDARIES) {
      const file = path.join(APP_ROOT, boundary);
      expect(existsSync(file), `${boundary} is there`).toBe(true);
      expect(readFileSync(file, 'utf8'), `${boundary} links the supplement`).toContain(SUPPLEMENT_IMPORT);
      expect(isScannedBy(globalsCss, file), `globals.css must skip ${boundary} (@source not)`).toBe(false);
      expect(isScannedBy(supplementalCss, file), `the supplement scans ${boundary}`).toBe(true);
      expect(importersOf(file, STATIC_IMPORT_PATTERN, sourceFiles), `${boundary} must be loaded with import() alone`)
        .toEqual([]);
      expect(importersOf(file, DYNAMIC_IMPORT_PATTERN, sourceFiles), `something loads ${boundary}`).not.toEqual([]);
    }
  });

  it('keeps parallel-route slots free of styled markup so an unscanned file cannot ship classes', () => {
    const slotDirectories = readdirSync(APP_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('@'))
      .map((entry) => entry.name);

    for (const slot of slotDirectories) {
      for (const file of walkFiles(path.join(APP_ROOT, slot))) {
        if (!/\.(?:tsx|jsx)$/.test(file)) continue;

        expect(
          readFileSync(file, 'utf8'),
          `${path.relative(APP_ROOT, file)} must delegate markup to a scanned directory`,
        ).not.toMatch(/className=/);
      }
    }
  });

  it('keeps globals.css aligned with the exact public component import closure', () => {
    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    const declaredSources = getDeclaredSources(globalsCss);
    const closure = collectPublicImportClosure();
    const expectedComponentSources = [...closure]
      .filter((file) => file.startsWith(path.join(SRC_ROOT, 'components') + path.sep))
      .map((file) => `../${path.relative(SRC_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredComponentSources = declaredSources
      .filter((source) => source.startsWith('../components/'))
      .sort();

    expect(globalsCss).not.toContain('@source "../components";');
    expect(declaredComponentSources).toEqual(expectedComponentSources);

    const expectedLibSources = [...closure]
      .filter((file) => file.startsWith(path.join(SRC_ROOT, 'lib') + path.sep))
      .filter((file) => DYNAMIC_UTILITY_STRING.test(readFileSync(file, 'utf8')))
      .map((file) => `../${path.relative(SRC_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredLibSources = declaredSources
      .filter((source) => source.startsWith('../lib/'))
      .sort();

    expect(declaredLibSources).toEqual(expectedLibSources);
  });

  // A public page can draw a file that lives in a signed-in folder: a creator's
  // own page opens the profile editor from src/app/creations. A full load draws
  // it with globals.css alone, so globals.css has to scan it; the supplement,
  // which scans every route, drew it right only after a client navigation from
  // a signed-in route.
  it('scans every file of the app folder that a public route draws', () => {
    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    const appFiles = [...collectPublicImportClosure()].filter((file) => file.startsWith(`${APP_ROOT}${path.sep}`));
    expect(
      appFiles.filter((file) => !isScannedBy(globalsCss, file)).map((file) => path.relative(SRC_ROOT, file)).sort(),
      'files a public route draws that globals.css does not scan: name each as @source "./<folder>/<file>"',
    ).toEqual([]);

    // File for file, as the component lines are: a line left after nothing
    // public draws its file any more puts a signed-in file's utilities on every
    // public page.
    const isInPublicFolder = (relative: string) => PUBLIC_ROUTE_DIRECTORIES.has(relative.split('/')[0]);
    const expectedFileSources = appFiles
      .map((file) => path.relative(APP_ROOT, file).split(path.sep).join('/'))
      .filter((relative) => relative.includes('/') && !isInPublicFolder(relative))
      .map((relative) => `./${relative}`)
      .sort();
    const declaredFileSources = getDeclaredSources(globalsCss)
      .filter((source) => /^\.\/[^/]+\/./.test(source) && !isInPublicFolder(source.slice('./'.length)))
      .sort();
    expect(declaredFileSources, 'files of signed-in folders that globals.css names').toEqual(expectedFileSources);
  });

  // The supplement comes after globals.css in the same cascade layer, and it
  // stays in the document after a client navigation, so every page can be
  // drawn with it: it has to hold every utility any route draws for its own
  // order to decide (`.claude/rules/web-routes-and-css.md` has the history;
  // `route-style-two-sheet-order.test.ts` checks the compiled sheets).
  it('scans every route, every component and the registries any route imports into the supplement', () => {
    const supplementalCss = readFileSync(path.join(APP_ROOT, 'non-public-utilities.css'), 'utf8');
    const declaredSources = getDeclaredSources(supplementalCss);
    // The whole app folder but its API routes, and the whole components
    // folder: a narrower line would only repeat these.
    expect(declaredSources.filter((source) => !source.startsWith('../lib/'))).toEqual(['./', '../components']);
    expect(getExcludedSources(supplementalCss)).toContain('./api');

    const expectedLibSources = [...collectRouteImportClosure()]
      .filter((file) => file.startsWith(path.join(SRC_ROOT, 'lib') + path.sep))
      .filter((file) => DYNAMIC_UTILITY_STRING.test(readFileSync(file, 'utf8')))
      .map((file) => `../${path.relative(SRC_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredLibSources = declaredSources
      .filter((source) => source.startsWith('../lib/'))
      .sort();

    expect(declaredLibSources).toEqual(expectedLibSources);
  });

  // The glob that reads `@source` takes `[id]` for a set of letters, so a line
  // naming a bracketed folder scans nothing and fails no other test.
  it('names no bracketed folder in a source line', () => {
    for (const stylesheet of ['globals.css', 'non-public-utilities.css']) {
      const sources = getDeclaredSources(readFileSync(path.join(APP_ROOT, stylesheet), 'utf8'));
      expect(
        sources.filter((source) => /[[\]]/.test(source)),
        `${stylesheet}: name the folder above it, or write the bracketed part as *`,
      ).toEqual([]);
    }
  });
});

// The readers above, on made-up trees: shapes the repo has not grown yet, where
// the checks once failed with nothing wrong or passed with something wrong.
describe('the readiness test reads', () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'route-style-readiness-'));
  const write = (relative: string, source = '') => {
    const file = path.join(fixtureRoot, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
  };

  afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

  it('a source line with or without its trailing slash', () => {
    const stylesheet = [
      '@source "./notifications/";',
      "@source './terms';",
      '@source "./";',
      '@source "../components/";',
      '@source not "./notifications/SignedInAlerts.tsx";',
      '@source not "./api/";',
    ].join('\n');

    expect(getDeclaredSources(stylesheet)).toEqual(['./notifications', './terms', './', '../components']);
    expect(getExcludedSources(stylesheet)).toEqual(['./notifications/SignedInAlerts.tsx', './api']);
    expect(isScannedBy(stylesheet, path.join(APP_ROOT, 'notifications', 'page.tsx'))).toBe(true);
    expect(isScannedBy(stylesheet, path.join(APP_ROOT, 'notifications', 'SignedInAlerts.tsx'))).toBe(false);
  });

  it('a route folder by its segment files, not by markup alone', () => {
    write('app/public-page/page.tsx');
    write('app/(pages)/pricing/page.tsx');
    write('app/(components)/Card.tsx');
    write('app/_shared/Card.tsx');
    write('app/_shared/page.tsx');
    write('app/kit/Card.tsx');
    write('app/kit/_preview/page.tsx');
    write('app/@modal/default.tsx');
    write('app/api/thing/route.ts');
    write('app/rss/route.ts');

    expect(listRouteDirectories(path.join(fixtureRoot, 'app'))).toEqual(['(pages)', 'public-page']);
  });

  it('a lazy boundary into the closure when imported with from, and not when loaded with import()', () => {
    const half = write('closure/Half.tsx', "import './sheet.css';\nimport { rows } from './rows';\n");
    const rows = write('closure/rows.ts', 'export const rows = [];\n');
    const staticPage = write('closure/static-page.tsx', "import Half from './Half';\n");
    const lazyPage = write('closure/lazy-page.tsx', "const Half = dynamic(() => import('./Half'));\n");
    const boundaries = new Set([half]);

    expect([...collectImportClosure([staticPage], boundaries)]).toEqual(expect.arrayContaining([half, rows]));
    expect([...collectImportClosure([lazyPage], boundaries)]).toEqual([lazyPage]);
    expect(importersOf(half, STATIC_IMPORT_PATTERN, [staticPage, lazyPage])).toEqual([path.relative(SRC_ROOT, staticPage)]);
    expect(importersOf(half, DYNAMIC_IMPORT_PATTERN, [staticPage, lazyPage])).toEqual([path.relative(SRC_ROOT, lazyPage)]);
  });
});
