import { expect, test, type Page } from '@playwright/test';

// A page opened from the side navigation starts at its top. Two things kept one
// from doing so (2026-10-18):
//
// - The shell brought back where Home, Explore, Alerts and Profile were left, so a
//   Profile scrolled to its last row and left reopened at that row. Those links
//   also told Next not to scroll, to leave the restoring to the shell.
// - The top bar is sticky. A short page (a min-h-screen root is the bar's height
//   taller than the window) opened from a scrolled one is clamped to a scroll of
//   about 65px with its top under the bar, and Next scrolls to the top only when a
//   new page's top is out of view. The shell now finishes that scroll.
//
// Next's docs suggest `scroll-padding-top` on the root for sticky headers. Here it
// made every focus in the bar or the drawer scroll the page by half a window; the
// last two tests hold that line.
//
// Offline these pages have little to show, so each case makes a page tall itself.

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

// The offline Profile spends about 8 seconds failing its reads before it draws.
const SLOW_PAGE = { timeout: 30_000 };

function sidebarLink(page: Page, name: string) {
  return page.locator('aside.app-shell-sidebar').getByRole('link', { name, exact: true });
}

/**
 * Waits for React to own the shell and the page. A click before that is a full page
 * load, which starts at the top whatever the bug, and a node added before it is
 * thrown away by hydration.
 */
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

/**
 * The scroll position once it has held for 700ms. A scroll that lands a frame or
 * more after the new page (the old restore did) would slip past a single read.
 */
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

/** Every page in this tab tall, from a sheet that outlives client navigations. */
async function makeEveryPageTall(page: Page) {
  await page.addStyleTag({ content: '.app-shell-content { min-height: 6000px !important; }' });
}

test('a tab opens at its top, not where it was last left', async ({ page }) => {
  // Two offline Profile draws on top of a cold compile of the route.
  test.slow();
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible(SLOW_PAGE);
  await hydrated(page);
  await makeEveryPageTall(page);

  await scrollTo(page, 2000);
  await sidebarLink(page, 'Explore').click();
  await page.waitForURL('**/showcase');
  // Explore was never scrolled; leaving it far down shows that Profile is now
  // brought to its top on arrival rather than kept wherever the window was.
  await scrollTo(page, 3000);

  await sidebarLink(page, 'Profile').click();
  await page.waitForURL('**/profile');
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible(SLOW_PAGE);
  expect(await settledScrollY(page)).toBe(0);

  // Pressing the tab that is already open still brings it back to the top.
  await scrollTo(page, 1200);
  await sidebarLink(page, 'Profile').click();
  expect(await settledScrollY(page)).toBe(0);
});

test('a short page opened from a scrolled one shows its top below the top bar', async ({ page }) => {
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await hydrated(page);
  // Tall from inside the page's own root, so the height leaves with the page.
  await page.locator('#main-content > *').first().evaluate((root) => {
    const spacer = document.createElement('div');
    spacer.style.height = '6000px';
    root.append(spacer);
  });

  await scrollTo(page, 1500);
  await sidebarLink(page, 'Search').click();
  await page.waitForURL('**/search');
  await expect(page.getByRole('heading', { name: 'Search the creator community' })).toBeVisible();

  expect(await settledScrollY(page)).toBe(0);
  const barBottom = await page.locator('header.app-shell-header').evaluate((bar) => bar.getBoundingClientRect().bottom);
  const pageTop = await page.locator('#main-content > *').first().evaluate((root) => root.getBoundingClientRect().top);
  expect(pageTop).toBeGreaterThanOrEqual(barBottom);
});

test('focus moving into the top bar leaves a scrolled page where it is', async ({ page }) => {
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await hydrated(page);
  await makeEveryPageTall(page);
  await scrollTo(page, 1500);

  await page.getByRole('link', { name: 'Open alerts' }).focus();
  expect(await settledScrollY(page)).toBe(1500);
});

test('the phone drawer opens and closes over a scrolled page without moving it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Alerts', exact: true })).toBeVisible();
  await hydrated(page);
  await makeEveryPageTall(page);
  await scrollTo(page, 1500);

  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  expect(await settledScrollY(page)).toBe(1500);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  expect(await settledScrollY(page)).toBe(1500);
});
