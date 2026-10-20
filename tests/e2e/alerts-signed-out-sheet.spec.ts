import { expect, test, type Page } from '@playwright/test';

// The Alerts tab is in the shell of every page, so signed-out visitors open
// /notifications, which draws them a sign-in card. While the folder's layout
// linked non-public-utilities.css, a full load carried the signed-in sheet as
// well, and a click on the tab fetched it and kept it for the rest of the
// visit. Its signed-in half now brings the sheet itself, loaded once the
// session check finds a reader (src/app/notifications/SignedInAlerts.tsx), so a
// signed-out visit to Alerts carries globals.css alone. Offline, with no
// session in the browser, every visit here is a signed-out one.

// A rule only the supplement holds: the workflow publish drawer's checkbox, a
// signed-in file. Each case also finds it on a route that links the sheet, so
// the reading cannot pass by losing the rule.
const SUPPLEMENT_ONLY_SELECTOR = '.accent-emerald-500';
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

/** Waits for React to own the shell and the page: a click before then is lost. */
async function hydrated(page: Page) {
  await page.waitForFunction(() => ['header.app-shell-header', '#main-content > *'].every((selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && Object.keys(element).some((key) => key.startsWith('__reactFiber$')));
  }), undefined, COLD_PAGE);
}

/** Whether a stylesheet in the document holds the supplement's rule: `next dev` links the sheets, a build inlines them. */
function supplementInDocument(page: Page) {
  return page.evaluate((selector) => {
    const holds = (rules: CSSRuleList): boolean => [...rules].some((rule) => (
      (rule instanceof CSSStyleRule && rule.selectorText === selector)
      || ('cssRules' in rule && holds((rule as CSSGroupingRule).cssRules))
    ));
    return [...document.styleSheets].some((sheet) => {
      try {
        return holds(sheet.cssRules);
      } catch {
        return false;
      }
    });
  }, SUPPLEMENT_ONLY_SELECTOR);
}

/** Gives anything the page still loads on its own (a lazy chunk and its sheet) its chance before a reading of absence. */
async function settled(page: Page) {
  await page.waitForTimeout(1_000);
}

async function push(page: Page, href: string) {
  await page.evaluate((target) => (
    window as unknown as { next: { router: { push: (href: string) => void } } }
  ).next.router.push(target), href);
}

test.describe.configure({ timeout: 180_000 });

test('a signed-out full load of Alerts carries globals.css alone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/notifications');
  await expect(page.getByRole('heading', { name: 'Sign in required' })).toBeVisible(COLD_PAGE);
  await hydrated(page);
  await settled(page);
  expect(await supplementInDocument(page), 'the signed-in sheet is in the document').toBe(false);

  // Positive control: Search, which a signed-out visitor opens too, keeps the
  // sheet its layout links.
  await page.goto('/search');
  await expect.poll(() => supplementInDocument(page), COLD_PAGE).toBe(true);
});

test('a signed-out click on the Alerts tab leaves the signed-in sheet out of the visit', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/terms');
  await hydrated(page);
  await page.evaluate(() => { (window as unknown as { openedOnTerms: boolean }).openedOnTerms = true; });

  await page.getByRole('link', { name: 'Open alerts' }).click();
  await expect(page).toHaveURL(/\/notifications$/, COLD_PAGE);
  await expect(page.getByRole('heading', { name: 'Sign in required' })).toBeVisible(COLD_PAGE);
  await hydrated(page);
  await settled(page);
  expect(await supplementInDocument(page), 'the signed-in sheet is in the document').toBe(false);

  // And so for the rest of the visit: back to a public page.
  await push(page, '/terms');
  await expect(page).toHaveURL(/\/terms$/, COLD_PAGE);
  await hydrated(page);
  await settled(page);
  expect(await supplementInDocument(page), 'the signed-in sheet is in the document').toBe(false);
  // All in the window /terms opened: client navigations, and no reload.
  expect(await page.evaluate(() => (window as unknown as { openedOnTerms?: boolean }).openedOnTerms === true)).toBe(true);

  // Positive control: a client navigation to a route that links the sheet brings it.
  await push(page, '/search');
  await expect(page).toHaveURL(/\/search$/, COLD_PAGE);
  await expect.poll(() => supplementInDocument(page), COLD_PAGE).toBe(true);
});
