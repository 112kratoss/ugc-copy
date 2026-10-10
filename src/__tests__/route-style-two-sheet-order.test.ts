// @vitest-environment node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

/**
 * A signed-in route loads `globals.css` and then `non-public-utilities.css`.
 * Both put their utilities in the same cascade layer, so between two rules of
 * the same weight the later sheet wins, whatever order Tailwind gave the two
 * utilities. The supplement emits only what its own sources use. So for an
 * element carrying `h-8 lg:h-px`: if the supplement emits `.h-8` again and
 * holds no `.lg\:h-px`, its `.h-8` comes last and the element is 32px tall at
 * every width. That is what the reel drew on the profile (a block where a
 * hairline belongs), and what cost the shell its hover and breakpoint rules on
 * every signed-in route.
 *
 * This reads the two sheets as Tailwind compiles them and every file a
 * signed-in route can draw, and fails on any pair of classes on one element
 * where the supplement's copy of the first outranks a second that only
 * globals.css holds and that Tailwind orders after it.
 */

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const APP_ROOT = path.join(SRC_ROOT, 'app');
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// The longhands a declared property reaches, so that `padding` meets `padding-inline`.
const SIDES = ['top', 'right', 'bottom', 'left'];
const REACH: Record<string, string[]> = {
  padding: SIDES.map((side) => `padding-${side}`),
  'padding-inline': ['padding-left', 'padding-right'],
  'padding-block': ['padding-top', 'padding-bottom'],
  margin: SIDES.map((side) => `margin-${side}`),
  'margin-inline': ['margin-left', 'margin-right'],
  'margin-block': ['margin-top', 'margin-bottom'],
  inset: SIDES,
  'inset-inline': ['left', 'right'],
  'inset-block': ['top', 'bottom'],
  gap: ['row-gap', 'column-gap'],
  overflow: ['overflow-x', 'overflow-y'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  'border-width': SIDES.map((side) => `border-${side}-width`),
  'border-style': SIDES.map((side) => `border-${side}-style`),
  'border-color': SIDES.map((side) => `border-${side}-color`),
};

type Utility = { order: number; properties: Set<string> };

async function compileUtilities(stylesheet: string): Promise<Map<string, Utility>> {
  const result = await postcss([tailwind({ optimize: false })])
    .process(readFileSync(stylesheet, 'utf8'), { from: stylesheet });
  const utilities = new Map<string, Utility>();
  let order = 0;

  postcss.parse(result.css).walkAtRules('layer', (layer) => {
    if (layer.params !== 'utilities') return;
    for (const node of layer.nodes ?? []) {
      if (node.type !== 'rule') continue;
      order += 1;
      const className = node.selector.match(/\.((?:\\.|[^\s.:>~+,)(\[\\])+)/)?.[1]?.replace(/\\(.)/g, '$1');
      if (!className) continue;
      const utility = utilities.get(className) ?? { order, properties: new Set<string>() };
      node.walkDecls((declaration) => {
        for (const property of REACH[declaration.prop] ?? [declaration.prop]) utility.properties.add(property);
      });
      utilities.set(className, utility);
    }
  });

  return utilities;
}

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
  if (!unresolvedPath) return null;

  const candidates = [
    ...SOURCE_EXTENSIONS.map((extension) => `${unresolvedPath}${extension}`),
    ...SOURCE_EXTENSIONS.slice(1).map((extension) => path.join(unresolvedPath, `index${extension}`)),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

/** Every file a route that links the supplement can draw, the root layout's shell included. */
function collectFilesDrawnWithTheSupplement(): string[] {
  const supplementRouteFiles = readdirSync(APP_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const layout = path.join(APP_ROOT, entry.name, 'layout.tsx');
      return existsSync(layout) && readFileSync(layout, 'utf8').includes('non-public-utilities.css');
    })
    .flatMap((entry) => walkFiles(path.join(APP_ROOT, entry.name)))
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file));
  const pendingFiles = [path.join(APP_ROOT, 'layout.tsx'), ...supplementRouteFiles];
  const visitedFiles = new Set<string>();

  while (pendingFiles.length > 0) {
    const file = pendingFiles.pop();
    if (!file || visitedFiles.has(file)) continue;
    visitedFiles.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*\()\s*['"]([^'"]+)['"]/g)) {
      const importedFile = resolveLocalImport(match[1], file);
      if (importedFile && !visitedFiles.has(importedFile)) pendingFiles.push(importedFile);
    }
  }

  return [...visitedFiles].filter((file) => /\.(?:ts|tsx|jsx)$/.test(file)).sort();
}

const STRING_LITERAL = /'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`/g;

function literalTokens(text: string): string[] {
  return [...text.matchAll(STRING_LITERAL)].flatMap((match) => (
    (match[1] ?? match[2] ?? match[3] ?? '').replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean)
  ));
}

/** The groups of class tokens that can land on one element: each `className` expression, and each string literal. */
function collectTokenGroups(source: string): string[][] {
  const groups: string[][] = [];

  for (const match of source.matchAll(/className=/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let end = start;
    if (source[start] === '"') {
      end = source.indexOf('"', start + 1);
    } else if (source[start] === '{') {
      for (let depth = 0; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        if (source[end] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
    }
    groups.push(literalTokens(source.slice(start, end + 1)));
  }
  for (const match of source.matchAll(STRING_LITERAL)) {
    groups.push(literalTokens(match[0]));
  }

  return groups.filter((group) => group.length > 1);
}

describe('the two stylesheets of a signed-in route', () => {
  it('never lets the supplement outrank a rule that only globals.css holds and that should have won', async () => {
    const publicUtilities = await compileUtilities(path.join(APP_ROOT, 'globals.css'));
    const supplementUtilities = await compileUtilities(path.join(APP_ROOT, 'non-public-utilities.css'));
    // The reading has to be of real sheets: both hold the plain utilities every page uses.
    expect(publicUtilities.get('lg:h-px')?.properties.has('height')).toBe(true);
    expect(publicUtilities.get('h-8')!.order).toBeLessThan(publicUtilities.get('lg:h-px')!.order);
    expect(supplementUtilities.has('h-8')).toBe(true);

    const files = collectFilesDrawnWithTheSupplement();
    // The files that used to be left to globals.css alone are among them.
    expect(files).toContain(path.join(APP_ROOT, 'showcase', 'ShowcaseReelViewer.tsx'));
    expect(files).toContain(path.join(SRC_ROOT, 'components', 'AppShellClient.tsx'));

    const overruled: string[] = [];
    for (const file of files) {
      const seen = new Set<string>();
      for (const group of collectTokenGroups(readFileSync(file, 'utf8'))) {
        const classes = [...new Set(group)].filter((token) => publicUtilities.has(token));
        for (const winner of classes) {
          if (!supplementUtilities.has(winner)) continue;
          for (const loser of classes) {
            if (loser === winner || supplementUtilities.has(loser)) continue;
            const first = publicUtilities.get(winner)!;
            const second = publicUtilities.get(loser)!;
            if (second.order <= first.order) continue;
            if (![...first.properties].some((property) => second.properties.has(property))) continue;
            const pair = `${path.relative(PROJECT_ROOT, file)}: ${loser} loses to ${winner}`;
            if (!seen.has(pair)) {
              seen.add(pair);
              overruled.push(pair);
            }
          }
        }
      }
    }

    expect(overruled).toEqual([]);
  }, 120_000);
});
