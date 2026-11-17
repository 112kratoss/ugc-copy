import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import exploreReel from './fixtures/explore-reel.json';

// The web sweep of 2026-11-17 (production 941e2a55b, Chrome at 375×812, signed in): above Explore's
// first post a phone drew the search bar, the "Creator community" eyebrow, the title and its blurb,
// Browse recipes and the filter bar, and the post's picture started in the lower half of the screen
// (at 648px of 812 on this lane, whose tool filter adds the bar's row of active filters). Below 640px
// the search bar now shares its row with Browse recipes, the title is for screen readers (the bottom
// bar's selected tab names the page) and the filter bar is tighter. From 640px the page is as it was.
//
// The dev server answers Explore's Recent lane for the fixture's own tool
// (support/supabase-server-stub.cjs, fixtures/explore-reel.json): three pictures by a creator of
// their own, read on the server, so the grid is drawn offline.

const LANE = `/showcase?sort=recent&tool=${exploreReel.toolSlug}`;
const [FIRST] = exploreReel.posts;
// In `next dev` a page compiles on its first request; offline Explore also waits on reads.
const COLD_PAGE = { timeout: 60_000 };
const PHONE = { width: 375, height: 812 };
const PHONE_DEVICE = { viewport: PHONE, isMobile: true, hasTouch: true };
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));

test.describe.configure({ timeout: 180_000 });

/** Signed in as the E2E user, every API call refused, and the lane's grid previews served. */
async function answerOffline(context: BrowserContext, baseURL: string) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: baseURL }]);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.startsWith('/storage/v1/object/public/showcase_media/')) {
      return route.fulfill({ contentType: 'image/png', body: PREVIEW_PICTURE });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
}

/** The lane's grid, drawn by the full client (each tile with its ⋯), at the top of the page. */
async function openLane(page: Page) {
  await page.goto(LANE, COLD_PAGE);
  await expect(page.getByRole('button', { name: `More actions for ${FIRST.title}` })).toBeAttached(COLD_PAGE);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
}

/** The top of the first post's picture, from the top of the window. */
async function firstPictureTop(page: Page) {
  const box = await page.getByRole('button', { name: FIRST.title, exact: true }).boundingBox();
  if (!box) throw new Error('The first post has no picture on screen');
  return box.y;
}

/** The top of the filter bar, and of the grid under it, in the drawing of the page on screen. */
async function layoutTops(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => element.getClientRects().length > 0;
    const bar = [...document.querySelectorAll('[data-explore-filter-bar]')].find(visible);
    const grid = [...document.querySelectorAll('div.grid.items-start')].find(visible);
    if (!bar || !grid) throw new Error('No filter bar and grid on screen');
    return { bar: bar.getBoundingClientRect().top, grid: grid.getBoundingClientRect().top };
  });
}

test.describe('on a phone', () => {
  test.use(PHONE_DEVICE);

  test('opens with the first post\'s picture in the top 40% of the screen, every control kept', async ({ page, context, baseURL }) => {
    await answerOffline(context, baseURL!);
    await openLane(page);

    expect(await firstPictureTop(page)).toBeLessThanOrEqual(PHONE.height * 0.4);

    // The search bar stays: below 1024px the top bar has only a magnifier (search UX audit, #817).
    await expect(page.locator('a[data-search-entry]')).toBeVisible();
    // Browse recipes stays in view: a phone's bottom bar has no Marketplace.
    await expect(page.getByRole('link', { name: 'Browse recipes' })).toBeVisible();
    // The page keeps its one heading, for screen readers; the eyebrow and the blurb are not drawn.
    await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toHaveCount(1);
    await expect(page.getByText('Creator community')).toBeHidden();
    await expect(page.getByText(/Fresh creator posts with optional recipes/)).toBeHidden();
    // Every filter is still a tap away.
    await expect(page.getByRole('button', { name: 'All posts' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Sort community posts' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeVisible();
  });

  // Explore is drawn three times on its way in: the loading outline ((feed)/loading.tsx, which is all
  // a page shows before a script swaps the streamed page in), the server's shell
  // (ShowcaseBootstrapClient) and the full client (ShowcaseClient), which loads after it. Each draws
  // the phone's header alike, so the filter bar never moves on arrival, and each draws the lane's row
  // of active filters (the outline its place), so neither does the grid
  // (explore-filter-row-steady.spec.ts holds every width and the hand-over's frames).
  test('draws the header alike in the loading outline, the server\'s shell and the full page', async ({ browser, page, context, baseURL }) => {
    const withoutScript = await browser.newContext({ ...PHONE_DEVICE, javaScriptEnabled: false });
    await answerOffline(withoutScript, baseURL!);
    const outlinePage = await withoutScript.newPage();
    await outlinePage.goto(LANE, COLD_PAGE);
    await expect(outlinePage.getByRole('status', { name: 'Loading Explore' })).toBeVisible();
    const outline = await layoutTops(outlinePage);
    await withoutScript.close();

    // The shell stays on screen while the full client's code is refused.
    const shellContext = await browser.newContext({ ...PHONE_DEVICE });
    await answerOffline(shellContext, baseURL!);
    let fullClientRefused = false;
    await shellContext.route(/\/_next\/static\/chunks\/.*ShowcaseClient/, (route) => {
      fullClientRefused = true;
      return route.abort();
    });
    const shellPage = await shellContext.newPage();
    await shellPage.goto(LANE, COLD_PAGE);
    await expect(shellPage.getByRole('navigation', { name: 'Explore filters' })).toBeVisible(COLD_PAGE);
    await expect.poll(() => fullClientRefused, COLD_PAGE).toBe(true);
    const shell = await layoutTops(shellPage);
    await shellContext.close();

    await answerOffline(context, baseURL!);
    await openLane(page);
    const full = await layoutTops(page);

    expect(shell.bar).toBe(outline.bar);
    expect(full.bar).toBe(outline.bar);
    expect(shell.grid).toBe(outline.grid);
    expect(full.grid).toBe(outline.grid);
  });
});

test.describe('on a laptop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('keeps the header as it was: eyebrow, title, blurb and Browse recipes, and no search bar', async ({ page, context, baseURL }) => {
    await answerOffline(context, baseURL!);
    await openLane(page);

    const header = page.locator('.ui-enter', { has: page.getByRole('heading', { level: 1, name: 'Explore' }) });
    await expect(header.getByText('Creator community')).toBeVisible();
    await expect(header.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
    await expect(header.getByText(/Fresh creator posts with optional recipes/)).toBeVisible();
    await expect(header.getByRole('link', { name: 'Browse recipes' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Browse recipes' })).toHaveCount(1);
    // From 1024px the top bar holds the search field.
    await expect(page.locator('a[data-search-entry]')).toBeHidden();
  });
});
