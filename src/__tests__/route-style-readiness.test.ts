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
// Every route a signed-out visitor can land on: the marketing and SEO pages,
// share landings (`/creators/[username]`, `/r/[code]`), the
// template catalog and the sign-in/auth screens. These routes render with the
// root `globals.css` alone. With `experimental.inlineCss` on, a public route
// that also linked the supplement would inline both sheets twice per response.
// Signed-in-only pages that live inside these directories (`/templates/mine`,
// `/templates/new`, `/creators/[username]` actions) are scanned by the public
// sheet too; their component closure is already part of it. `/post` is not
// public: it holds only the composer and the edit page.
const PUBLIC_ROUTE_DIRECTORIES = new Set([
  'ai-image-generator',
  'ai-motion-transfer',
  'ai-video-generator',
  'ai-workflow-builder',
  'alternatives',
  'auth',
  'blog',
  'child-safety',
  'contact',
  'creators',
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

function collectPublicImportClosure(): Set<string> {
  const routeSources = [...PUBLIC_ROUTE_DIRECTORIES].flatMap((directory) => (
    walkFiles(path.join(APP_ROOT, directory)).filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file))
  ));

  return collectImportClosure([
    path.join(APP_ROOT, 'layout.tsx'),
    path.join(APP_ROOT, 'page.tsx'),
    ...routeSources,
  ]);
}

function collectNonPublicImportClosure(): Set<string> {
  const routeSources = readdirSync(APP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !PUBLIC_ROUTE_DIRECTORIES.has(entry.name) && entry.name !== 'api')
    .flatMap((entry) => walkFiles(path.join(APP_ROOT, entry.name)))
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file));

  return collectImportClosure(routeSources);
}

function getDeclaredSources(stylesheet: string): string[] {
  return [...stylesheet.matchAll(/@source\s+"([^"]+)";/g)].map((match) => match[1]);
}

describe('route utility stylesheet readiness', () => {
  it('links the supplemental utility sheet from every non-public visual route boundary', () => {
    const supplementalCss = readFileSync(path.join(APP_ROOT, 'non-public-utilities.css'), 'utf8');
    const declaredSources = new Set(getDeclaredSources(supplementalCss));
    const visualRouteDirectories = readdirSync(APP_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => walkFiles(path.join(APP_ROOT, entry.name)).some((file) => file.endsWith('/page.tsx')))
      .map((entry) => entry.name)
      // Parallel-route slots (`@modal`) are not route boundaries: they render
      // inside whichever route is already on screen, public or not, so they
      // cannot own a stylesheet. Requiring the private supplement here would
      // load authenticated-only CSS on public routes and invert the split.
      // Slot markup therefore lives under an already-scanned directory.
      .filter((directory) => !directory.startsWith('@'))
      .filter((directory) => !PUBLIC_ROUTE_DIRECTORIES.has(directory))
      .sort();

    for (const directory of visualRouteDirectories) {
      const layoutPath = path.join(APP_ROOT, directory, 'layout.tsx');
      expect(existsSync(layoutPath), `${directory} needs a route layout`).toBe(true);
      expect(readFileSync(layoutPath, 'utf8'), `${directory} must link the supplement`)
        .toContain(SUPPLEMENT_IMPORT);
      expect(declaredSources.has(`./${directory}`), `${directory} must be scanned`).toBe(true);
    }

    expect(supplementalCss).toContain('@import "tailwindcss/theme.css" theme(reference);');
    expect(supplementalCss).toContain('@import "tailwindcss/utilities.css" layer(utilities) source(none);');
    expect(supplementalCss).toContain('@source "../lib/client-generation-models.ts";');
    expect(supplementalCss).toContain('@source "../lib/models.ts";');
    expect(supplementalCss).not.toContain('@source "./showcase";');
    expect(supplementalCss).not.toContain('@source "./marketplace";');
    expect(supplementalCss).not.toContain('@source "./feed";');

    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    const publicSources = new Set(getDeclaredSources(globalsCss));
    for (const publicDirectory of PUBLIC_ROUTE_DIRECTORIES) {
      const layoutPath = path.join(APP_ROOT, publicDirectory, 'layout.tsx');
      if (existsSync(layoutPath)) {
        expect(readFileSync(layoutPath, 'utf8'), `${publicDirectory} must not link the supplement`)
          .not.toContain('non-public-utilities.css');
      }
      expect(publicSources.has(`./${publicDirectory}`), `${publicDirectory} must be scanned by globals.css`)
        .toBe(true);
      expect(declaredSources.has(`./${publicDirectory}`), `${publicDirectory} must not be scanned by the supplement`)
        .toBe(false);
    }
    expect(readFileSync(path.join(APP_ROOT, 'layout.tsx'), 'utf8'))
      .not.toContain('non-public-utilities.css');
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

  it('keeps the supplemental stylesheet aligned with the private component import closure', () => {
    const supplementalCss = readFileSync(path.join(APP_ROOT, 'non-public-utilities.css'), 'utf8');
    const declaredSources = getDeclaredSources(supplementalCss);
    const publicClosure = collectPublicImportClosure();
    const privateClosure = collectNonPublicImportClosure();
    const expectedComponentSources = [...privateClosure]
      .filter((file) => file.startsWith(path.join(SRC_ROOT, 'components') + path.sep))
      .filter((file) => !publicClosure.has(file))
      .map((file) => `../${path.relative(SRC_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredComponentSources = declaredSources
      .filter((source) => source.startsWith('../components/'))
      .sort();

    expect(declaredComponentSources).toEqual(expectedComponentSources);

    const expectedLibSources = [...privateClosure]
      .filter((file) => file.startsWith(path.join(SRC_ROOT, 'lib') + path.sep))
      .filter((file) => DYNAMIC_UTILITY_STRING.test(readFileSync(file, 'utf8')))
      .map((file) => `../${path.relative(SRC_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredLibSources = declaredSources
      .filter((source) => source.startsWith('../lib/'))
      .sort();

    expect(declaredLibSources).toEqual(expectedLibSources);
  });
});
