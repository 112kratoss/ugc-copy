import { expect, test, type Page } from '@playwright/test';

import creationPost from './fixtures/creation-post.json';

// Owner's decision, 2026-11-03: a creation's settings are a standard detail of its post, seen
// without unlocking anything. The post page draws them on a quiet line under the byline that says
// what the post was made with, in the words the app's Details uses too
// (ugc-mobile/lib/generation-setup/generation-setup.ts). The dev server answers the post's reads,
// its creation's settings included (support/supabase-server-stub.cjs, fixtures/creation-post.json).

const PHONE = { width: 390, height: 844 };
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

test.describe.configure({ timeout: 120_000 });

// A stand-in for the creation itself, drawn at its 9:16.
const CREATION_PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#2b1b4f"/><stop offset="0.55" stop-color="#e2725b"/><stop offset="1" stop-color="#f6c177"/>
</linearGradient></defs>
<rect width="1080" height="1920" fill="url(#sky)"/>
<circle cx="540" cy="1180" r="190" fill="#ffd9a0" opacity="0.9"/>
<path d="M0 1500 L160 1340 L300 1420 L470 1260 L640 1400 L820 1300 L1080 1460 L1080 1920 L0 1920 Z" fill="#1d1426"/>
</svg>`;

/** Signed out, with nothing from the browser answered but the post's own picture. */
async function visitSignedOut(page: Page) {
  const context = page.context();
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  // The cover goes through Next's image optimizer, whose fetch of the placeholder project's storage
  // fails offline; answered last, so it wins.
  await context.route('**/_next/image**', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: CREATION_PICTURE,
  }));
}

async function hideDevBadge(page: Page) {
  // `next dev` draws its badge over the bottom-left corner.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function coverLoaded(page: Page) {
  await expect.poll(() => page.locator('[data-testid="media-detail-frame"] img').evaluateAll(
    (images) => images.some((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0),
  ), COLD_PAGE).toBe(true);
}

test("a creation post shows its settings under Made with to a signed-out visitor", async ({ page }, testInfo) => {
  await visitSignedOut(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/showcase/${creationPost.post.id}`);

  const head = page.getByTestId('canonical-post-head');
  await expect(head.getByRole('heading', { level: 1, name: creationPost.post.title })).toBeVisible(COLD_PAGE);
  await expect(head.getByText('Made with Nano Banana 2.0')).toBeVisible();

  const setup = head.getByTestId('post-generation-setup');
  await expect(setup).toBeVisible();
  // What a visitor reads, each value named on hover. The creation ran with Google Search
  // grounding off, as every run does now no image model offers it, so the line leaves it out...
  const terms = setup.locator('[aria-hidden="true"] > span:not(:empty)');
  await expect(terms).toHaveText(['9:16', '·', '1K', '·', 'JPG']);
  await expect(setup.getByText('JPG', { exact: true })).toHaveAttribute('title', 'Output format');
  await expect(setup).not.toContainText(/grounding/i);
  // ...and what a screen reader hears.
  await expect(setup.getByText(
    'Generation settings: Aspect ratio: 9:16, Resolution: 1K, Output format: JPG',
  )).toBeAttached();
  // The line sits between the byline and the title.
  const [bylineBottom, setupTop, setupBottom, titleTop] = await Promise.all([
    head.getByText('Made with Nano Banana 2.0').evaluate((element) => element.getBoundingClientRect().bottom),
    setup.evaluate((element) => element.getBoundingClientRect().top),
    setup.evaluate((element) => element.getBoundingClientRect().bottom),
    head.getByRole('heading', { level: 1 }).evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(setupTop).toBeGreaterThanOrEqual(bylineBottom);
  expect(titleTop).toBeGreaterThanOrEqual(setupBottom);
  // Neither the model, which Made with names, nor the creation's inputs.
  await expect(setup).not.toContainText(/nano banana|model|skyline|reference|input/i);
  // Nothing is locked or for sale on this post: the settings needed no unlock.
  await expect(page.getByTestId('canonical-post-recipe')).toHaveCount(0);

  await hideDevBadge(page);
  await coverLoaded(page);
  await page.screenshot({ path: testInfo.outputPath('creation-post-signed-out-desktop.png') });

  // A phone wraps the byline, and the line keeps its place under it.
  await page.setViewportSize(PHONE);
  await expect(setup).toBeVisible();
  await expect(terms).toHaveText(['9:16', '·', '1K', '·', 'JPG']);
  await page.screenshot({ path: testInfo.outputPath('creation-post-signed-out-phone.png') });
});
