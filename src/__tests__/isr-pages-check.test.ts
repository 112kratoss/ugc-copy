import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_EXPIRE_SECONDS,
  ON_DEMAND_ISR_PAGES,
  PRERENDERED_ISR_PAGES,
  findIsrPageProblems,
  verifyIsrPages,
} from '../../scripts/build/check-isr-pages.mjs';

const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

// The parts of `.next/prerender-manifest.json` the check reads, as Next 16 writes them.
function manifest() {
  return {
    version: 4,
    routes: {
      '/': { initialRevalidateSeconds: 900, initialExpireSeconds: 3600, srcRoute: '/' },
      '/marketplace': { initialRevalidateSeconds: 300, initialExpireSeconds: 3600, srcRoute: '/marketplace' },
      '/pricing': { initialRevalidateSeconds: false, initialExpireSeconds: undefined, srcRoute: '/pricing' },
    },
    dynamicRoutes: {
      '/showcase/[id]': { routeRegex: '^/showcase/([^/]+?)(?:/)?$', fallback: null },
      '/creators/[username]': { routeRegex: '^/creators/([^/]+?)(?:/)?$', fallback: null },
      '/blog/[slug]': { routeRegex: '^/blog/([^/]+?)(?:/)?$', fallback: false },
    },
    notFoundRoutes: [],
  };
}

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('the ISR pages check (build:verify)', () => {
  it('names the pages the cost work made ISR, and an hour as the longest a page is served', () => {
    expect(PRERENDERED_ISR_PAGES).toEqual(['/', '/marketplace']);
    expect(ON_DEMAND_ISR_PAGES).toEqual(['/showcase/[id]', '/creators/[username]']);
    expect(MAX_EXPIRE_SECONDS).toBe(3600);
    expect(packageJson.scripts['build:verify']).toContain('node scripts/build/check-isr-pages.mjs');
  });

  it('passes a build whose pages are all ISR', () => {
    expect(findIsrPageProblems(manifest(), 3600)).toEqual([]);
  });

  // headers(), cookies() or the session read in a page makes it render per
  // request: the build leaves it out of the manifest.
  it('fails a page that renders on every request', () => {
    const build = manifest();
    delete (build.routes as Record<string, unknown>)['/marketplace'];
    delete (build.dynamicRoutes as Record<string, unknown>)['/showcase/[id]'];

    expect(findIsrPageProblems(build, 3600)).toEqual([
      '/marketplace is not prerendered: it renders on every request.',
      '/showcase/[id] is not an ISR route: every visit renders it.',
    ]);
  });

  it('fails a page that is never drawn again, or served past the hour', () => {
    const build = manifest();
    build.routes['/'] = { ...build.routes['/'], initialRevalidateSeconds: false as unknown as number };
    build.routes['/marketplace'] = { ...build.routes['/marketplace'], initialExpireSeconds: 31_536_000 };

    expect(findIsrPageProblems(build, 31_536_000)).toEqual([
      '/ is prerendered but never drawn again (initialRevalidateSeconds: false).',
      '/marketplace may be served 31536000 seconds after it was drawn, past 3600.',
      'expireTime is 31536000: an ISR page drawn on its first visit may be served longer than 3600 seconds after it was drawn.',
    ]);
  });

  it('fails an address the build did not draw being answered as missing, or from a shell', () => {
    const build = manifest();
    build.dynamicRoutes['/creators/[username]'] = { ...build.dynamicRoutes['/creators/[username]'], fallback: false as unknown as null };

    expect(findIsrPageProblems(build, 3600)).toEqual([
      '/creators/[username] has fallback false, not null: an address the build did not draw should be drawn on its first visit, then cached.',
    ]);
  });

  it('reads the build from .next, and says what to do when it fails', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'magicbooklet-isr-pages-'));
    await writeFile(path.join(root, 'prerender-manifest.json'), JSON.stringify(manifest()));
    await writeFile(path.join(root, 'required-server-files.json'), JSON.stringify({ config: { expireTime: 3600 } }));

    await expect(verifyIsrPages({ nextDirectory: root })).resolves.toEqual({
      prerendered: ['/ (900s)', '/marketplace (300s)'],
      onDemand: ['/showcase/[id]', '/creators/[username]'],
      expireTime: 3600,
    });

    const build = manifest();
    delete (build.dynamicRoutes as Record<string, unknown>)['/creators/[username]'];
    await writeFile(path.join(root, 'prerender-manifest.json'), JSON.stringify(build));
    await expect(verifyIsrPages({ nextDirectory: root })).rejects.toThrow(
      /1 ISR page problem\(s\)[\s\S]*\/creators\/\[username\] is not an ISR route[\s\S]*move that read to the browser/,
    );
  });
});
