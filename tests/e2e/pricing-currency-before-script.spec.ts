import { expect, test, type Page } from '@playwright/test';

/**
 * A currency picked on /pricing before the page's script has run is the one its packs are priced
 * in, and the page keeps it as the visitor's choice (2026-11-06).
 *
 * The server's HTML draws the currency select before any script runs, so on a slow connection a
 * visitor can pick one first. React never hears that, and this React build hydrates a select
 * without reading its choice back: the page's state kept the currency the server drew, its mount
 * effect then set the browser's default (the locale's, USD here), and the select's next commit
 * chose that over the visitor's pick, which was never saved either (as /contact's subject,
 * contact-typed-before-script.spec.ts).
 *
 * The page's own chunk is held until the currency is picked. The FX line's "Updated" date is the
 * sign the script ran: only the page's mount effect asks for the rates.
 */

const COLD_PAGE = { timeout: 45_000 };
const STORAGE_KEY = 'magicbooklet_currency';
const FX = { base: 'INR', rates: { USD: 0.012, EUR: 0.011, GBP: 0.0095 }, updatedAt: '2026-11-06' };

test.use({ locale: 'en-US' });

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/pricing\/page\.js(\?|$)/, async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return { requests: () => chunk.requests, release: () => release() };
}

/** Offline the rates cannot be read, so the page is given some. */
async function answerFx(page: Page) {
  await page.route('**/api/fx', (route) => route.fulfill({ json: FX }));
}

function savedCurrency(page: Page) {
  return page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY);
}

/** The Starter pack's price line: its amount and the currency named beside it. */
function starterPrice(page: Page) {
  return page.locator('h2', { hasText: 'Starter' }).locator('xpath=../following-sibling::div[1]');
}

test(`/pricing: a currency picked before the page's script runs prices the packs, and is kept`, async ({ page }) => {
  test.setTimeout(120_000);
  await answerFx(page);
  const chunk = await holdPageChunk(page);

  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto('/pricing', { waitUntil: 'commit' });
  const select = page.locator('#pricing-currency');
  await expect(select).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the pick below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  // The server drew INR: no country header reaches the E2E server.
  await expect(select).toHaveValue('INR');
  await select.selectOption('EUR');
  chunk.release();

  await expect(page.getByText(`Updated ${FX.updatedAt}`)).toBeVisible(COLD_PAGE);

  await expect(select).toHaveValue('EUR');
  await expect(starterPrice(page)).toContainText('EUR');
  await expect.poll(() => savedCurrency(page), { message: 'the pick is saved as a choice made after the script is' }).toBe('EUR');

  // Back on the page, the saved choice opens it, as a choice made after the script does.
  await page.reload({ ...COLD_PAGE, waitUntil: 'load' });
  await expect(page.getByText(`Updated ${FX.updatedAt}`)).toBeVisible(COLD_PAGE);
  await expect(select).toHaveValue('EUR');
});

test(`/pricing: a visitor who picks nothing before the script runs gets the browser's currency, unsaved`, async ({ page }) => {
  test.setTimeout(120_000);
  await answerFx(page);
  const chunk = await holdPageChunk(page);

  await page.goto('/pricing', { waitUntil: 'commit' });
  await expect(page.locator('#pricing-currency')).toBeVisible(COLD_PAGE);
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  chunk.release();

  await expect(page.getByText(`Updated ${FX.updatedAt}`)).toBeVisible(COLD_PAGE);
  await expect(page.locator('#pricing-currency')).toHaveValue('USD');
  await expect(starterPrice(page)).toContainText('USD');
  expect(await savedCurrency(page)).toBeNull();
});
