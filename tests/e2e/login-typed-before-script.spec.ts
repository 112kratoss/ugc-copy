import { expect, test, type Page } from '@playwright/test';

/**
 * What a visitor types into /login's sign-in form before the page's script has run is what the
 * sign-in sends, and the fields keep it (2026-11-01).
 *
 * The server's HTML draws the form before any script runs, so on a slow connection a visitor can
 * type their email and password first. React never hears that typing, and this React build
 * hydrates an input without reading its value back: the text stayed in the fields while the
 * page's state stayed empty. Enter, pressed once the script had run, signed in with
 * `{"email":"","password":""}`, the render that followed wrote the empty state over both fields,
 * and the alert said the email and password do not match.
 *
 * The page's own chunk is held until both fields are filled, as in
 * form-submit-before-script.spec.ts, and Enter waits for React to have committed the page's
 * hydration. The form gives no sign of its own without a render, and before the fix any render
 * of it wrote the empty state over the fields, the loss this spec is about; a `__reactFiber$`
 * key is set before the commit (.claude/rules/e2e.md).
 */

const COLD_PAGE = { timeout: 45_000 };
const EMAIL = 'early-visitor@example.com';
const PASSWORD = 'typed-before-the-script-5150';

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/login\/page\.js(\?|$)/, async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return { requests: () => chunk.requests, release: () => release() };
}

/**
 * Whether React has committed the page's hydration: the root it hydrates, the document, no
 * longer marks its tree as dehydrated. The commit sets that, after the render has reached every
 * field and before any key pressed there is React's.
 */
function hydrationCommitted(page: Page) {
  return page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  });
}

test(`/login: an email and password typed before the page's script runs are what the sign-in sends, and stay in the fields`, async ({ page }) => {
  test.setTimeout(120_000);
  const signIns: unknown[] = [];
  await page.route(/^https:\/\/example\.supabase\.co\/auth\/v1\/token\?grant_type=password$/, async (route) => {
    signIns.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid login credentials' } });
  });
  const chunk = await holdPageChunk(page);

  // No timeout of its own: this can be the run's first request for the route, which waits for
  // its compile, and on a busy machine that outlasts any fixed wait (.claude/rules/e2e.md).
  await page.goto('/login?redirect=%2Fcreate-image', { waitUntil: 'commit' });
  await expect(page.locator('#login-password')).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the typing below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await page.locator('#login-email').fill(EMAIL);
  await page.locator('#login-password').fill(PASSWORD);
  chunk.release();
  await expect.poll(() => hydrationCommitted(page), { ...COLD_PAGE, message: 'React commits the page’s hydration' }).toBe(true);

  await page.locator('#login-password').press('Enter');

  await expect.poll(() => signIns.length, { message: 'the page signs in through Supabase' }).toBe(1);
  expect(signIns[0]).toMatchObject({ email: EMAIL, password: PASSWORD });
  await expect(page.locator('#auth-error')).toBeVisible();
  await expect(page.locator('#login-email')).toHaveValue(EMAIL);
  await expect(page.locator('#login-password')).toHaveValue(PASSWORD);
});
