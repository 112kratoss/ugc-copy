import { expect, test, type Page } from '@playwright/test';

/**
 * What a visitor puts into /contact's form before the page's script has run is what the form
 * sends, and the fields keep it (2026-11-05).
 *
 * The page is prerendered, so its form is in the HTML before any script runs, and on a slow
 * connection a visitor can fill it in first. React never hears that, and this React build hydrates
 * the fields without reading them back: the form's state stayed empty, Send posted an empty name,
 * email and message on the default subject, and the render that followed wrote that state over
 * the fields (a select's chosen option included: hydration leaves it alone, the next commit does
 * not), as on /login (login-typed-before-script.spec.ts).
 *
 * The page's own chunk is held until the form is filled, and Send waits for React to have
 * committed the page's hydration (.claude/rules/e2e.md): the document's root no longer marks its
 * tree dehydrated, with no Suspense or Activity boundary between it and the form.
 */

const COLD_PAGE = { timeout: 45_000 };
const FILLED = {
  name: 'Early Visitor',
  email: 'early-visitor@example.com',
  subject: 'billing',
  message: 'Typed before the page’s script ran.',
};

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/contact\/page\.js(\?|$)/, async (route) => {
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

test(`/contact: a form filled in before the page's script runs is what Send posts, and the fields keep it`, async ({ page }) => {
  test.setTimeout(120_000);
  const sent: unknown[] = [];
  await page.route('**/api/contact', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 503, json: { error: 'Messages are paused for this test.' } });
  });
  const chunk = await holdPageChunk(page);

  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto('/contact', { waitUntil: 'commit' });
  await expect(page.locator('#message')).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the filling below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await page.locator('#name').fill(FILLED.name);
  await page.locator('#email').fill(FILLED.email);
  await page.locator('#subject').selectOption(FILLED.subject);
  await page.locator('#message').fill(FILLED.message);
  chunk.release();
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);

  await page.getByRole('button', { name: 'Send Message' }).click();

  await expect.poll(() => sent.length, { message: 'the form posts to /api/contact' }).toBe(1);
  expect(sent[0]).toEqual(FILLED);
  await expect(page.getByRole('alert').filter({ hasText: 'Messages are paused for this test.' })).toBeVisible();
  await expect(page.locator('#name')).toHaveValue(FILLED.name);
  await expect(page.locator('#email')).toHaveValue(FILLED.email);
  await expect(page.locator('#subject')).toHaveValue(FILLED.subject);
  await expect(page.locator('#message')).toHaveValue(FILLED.message);
});
