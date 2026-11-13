import { expect, test, type Page } from '@playwright/test';

/**
 * A query typed into /search before the page's script has run is searched for, and the field
 * keeps it (2026-11-05).
 *
 * The server's HTML draws the search field before any script runs, and this React build hydrates
 * an input without reading its value back: the field showed the query while the page's state
 * stayed empty, so nothing was searched for until the next key, and any render before that wrote
 * the empty state over the field (as on /login, login-typed-before-script.spec.ts).
 *
 * The page's own chunk is held until the query is typed, and the search is awaited once React has
 * committed the page's hydration (.claude/rules/e2e.md): signed out, no Suspense or Activity
 * boundary sits between the document's root and the field.
 */

const COLD_PAGE = { timeout: 45_000 };
const QUERY = 'luna';

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/search\/page\.js(\?|$)/, async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return { requests: () => chunk.requests, release: () => release() };
}

/** Whether React has committed the page's hydration (login-typed-before-script.spec.ts). */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

test(`/search: a query typed before the page's script runs is searched for, and the field keeps it`, async ({ page }) => {
  test.setTimeout(120_000);
  const searched: string[] = [];
  // /api/search alone: the box holds the focus here, so the typeahead asks /api/search/suggest
  // for the same text (search-typeahead.spec.ts), which the dev server answers with a failure
  // that is drawn as nothing.
  await page.route((url) => url.pathname === '/api/search', async (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get('q') ?? '';
    searched.push(query);
    const empty = { items: [], nextCursor: null };
    await route.fulfill({
      json: { query, normalizedQuery: query, type: url.searchParams.get('type') ?? 'top', creators: empty, posts: empty, recipes: empty },
    });
  });
  const chunk = await holdPageChunk(page);

  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto('/search', { waitUntil: 'commit' });
  const field = page.getByRole('combobox');
  await expect(field).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the typing below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await field.fill(QUERY);
  chunk.release();
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);

  await expect.poll(() => searched, { message: 'the page searches for the query typed early' }).toEqual([QUERY]);
  await expect(page.getByText(`No results for “${QUERY}”`)).toBeVisible();
  await expect(field).toHaveValue(QUERY);
});
