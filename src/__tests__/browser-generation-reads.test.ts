import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `authenticated` may read only the resume columns of `generations`
 * (20260726071722_harden_data_api_and_storage_contract.sql), and a read of any
 * other column fails the whole query (42501, a 403 from PostgREST). The pages'
 * tests mock Supabase, so they pass either way: from 2026-10-13 production
 * refused every creator's look for a run at work (it had gained the prompt, the
 * cost and the model), and each creator opened idle while the run went on.
 * Generation reads are the server's: an API route on the service client, with
 * the owner checked in code (`GET /api/generations/active`).
 */

const SRC_ROOT = path.join(process.cwd(), 'src');
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx'];

/** A table read of `generations` through any supabase-js client. */
const GENERATIONS_READ = /\.from\(\s*['"]generations['"]\s*\)/;
const CLIENT_DIRECTIVE = /^\s*(['"])use client\1/;
// What loads a module with its importer: a value import or re-export, a bare import, an
// import(). `import type` and `export type` are erased and load nothing.
const LOADING_IMPORT = /(?:^\s*import\s+(?!type\b)[^'"]*?from\s*|^\s*export\s+(?!type\b)[^'"]*?from\s*|^\s*import\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/gm;

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

  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${unresolvedPath}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS.slice(1)) {
    const candidate = path.join(unresolvedPath, `index${extension}`);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function listClientComponents(): string[] {
  const testsRoot = path.join(SRC_ROOT, '__tests__') + path.sep;
  return walkFiles(SRC_ROOT)
    .filter((file) => !file.startsWith(testsRoot) && /\.(?:ts|tsx|js|jsx)$/.test(file))
    .filter((file) => CLIENT_DIRECTIVE.test(readFileSync(file, 'utf8')));
}

/** Every file of src a client component loads, and what those load. */
function collectBrowserModules(entries: string[]): Set<string> {
  const pending = [...entries];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(LOADING_IMPORT)) {
      const imported = resolveLocalImport(match[1], file);
      if (imported?.startsWith(SRC_ROOT) && !visited.has(imported)) pending.push(imported);
    }
  }
  return visited;
}

describe('generation reads in the browser', () => {
  const browserModules = collectBrowserModules(listClientComponents());

  it('follows every creator into the modules it loads', () => {
    const relative = [...browserModules].map((file) => path.relative(SRC_ROOT, file));
    expect(relative).toEqual(expect.arrayContaining([
      'app/create-image/CreateImageClient.tsx',
      'app/create-video/CreateVideoClient.tsx',
      'app/create-motion/CreateMotionClient.tsx',
      // Loaded with each creator, by a value import.
      'lib/generation-status-client.ts',
    ]));
    // Only a type comes from the route's service; nothing of it reaches the browser.
    expect(relative).not.toContain('lib/creator-active-run-service.ts');
  });

  it('would see a read of the table, whatever its quotes and spacing', () => {
    expect(GENERATIONS_READ.test(`supabase\n  .from('generations')\n  .select('id, prompt')`)).toBe(true);
    expect(GENERATIONS_READ.test('supabase.from( "generations" )')).toBe(true);
    expect(GENERATIONS_READ.test("supabase.from('generation_jobs')")).toBe(false);
  });

  it('are never made by a module a client component loads', () => {
    const readers = [...browserModules]
      .filter((file) => GENERATIONS_READ.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC_ROOT, file))
      .sort();

    expect(readers).toEqual([]);
  });
});
