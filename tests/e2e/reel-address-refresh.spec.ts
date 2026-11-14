import { expect, test, type Page } from '@playwright/test';

// A refresh on a post's reel address (`?post=` on Explore, a creator's page or the profile)
// drew the page under the reel first (owner's recording, 2026-11-15): the server's HTML is the
// grid, and the reel, a chunk of its own, opened only once the page's script had run, over the
// grid dimmed under "Opening preview". The root layout now marks such an address on the root
// element before the first paint, and the reel's own stage covers the page until the reel's
// dialog attaches (src/lib/reel-opening-restore.ts).

const COLD_PAGE = { timeout: 45_000 };
// A post the dev server's stub answers (fixtures/post-with-recipe.json); offline the reel opens on
// it as a direct read, loading and then whatever the read answers, inside its dialog.
const POST_ID = 'e2e5ec1e-0000-4000-8000-000000000001';

test.describe.configure({ timeout: 120_000 });

/** What the window's middle shows on top: the reel's stage, the reel, or the page. */
function topmostAtCentre(page: Page) {
  return page.evaluate(() => {
    const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    if (element?.closest('.reel-opening-cover')) return 'stage';
    if (element?.closest('[role="dialog"]')) return 'reel';
    return 'page';
  });
}

/** Next's own scripts never arrive: the page is what the server sent, with its inline scripts run. */
async function withoutPageScripts(page: Page) {
  await page.route('**/_next/static/chunks/**', (route) => route.abort());
}

for (const { name, path } of [
  { name: 'Explore', path: '/showcase' },
  { name: 'a creator\'s page', path: '/creators/e2e-creator' },
]) {
  test(`${name} loaded on a post's reel address shows the reel's stage before any script, not the page`, async ({ page }) => {
    await withoutPageScripts(page);
    await page.goto(`${path}?post=${POST_ID}`, COLD_PAGE);

    await expect(page.locator('.reel-opening-cover')).toBeVisible();
    expect(await topmostAtCentre(page)).toBe('stage');
  });

  test(`${name} loaded without a post never shows the reel's stage`, async ({ page }) => {
    await withoutPageScripts(page);
    await page.goto(path, COLD_PAGE);

    await expect(page.locator('.reel-opening-cover')).toBeHidden();
    expect(await topmostAtCentre(page)).toBe('page');
  });
}

// Explore's grid is drawn from a server read the offline server cannot make (it draws "Could not
// load Explore"), so its reel is never reached here; the creator's page opens the same reel.
test("a creator's page loaded on a post's reel address hands the stage to the reel", async ({ page }) => {
  await page.goto(`/creators/e2e-creator?post=${POST_ID}`, COLD_PAGE);

  await expect(page.getByRole('dialog', { name: /reel viewer$/ })).toBeVisible(COLD_PAGE);
  await expect(page.locator('.reel-opening-cover')).toBeHidden();
  expect(await page.locator('html').getAttribute('data-reel-opening')).toBeNull();
  expect(await topmostAtCentre(page)).toBe('reel');
});

test('the stage is never drawn on a post page, whose address is the post itself', async ({ page }) => {
  await withoutPageScripts(page);
  await page.goto(`/showcase/${POST_ID}?post=${POST_ID}`, COLD_PAGE);

  await expect(page.locator('.reel-opening-cover')).toBeHidden();
});
