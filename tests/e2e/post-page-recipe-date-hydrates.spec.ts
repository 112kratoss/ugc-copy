import { expect, test } from '@playwright/test';

import recipePost from './fixtures/post-with-recipe.json';

// The live sweep of 2026-11-18 (build 38dec188b), in a browser in India: a post page whose recipe
// was updated after 18:30 UTC threw React's error #418. The server, in UTC, wrote "Updated Nov 3,
// 2026" and the browser, in India, "Updated Nov 4, 2026", so React threw the server's HTML away and
// drew the whole page again: everything the pre-paint scripts had marked on the root element (the
// session hint, the account, the scrollbar room, the balance's width) went with it, and the top
// bar's controls moved 9px. The date is the server's day in both now.
//
// The dev server draws the post from fixtures/post-with-recipe.json, whose recipe was updated at
// 20:00 UTC on 2026-10-01: 01:30 on 2026-10-02 in India.

const COLD_PAGE = { timeout: 60_000 };

test.use({ timezoneId: 'Asia/Kolkata', locale: 'en-IN', viewport: { width: 1440, height: 900 } });

test('a reader in India hydrates a post page whose recipe was updated late in the UTC day', async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat|didn't match|did not match|#418|#425/i.test(message.text())) {
      hydrationErrors.push(message.text().slice(0, 300));
    }
  });
  page.on('pageerror', (error) => {
    if (/hydrat|didn't match|#418|#425/i.test(String(error))) hydrationErrors.push(String(error).slice(0, 300));
  });

  await page.goto(`/showcase/${recipePost.post.id}`, COLD_PAGE);
  await expect(page.getByText('Updated Oct 1, 2026')).toBeVisible(COLD_PAGE);
  // The browser's own day for that moment is the 2nd: the page shows the server's, the 1st.
  expect(await page.evaluate(() => new Date('2026-10-01T20:00:00.000Z').getDate())).toBe(2);

  // Hydration is over once the root has committed (login-typed-before-script.spec.ts says why
  // that, and not a `__reactFiber$` key, is the sign).
  await expect.poll(() => page.evaluate(() => {
    type HostRoot = { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } };
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, HostRoot>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  }), COLD_PAGE).toBe(true);
  await page.waitForTimeout(500);
  expect(hydrationErrors).toEqual([]);
  await expect(page.getByText('Updated Oct 1, 2026')).toBeVisible();
});
