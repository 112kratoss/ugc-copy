import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

/**
 * The web bundle and the server import platform-free modules from folders
 * under ugc-mobile/lib. Vercel uploads only what .vercelignore lets through,
 * and it excluded the whole mobile workspace, so the staged production build
 * failed with "Module not found" on 2026-09-14 while every local build passed.
 * Gitignore semantics cannot re-include a file under an excluded directory, so
 * the contents are excluded level by level and each shared folder is
 * re-included explicitly. Each folder also carries a tsconfig.json that
 * extends nothing: Vite resolves the nearest one for every TypeScript file it
 * transforms, and ugc-mobile/tsconfig.json extends expo/tsconfig.base, which
 * the web CI never installs, so the web tests fail there with TSCONFIG_ERROR.
 *
 * Both break only on Vercel or the CI runner, never on a machine that has the
 * whole mobile workspace, so the folders are read from the imports themselves
 * rather than listed here: a new one cannot be forgotten.
 */

const repoRoot = process.cwd();

/** Every TypeScript file under a folder, as a path from the repo root. */
function typeScriptFiles(folder: string) {
  return readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(folder, file));
}

/**
 * What a file loads at run time: its imports, re-exports and import() calls.
 * `import type`, `export type` and a type's `typeof import(…)` are erased by
 * the compiler, so they load nothing. An import of `type` names alone
 * (`import { type A }`) still counts, though the compiler drops it too: write
 * it as `import type`.
 */
function runtimeSpecifiers(fileName: string, source: string) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    let specifier: ts.Node | undefined;
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      specifier = node.moduleSpecifier;
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      specifier = node.moduleSpecifier;
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

it('keeps every ugc-mobile/lib folder the web loads in the Vercel upload, with a tsconfig.json of its own', () => {
  const lines = readFileSync('.vercelignore', 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  expect(lines).not.toContain('ugc-mobile');
  expect(lines).not.toContain('ugc-mobile/');
  const order = ['ugc-mobile/*', '!ugc-mobile/lib', 'ugc-mobile/lib/*'].map((pattern) => lines.indexOf(pattern));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);

  // Each shared folder, with the first file found loading it.
  const folders = new Map<string, string>();
  const problems: string[] = [];
  const files = typeScriptFiles('src');
  // A shared folder's files join the walk when it is found, so what they load counts too.
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    if (!file.startsWith('ugc-mobile/') && !source.includes('ugc-mobile')) continue;
    for (const specifier of runtimeSpecifiers(file, source)) {
      if (!specifier.startsWith('.')) continue;
      const target = relative(repoRoot, resolve(dirname(file), specifier));
      const [workspace, lib, folder, ...rest] = target.split('/');
      if (workspace !== 'ugc-mobile') continue;
      if (lib !== 'lib') {
        problems.push(`${file} loads ${target}, which ugc-mobile/* keeps out of the Vercel upload`);
      } else if (!folder || (rest.length === 0 && !statSync(join('ugc-mobile/lib', folder), { throwIfNoEntry: false })?.isDirectory())) {
        problems.push(
          `${file} loads ${target}, a file directly in ugc-mobile/lib: move it into a shared folder. `
          + 'ugc-mobile/lib/* keeps it out of the Vercel upload, and its nearest tsconfig.json is '
          + 'ugc-mobile/tsconfig.json, which fails on CI with TSCONFIG_ERROR',
        );
      } else if (!folders.has(folder)) {
        folders.set(folder, file);
        files.push(...typeScriptFiles(join('ugc-mobile/lib', folder)));
      }
    }
  }

  // The walk found something: the catalog modules have been shared since the first of these.
  expect([...folders.keys()]).toContain('model-catalog');
  for (const [folder, importer] of folders) {
    const reinclude = `!ugc-mobile/lib/${folder}`;
    if (!(lines.indexOf(reinclude) > lines.indexOf('ugc-mobile/lib/*'))) {
      problems.push(`${importer} loads ugc-mobile/lib/${folder}: add "${reinclude}" after "ugc-mobile/lib/*" in .vercelignore`);
    }
    const configFile = join('ugc-mobile/lib', folder, 'tsconfig.json');
    const config = statSync(configFile, { throwIfNoEntry: false })
      ? ts.parseConfigFileTextToJson(configFile, readFileSync(configFile, 'utf8')).config
      : undefined;
    if (!config || 'extends' in config) {
      problems.push(`${importer} loads ugc-mobile/lib/${folder}: give it a tsconfig.json that extends nothing, like model-catalog's`);
    }
  }
  expect(problems).toEqual([]);
});

it('counts only the imports that load something at run time', () => {
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
  ].join('\n');
  expect(runtimeSpecifiers('fixture.ts', source)).toEqual([
    'multi-line-import',
    'type-names-alone',
    'side-effect-import',
    're-export',
    'named-re-export',
    'dynamic-import',
  ]);
});
