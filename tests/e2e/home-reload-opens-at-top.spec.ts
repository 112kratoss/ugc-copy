import { expect, test, type Page } from '@playwright/test';

// A reload of Home opens at its top (owner's recording, 2026-11-16). Home's feed is
// ranked afresh on every load, so the browser's own restore of the old scroll offset
// put the reader in the middle of a different feed: the skeleton and the first rows
// drew at the top, then the page jumped down onto a post they had never scrolled to.
// The root layout's inline script marks Home's history entry for no restore as the
// document goes, and the reloaded document gives the browser its restore back once its
// load is done (src/lib/home-reload-at-top.ts), so Back and Forward inside the app
// still land where they were left, and every other page's reload still keeps its place.
//
// Signed out, as home-logo-top-and-refresh.spec.ts draws Home: the same shell and the
// same feed as signed in, and the bare E2E cookie loops `/` through the proxy's
// rewrite. The page is made tall from the first layout of every load, the hardest
// case: the browser can restore the offset before any of the page's own code runs.

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const SLOW_PAGE = { timeout: 30_000 };

const EMPTY_FEED_PAGE = {
  items: [],
  pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 0 },
};

async function answerFeed(page: Page) {
  await page.route('**/api/showcase/feed?*', (route) => route.fulfill({ json: EMPTY_FEED_PAGE }));
}

/**
 * Every load of every page in this test is 6000px tall from its first layout. The style goes
 * into <head> as soon as there is one, where hydration leaves a node it did not draw, and goes
 * back if anything takes it out.
 */
async function tallFromFirstLayout(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = '.app-shell-content { min-height: 6000px !important; }';
    // An init script can run before the document has a root element.
    const keep = () => {
      const home = document.head ?? document.documentElement;
      if (home && style.parentNode !== home) home.appendChild(style);
    };
    keep();
    new MutationObserver(keep).observe(document, { childList: true, subtree: true });
  });
}

function sidebarLink(page: Page, name: string) {
  return page.locator('aside.app-shell-sidebar').getByRole('link', { name, exact: true });
}

/** Waits for React to own the shell and the page, as pages-open-at-top.spec.ts does. */
async function hydrated(page: Page) {
  await page.waitForFunction(() => ['header.app-shell-header', '#main-content > *'].every((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactFiber$')));
  }), undefined, SLOW_PAGE);
}

async function homeDrawn(page: Page) {
  await expect(page.getByRole('button', { name: 'For you' })).toBeVisible(SLOW_PAGE);
  await hydrated(page);
}

async function scrollTo(page: Page, top: number) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), top);
  await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBe(top);
}

/** The scroll position once it has held for 700ms, so a late restore or smooth scroll has ended. */
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

test('a reload of a scrolled Home opens at its top', async ({ page }) => {
  test.slow();
  await answerFeed(page);
  await tallFromFirstLayout(page);
  await page.goto('/');
  await homeDrawn(page);

  await scrollTo(page, 2400);
  await page.reload({ waitUntil: 'load' });
  await homeDrawn(page);

  expect(await settledScrollY(page)).toBe(0);
  // The browser's restore is back on once the load is done.
  await expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe('auto');
});

test('after a reload of Home, Back to Home still lands where it was left', async ({ page }) => {
  test.slow();
  await answerFeed(page);
  await tallFromFirstLayout(page);
  await page.goto('/');
  await homeDrawn(page);
  await page.reload({ waitUntil: 'load' });
  await homeDrawn(page);
  await expect.poll(() => page.evaluate(() => history.scrollRestoration)).toBe('auto');

  await scrollTo(page, 1800);
  await sidebarLink(page, 'AI agents').click();
  await expect(page).toHaveURL(/\/developers\/mcp$/, SLOW_PAGE);
  await hydrated(page);
  expect(await settledScrollY(page)).toBe(0);

  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  expect(await settledScrollY(page)).toBe(1800);
});

test('a reload of another page keeps its place', async ({ page }) => {
  test.slow();
  await tallFromFirstLayout(page);
  await page.goto('/developers/mcp');
  await hydrated(page);

  await scrollTo(page, 1800);
  await page.reload({ waitUntil: 'load' });
  await hydrated(page);

  expect(await settledScrollY(page)).toBe(1800);
});
