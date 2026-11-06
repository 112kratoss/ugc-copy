import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A sort picked on Recipe sales before the page's script has run is the order the seller's recipes
 * are listed in, and stays picked (2026-11-06).
 *
 * The server's HTML draws the list and its sort select before any script runs, so on a slow
 * connection a seller can pick one first. React never hears that, and this React build hydrates a
 * select without reading its choice back: the list kept the order the server drew (Most unlocked),
 * and the select's next commit chose that again over the seller's pick (as /contact's subject,
 * contact-typed-before-script.spec.ts).
 *
 * The dev server answers the page's reads from tests/e2e/fixtures/seller-recipes.json
 * (tests/e2e/support/supabase-server-stub.cjs): an older recipe unlocked five times and a newer
 * one never unlocked, which the two sorts order the other way round. The page's own chunk is held
 * until the sort is picked. `marketplace/loading.tsx` puts a Suspense between the document's root
 * and the list, which React hydrates in a commit of its own, so the root's commit is no sign here:
 * the spec waits until the committed tree holds the select's fiber.
 */

const COLD_PAGE = { timeout: 60_000 };
const OLDER = 'Older, most unlocked';
const NEWER = 'Newer, never unlocked';

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/marketplace\/sell\/page\.js(\?|$)/, async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return { requests: () => chunk.requests, release: () => release() };
}

/** Whether React's committed tree holds this element's fiber: its Suspense boundary has hydrated. */
function committed(field: Locator) {
  return field.evaluate((element) => {
    type Fiber = { child: Fiber | null; sibling: Fiber | null; stateNode: unknown };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, { stateNode?: { current?: Fiber } }>)[key] : undefined;
    const stack: Fiber[] = root?.stateNode?.current ? [root.stateNode.current] : [];
    while (stack.length > 0) {
      const fiber = stack.pop()!;
      if (fiber.stateNode === element) return true;
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return false;
  });
}

test(`/marketplace/sell: a sort picked before the page's script runs orders the recipes, and stays picked`, async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: baseURL! }]);
  const chunk = await holdPageChunk(page);

  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto('/marketplace/sell', { waitUntil: 'commit' });
  const sort = page.getByLabel('Sort recipes');
  const rows = page.getByRole('list', { name: 'Your recipes' }).locator(':scope > li');
  await expect(sort).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the pick below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await expect(sort).toHaveValue('unlocks');
  await expect(rows.first()).toContainText(OLDER);
  expect(await committed(sort)).toBe(false);
  await sort.selectOption('newest');
  chunk.release();

  await expect.poll(() => committed(sort), { ...COLD_PAGE, message: 'React commits the list’s hydration' }).toBe(true);

  await expect(rows.first()).toContainText(NEWER);
  await expect(sort).toHaveValue('newest');

  // A render of the list's own: the select keeps the pick, and the list its order.
  await page.getByRole('button', { name: /^Live 2$/ }).click();
  await expect(page.getByRole('button', { name: /^Live 2$/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(sort).toHaveValue('newest');
  await expect(rows.first()).toContainText(NEWER);
  await expect(rows.nth(1)).toContainText(OLDER);
});
