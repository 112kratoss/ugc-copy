#!/usr/bin/env node

// Under `experimental.inlineCss` a document carries each stylesheet it inlines twice: in its <style>
// tag and once in the RSC payload. Next wrote the root sheet a third time, for the global-error
// boundary (vercel/next.js#98110), 152 KB of every page's decoded HTML on 2026-10-20, until
// patch-next-global-error-css.mjs. This fails the build when a prerendered document carries a
// stylesheet the build emitted more than twice, and when no document carries one at all, which would
// mean it can no longer see them.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_INLINED_COPIES = 2;

// Text that reads the same in a <style> tag and in the payload's escaped string, where `"` and `\`
// are escaped and `<`, `>` and `&` may be.
const PLAIN_RUN = /[ !#-%(-;=?-[\]-~]{40,}/g;

async function filesUnder(directory, extension) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = await Promise.all(entries.map((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(full, extension);
    return entry.name.endsWith(extension) ? [full] : [];
  }));
  return found.flat();
}

function occurrences(text, needle) {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/**
 * Up to three pieces of a stylesheet's text, from its start, middle and end, that occur in it once
 * and read the same wherever a document holds a copy. None for a sheet too small to have one.
 */
export function stylesheetNeedles(css, length = 80) {
  const runs = [...css.matchAll(PLAIN_RUN)].filter((match) => match[0].length >= length);
  const picks = runs.length <= 3 ? runs : [runs[0], runs[Math.floor(runs.length / 2)], runs[runs.length - 1]];
  return picks
    .map((match) => match[0].slice(0, length))
    .filter((needle, index, all) => all.indexOf(needle) === index && occurrences(css, needle) === 1);
}

/** How many copies of the sheet a document holds: the fewest of its needles (0 with none). */
export function countInlinedCopies(html, needles) {
  if (needles.length === 0) return 0;
  return Math.min(...needles.map((needle) => occurrences(html, needle)));
}

export async function verifyInlineCssCopies({ nextDirectory = path.resolve('.next') } = {}) {
  const stylesheets = [];
  for (const file of await filesUnder(path.join(nextDirectory, 'static'), '.css')) {
    const needles = stylesheetNeedles(await readFile(file, 'utf8'));
    if (needles.length > 0) stylesheets.push({ file, needles });
  }
  const documents = await filesUnder(path.join(nextDirectory, 'server', 'app'), '.html');
  const over = [];
  let carrying = 0;
  let most = 0;
  for (const document of documents) {
    const html = await readFile(document, 'utf8');
    let carries = false;
    for (const { file, needles } of stylesheets) {
      const copies = countInlinedCopies(html, needles);
      if (copies > 0) carries = true;
      most = Math.max(most, copies);
      if (copies > MAX_INLINED_COPIES) {
        over.push(`  ${path.relative(nextDirectory, document)}: ${path.relative(nextDirectory, file)} ${copies} times`);
      }
    }
    if (carries) carrying += 1;
  }
  if (carrying === 0) {
    throw new Error(
      `None of ${documents.length} prerendered document(s) carries any of ${stylesheets.length} stylesheet(s) the build emitted. `
      + 'With experimental.inlineCss every page inlines its sheets, so this check no longer sees them: '
      + 'update scripts/build/check-inline-css-copies.mjs, or drop it from build:verify if inlining was turned off.',
    );
  }
  if (over.length > 0) {
    throw new Error(
      `${over.length} prerendered document/stylesheet pair(s) carry the sheet more than ${MAX_INLINED_COPIES} times:\n`
      + `${over.slice(0, 10).join('\n')}\n`
      + 'The third copy is the global-error boundary\'s (vercel/next.js#98110). Run '
      + '`node scripts/build/patch-next-global-error-css.mjs` (the postinstall does) and build again; '
      + 'if it reports that the runtime no longer fits, update the patch to the installed Next.',
    );
  }
  return { documents: documents.length, carrying, stylesheets: stylesheets.length, most };
}

async function main() {
  const result = await verifyInlineCssCopies();
  console.log(
    `Inlined stylesheets: ${result.carrying} of ${result.documents} prerendered document(s) carry one, `
    + `none more than ${result.most} time(s).`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
