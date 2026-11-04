import { expect, test, type Page } from '@playwright/test';

/**
 * A filter typed into /templates' search field before the page's script has run filters the
 * catalog, and the field keeps it (2026-11-05).
 *
 * The server's HTML draws the field before any script runs, and this React build hydrates an input
 * without reading its value back: the field showed the filter while the page's state stayed empty,
 * and the page's first render after that (here, the catalog arriving) wrote the empty state over
 * the field and left every template listed (as on /login, login-typed-before-script.spec.ts).
 *
 * The E2E server cannot read the catalog, so the page loads it through `/api/templates` once its
 * script runs, which this spec answers. The page's own chunk is held until the filter is typed,
 * and the grid is checked once React has committed the page's hydration (.claude/rules/e2e.md):
 * no Suspense or Activity boundary sits between the document's root and the field.
 */

const COLD_PAGE = { timeout: 45_000 };
const FILTER = 'lighthouse';

function template(id: string, name: string) {
  return {
    id,
    slug: id,
    name,
    description: null,
    category: 'Creative',
    thumbnailUrl: null,
    videoUrl: null,
    inputSlots: [{ key: 'photo', kind: 'image', label: 'Photo', required: true }],
    outputKind: 'video',
    status: 'active',
    useCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/templates\/page\.js(\?|$)/, async (route) => {
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

test(`/templates: a filter typed before the page's script runs filters the catalog, and the field keeps it`, async ({ page }) => {
  test.setTimeout(120_000);
  let catalogReads = 0;
  await page.route(/\/api\/templates(\?|$)/, async (route) => {
    catalogReads += 1;
    await route.fulfill({
      json: { templates: [template('lighthouse-dusk', 'Lighthouse at dusk'), template('neon-portrait', 'Neon portrait')], nextCursor: null },
    });
  });
  const chunk = await holdPageChunk(page);

  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto('/templates', { waitUntil: 'commit' });
  const field = page.getByRole('searchbox', { name: 'Search templates' });
  await expect(field).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the typing below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await field.fill(FILTER);
  chunk.release();
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);

  // Twice in development, where Strict Mode runs the page's effects again.
  await expect.poll(() => catalogReads, { message: 'the page loads the catalog' }).toBeGreaterThan(0);
  await expect(page.getByText('Lighthouse at dusk')).toBeVisible();
  await expect(page.getByText('Neon portrait')).toHaveCount(0);
  await expect(field).toHaveValue(FILTER);
});
