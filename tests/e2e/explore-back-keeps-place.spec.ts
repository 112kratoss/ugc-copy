import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import loadMoreLane from './fixtures/explore-load-more.json';

// The owner's report of 2026-11-27: on Explore, after scrolling down, opening something and coming
// back, the grid is displaced: other posts are where the reader was a moment ago.
//
// Back drew the grid again with every post it had, and the browser put the scroll back where it
// was, but into a longer page: the tiles were new elements, and a tile not drawn yet stands at its
// placeholder's height (`content-visibility: auto` with `contain-intrinsic-size`), not its own.
// Every row above the reader's post drew it that much lower, the rows then took their own heights,
// and the page settled away from where it was left. Measured here before the fix, in a window
// 1440px wide (rows of four, each 113px taller as placeholders, four of them above the post): left
// 283px from the window's top, back at 737px; in one 375px wide, left at 193px and back at 575px.
//
// The dev server answers Explore's Recent lane for the fixture's own tool
// (support/supabase-server-stub.cjs, fixtures/explore-load-more.json): thirty pictures, twelve to a
// page. The first page is read on the server; each later page is answered here, as
// explore-load-more-steady.spec.ts answers it. The reader loads all three pages, stops on a post
// of the lane's second page, leaves by a link of the page and comes back with the browser's Back.

const LANE = `/showcase?sort=recent&tool=${loadMoreLane.toolSlug}`;
const PAGE_SIZE = 12;
const number = (n: number) => String(n).padStart(2, '0');
const title = (n: number) => `${loadMoreLane.titlePrefix}${number(n)}`;
const postId = (n: number) => `${loadMoreLane.postIdPrefix}${number(n)}`;
const CREATOR_PAGE = `/creators/${loadMoreLane.creator.username}`;
/** The post the reader stops on: on the lane's second page, so with rows of the grid above it at every width. */
const ANCHOR = 18;
// In `next dev` a page compiles on its first request; offline Explore also waits on reads.
const COLD_PAGE = { timeout: 60_000 };
const PREVIEW_PICTURE = fs.readFileSync(path.join(__dirname, 'fixtures/red.png'));
const PICTURES = 'https://example.supabase.co/storage/v1/object/public/showcase_media';
/** How far a tile may stand from where the reader left it: a rounding of the layout, no more. */
const SAME_PLACE_PX = 2;
/** The frames read once Explore is back: a second and a half of them. */
const FRAMES_AFTER_BACK = 90;
/**
 * How long the page left for (or the reel) may stay up after the press on Back. The router brings
 * the page back inside the press's own task, so here it is gone by the first frame; a loaded CI
 * runner is given room, and the claim that follows starts at the first frame that draws Explore.
 */
const EXPLORE_BACK_WITHIN_MS = 5_000;
/** The recording ends by itself if Explore never comes back. */
const GIVES_UP_AFTER_MS = 15_000;

test.describe.configure({ timeout: 240_000 });

/** The lane's post `n` as /api/showcase/feed answers it (contracts/mobile-api-v1.json, getShowcaseFeed). */
function feedItem(n: number) {
  const picture = `${PICTURES}/${loadMoreLane.creator.id}/load-more-${number(n)}`;
  return {
    id: postId(n),
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

type Viewer = 'signed in' | 'signed out';

/** The grid's pictures served, every later page of the lane answered, and the E2E user signed in or nobody. */
async function answerOffline(page: Page, viewer: Viewer) {
  const context = page.context();
  if (viewer === 'signed in') {
    await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: String(test.info().project.use.baseURL) }]);
  }
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
    // A page the grid gave up on while it was on its way has nobody to answer.
    await route.fulfill({
      json: {
        items: Array.from({ length: last - offset }, (_, index) => feedItem(offset + index + 1)),
        pageInfo: { hasMore, limit: PAGE_SIZE, offset, nextOffset: hasMore ? last : null },
      },
    }).catch(() => undefined);
  });
}

const tile = (page: Page, n: number) => page.getByRole('button', { name: title(n), exact: true });
const tileMenu = (page: Page, n: number) => page.getByRole('button', { name: `More actions for ${title(n)}` });
const reel = (page: Page) => page.getByRole('dialog', { name: 'Explore reel viewer' });

/**
 * Scrolls to the page's end the way a reader does, a part of a screen at each frame, so that every
 * row on the way is drawn as it passes. A jump to the end draws none of the rows it skips, and a
 * tile never drawn stands at its placeholder's height from then on, which is not how a reader gets
 * down a feed.
 */
const scrollToTheEnd = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => {
  const step = () => {
    const left = document.documentElement.scrollHeight - window.innerHeight - window.scrollY;
    if (left <= 1) {
      resolve();
      return;
    }
    window.scrollBy({ top: Math.min(left, window.innerHeight / 2), behavior: 'instant' });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}));

/**
 * Explore's lane, drawn by the full client with all thirty posts: the reader scrolled to its end,
 * and to its end again as each next page came. `leavesFor`: the page the reader will leave for, asked for first so that `next dev`
 * compiles its route before Explore is open (a compile under an open page can reload it, the third
 * gotcha in .claude/rules/e2e.md: the first run of this spec lost its grid that way).
 */
async function openLaneAndLoadEveryPage(page: Page, viewer: Viewer, leavesFor: string) {
  await page.request.get(leavesFor, { timeout: 0 });
  await page.goto(LANE, COLD_PAGE);
  if (viewer === 'signed out') {
    // A visitor's first screen is the shell of six tiles; the grid takes over on the first scroll.
    await expect(page.locator('[data-showcase-bootstrap-card]').first()).toBeVisible(COLD_PAGE);
    const { width, height } = page.viewportSize()!;
    await expect(async () => {
      if (await page.locator('[data-showcase-bootstrap-card]').count()) {
        await page.mouse.move(width / 2, height / 2);
        await page.mouse.wheel(0, 200);
      }
      await expect(tileMenu(page, 1)).toBeAttached({ timeout: 2_000 });
    }).toPass(COLD_PAGE);
  }
  await expect(tileMenu(page, 1)).toBeAttached(COLD_PAGE);
  await expect(tile(page, PAGE_SIZE)).toBeAttached(COLD_PAGE);
  for (const last of [2 * PAGE_SIZE, loadMoreLane.postCount]) {
    await expect(async () => {
      await scrollToTheEnd(page);
      await expect(tile(page, last)).toBeAttached({ timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
  }
  await expect(page.locator('[data-showcase-load-more-skeleton]')).toHaveCount(0);
  // The last page's rows too.
  await scrollToTheEnd(page);
}

type Place = { scrollY: number; top: number };

/** Where the reader's post stands in the window, once the page has stood still for ten frames. */
async function settledPlace(page: Page): Promise<Place> {
  return page.evaluate((anchor) => new Promise<Place>((resolve) => {
    const read = () => {
      const box = [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === anchor)?.getBoundingClientRect();
      return { scrollY: Math.round(window.scrollY), top: box ? Math.round(box.top) : Number.NaN };
    };
    let last = read();
    let still = 0;
    const tick = () => {
      const now = read();
      still = now.scrollY === last.scrollY && now.top === last.top ? still + 1 : 0;
      last = now;
      if (still >= 10) resolve(now);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), title(ANCHOR));
}

/** The reader stops with the post in the middle of the window, rows of the grid above it. */
async function stopOnTheAnchor(page: Page): Promise<Place> {
  await tile(page, ANCHOR).evaluate((button) => button.scrollIntoView({ block: 'center', behavior: 'instant' }));
  const place = await settledPlace(page);
  expect(place.scrollY).toBeGreaterThan(1200);
  await expect(tile(page, ANCHOR)).toBeInViewport();
  return place;
}

type FrameAfterBack = {
  /** Milliseconds since Back was pressed (the `popstate`). */
  at: number;
  path: string;
  /**
   * Explore is the page drawn, in any of its three forms (the loading outline, the first-paint
   * shell, the grid), with no reel over it: the page left for, or the reel, has gone.
   */
  explore: boolean;
  scrollY: number;
  /** The reader's post: where its top is drawn, or null while the page does not draw it. */
  anchorTop: number | null;
  /** The grid's tiles (the first-paint shell's have no menu, and count for none). */
  tiles: number;
  /** The first-paint shell of six tiles is up. */
  shell: boolean;
  /** The route's loading outline is up. */
  loading: boolean;
  height: number;
};

/**
 * Every frame from the next Back on: whether Explore is the page drawn, where it is scrolled and
 * where the reader's post is drawn. Read until Explore has been back for `FRAMES_AFTER_BACK`
 * frames, or for `GIVES_UP_AFTER_MS`.
 */
async function recordFramesAfterBack(page: Page) {
  await page.evaluate(({ anchor, count, limit }) => {
    const recorder = window as unknown as { __framesAfterBack: FrameAfterBack[]; __framesAfterBackDone: boolean };
    const frames: FrameAfterBack[] = [];
    recorder.__framesAfterBack = frames;
    recorder.__framesAfterBackDone = false;
    window.addEventListener('popstate', () => {
      const pressedAt = performance.now();
      let sinceExplore = 0;
      const sample = () => {
        const buttons = [...document.querySelectorAll('main button[aria-label]')];
        const box = buttons.find((button) => button.getAttribute('aria-label') === anchor)?.getBoundingClientRect();
        const explore = document.querySelector('[data-explore-filter-bar]') !== null
          && document.querySelector('[role="dialog"][aria-label="Explore reel viewer"]') === null;
        frames.push({
          at: Math.round(performance.now() - pressedAt),
          path: window.location.pathname,
          explore,
          scrollY: Math.round(window.scrollY),
          anchorTop: box ? Math.round(box.top) : null,
          tiles: buttons.filter((button) => button.getAttribute('aria-label')?.startsWith('More actions for ')).length,
          shell: document.querySelector('[data-showcase-bootstrap-card]') !== null,
          loading: document.querySelector('[aria-label="Loading Explore"]') !== null,
          height: document.documentElement.scrollHeight,
        });
        if (explore || sinceExplore > 0) sinceExplore += 1;
        if (sinceExplore >= count || performance.now() - pressedAt > limit) recorder.__framesAfterBackDone = true;
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true });
  }, { anchor: title(ANCHOR), count: FRAMES_AFTER_BACK, limit: GIVES_UP_AFTER_MS });
}

async function framesAfterBack(page: Page) {
  const recorder = () => page.evaluate(() => {
    const { __framesAfterBack, __framesAfterBackDone } = window as unknown as { __framesAfterBack?: FrameAfterBack[]; __framesAfterBackDone?: boolean };
    return { frames: __framesAfterBack ?? [], done: __framesAfterBackDone === true };
  });
  await expect.poll(async () => (await recorder()).done, { timeout: GIVES_UP_AFTER_MS + 30_000 }).toBe(true);
  const { frames } = await recorder();
  const record = test.info().outputPath('frames-after-back.json');
  fs.writeFileSync(record, JSON.stringify(frames, null, 1));
  await test.info().attach('frames-after-back.json', { path: record, contentType: 'application/json' });
  return frames;
}

/**
 * Back put the reader where they were. The page left for (or the reel) may stay up for the first
 * frames after the press, for no longer than `EXPLORE_BACK_WITHIN_MS`. From the first frame that
 * draws Explore again, in whatever form, it is the grid with every post the lane had loaded, never
 * the loading outline or the six-tile shell, and the post the reader stopped on is where they left
 * it, in every frame; and nothing moves after.
 */
async function expectThePlaceKept(page: Page, before: Place, frames: FrameAfterBack[]) {
  // The frames that differ, in order: the whole story of a failure in a line or two.
  const story = JSON.stringify({
    before,
    frames: frames.filter((frame, index) => JSON.stringify({ ...frame, at: 0 }) !== JSON.stringify({ ...frames[index - 1], at: 0 })),
  });
  const back = frames.findIndex((frame) => frame.explore);
  expect(back, `Explore is drawn again ${story}`).toBeGreaterThanOrEqual(0);
  expect(frames[back].at, `Explore is back within ${EXPLORE_BACK_WITHIN_MS}ms of the press ${story}`).toBeLessThanOrEqual(EXPLORE_BACK_WITHIN_MS);
  const drawn = frames.slice(back);
  expect(drawn.length, story).toBeGreaterThanOrEqual(FRAMES_AFTER_BACK);
  for (const frame of drawn) {
    expect(frame.path, story).toBe('/showcase');
    expect(frame.explore, `Explore stays the page drawn ${story}`).toBe(true);
    expect(frame.shell, `the six-tile shell is never drawn on the way back ${story}`).toBe(false);
    expect(frame.loading, `the loading outline is never drawn on the way back ${story}`).toBe(false);
    // No frame of Explore with the grid empty or part drawn.
    expect(frame.tiles, `every post the lane had loaded, in every frame ${story}`).toBe(loadMoreLane.postCount);
    expect(frame.anchorTop, `the reader's post is drawn in every frame ${story}`).not.toBeNull();
    expect(Math.abs(frame.anchorTop! - before.top), `the reader's post, left ${before.top}px from the window's top ${story}`).toBeLessThanOrEqual(SAME_PLACE_PX);
    expect(Math.abs(frame.scrollY - before.scrollY), `the scroll, left at ${before.scrollY}px ${story}`).toBeLessThanOrEqual(SAME_PLACE_PX);
  }
  // And it stays there.
  await page.waitForTimeout(1_000);
  const after = await settledPlace(page);
  const settled = JSON.stringify({ before, after });
  expect(Math.abs(after.top - before.top), settled).toBeLessThanOrEqual(SAME_PLACE_PX);
  expect(Math.abs(after.scrollY - before.scrollY), settled).toBeLessThanOrEqual(SAME_PLACE_PX);
  await expect(tile(page, ANCHOR)).toBeInViewport();
}

/** The reader opens the creator of the post they stopped on, from its tile, and comes back. */
async function leaveForTheCreatorAndComeBack(page: Page) {
  // In document order the tiles' creator links are the posts' own.
  await page.getByRole('main').locator(`a[href="${CREATOR_PAGE}"]`).nth(ANCHOR - 1).click();
  await page.waitForURL(`**${CREATOR_PAGE}`, COLD_PAGE);
  await expect(tile(page, ANCHOR)).toHaveCount(0, COLD_PAGE);
  // The creator's page has come (offline, the page that says it could not be read).
  await page.waitForLoadState('networkidle');

  await recordFramesAfterBack(page);
  await page.goBack();
  await page.waitForURL(`**${LANE}`, COLD_PAGE);
  return framesAfterBack(page);
}

for (const viewer of ['signed in', 'signed out'] as const) {
  test.describe(`${viewer}, on a laptop`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('Back from a creator opened from a tile lands on the post the reader left, from its first frame', async ({ page }) => {
      await answerOffline(page, viewer);
      await openLaneAndLoadEveryPage(page, viewer, CREATOR_PAGE);
      const before = await stopOnTheAnchor(page);
      await page.screenshot({ path: test.info().outputPath('before-leaving.png') });

      const frames = await leaveForTheCreatorAndComeBack(page);
      await page.screenshot({ path: test.info().outputPath('after-back.png') });
      await expectThePlaceKept(page, before, frames);
    });

    // The post's own page is reached through the reel, whose entry Back returns to first: the grid
    // is drawn again under the reel there, and the reader sees it once Back closes the reel.
    test('Back from the post page opened from the reel, then Back out of the reel, leaves the grid where it was', async ({ page }) => {
      await answerOffline(page, viewer);
      await openLaneAndLoadEveryPage(page, viewer, `/showcase/${postId(ANCHOR)}`);
      const before = await stopOnTheAnchor(page);

      await tile(page, ANCHOR).click();
      await expect(reel(page)).toBeVisible(COLD_PAGE);
      await reel(page).getByRole('link', { name: 'Post details' }).click();
      await page.waitForURL(`**/showcase/${postId(ANCHOR)}?**`, COLD_PAGE);
      await expect(reel(page)).toHaveCount(0, COLD_PAGE);
      await page.waitForLoadState('networkidle');

      await page.goBack();
      await page.waitForURL(/[?&]post=/, COLD_PAGE);
      await expect(reel(page)).toBeVisible(COLD_PAGE);
      await recordFramesAfterBack(page);
      await page.goBack();
      await page.waitForURL(`**${LANE}`, COLD_PAGE);
      await expect(reel(page)).toHaveCount(0);
      await expectThePlaceKept(page, before, await framesAfterBack(page));
    });
  });
}

// One column: every post before the reader's is a row above it.
test.describe('signed in, on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('Back from a creator opened from a tile lands on the post the reader left, from its first frame', async ({ page }) => {
    await answerOffline(page, 'signed in');
    await openLaneAndLoadEveryPage(page, 'signed in', CREATOR_PAGE);
    const before = await stopOnTheAnchor(page);

    const frames = await leaveForTheCreatorAndComeBack(page);
    await expectThePlaceKept(page, before, frames);
  });
});
