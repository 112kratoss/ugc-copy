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
const PUBLIC_ROUTE_DIRECTORIES = new Set(['marketplace', 'showcase']);
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
  const routeSources = ['showcase', 'marketplace'].flatMap((directory) => (
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

    for (const publicDirectory of PUBLIC_ROUTE_DIRECTORIES) {
      expect(readFileSync(path.join(APP_ROOT, publicDirectory, 'layout.tsx'), 'utf8'))
        .not.toContain('non-public-utilities.css');
    }
    expect(readFileSync(path.join(APP_ROOT, 'layout.tsx'), 'utf8'))
      .not.toContain('non-public-utilities.css');
  });

  it('keeps globals.css aligned with the exact public component import closure', () => {
    const globalsCss = readFileSync(path.join(APP_ROOT, 'globals.css'), 'utf8');
    const declaredSources = getDeclaredSources(globalsCss);
    const closure = collectPublicImportClosure();
    const expectedComponentSources = [...closure]
      .filter((file) => file.startsWith(path.join(APP_ROOT, 'components') + path.sep))
      .map((file) => `./${path.relative(APP_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredComponentSources = declaredSources
      .filter((source) => source.startsWith('./components/'))
      .sort();

    expect(globalsCss).not.toContain('@source "./components";');
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
      .filter((file) => file.startsWith(path.join(APP_ROOT, 'components') + path.sep))
      .filter((file) => !publicClosure.has(file))
      .map((file) => `./${path.relative(APP_ROOT, file).split(path.sep).join('/')}`)
      .sort();
    const declaredComponentSources = declaredSources
      .filter((source) => source.startsWith('./components/'))
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
