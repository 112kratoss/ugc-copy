import fs from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

// Home's half of the owner's report of 2026-11-27 (explore-back-keeps-place.spec.ts holds
// Explore's): after scrolling down the feed, opening something and coming back, other posts are
// where the reader was.
//
// Home's feed keeps each card's measured height and places the cards by them, so Back draws a page
// as long as the one that was left and the browser puts the scroll back where it was. But the
// cards are new elements, and a card not drawn yet stands at its placeholder's height
// (`content-visibility: auto` with `contain-intrinsic-size`): measured again at that height, the
// cards above the reader took other places than the ones they were left in, and the reader's card
// with them (before the fix: left 328px from the window's top, back at 51px; on a phone 144px,
// back at 1062px). And the first frame after Back drew no card in the window at all: the list had
// mounted the feed's first cards, and took the scroll the browser put back a frame later.
//
// Signed out, as home-logo-top-and-refresh.spec.ts draws Home: the signed-in Home is the same
// feed (`FeedClient`), and the bare E2E cookie loops `/` through the proxy's rewrite. Offline the
// feed's server read fails, so the feed asks `/api/showcase/feed` from the browser, which this
// spec answers: twelve posts to a page, tall pictures and wide ones, so the cards differ in height.

const PAGE_SIZE = 12;
const CREATOR = { id: 'e2e-feed-creator', username: 'e2e-feed-creator', name: 'Feed Creator', avatar: null };
const CREATOR_PAGE = `/creators/${CREATOR.username}`;
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };
/** How far a card may stand from where the reader left it: a rounding of the layout, no more. */
const SAME_PLACE_PX = 2;
/** The frames read after Back: a second and a half of them. */
const FRAMES_AFTER_BACK = 90;
// 1×1 PNG: a picture that loads.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe.configure({ timeout: 240_000 });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const number = (n: number) => String(n).padStart(2, '0');
const title = (n: number) => `Home post ${number(n)}`;

/** The feed's post `n` as /api/showcase/feed answers it: every third picture wide, the others tall. */
function feedItem(n: number) {
  const id = `0f1c2d3e-0000-4000-8000-0000000001${number(n)}`;
  const media = (file: string) => `/api/media?${new URLSearchParams({ bucket: 'post_media', path: `private-posts/${id}/${file}` })}`;
  const wide = n % 3 === 0;
  return {
    isNsfw: false,
    nsfwRevealed: false,
    id,
    mediaUrl: media('photo.jpg'),
    mediaKind: 'image',
    mediaItems: [{
      id: `${id}-media`,
      mediaKey: 'media-1',
      url: media('photo.jpg'),
      previewUrl: media('photo.preview.webp'),
      displayUrl: null,
      previewThumbhash: '3lcOJBCq+IqoaX2XR4jRb6QEdw==',
      previewStatus: 'ready',
      gridReady: true,
      mediaKind: 'image',
      contentType: 'image/jpeg',
      originalName: 'photo.jpg',
      width: wide ? 1600 : 898,
      height: wide ? 900 : 1598,
      durationSeconds: null,
      sortOrder: 0,
    }],
    model: 'external',
    title: title(n),
    prompt: '',
    body: '',
    category: 'image',
    creationMode: null,
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-14T13:38:04.953Z',
    creator: CREATOR,
    isSaved: false,
    sourceKind: 'external',
    sourceTool: null,
    sourceToolSlug: null,
    sourceTools: [],
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

/** Answers the feed, `total` posts in pages of twelve, and every picture; anything else as it fails offline. */
async function answerHome(page: Page, total: number) {
  await page.context().route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route('**/api/showcase/feed?*', (route) => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? 0);
    const last = Math.min(offset + PAGE_SIZE, total);
    const hasMore = last < total;
    // A page the feed gave up on while it was on its way has nobody to answer.
    return route.fulfill({
      json: {
        items: Array.from({ length: last - offset }, (_, index) => feedItem(offset + index + 1)),
        pageInfo: { hasMore, nextOffset: hasMore ? last : null, nextCursor: null, limit: PAGE_SIZE, offset },
      },
    }).catch(() => undefined);
  });
  await page.route((url) => url.pathname === '/api/media', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
}

const heading = (page: Page, n: number) => page.getByRole('heading', { name: title(n), exact: true });
const card = (page: Page, n: number) => page.locator('article').filter({ has: heading(page, n) });

/**
 * Scrolls to the page's end the way a reader does, a part of a screen at each frame, so that every
 * card on the way is drawn as it passes (a jump draws none of the cards it skips).
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

/** Home with every one of `total` posts loaded: the reader scrolled to its end as each page came. */
async function openHomeAndLoadEveryPage(page: Page, total: number) {
  // Asked for first, so that `next dev` compiles the creator's route before Home is open (a
  // compile under an open page can reload it, the third gotcha in .claude/rules/e2e.md).
  await page.request.get(CREATOR_PAGE, { timeout: 0 });
  await page.goto('/', COLD_PAGE);
  await expect(card(page, 1)).toBeVisible(COLD_PAGE);
  // The feed draws only the cards near the window, and asks for its next page as its end comes
  // near: at the end of the last page the last post's card is drawn.
  await expect(async () => {
    await scrollToTheEnd(page);
    await expect(heading(page, total)).toBeAttached({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await scrollToTheEnd(page);
}

type Place = { scrollY: number; top: number };

/** Where the card stands in the window, once the page has stood still for twenty frames. */
async function settledPlace(page: Page, anchor: number): Promise<Place> {
  return page.evaluate((name) => new Promise<Place>((resolve) => {
    const read = () => {
      const box = [...document.querySelectorAll('article')]
        .find((article) => [...article.querySelectorAll('h1, h2, h3')].some((found) => found.textContent === name))
        ?.getBoundingClientRect();
      return { scrollY: Math.round(window.scrollY), top: box ? Math.round(box.top) : Number.NaN };
    };
    let last = read();
    let still = 0;
    const tick = () => {
      const now = read();
      still = now.scrollY === last.scrollY && now.top === last.top ? still + 1 : 0;
      last = now;
      if (still >= 20) resolve(now);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), title(anchor));
}

/**
 * The reader scrolls back up, as a reader does, until the card's top is in the upper part of the
 * window, clear of the top bar, and stops there.
 */
async function stopOnTheCard(page: Page, anchor: number): Promise<Place> {
  await page.evaluate((name) => new Promise<void>((resolve) => {
    const step = () => {
      const box = [...document.querySelectorAll('article')]
        .find((article) => [...article.querySelectorAll('h1, h2, h3')].some((found) => found.textContent === name))
        ?.getBoundingClientRect();
      if ((box && box.top >= 140) || window.scrollY <= 0) {
        resolve();
        return;
      }
      window.scrollBy({ top: -window.innerHeight / 4, behavior: 'instant' });
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }), title(anchor));
  const place = await settledPlace(page, anchor);
  expect(place.scrollY).toBeGreaterThan(1200);
  expect(place.top).toBeGreaterThanOrEqual(100);
  expect(place.top).toBeLessThan(page.viewportSize()!.height / 2);
  return place;
}

type FrameAfterBack = {
  path: string;
  scrollY: number;
  /** The reader's card: where its top is drawn, or null while the page does not draw it. */
  anchorTop: number | null;
  /** The feed's cards drawn inside the window. */
  cardsInView: number;
  height: number;
};

/** Every frame from the next Back on: where the page is scrolled and where the reader's card is drawn. */
async function recordFramesAfterBack(page: Page, anchor: number) {
  await page.evaluate(({ name, count }) => {
    const frames: FrameAfterBack[] = [];
    (window as unknown as { __framesAfterBack: FrameAfterBack[] }).__framesAfterBack = frames;
    window.addEventListener('popstate', () => {
      const sample = () => {
        const cards = [...document.querySelectorAll('article')];
        const box = cards
          .find((article) => [...article.querySelectorAll('h1, h2, h3')].some((found) => found.textContent === name))
          ?.getBoundingClientRect();
        frames.push({
          path: window.location.pathname,
          scrollY: Math.round(window.scrollY),
          anchorTop: box ? Math.round(box.top) : null,
          cardsInView: cards.filter((article) => {
            const rect = article.getBoundingClientRect();
            return rect.bottom > 0 && rect.top < window.innerHeight;
          }).length,
          height: document.documentElement.scrollHeight,
        });
        if (frames.length < count) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true });
  }, { name: title(anchor), count: FRAMES_AFTER_BACK });
}

async function framesAfterBack(page: Page) {
  const read = () => page.evaluate(() => (window as unknown as { __framesAfterBack?: FrameAfterBack[] }).__framesAfterBack ?? []);
  await expect.poll(async () => (await read()).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(FRAMES_AFTER_BACK);
  const frames = await read();
  const record = test.info().outputPath('frames-after-back.json');
  fs.writeFileSync(record, JSON.stringify(frames, null, 1));
  await test.info().attach('frames-after-back.json', { path: record, contentType: 'application/json' });
  return frames;
}

/**
 * The reader opens the creator of the card they stopped on, from the card, and comes back with the
 * browser's Back: from the first frame after it the card is where they left it, and stays there.
 */
async function leaveForTheCreatorAndComeBack(page: Page, anchor: number, before: Place) {
  // Where the window stood at the press itself: the press moved nothing.
  await page.evaluate(() => document.addEventListener('click', () => {
    (window as unknown as { __leftAt: number }).__leftAt = Math.round(window.scrollY);
  }, { capture: true, once: true }));
  await card(page, anchor).locator(`a[href="${CREATOR_PAGE}"]`).first().click();
  await page.waitForURL(`**${CREATOR_PAGE}`, COLD_PAGE);
  expect(await page.evaluate(() => (window as unknown as { __leftAt: number }).__leftAt)).toBe(before.scrollY);
  await expect(heading(page, anchor)).toHaveCount(0, COLD_PAGE);
  // The creator's page has come (offline, the page that says it could not be read).
  await page.waitForLoadState('networkidle');

  await recordFramesAfterBack(page, anchor);
  await page.goBack();
  await page.waitForURL((url) => url.pathname === '/', COLD_PAGE);
  const frames = await framesAfterBack(page);

  // The frames that differ, in order: the whole story of a failure in a line or two.
  const story = JSON.stringify({ before, frames: frames.filter((frame, index) => JSON.stringify(frame) !== JSON.stringify(frames[index - 1])) });
  for (const frame of frames) {
    expect(frame.path, story).toBe('/');
    expect(frame.anchorTop, `the reader's card is drawn in every frame ${story}`).not.toBeNull();
    expect(Math.abs(frame.anchorTop! - before.top), `the reader's card, left ${before.top}px from the window's top ${story}`).toBeLessThanOrEqual(SAME_PLACE_PX);
    expect(Math.abs(frame.scrollY - before.scrollY), `the scroll, left at ${before.scrollY}px ${story}`).toBeLessThanOrEqual(SAME_PLACE_PX);
  }
  // And it stays there.
  await page.waitForTimeout(1_000);
  const after = await settledPlace(page, anchor);
  const settled = JSON.stringify({ before, after });
  expect(Math.abs(after.top - before.top), settled).toBeLessThanOrEqual(SAME_PLACE_PX);
  expect(Math.abs(after.scrollY - before.scrollY), settled).toBeLessThanOrEqual(SAME_PLACE_PX);
  await expect(heading(page, anchor)).toBeInViewport();
}

test.describe('on a laptop', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // Three pages loaded: Back brings the feed back from what the tab kept of it.
  test('Back from a creator opened from a card deep in the feed lands on that card, from its first frame', async ({ page }) => {
    await answerHome(page, 30);
    await openHomeAndLoadEveryPage(page, 30);
    const before = await stopOnTheCard(page, 17);
    await page.screenshot({ path: test.info().outputPath('before-leaving.png') });

    await leaveForTheCreatorAndComeBack(page, 17, before);
    await page.screenshot({ path: test.info().outputPath('after-back.png') });
  });

  // The feed's first page alone, which is as far as many readers go.
  test('Back from a creator opened from a card of the first page lands on that card, from its first frame', async ({ page }) => {
    await answerHome(page, PAGE_SIZE);
    await openHomeAndLoadEveryPage(page, PAGE_SIZE);
    const before = await stopOnTheCard(page, 8);

    await leaveForTheCreatorAndComeBack(page, 8, before);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('Back from a creator opened from a card deep in the feed lands on that card, from its first frame', async ({ page }) => {
    await answerHome(page, 30);
    await openHomeAndLoadEveryPage(page, 30);
    const before = await stopOnTheCard(page, 17);

    await leaveForTheCreatorAndComeBack(page, 17, before);
  });
});
