import { expect, test, type Page } from '@playwright/test';

/**
 * The top bar's toggle hides the app's sidebar where it stands beside the page (owner,
 * 2026-11-02, after the Claude app's own). The choice holds across a reload and is drawn
 * from the first paint: the root layout marks the root element inline, ahead of the page's
 * script, which this spec holds back to see the page as the server's HTML draws it.
 */

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

/** Offline the quote cannot be priced, so the page is given one. Its first request says the page's script runs. */
async function answerQuote(page: Page) {
  const asked: unknown[] = [];
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    asked.push(request);
    await route.fulfill({
      json: { modelId: request.modelId ?? 'unknown', catalogRevision: request.catalogRevision ?? 'unknown', normalizedSettings: {}, costCredits: 19 },
    });
  });
  return asked;
}

test('the top bar hides the sidebar, and the page is drawn without it from the next load\'s first paint', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const quotes = await answerQuote(page);
  await page.goto('/create-video', COLD_PAGE);
  await expect.poll(() => quotes.length, COLD_PAGE).toBeGreaterThan(0);

  const sidebar = page.getByRole('complementary', { name: 'Primary navigation' });
  await expect(sidebar).toBeVisible();
  await page.getByRole('button', { name: 'Hide sidebar' }).click();
  await expect(sidebar).toBeHidden();
  // The button stays where it was, with the focus, and now brings the sidebar back.
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeFocused();

  // The next load, with the page's script held back: the server's HTML, which names the toggle
  // "Hide sidebar" until the script reads the choice, is already drawn without the sidebar.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/_next\/static\/chunks\//, async (route) => {
    await held;
    await route.continue();
  });
  await page.reload({ waitUntil: 'domcontentloaded', ...COLD_PAGE });
  await expect(page.locator('.app-shell-sidebar-toggle')).toHaveAttribute('aria-label', 'Hide sidebar');
  await expect(sidebar).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.dataset.sidebar)).toBe('hidden');
  release();
  await expect(page.getByRole('button', { name: 'Show sidebar' })).toBeVisible(COLD_PAGE);
  await page.unroute(/\/_next\/static\/chunks\//);

  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await expect(sidebar).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem('app-shell-sidebar'))).toBeNull();

  // Under 768px the sidebar is the menu's, and the toggle is not drawn.
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator('.app-shell-sidebar-toggle')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
});
