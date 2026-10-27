import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/**
 * The web app, the server and the web tests load platform-free modules from
 * folders under ugc-mobile/lib, and two things break only away from a machine
 * that has the whole mobile workspace.
 *
 * Vercel uploads only what .vercelignore lets through. It once excluded the
 * whole workspace, and the staged production build failed with "Module not
 * found" on 2026-09-14 while every local build passed. Now ugc-mobile/lib is
 * uploaded whole and the rest of the workspace is not, so whatever the build
 * reaches in the workspace must sit in lib. That includes what it reaches only
 * with `import type`: `next build` type-checks the app against the upload.
 *
 * The web CI test job has no ugc-mobile/node_modules, and Vite reads the nearest
 * tsconfig.json of every TypeScript file it transforms. ugc-mobile/tsconfig.json
 * extends expo/tsconfig.base, which is not installed there, so a mobile file the
 * web loads at run time needs a nearer tsconfig.json that extends nothing, or
 * the web tests fail on the runner with TSCONFIG_ERROR.
 *
 * What the web reaches is read from the code itself rather than listed here, so
 * a new shared folder cannot be forgotten.
 */

const repoRoot = process.cwd();
// The configuration `next build` type-checks with and resolves modules by.
const rootConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile('tsconfig.json', ts.sys.readFile).config,
  ts.sys,
  repoRoot,
);
// The files whose type errors `next build` ignores (next/dist/lib/typescript/runTypeCheck.js).
const IGNORED_BY_NEXT_TYPE_CHECK = /[\\/]__(?:tests|mocks)__[\\/]|(?<=[\\/.])(?:spec|test)\.[^\\/]+$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;

type ModuleReference = { specifier: string; typeOnly: boolean };

/**
 * Every module a file names: imports, re-exports, `import()`, `require()`, and
 * the Vitest calls that load a module's real code (`vi.importActual`,
 * `vi.importMock`, and `vi.mock` or `vi.doMock` with no factory or one that is
 * handed the original). `typeOnly` marks what the compiler erases (`import type`,
 * `export type`, `typeof import(…)`): it loads nothing at run time, but the type
 * check still reads it. An import of `type` names alone (`import { type A }`)
 * counts as loading the module, though the compiler drops it too.
 */
function moduleReferences(fileName: string, source: string): ModuleReference[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const references: ModuleReference[] = [];
  const add = (node: ts.Node | undefined, typeOnly: boolean) => {
    if (node && ts.isStringLiteralLike(node)) references.push({ specifier: node.text, typeOnly });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier, Boolean(node.importClause?.isTypeOnly));
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const [first, factory] = node.arguments;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
        add(first, false);
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi') {
        const method = callee.name.text;
        const loadsOriginal = !factory || (ts.isFunctionLike(factory) && factory.parameters.length > 0);
        if (method === 'importActual' || method === 'importMock' || ((method === 'mock' || method === 'doMock') && loadsOriginal)) {
          add(first, false);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

/**
 * The repo path of what `specifier` in `importer` loads, as the build resolves
 * it, or undefined for a package. A path TypeScript cannot resolve (an image,
 * say) keeps its plain relative meaning.
 */
function resolveReference(importer: string, specifier: string) {
  const { resolvedModule } = ts.resolveModuleName(specifier, resolve(importer), rootConfig.options, ts.sys);
  if (resolvedModule) {
    return resolvedModule.isExternalLibraryImport ? undefined : relative(repoRoot, resolvedModule.resolvedFileName);
  }
  return specifier.startsWith('.') ? relative(repoRoot, resolve(dirname(importer), specifier)) : undefined;
}

/**
 * Every mobile-workspace file reached from `roots`, each with the first file
 * found naming it. `withTypes` follows type-only references too, as the type
 * check does; without it, only what loads at run time.
 */
function mobileFilesReached(roots: string[], withTypes: boolean) {
  const reached = new Map<string, string>();
  const pending = [...roots];
  // A file reached in the workspace joins the walk, so what it names counts too.
  for (const file of pending) {
    const source = readFileSync(file, 'utf8');
    const inWorkspace = file.startsWith('ugc-mobile/');
    if (!inWorkspace && !source.includes('ugc-mobile')) continue;
    for (const { specifier, typeOnly } of moduleReferences(file, source)) {
      if (typeOnly && !withTypes) continue;
      // Outside the workspace only a path that names it leads there; inside it, a bare name is a package.
      if (inWorkspace ? !specifier.startsWith('.') : !specifier.includes('ugc-mobile')) continue;
      const target = resolveReference(file, specifier);
      if (!target?.startsWith('ugc-mobile/') || reached.has(target)) continue;
      reached.set(target, file);
      if (SOURCE_FILE.test(target) && existsSync(target)) pending.push(target);
    }
  }
  return reached;
}

/** Every file under `folder` whose name matches `pattern`, as a path from the repo root. */
function filesUnder(folder: string, pattern: RegExp) {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((file) => pattern.test(file))
    .map((file) => join(folder, file));
}

/** The tsconfig.json Vite reads for `file`: the nearest one up its folders. */
function nearestTsconfig(file: string) {
  let folder = dirname(file);
  while (folder !== '.' && !existsSync(join(folder, 'tsconfig.json'))) folder = dirname(folder);
  return join(folder, 'tsconfig.json');
}

it('uploads ugc-mobile/lib whole and nothing else of the mobile workspace', () => {
  // Gitignore keeps a pattern's leading spaces and applies the last line that
  // matches, so every line naming the workspace is compared as written.
  const workspaceLines = readFileSync('.vercelignore', 'utf8')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.startsWith('#') && line.includes('ugc-mobile'));
  expect(workspaceLines).toEqual(['ugc-mobile/*', '!ugc-mobile/lib']);
});

it('keeps everything the web build reaches in the mobile workspace inside ugc-mobile/lib', () => {
  // What `next build` reads: the type-checked program, and the app's JavaScript for the bundler.
  const roots = [
    ...rootConfig.fileNames.map((file) => relative(repoRoot, file)),
    ...filesUnder('src', /\.[cm]?jsx?$/),
  ].filter((file) => !IGNORED_BY_NEXT_TYPE_CHECK.test(file));
  const reached = mobileFilesReached(roots, true);
  // The walk found something: the app has loaded the catalog modules since the first of these.
  expect([...reached.keys()].some((file) => file.startsWith('ugc-mobile/lib/model-catalog/'))).toBe(true);
  const problems = [...reached]
    .filter(([file]) => !file.startsWith('ugc-mobile/lib/'))
    .map(([file, importer]) => `${importer} reaches ${file}, which .vercelignore keeps out of the Vercel upload (only ugc-mobile/lib goes up), so the build fails there`);
  expect(problems).toEqual([]);
});

it('gives every mobile file the web loads at run time a nearest tsconfig.json that extends nothing', () => {
  const reached = mobileFilesReached(filesUnder('src', SOURCE_FILE), false);
  expect([...reached.keys()].some((file) => file.startsWith('ugc-mobile/lib/model-catalog/'))).toBe(true);
  const problems: string[] = [];
  for (const [file, importer] of reached) {
    // Vite loads JSON and other assets without a tsconfig.
    if (!SOURCE_FILE.test(file) || file.endsWith('.d.ts')) continue;
    const configFile = nearestTsconfig(file);
    const config = ts.parseConfigFileTextToJson(configFile, readFileSync(configFile, 'utf8')).config;
    if (!config || 'extends' in config) {
      problems.push(
        `${importer} loads ${file}, whose nearest tsconfig.json is ${configFile}: give its folder a tsconfig.json `
        + "that extends nothing, like ugc-mobile/lib/model-catalog's, or the web tests fail on CI with TSCONFIG_ERROR",
      );
    }
  }
  expect(problems).toEqual([]);
});

it('reads every form that names a module, and marks the ones the compiler erases', () => {
  const source = [
    "import type { A } from 'import-type';",
    'import type {',
    '  B,',
    "} from 'multi-line-import-type';",
    "export type { C } from 'export-type';",
    "type D = typeof import('type-position-import');",
    "// import { e } from 'comment';",
    "const f = \"import { g } from 'string'\";",
    'import {',
    '  h,',
    "} from 'multi-line-import';",
    "import { type K } from 'type-names-alone';",
    "import 'side-effect-import';",
    "export * from 're-export';",
    "export { i } from 'named-re-export';",
    "const j = () => import('dynamic-import');",
    "const l = require('require-call');",
    "vi.mock('automock');",
    "vi.mock('mock-with-factory', () => ({}));",
    "vi.mock('mock-with-original', async (importOriginal) => importOriginal());",
    "const m = vi.importActual('import-actual');",
  ].join('\n');
  expect(moduleReferences('fixture.ts', source)).toEqual([
    { specifier: 'import-type', typeOnly: true },
    { specifier: 'multi-line-import-type', typeOnly: true },
    { specifier: 'export-type', typeOnly: true },
    { specifier: 'type-position-import', typeOnly: true },
    { specifier: 'multi-line-import', typeOnly: false },
    { specifier: 'type-names-alone', typeOnly: false },
    { specifier: 'side-effect-import', typeOnly: false },
    { specifier: 're-export', typeOnly: false },
    { specifier: 'named-re-export', typeOnly: false },
    { specifier: 'dynamic-import', typeOnly: false },
    { specifier: 'require-call', typeOnly: false },
    { specifier: 'automock', typeOnly: false },
    { specifier: 'mock-with-original', typeOnly: false },
    { specifier: 'import-actual', typeOnly: false },
  ]);
});
