#!/usr/bin/env node

// The home page, the marketplace, every post page and every creator page are drawn once and cached
// for everyone (ISR), and only a change they show draws them again. A page that starts reading the
// request (headers(), cookies(), the session, its search params) quietly goes back to rendering on
// every visit: each one reaches the database and the functions again, and every test still passes.
// This reads the build's prerender manifest and fails when one of them is no longer ISR, and when a
// cached page could be served more than an hour after it was drawn (`expireTime` in next.config.ts),
// which the pages' media links are signed to outlive (src/lib/media-signature-scope.ts).
// Its reach: `/` and `/marketplace` are drawn at build time, so a request read in their render code
// fails here. `/showcase/[id]` and `/creators/[username]` are drawn on first visit, so for them this
// catches route-config changes only; a request read added to their render code is caught by their
// vitest page tests (headers, cookies and the session throw there), and at runtime Next would
// answer such a page with a 500 rather than render it per request.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pages prerendered at build time and drawn again on their revalidate period. */
export const PRERENDERED_ISR_PAGES = ['/', '/marketplace'];

/** Pages drawn on their first visit, one per address, then cached (`generateStaticParams` returns none). */
export const ON_DEMAND_ISR_PAGES = ['/showcase/[id]', '/creators/[username]'];

/** The longest a cached page may be served after it was drawn. */
export const MAX_EXPIRE_SECONDS = 3600;

/**
 * What is wrong with the build's ISR pages, one line each; none when all is well.
 * `manifest` is `.next/prerender-manifest.json`, `expireTime` the build's own (required-server-files).
 */
export function findIsrPageProblems(manifest, expireTime) {
  const problems = [];

  for (const route of PRERENDERED_ISR_PAGES) {
    const entry = manifest?.routes?.[route];
    if (!entry) {
      problems.push(`${route} is not prerendered: it renders on every request.`);
      continue;
    }
    const { initialRevalidateSeconds: revalidate, initialExpireSeconds: expire } = entry;
    if (typeof revalidate !== 'number' || revalidate <= 0) {
      problems.push(`${route} is prerendered but never drawn again (initialRevalidateSeconds: ${JSON.stringify(revalidate)}).`);
    }
    if (typeof expire !== 'number' || expire > MAX_EXPIRE_SECONDS) {
      problems.push(`${route} may be served ${JSON.stringify(expire)} seconds after it was drawn, past ${MAX_EXPIRE_SECONDS}.`);
    }
  }

  for (const route of ON_DEMAND_ISR_PAGES) {
    const entry = manifest?.dynamicRoutes?.[route];
    if (!entry) {
      problems.push(`${route} is not an ISR route: every visit renders it.`);
    } else if (entry.fallback !== null) {
      problems.push(
        `${route} has fallback ${JSON.stringify(entry.fallback)}, not null: an address the build did not draw `
        + 'should be drawn on its first visit, then cached.',
      );
    }
  }

  if (typeof expireTime !== 'number' || expireTime > MAX_EXPIRE_SECONDS) {
    problems.push(
      `expireTime is ${JSON.stringify(expireTime)}: an ISR page drawn on its first visit may be served longer than `
      + `${MAX_EXPIRE_SECONDS} seconds after it was drawn.`,
    );
  }

  return problems;
}

export async function verifyIsrPages({ nextDirectory = path.resolve('.next') } = {}) {
  const readJson = async (name) => JSON.parse(await readFile(path.join(nextDirectory, name), 'utf8'));
  const manifest = await readJson('prerender-manifest.json');
  const { config } = await readJson('required-server-files.json');
  const problems = findIsrPageProblems(manifest, config?.expireTime);
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} ISR page problem(s) in this build:\n${problems.map((line) => `  ${line}`).join('\n')}\n`
      + 'A page renders per request once it reads headers(), cookies(), the session or its search params: '
      + 'move that read to the browser, as the post, creator and marketplace pages do.',
    );
  }
  return {
    prerendered: PRERENDERED_ISR_PAGES.map((route) => `${route} (${manifest.routes[route].initialRevalidateSeconds}s)`),
    onDemand: ON_DEMAND_ISR_PAGES,
    expireTime: config.expireTime,
  };
}

async function main() {
  const result = await verifyIsrPages();
  console.log(
    `ISR pages: ${result.prerendered.join(', ')} prerendered; ${result.onDemand.join(', ')} drawn on first visit; `
    + `none served more than ${result.expireTime}s after it was drawn.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
