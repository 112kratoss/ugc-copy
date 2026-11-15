import { expect, test, type Page } from '@playwright/test';

// The brand in the side navigation is Home's other control (2026-11-15). On Home it
// does what pressing Home does there: a scrolled feed goes back to its top, and a
// feed already at its top is fetched afresh from page one, as X and Instagram do.
// Before, the logo was a plain link to `/`, and on Home that link left a scrolled
// feed where it was and never refreshed it.
//
// Signed out: the signed-in Home is the same shell and the same feed (`HomeExperience`,
// `FeedClient`), and the bare E2E cookie loops `/` through the proxy's rewrite. Offline
// the feed's server read fails, so the feed asks `/api/showcase/feed` from the
// browser, which this spec answers and counts. The page is made tall itself.

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const SLOW_PAGE = { timeout: 30_000 };

const EMPTY_FEED_PAGE = {
  items: [],
  pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 0 },
};

/** Answers every feed request with an empty page and counts those for page one. */
async function countFeedRefreshes(page: Page) {
  const firstPages: string[] = [];
  await page.route('**/api/showcase/feed?*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.searchParams.has('cursor') && url.searchParams.get('offset') === '0') {
      firstPages.push(url.search);
    }
    await route.fulfill({ json: EMPTY_FEED_PAGE });
  });
  return firstPages;
}

function sidebarLogo(page: Page) {
  return page.locator('aside.app-shell-sidebar').getByRole('link', { name: /^Magic Booklet/ });
}

function sidebarHome(page: Page) {
  return page.locator('aside.app-shell-sidebar').getByRole('link', { name: 'Home', exact: true });
}

/** Waits for React to own the shell and the page, as pages-open-at-top.spec.ts does. */
async function hydrated(page: Page) {
  await page.waitForFunction(() => ['header.app-shell-header', '#main-content > *'].every((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactFiber$')));
  }), undefined, SLOW_PAGE);
}

async function scrollTo(page: Page, top: number) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(top);
}

/** The scroll position once it has held for 700ms, so a smooth scroll has ended. */
async function settledScrollY(page: Page) {
  const startedAt = Date.now();
  let last = Number.NaN;
  let stableSince = Date.now();
  while (Date.now() - startedAt < 8000) {
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y !== last) {
      last = y;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 700) {
      return y;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`the scroll position never settled (last read ${last})`);
}

async function openTallHome(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'For you' })).toBeVisible(SLOW_PAGE);
  await hydrated(page);
  await page.addStyleTag({ content: '.app-shell-content { min-height: 6000px !important; }' });
}

test('the logo on a scrolled Home brings the feed back to its top', async ({ page }) => {
  test.slow();
  await countFeedRefreshes(page);
  await openTallHome(page);

  await scrollTo(page, 2400);
  await sidebarLogo(page).click();

  expect(await settledScrollY(page)).toBe(0);
});

test('the logo on Home at its top fetches the feed afresh', async ({ page }) => {
  test.slow();
  const firstPages = await countFeedRefreshes(page);
  await openTallHome(page);
  // The page's own first fetch, offline, and nothing since.
  await expect.poll(() => firstPages.length).toBe(1);

  await sidebarLogo(page).click();
  await expect.poll(() => firstPages.length).toBe(2);
  expect(await settledScrollY(page)).toBe(0);

  // Scrolled again, the logo only scrolls: the feed is not fetched a third time.
  await scrollTo(page, 1800);
  await sidebarLogo(page).click();
  expect(await settledScrollY(page)).toBe(0);
  expect(firstPages).toHaveLength(2);
});

test('Home pressed on Home at its top fetches the feed afresh', async ({ page }) => {
  test.slow();
  const firstPages = await countFeedRefreshes(page);
  await openTallHome(page);
  await expect.poll(() => firstPages.length).toBe(1);

  await sidebarHome(page).click();
  await expect.poll(() => firstPages.length).toBe(2);
});
