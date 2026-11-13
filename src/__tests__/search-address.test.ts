// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readSearchPageAddress, readSearchPageOpening, writeSearchPageAddress } from '@/app/search/search-address';

// The search page's address: how it is written so that Next's router never
// takes the write for a navigation, and how the page reads it back.

/**
 * Next's patch of history.replaceState, as next/dist/client/components/app-router.js
 * has it: a state that carries Next's own mark goes straight to the browser;
 * any other is first dispatched to the router as a navigation (ACTION_RESTORE),
 * which discards the navigation still loading (app-router-instance.js).
 */
function patchAsNextDoes() {
  const toldRouter: string[] = [];
  const original = window.history.replaceState.bind(window.history);
  window.history.replaceState = function replaceState(data: unknown, unused: string, url?: string | URL | null) {
    const marked = data as { __NA?: unknown; _N?: unknown } | null;
    if (marked?.__NA || marked?._N) return original(data, unused, url);
    if (url) toldRouter.push(String(url));
    return original(data ?? {}, unused, url);
  };
  return { toldRouter, restore: () => { window.history.replaceState = original; } };
}

const address = () => `${window.location.pathname}${window.location.search}`;

describe('the search page’s address', () => {
  let next: ReturnType<typeof patchAsNextDoes>;

  beforeEach(() => {
    window.history.replaceState(null, '', '/search');
    next = patchAsNextDoes();
  });

  afterEach(() => {
    next.restore();
    vi.restoreAllMocks();
  });

  it('is written without a word to Next’s router, with the entry’s own state kept', () => {
    window.history.replaceState({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: 'kept' }, guard: 'kept too' }, '', '/search');
    writeSearchPageAddress('/search?q=lumi&type=posts');
    expect(address()).toBe('/search?q=lumi&type=posts');
    expect(next.toldRouter).toEqual([]);
    expect(window.history.state).toEqual({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: 'kept' }, guard: 'kept too' });
  });

  it('is written without a word to the router from an entry that has no state, as a plain #fragment link leaves', () => {
    expect(window.history.state).toBeNull();
    writeSearchPageAddress('/search?q=lumi');
    expect(address()).toBe('/search?q=lumi');
    expect(next.toldRouter).toEqual([]);
    // Next's popstate reloads the page on a state without its mark.
    expect(window.history.state).toEqual({ __NA: true });
  });

  it('writes nothing when the address already says it', () => {
    writeSearchPageAddress('/search?q=lumi');
    const written = vi.spyOn(window.history, 'replaceState');
    writeSearchPageAddress('/search?q=lumi');
    expect(written).not.toHaveBeenCalled();
  });

  it('writes again what something else wrote over, as the router does when it commits on the page', () => {
    writeSearchPageAddress('/search?q=lumi');
    window.history.replaceState({ __NA: true }, '', '/search?q=luna');
    writeSearchPageAddress('/search?q=lumi');
    expect(address()).toBe('/search?q=lumi');
  });

  it('lets a refused write pass: Safari allows 100 in 30 seconds and throws at the next', () => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new DOMException('Attempt to use history.replaceState() more than 100 times per 30 seconds', 'SecurityError');
    });
    expect(() => writeSearchPageAddress('/search?q=lumi')).not.toThrow();
    expect(address()).toBe('/search');
  });

  it('still finds, in the installed Next, the patch that hands a marked state straight to the browser', () => {
    // What the write above rests on. If an upgrade of Next changes this, the
    // page's address write may reach the router again and discard a navigation
    // (tests/e2e/public-search.spec.ts holds the behaviour in a browser).
    const source = fs.readFileSync(path.join(process.cwd(), 'node_modules/next/dist/client/components/app-router.js'), 'utf8');
    expect(source).toMatch(/window\.history\.replaceState = function replaceState\(data, _unused, url\) \{[\s\S]{0,400}?if \(data\?\.__NA \|\| data\?\._N\) \{\s*return originalReplaceState\(data, _unused, url\);/);
  });

  it('reads the search an address names, as the server reads it for the page', () => {
    const params = new URLSearchParams('q=%20Neon%20%20Portrait%20&type=posts&sort=latest&madeWith=model%3Aflux-2&kind=video');
    expect(readSearchPageOpening((name) => params.get(name))).toEqual({
      query: 'Neon Portrait',
      type: 'posts',
      sort: 'latest',
      filters: { madeWith: 'model:flux-2', mediaKind: 'video', hasRecipe: false, following: false },
      exact: false,
    });
    // An address that names a tab, an order or a filter wrongly opens the plain search.
    const wrong = new URLSearchParams('q=neon&type=everything&sort=oldest&kind=hologram');
    expect(readSearchPageOpening((name) => wrong.get(name))).toEqual({
      query: 'neon',
      type: 'top',
      sort: 'top',
      filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
      exact: false,
    });
  });

  it('reads the browser’s address only while it is the search page’s own', () => {
    window.history.replaceState({ __NA: true }, '', '/search?q=lumi&type=creators');
    expect(readSearchPageAddress()).toMatchObject({ query: 'lumi', type: 'creators' });
    // A navigation here first renders the page while the address is still the page before's.
    window.history.replaceState({ __NA: true }, '', '/creators/lumen?q=not-a-search');
    expect(readSearchPageAddress()).toBeNull();
  });
});
