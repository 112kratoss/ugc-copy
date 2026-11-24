import { expect, test, type Page, type Request } from '@playwright/test';

import creationPost from './fixtures/creation-post.json';

// Post view counts, step 2 (owner, 2026-11-23): a view is a post shown large, half on screen for one
// second, on the post page, a Home card or the reel, and the web reports each one to
// `POST /api/showcase/views` for every reader, a visitor's included: the server counts a web guest's
// views only this way. These check the post page and a Home card for a visitor: no view before a
// second on screen, one after it, once.
//
// The page's clock is the test's (`page.clock`), so a second passes when the test says so. The post
// page's second counts only while the page is in front: the page is held in the background (an init
// script answers `document.visibilityState`) until the clock is paused, so no second starts early.
// A Home card's second has no such hold, so its feed page is answered only once the clock is paused.
// Views go in batches, 5 s after the last one queued.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };

/**
 * Moves the page's clock on a second at a time until the views sent number `count`: a view that
 * qualified is queued once React has drawn its state, and goes with the next batch.
 */
async function runUntilViewsSent(page: Page, views: ViewRequest[], count: number) {
  await expect.poll(async () => {
    await page.clock.runFor(1_000);
    return views.length;
  }, { timeout: 30_000 }).toBe(count);
}

test.describe.configure({ timeout: 120_000 });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

type ViewRequest = { contentType: string | null; authorization: string | null; body: unknown };

/** Signed out, with nothing from the browser answered but what each test answers, and the views kept. */
async function visitSignedOut(page: Page): Promise<ViewRequest[]> {
  const context = page.context();
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await context.route('**/_next/image**', (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#e2725b"/></svg>',
  }));
  const views: ViewRequest[] = [];
  await page.route('**/api/showcase/views', async (route) => {
    const request: Request = route.request();
    views.push({
      contentType: await request.headerValue('content-type'),
      authorization: await request.headerValue('authorization'),
      body: request.postDataJSON(),
    });
    await route.fulfill({ status: 204 });
  });
  return views;
}

/**
 * The page held in the background until the test brings it to the front, and the post page's
 * content counted each time its observer is told where it is (the sign that the page's view
 * check is running).
 */
async function holdPageInBackground(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { __e2ePageVisibility: string; __e2ePostContentSeen: number };
    state.__e2ePageVisibility = 'hidden';
    state.__e2ePostContentSeen = 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state.__e2ePageVisibility });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state.__e2ePageVisibility === 'hidden' });
    const NativeObserver = window.IntersectionObserver;
    window.IntersectionObserver = class extends NativeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super((entries, observer) => {
          if (entries.some((entry) => entry.target.matches('[data-testid="canonical-post-media"]'))) {
            state.__e2ePostContentSeen += 1;
          }
          callback(entries, observer);
        }, options);
      }
    };
  });
}

async function setPageVisibility(page: Page, visibility: 'visible' | 'hidden') {
  await page.evaluate((next) => {
    (window as unknown as { __e2ePageVisibility: string }).__e2ePageVisibility = next;
    document.dispatchEvent(new Event('visibilitychange'));
  }, visibility);
}

test('the post page reports one view after a second on screen, and none before', async ({ page }) => {
  const views = await visitSignedOut(page);
  await holdPageInBackground(page);
  await page.clock.install();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/showcase/${creationPost.post.id}`);

  await expect(page.getByRole('heading', { level: 1, name: creationPost.post.title })).toBeVisible(COLD_PAGE);
  // The page's own check has been told where the post is: half of it, or more, on screen.
  await expect.poll(
    () => page.evaluate(() => (window as unknown as { __e2ePostContentSeen: number }).__e2ePostContentSeen),
    COLD_PAGE,
  ).toBeGreaterThan(0);
  await page.clock.pauseAt(new Date(Date.now() + 5_000));

  // In front for 999 ms, then put away: nothing is seen, and nothing is sent, however long it waits.
  await setPageVisibility(page, 'visible');
  await page.clock.runFor(999);
  await setPageVisibility(page, 'hidden');
  await page.clock.runFor(60_000);
  expect(views).toEqual([]);

  // In front for a whole second: one view, as JSON, a visitor's (no token), in the next batch.
  await setPageVisibility(page, 'visible');
  await page.clock.runFor(1_000);
  await runUntilViewsSent(page, views, 1);
  expect(views[0]).toEqual({
    contentType: 'application/json',
    authorization: null,
    body: { views: [{ postId: creationPost.post.id, surface: 'post-page' }] },
  });

  // Once: the page reports a post one time a reader and UTC day.
  await page.clock.runFor(60_000);
  await setPageVisibility(page, 'hidden');
  await page.clock.runFor(60_000);
  expect(views).toHaveLength(1);
  await page.clock.resume();
});

const HOME_POST_ID = 'e2e5e700-0000-4000-8000-0000000000a1';

/** A text post on Home's first page, the one card the feed draws. */
const HOME_FEED_PAGE = {
  items: [{
    id: HOME_POST_ID,
    mediaUrl: null,
    mediaKind: null,
    mediaItems: [],
    model: 'external',
    title: 'Notes from a night shoot',
    prompt: '',
    body: 'Three things that changed how I light a rooftop at dusk.',
    category: 'text',
    postFormat: 'text',
    saveCount: 2,
    viewCount: 1_234,
    remixCount: 0,
    commentCount: 1,
    createdAt: '2026-11-20T10:00:00.000Z',
    creator: { id: 'e2e-home-creator', username: 'night-shoots', name: 'Night Shoots', avatar: null },
    sourceKind: 'manual',
    sourceTool: null,
    generationId: null,
    asset: null,
    canRemix: false,
  }],
  pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 0 },
};

test('a Home card reports one view after a second on screen, and none before', async ({ page }) => {
  const views = await visitSignedOut(page);
  // Tall enough that the card is on screen under the "Make this" shelf.
  await page.setViewportSize({ width: 1280, height: 1400 });
  // Offline the feed's server read fails, so the feed asks its first page from the browser: it is
  // answered only once the clock is paused, so the card's second starts on the test's word.
  let releaseFeed: () => void = () => undefined;
  const feedReleased = new Promise<void>((resolve) => { releaseFeed = resolve; });
  let feedAsked = false;
  await page.route('**/api/showcase/feed?*', async (route) => {
    feedAsked = true;
    await feedReleased;
    await route.fulfill({ json: HOME_FEED_PAGE });
  });
  await page.clock.install();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'For you' })).toBeVisible(COLD_PAGE);
  await expect.poll(() => feedAsked, COLD_PAGE).toBe(true);
  await page.clock.pauseAt(new Date(Date.now() + 5_000));
  releaseFeed();

  const card = page.locator(`[data-showcase-post-id="${HOME_POST_ID}"]`);
  await expect(card.getByRole('link', { name: 'Notes from a night shoot' })).toBeVisible(COLD_PAGE);
  // The card draws its views in its action row: the eye and the compact figure, the whole number
  // for a screen reader, and no control.
  const viewCount = card.locator('[data-post-view-count]');
  await expect(viewCount).toBeVisible();
  await expect(viewCount.locator('span[aria-hidden="true"]').first()).toHaveText('1.2K');
  await expect(viewCount.getByText('1,234 views')).toBeAttached();
  await expect(viewCount.locator('button, a, [tabindex]')).toHaveCount(0);

  // On screen for 999 ms, then scrolled just past: not seen, and nothing is sent. (Just past, so the
  // windowed feed keeps the card mounted: it would take a far one down at the clock's next frame,
  // and bring it back only at a frame the paused clock never runs.)
  await page.clock.runFor(999);
  await page.addStyleTag({ content: '.app-shell-content { min-height: 6000px !important; }' });
  await page.evaluate((id) => {
    const rect = document.querySelector(`[data-showcase-post-id="${id}"]`)!.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.bottom + 1, behavior: 'instant' });
  }, HOME_POST_ID);
  await expect(card).not.toBeInViewport();
  // The card's own observer hears of it in the same frame as the check's; a moment more, in real time.
  await page.waitForTimeout(250);
  await page.clock.runFor(60_000);
  expect(views).toEqual([]);

  // Back, and on screen for a whole second: one view, a visitor's, on the Home card's surface.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(card).toBeInViewport({ ratio: 0.5 });
  await runUntilViewsSent(page, views, 1);
  expect(views[0]).toEqual({
    contentType: 'application/json',
    authorization: null,
    body: { views: [{ postId: HOME_POST_ID, surface: 'feed' }] },
  });

  await page.clock.runFor(60_000);
  expect(views).toHaveLength(1);
  await page.clock.resume();
});
