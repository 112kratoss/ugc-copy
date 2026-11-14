import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HOME_PRERENDER_FILE,
  findHomeShellProblems,
  verifyHomeShellPrerender,
} from '../../scripts/build/check-home-shell-prerender.mjs';

const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The parts of the prerendered Home the check reads: both Home tabs and the Sign in link. */
function home({ current = true, returnUrl = '%2F' } = {}) {
  const currentAttribute = current ? ' aria-current="page"' : '';
  return [
    `<a href="/"${currentAttribute} data-app-nav-tab="home" title="Community feed and your creative workspace" class="ui-focus-ring">Home</a>`,
    `<a class="app-shell-when-signed-out" href="/login?returnUrl=${returnUrl}">Sign in</a>`,
    `<nav aria-label="Primary mobile navigation"><a href="/"${currentAttribute} data-app-nav-tab="home" class="ui-focus-ring">Home</a></nav>`,
    // The page's data payload carries the link again, its quotes escaped (a 2026-11-15 build).
    `<script>self.__next_f.push([1,"{\\"href\\":\\"/login?returnUrl=${returnUrl}\\",\\"prefetch\\":false}"])</script>`,
  ].join('');
}

let root: string | null = null;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("the prerendered Home's shell check (build:verify)", () => {
  it('runs with the build checks', () => {
    expect(packageJson.scripts['build:verify']).toContain('node scripts/build/check-home-shell-prerender.mjs');
  });

  it('passes a Home drawn as Home', () => {
    expect(findHomeShellProblems(home())).toEqual([]);
  });

  // The live site before #811: `/` prerendered under `/index`, which the shell drew neutral.
  it('fails a Home the server drew under another pathname', () => {
    const problems = findHomeShellProblems(home({ current: false, returnUrl: '%2Findex' }));

    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/Home tab is not marked current/);
    expect(problems[1]).toBe('Sign in returns to /index, not /.');
  });

  it('fails a page with no Home tab, which it cannot judge', () => {
    expect(findHomeShellProblems('<main>Home</main>')).toEqual([
      expect.stringMatching(/draws no Home tab/),
    ]);
  });

  it('reads the build directory, and names the file it could not read', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'home-shell-prerender-'));
    await expect(verifyHomeShellPrerender({ nextDirectory: root })).rejects.toThrow(/could not be read/);

    await mkdir(path.dirname(path.join(root, HOME_PRERENDER_FILE)), { recursive: true });
    await writeFile(path.join(root, HOME_PRERENDER_FILE), home({ current: false }));
    await expect(verifyHomeShellPrerender({ nextDirectory: root })).rejects.toThrow(/isHomeRoutePathname/);

    await writeFile(path.join(root, HOME_PRERENDER_FILE), home());
    await expect(verifyHomeShellPrerender({ nextDirectory: root })).resolves.toBeUndefined();
  });
});
