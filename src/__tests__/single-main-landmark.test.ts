import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The shell wraps every page in `<main id="main-content">` (`AppShellClient.tsx`, both its full and
 * its minimal chrome; the root layout draws every route, /admin included, inside it). A page that
 * drew a `<main>` of its own nested a second main landmark inside the first, which a screen
 * reader's landmark list reads as two main regions (audit 2026-11-27, finding 14). A page's own
 * region is a `<div>` or a labelled `<section>`.
 */

const SRC_ROOT = path.join(process.cwd(), 'src');
const ROOTS = [path.join(SRC_ROOT, 'app'), path.join(SRC_ROOT, 'components')];
const API_ROOT = path.join(SRC_ROOT, 'app', 'api');
const SHELL = path.join(SRC_ROOT, 'components', 'AppShellClient.tsx');
const MAIN_ELEMENT = /<main\b|\bas=["']main["']|\brole=["']main["']/;

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const file = path.join(directory, name);
    if (file === API_ROOT) return [];
    if (statSync(file).isDirectory()) return walk(file);
    return /\.(?:tsx|jsx)$/.test(name) ? [file] : [];
  });
}

/** Markup only: comments may speak of `<main>`. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

describe('one main landmark per page', () => {
  it('leaves <main> to the app shell', () => {
    const shell = readFileSync(SHELL, 'utf8');
    expect(shell).toMatch(/<main id="main-content"/);

    const offenders = ROOTS.flatMap(walk)
      .filter((file) => file !== SHELL)
      .filter((file) => MAIN_ELEMENT.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});
