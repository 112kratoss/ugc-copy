import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * The bar between a creator's column and its result drags the column wider or narrower where
 * the two stand side by side (owner, 2026-11-02: "make this bar move sideways so we can expand
 * a little"). The width is kept in this browser across a reload, the result keeps its 440px,
 * and a double-click gives the layout its own width back. jsdom lays nothing out, so the drag,
 * the floors and the bar's place in the gap are checked here.
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

const width = (locator: Locator) => locator.evaluate((element) => Math.round(element.getBoundingClientRect().width));

/** Drags the grip sideways by `dx`, with the mouse, in steps as a hand does. */
async function dragGrip(page: Page, grip: Locator, dx: number) {
  const box = await grip.boundingBox();
  if (!box) throw new Error('The grip is not drawn.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test('the bar between the column and the result drags the column, keeps its width and resets on a double-click', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const quotes = await answerQuote(page);
  await page.goto('/create-video', COLD_PAGE);
  // A drag before the page's script runs would be lost (the fifth gotcha in .claude/rules/e2e.md).
  await expect.poll(() => quotes.length, COLD_PAGE).toBeGreaterThan(0);

  const grip = page.getByRole('separator', { name: 'Column width' });
  await expect(grip).toBeVisible();
  const column = page.locator(`[id="${await grip.getAttribute('aria-controls')}"]`);
  const result = column.locator('xpath=following-sibling::section[1]');
  const own = await width(column);

  // The bar stands in the gap between the two panes.
  const [columnBox, stripBox, resultBox] = await Promise.all([
    column.boundingBox(),
    grip.locator('xpath=..').boundingBox(),
    result.boundingBox(),
  ]);
  expect(stripBox!.x).toBeGreaterThanOrEqual(columnBox!.x + columnBox!.width - 1);
  expect(stripBox!.x + stripBox!.width).toBeLessThanOrEqual(resultBox!.x + 1);

  await dragGrip(page, grip, 120);
  await expect.poll(() => width(column)).toBe(own + 120);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('creator-column-width'))).toBe(String(own + 120));
  await expect(grip).toHaveAttribute('aria-valuenow', String(own + 120));

  // As far right as it goes, the result keeps its 440px.
  await dragGrip(page, grip, 800);
  await expect.poll(() => width(result)).toBeGreaterThanOrEqual(440);
  const widest = await width(column);
  expect(widest).toBeGreaterThan(own + 120);

  // Kept across a reload.
  await page.reload(COLD_PAGE);
  await expect(grip).toBeVisible(COLD_PAGE);
  await expect.poll(() => width(column), COLD_PAGE).toBe(widest);

  // A double-click gives the layout its own width back, and forgets the kept one.
  await grip.dblclick();
  await expect.poll(() => width(column)).toBe(own);
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem('creator-column-width'))).toBeNull();

  // Under the two panes' width there is no bar: the result follows the column.
  await page.setViewportSize({ width: 1000, height: 900 });
  await expect(grip).toBeHidden();
});
