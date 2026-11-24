import { expect, test, type Page } from '@playwright/test';

import recipePage from './fixtures/creator-page-recipes.json';

// Seen on 2026-11-24 while measuring the reel's rail on phones (#905): on a 360px phone the reel's
// Details row drew a long creator name and handle under the Follow button, which covered them,
// where the name should end in an ellipsis before it. `CreatorIdentity` is an inline-flex box, and
// an inline box is as wide as its content's narrowest line at least: its name and handle never
// wrap, so it overflowed the slot its row gave it, and their `truncate` never had a narrower box
// to cut them in. The creator page's reel shows it: its creator's name, "E2E Recipe Page Creator",
// and handle are longer than a phone's row leaves beside Follow.
//
// The dev server answers the page's reads (support/supabase-server-stub.cjs,
// fixtures/creator-page-recipes.json). The browser's own requests are answered here, offline: the
// row is drawn from the page's data alone.

const CREATOR = recipePage.creator;
// The page opens its reel on a post of its own from the address, once its script runs: no press
// that a page still hydrating would drop.
const REEL_PATH = `/creators/${CREATOR.username}?post=${recipePage.posts[0].id}`;
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350"><rect width="1080" height="1350" fill="#2b1b4f"/></svg>`;

test.describe.configure({ timeout: 180_000 });

async function answerOffline(page: Page) {
  const context = page.context();
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await context.route('**/_next/image**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PICTURE }));
}

for (const width of [320, 360]) {
  test(`the reel's creator row ends the creator's name before Follow on a ${width}px phone`, async ({ page }) => {
    await answerOffline(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(REEL_PATH);

    const details = page.locator('[role="dialog"] [data-reel-scroll-region="details"]');
    const follow = details.locator('[data-reel-follow]');
    const identity = details.locator(`a[href="/creators/${CREATOR.username}"]`).first();
    await expect(follow).toBeVisible(COLD_PAGE);
    await expect(identity).toContainText(CREATOR.display_name);

    const row = await identity.evaluate((link, followSelector) => {
      const button = link.closest('[data-reel-scroll-region="details"]')!.querySelector(followSelector)!;
      const name = link.querySelector('.truncate')!;
      return {
        identityRight: link.getBoundingClientRect().right,
        followLeft: button.getBoundingClientRect().left,
        nameCut: name.scrollWidth > name.clientWidth,
      };
    }, '[data-reel-follow]');

    // The name is longer than the row leaves it here, so the row has something to cut.
    expect.soft(row.nameCut, 'the name ends in an ellipsis').toBe(true);
    expect.soft(row.identityRight, 'the name and handle end before Follow').toBeLessThanOrEqual(row.followLeft);
  });
}
