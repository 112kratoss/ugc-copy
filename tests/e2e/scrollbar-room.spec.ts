import { expect, test, type Page } from '@playwright/test';

// The live sweep of 2026-11-17 measured it in a browser whose scrollbars take room beside the page:
// Alerts, whose list comes after its first paint, moved 7.5px sideways when its scrollbar came (a
// layout shift of 0.0054), as every page did going between a short page and a long one. The root
// layout now marks such a browser before the first paint and the stylesheet keeps the room open
// (src/lib/scrollbar-room-restore.ts). Playwright's own browser hides its scrollbars, which take no
// room there, so the first test launches one that shows them, as a Windows or Linux browser does.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };
const SHORT_PAGE = '/login';

/** Where the page's heading starts, which a scrollbar coming moves when the page gives it room. */
function headingLeft(page: Page) {
  return page.locator('h1').first().evaluate((heading) => heading.getBoundingClientRect().left);
}

test('a page keeps its place when its scrollbar comes, where scrollbars take room beside it', async ({ playwright }, testInfo) => {
  const browser = await playwright.chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  try {
    const page = await browser.newPage({ baseURL: String(testInfo.project.use.baseURL), viewport: { width: 1440, height: 1600 } });
    await page.goto(SHORT_PAGE, COLD_PAGE);
    await expect(page.locator('h1').first()).toBeVisible(COLD_PAGE);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), 'the page starts too short to scroll').toBe(true);
    const before = await headingLeft(page);

    // What a late list does: the page grows past the window, and its scrollbar comes.
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div style="height:4000px" aria-hidden="true"></div>'));
    expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight), 'the page scrolls now').toBe(true);
    expect(await headingLeft(page), 'the heading has not moved').toBe(before);
    // The room is kept open, from the first paint: a scrollbar's width less than the window.
    await expect(page.locator('html')).toHaveAttribute('data-scrollbar-room', '');
    expect(await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)).toBeGreaterThan(0);
  } finally {
    await browser.close();
  }
});

test('a browser whose scrollbars take no room is not marked, and its pages use the whole window', async ({ page }) => {
  await page.goto(SHORT_PAGE, COLD_PAGE);
  await expect(page.locator('h1').first()).toBeVisible(COLD_PAGE);
  await expect(page.locator('html')).not.toHaveAttribute('data-scrollbar-room');
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<div style="height:4000px" aria-hidden="true"></div>'));
  expect(await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)).toBe(0);
});
