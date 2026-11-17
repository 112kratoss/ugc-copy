import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import loadMoreLane from './fixtures/explore-load-more.json';

// The owner's report of 2026-11-17: on Explore, after a refresh, a scroll down to where more posts
// load made the page jump.
//
// The dev server answers Explore's Recent lane for the fixture's own tool
// (support/supabase-server-stub.cjs, fixtures/explore-load-more.json): thirty pictures, twelve to a
// page. The first page is read on the server; each Load More's is answered here, a second late so
// the loading row shows the way a real network's does (the API's own read stops offline at its
// rate limit, which reads the database).

const LANE = `/showcase?sort=recent&tool=${loadMoreLane.toolSlug}`;
const PAGE_SIZE = 12;
const number = (n: number) => String(n).padStart(2, '0');
const title = (n: number) => `${loadMoreLane.titlePrefix}${number(n)}`;
// In `next dev` a page compiles on its first request; offline Explore also waits on reads.
const COLD_PAGE = { timeout: 60_000 };
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));
const PICTURES = 'https://example.supabase.co/storage/v1/object/public/showcase_media';

test.describe.configure({ timeout: 180_000 });

/** The lane's post `n` as /api/showcase/feed answers it (contracts/mobile-api-v1.json, getShowcaseFeed). */
function feedItem(n: number) {
  const id = `${loadMoreLane.postIdPrefix}${number(n)}`;
  const picture = `${PICTURES}/${loadMoreLane.creator.id}/load-more-${number(n)}`;
  return {
    id,
    mediaUrl: `${picture}.display.e2e10ad0.webp`,
    mediaKind: 'image',
    mediaItems: [{
      id: `e2e-load-more-cover-${number(n)}`,
      url: `${picture}.display.e2e10ad0.webp`,
      previewUrl: `${picture}.preview.e2e10ad0.webp`,
      previewThumbhash: null,
      previewStatus: 'ready',
      previewCacheKey: `post-media:e2e-load-more-cover-${number(n)}`,
      gridReady: true,
      mediaKind: 'image',
      contentType: 'image/png',
      originalName: `load-more-${number(n)}.png`,
      width: 1080,
      height: 1350,
      durationSeconds: null,
      sortOrder: 0,
    }],
    model: null,
    title: title(n),
    prompt: `A picture for the load-more lane, number ${number(n)}.`,
    body: '',
    category: 'image',
    creationMode: null,
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: new Date(Date.UTC(2026, 10, 3, 10, 0, 0) - (n - 1) * 60_000).toISOString(),
    creator: {
      id: loadMoreLane.creator.id,
      username: loadMoreLane.creator.username,
      name: loadMoreLane.creator.display_name,
      avatar: null,
    },
    isSaved: false,
    generationId: null,
    canRemix: false,
  };
}

/** Signed in as the E2E user, the grid's pictures served, a Load More's page a second late. */
async function answerOffline(context: BrowserContext, page: Page, baseURL: string) {
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
  await page.route('**/api/showcase/feed?*', async (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    const last = Math.min(offset + PAGE_SIZE, loadMoreLane.postCount);
    const hasMore = last < loadMoreLane.postCount;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await route.fulfill({
      json: {
        items: Array.from({ length: last - offset }, (_, index) => feedItem(offset + index + 1)),
        pageInfo: { hasMore, limit: PAGE_SIZE, offset, nextOffset: hasMore ? last : null },
      },
    });
  });
}

type Frame = { scrollY: number; height: number; anchorTop: number | null; skeleton: boolean };

/**
 * From the next frame on, each frame's scroll position, page height and where page one's last post
 * is drawn on screen, recorded until `settledFrames` reads them. Started once the reader's last
 * scroll has landed, so every change it records is the page's own.
 */
async function recordFrames(page: Page, anchorTitle: string) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate((anchor) => {
    const frames: Frame[] = [];
    const recorder = window as unknown as { __frames: Frame[]; __framesDone?: boolean };
    recorder.__frames = frames;
    recorder.__framesDone = false;
    const picture = () => [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === anchor);
    const read = () => {
      const box = picture()?.getBoundingClientRect();
      frames.push({
        scrollY: Math.round(window.scrollY),
        height: document.documentElement.scrollHeight,
        anchorTop: box ? Math.round(box.top) : null,
        skeleton: Boolean(document.querySelector('[data-showcase-load-more-skeleton]')),
      });
      if (!recorder.__framesDone) requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  }, anchorTitle);
}

/** The frames recorded, once the next page has come and its rows are all drawn (Load More is back). */
async function settledFrames(page: Page, firstOfNextPage: string) {
  await expect(page.getByRole('button', { name: firstOfNextPage, exact: true })).toBeAttached({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Load More', exact: true })).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => new Promise<Frame[]>((resolve) => {
    // Two more frames, so the last change before the call is among those read.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const recorder = window as unknown as { __frames: Frame[]; __framesDone?: boolean };
      recorder.__framesDone = true;
      resolve(recorder.__frames);
    }));
  }));
}

/** Nothing on screen moved: page one's last post stays where the reader left it, in every frame. */
function expectNothingMoved(frames: Frame[]) {
  const all = JSON.stringify(frames);
  expect(frames.length, all).toBeGreaterThan(1);
  // The loading row showed: the page was waited for, as on a real network.
  expect(frames.some((frame) => frame.skeleton), all).toBe(true);
  expect(frames.some((frame) => !frame.skeleton), all).toBe(true);
  expect(frames.filter((frame) => frame.anchorTop === null), all).toEqual([]);
  expect(new Set(frames.map((frame) => frame.scrollY)).size, all).toBe(1);
  expect(new Set(frames.map((frame) => frame.anchorTop)).size, all).toBe(1);
}

/** Explore's lane drawn by the full client, page one in full (its rows are revealed one by one). */
async function openLane(page: Page) {
  await page.goto(LANE, COLD_PAGE);
  await expect(page.getByRole('button', { name: `More actions for ${title(1)}` })).toBeAttached(COLD_PAGE);
  await expect(page.getByRole('button', { name: 'Load More', exact: true })).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('button', { name: title(PAGE_SIZE), exact: true })).toBeAttached();
}

const toTheBottom = (page: Page) => page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));

test('more posts arriving under a reader at the bottom of Explore move nothing on screen', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await answerOffline(context, page, baseURL!);
  await openLane(page);

  // To the bottom, where a scroll ends: the grid asks for the next page there.
  await toTheBottom(page);
  await recordFrames(page, title(PAGE_SIZE));
  // Before the fix the loading row and Load More's block went before the page's first row came,
  // the page got 100px shorter than the reader's place, and the reader was moved up by it.
  expectNothingMoved(await settledFrames(page, title(PAGE_SIZE + 1)));
});

// The narrowest four-column grid: its row is the shortest a page can draw in the loading row's
// place, and a reader who scrolled on into that row is the one a shorter page moves furthest.
test('at 1280px, a reader who scrolls on into the loading row is not moved when the page comes', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await answerOffline(context, page, baseURL!);
  await openLane(page);

  await toTheBottom(page);
  await expect(page.locator('[data-showcase-load-more-skeleton]')).toBeAttached();
  await toTheBottom(page);
  await recordFrames(page, title(PAGE_SIZE));
  expectNothingMoved(await settledFrames(page, title(PAGE_SIZE + 1)));
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('a reader who scrolls on into the loading row is not moved when the page comes', async ({ page, context, baseURL }) => {
    await answerOffline(context, page, baseURL!);
    await openLane(page);

    await toTheBottom(page);
    await expect(page.locator('[data-showcase-load-more-skeleton]')).toBeAttached();
    // On into the loading row, as far as it goes, while the page is on its way.
    await toTheBottom(page);
    await recordFrames(page, title(PAGE_SIZE));
    expectNothingMoved(await settledFrames(page, title(PAGE_SIZE + 1)));
  });
});
