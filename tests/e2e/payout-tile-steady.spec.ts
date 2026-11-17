import { expect, test } from '@playwright/test';

/**
 * The Earnings tile on Recipe sales keeps its height from the loading state to the loaded one
 * (2026-11-17). It drew a heading and one line, then grew to the balance, its caption and the
 * progress block when the payout read came in, and the recipes grid below it moved (a layout shift
 * of 0.0137 on production). The read is answered a second late here with a zero balance, the
 * common case, and the layout shifts from that answer on are summed.
 */

const COLD_PAGE = { timeout: 60_000 };

const ZERO_BALANCE = {
  availableTokenSubunits: 0,
  heldTokenSubunits: 0,
  lifetimeEarnedTokenSubunits: 0,
  lifetimePaidOutTokenSubunits: 0,
  availableUsd: '$0.00',
  minimumTokenSubunits: 1_000_000,
  minimumUsd: '$100.00',
  canRequest: false,
  pendingRequest: null,
  history: [],
};

test('/marketplace/sell: the Earnings tile does not grow when the balance arrives', async ({ page, context, baseURL }) => {
  test.setTimeout(180_000);
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: baseURL! }]);
  await page.addInitScript(() => {
    const w = window as unknown as { __shifts: { at: number; value: number }[] };
    w.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) w.__shifts.push({ at: performance.now(), value: entry.value });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });

  let answered = 0;
  await page.route('**/api/creator/payouts', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    answered = Date.now();
    await route.fulfill({ json: ZERO_BALANCE });
  });

  await page.goto('/marketplace/sell', { waitUntil: 'commit' });
  const tile = page.locator('section.ui-card').filter({ has: page.getByRole('heading', { name: 'Earnings' }) });
  await expect(tile).toBeVisible(COLD_PAGE);
  await expect(tile.getByText('Loading your balance…')).toBeVisible();
  // Past the recipes' own first paint, so the only thing left to move is the tile.
  await expect(page.getByRole('list', { name: 'Your recipes' })).toBeVisible(COLD_PAGE);
  await page.evaluate(() => {
    (window as unknown as { __mark: number }).__mark = performance.now();
  });
  const loadingHeight = (await tile.boundingBox())!.height;

  await expect(tile.getByText('$0.00')).toBeVisible(COLD_PAGE);
  expect(answered).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  const loadedHeight = (await tile.boundingBox())!.height;
  const shifted = await page.evaluate(() => {
    const w = window as unknown as { __mark: number; __shifts: { at: number; value: number }[] };
    return w.__shifts.filter((shift) => shift.at >= w.__mark).reduce((sum, shift) => sum + shift.value, 0);
  });
  expect(Math.abs(loadedHeight - loadingHeight), `tile height ${loadingHeight} -> ${loadedHeight}`).toBeLessThanOrEqual(1);
  expect(shifted, 'layout shift from the answer on').toBeLessThan(0.001);
});
