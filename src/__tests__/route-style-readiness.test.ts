import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const APP_ROOT = path.join(SRC_ROOT, 'app');
const SUPPLEMENT_IMPORT = "import '@/app/non-public-utilities.css';";
const SUPPLEMENT_IMPORT_PATTERN = /import\s+['"][^'"]*non-public-utilities\.css['"]/;
// Every route a signed-out visitor can land on: the marketing and SEO pages,
// the policy pages (the store listings link account deletion), share landings
// (`/creators/[username]`, `/r/[code]`), the
// template catalog and the sign-in/auth screens. A full load of these routes
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
  'pricing',
  'privacy',
  'r',
  'showcase',
  'templates',
  'terms',
]);
// Every other route folder: the signed-in surfaces, each with a layout that
// links the supplement. Search and Alerts also draw for a signed-out visitor
// (results, a sign-in card) and keep it. A folder in neither list fails: one
// left out used to count as signed-in, so a new public page built on a
// signed-in layout passed and inlined both sheets.
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
  'notifications',
  'post',
  'profile',
  'search',
  'template-runs',
  'unlocks',
  'welcome-reward',
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

function collectImportClosure(entryFiles: string[]): Set<string> {
  const pendingFiles = [...entryFiles];
  const visitedFiles = new Set<string>();

  while (pendingFiles.length > 0) {
    const file = pendingFiles.pop();
    if (!file || visitedFiles.has(file)) {
      continue;
    }

    visitedFiles.add(file);
    const source = readFileSync(file, 'utf8');
    const importPattern = /(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(importPattern)) {
      const importedFile = resolveLocalImport(match[1], file);
      if (importedFile && !visitedFiles.has(importedFile)) {
        pendingFiles.push(importedFile);
      }
    }
  }

  return visitedFiles;
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

function collectPublicImportClosure(): Set<string> {
  const routeSources = [...PUBLIC_ROUTE_DIRECTORIES].flatMap((directory) => (
    walkFiles(path.join(APP_ROOT, directory)).filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file))
  ));

  return collectImportClosure([...listRootMarkupFiles(), ...routeSources]);
}

/** Every file any route can draw: the root's own files and every route folder, with what they import. */
function collectRouteImportClosure(): Set<string> {
  const routeSources = readdirSync(APP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'api')
    .flatMap((entry) => walkFiles(path.join(APP_ROOT, entry.name)))
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file));

  return collectImportClosure([...listRootMarkupFiles(), ...routeSources]);
}

/**
 * The folders of src/app that draw a route: every one with markup in it, but
 * the API routes. Parallel-route slots (`@modal`) are not route boundaries:
 * they render inside whichever route is already on screen, public or not, so
 * they cannot own a stylesheet (the slot test below keeps markup out of them).
 */
function listRouteDirectories(): string[] {
  return readdirSync(APP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'api' && !entry.name.startsWith('@'))
    .filter((entry) => walkFiles(path.join(APP_ROOT, entry.name)).some((file) => /\.(?:tsx|jsx)$/.test(file)))
    .map((entry) => entry.name)
    .sort();
}

// Tailwind reads either quote.
function getDeclaredSources(stylesheet: string): string[] {
  return [...stylesheet.matchAll(/@source\s+(["'])([^"']+)\1\s*;/g)].map((match) => match[2]);
}

function getExcludedSources(stylesheet: string): string[] {
  return [...stylesheet.matchAll(/@source\s+not\s+(["'])([^"']+)\1\s*;/g)].map((match) => match[2]);
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
    // that also draws a signed-out state (Search, Alerts) keeps the supplement.
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
    // itself in the closure.
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
    expect(supplementalCss).toMatch(/@source\s+not\s+"\.\/api";/);

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
