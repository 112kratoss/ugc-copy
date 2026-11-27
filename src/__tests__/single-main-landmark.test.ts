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

/**
 * A whole document written into another window (a popup's `<!doctype html>` template) has its own
 * landmarks, outside the shell's page.
 */
const OTHER_DOCUMENT = /`\s*<!doctype html[\s\S]*?`/gi;

/** The page's own markup: comments may speak of `<main>`, and another document is its own. */
function pageMarkup(source: string): string {
  return source
    .replace(OTHER_DOCUMENT, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
}

describe('one main landmark per page', () => {
  it('leaves <main> to the app shell', () => {
    const shell = readFileSync(SHELL, 'utf8');
    expect(shell).toMatch(/<main id="main-content"/);

    const offenders = ROOTS.flatMap(walk)
      .filter((file) => file !== SHELL)
      .filter((file) => MAIN_ELEMENT.test(pageMarkup(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });

  // The template publisher's test tab is a document of its own, written into a popup, whose
  // stylesheet draws its card with a `main { … }` rule: its <main> is that document's one landmark.
  it('leaves the main of a document written into a popup alone', () => {
    const drawer = readFileSync(path.join(SRC_ROOT, 'app/create-workflow/WorkflowTemplatePublishDrawer.tsx'), 'utf8');
    const popup = drawer.match(OTHER_DOCUMENT)?.[0] ?? '';
    expect(popup).toMatch(/\bmain \{/);
    expect(popup).toMatch(/<main\b[^>]*>[\s\S]*<\/main>/);
    expect(pageMarkup(drawer)).not.toMatch(MAIN_ELEMENT);
  });
});
