#!/usr/bin/env node

// The shell draws Home (its title, its tab, the Sign in link's way back) from the pathname the
// server renders the page under, and the browser's first render must draw the same, because React
// does not patch an attribute that hydrates differently. A browser always reads `/` for Home; the
// server read `/index` for the prerendered `/` (the live site's Sign in wrote `returnUrl=%2Findex`)
// and `/home` behind the signed-in rewrite, so the shell takes those for Home by name
// (`isHomeRoutePathname`, src/components/app-shell-nav.ts). Until 2026-11-14 it drew a neutral
// header until it mounted instead, and every refresh of Home moved the top bar (#811).
// A Next upgrade could prerender `/` under yet another pathname, which no unit test or `next dev`
// sees: this reads the built page and fails unless the server already drew it as Home.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where Next writes the prerendered `/`, from the `.next` directory. */
export const HOME_PRERENDER_FILE = path.join('server', 'app', 'index.html');

/** What is wrong with the prerendered Home's shell, one line each; none when all is well. */
export function findHomeShellProblems(html) {
  const problems = [];

  const homeTabs = [...html.matchAll(/<a\b[^>]*\bdata-app-nav-tab="home"[^>]*>/g)].map(([tag]) => tag);
  if (homeTabs.length === 0) {
    problems.push('the page draws no Home tab (`data-app-nav-tab="home"`): the check cannot tell how the shell read it.');
  } else if (!homeTabs.every((tag) => /\baria-current="page"/.test(tag))) {
    problems.push('the Home tab is not marked current (`aria-current="page"`): the server drew Home under a pathname the shell does not take for Home.');
  }

  // Both the HTML's links and the page's data payload, whose copy escapes the closing quote (`\"`).
  const returnUrls = [...html.matchAll(/\/login\?returnUrl=([^"&\s\\]*)/g)].map(([, value]) => value);
  const strayReturnUrls = [...new Set(returnUrls.filter((value) => value !== '%2F'))];
  if (strayReturnUrls.length > 0) {
    problems.push(`Sign in returns to ${strayReturnUrls.map((value) => decodeURIComponent(value)).join(', ')}, not /.`);
  }

  return problems;
}

export async function verifyHomeShellPrerender({ nextDirectory = path.resolve('.next') } = {}) {
  const file = path.join(nextDirectory, HOME_PRERENDER_FILE);
  const html = await readFile(file, 'utf8').catch((error) => {
    throw new Error(`The prerendered Home (${file}) could not be read: ${error instanceof Error ? error.message : error}`);
  });
  const problems = findHomeShellProblems(html);
  if (problems.length > 0) {
    throw new Error(
      `The prerendered Home's shell does not read as Home:\n${problems.map((line) => `  ${line}`).join('\n')}\n`
      + 'Find the pathname the server drew it under and add it to isHomeRoutePathname (src/components/app-shell-nav.ts).',
    );
  }
}

async function main() {
  await verifyHomeShellPrerender();
  console.log('Prerendered Home: its shell reads Home, and Sign in returns to /.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
