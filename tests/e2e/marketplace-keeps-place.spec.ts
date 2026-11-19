import fs from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import market from './fixtures/marketplace-recipes.json';
import imagePost from './fixtures/creation-post-free-recipe.json';

// Marketplace, as the owner's recording of the live site showed it (2026-11-16, signed in):
// - Back from a recipe lost the reader's place: after two "Load more recipes" and a recipe opened
//   six rows down, the post's "Back to Marketplace" drew the first four recipes alone, with "Load
//   more recipes" at the bottom of the window, the scroll clamped to that short page; the recipes
//   loaded before came a moment later below it, and the reader was left on the first row.
// - A recipe opened from it started at the foot of its post (`#recipe`).
// - A recipe whose picture had not come yet was solid black.
// (The fourth, the side navigation's slow press, is a prefetch, which `next dev` never makes:
// app-shell-client.test.tsx holds it.)
// And as the live sweep of 2026-11-17 found it:
// - The first press of "Load more recipes" on the first screen did nothing: it only brought the
//   interactive list in ("Opening buyer tools…"), which drew the same four recipes, and the reader
//   had to press again.
// - On a phone the first screen held no recipe: the hero and the open filter panel filled it.
// And as the owner reported it on 2026-11-20:
// - Every page after the first needed a press of "Load more recipes". A reader who scrolls towards
//   the end now gets the next page by itself, as Home's feed loads, from 600 px away; the button
//   stays, for a keyboard and for a page that failed.
//
// The dev server draws the storefront's first page from fixtures/marketplace-recipes.json
// (support/supabase-server-stub.cjs); the list API's pages and the covers are answered here, and
// the recipes "Load more" brings open the picture post with a free recipe the stub draws
// (fixtures/creation-post-free-recipe.json). A signed-in reader holds a session cookie, never the
// E2E bypass's: the page's auth provider asks Supabase who that is on every mount, as production's
// does, and the answer comes after a delay.

const COLD_PAGE = { timeout: 45_000 };
const USER_ID = 'e2e-market-reader';
const FIRST_PAGE = market.bundles.length - 1;
const MORE_PAGE = 12;
/** Two more pages, each brought by a scroll to the end: 28 recipes, seven rows of four. */
const LOADED = FIRST_PAGE + 2 * MORE_PAGE;
/**
 * The listing ends there. A reader near the end of a listing with more gets its next page by itself,
 * so one that went on would grow under the recipe opened six rows down before it was opened.
 */
const TOTAL = LOADED;
/** The recipe opened: the second of the sixth row. */
const OPENED = 22;

test.describe.configure({ timeout: 180_000 });

/** The dev server's own origin, the config's base URL, so a cookie reaches it on whatever port the run uses. */
const origin = () => String(test.info().project.use.baseURL);

/** The listing's first page as the page's own script asks for it once it knows who is looking. */
const isFirstPageRead = (request: { url: () => string }) => request.url().includes('/api/marketplace/resources?sort=recent&offset=0&limit=4');

function base64Url(text: string) {
  return Buffer.from(text).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cover(label: string, hue: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">
<rect width="1080" height="1350" fill="hsl(${hue} 55% 42%)"/>
<text x="540" y="700" font-family="sans-serif" font-size="120" fill="white" text-anchor="middle">${label}</text>
</svg>`;
}

type ListItem = Record<string, unknown> & { id: string; title: string; post: Record<string, unknown> | null };

/** A recipe "Load more" brings, shaped as the list API answers: it opens the image post with a free recipe the stub draws. */
function moreRecipe(template: ListItem, index: number): ListItem {
  const title = `Recipe ${index}`;
  return {
    ...template,
    id: `e2e-more-recipe-${index}`,
    postId: imagePost.post.id,
    title,
    post: template.post && {
      ...template.post,
      id: imagePost.post.id,
      title,
      mediaPreviewUrl: `https://example.supabase.co/storage/v1/object/public/showcase_media/e2e-market-creator/more-${index}.preview.e2e1${String(index).padStart(4, '0')}.webp`,
    },
  };
}

/** The recipe a signed-in reader's own first page leaves out, as the creator's block would. */
const BLOCKED_TITLE = market.bundles[1].title;

/**
 * The list API's pages: the first as the dev server answers it (read once, as a visitor), the
 * rest made from it; and the covers, a picture each, each after `coverDelayMs(its recipe's number)`.
 * `firstPageHeld`: the page's own read of its first page is answered only once it settles, as a
 * slow production read is. `blockedForReader`: that read, made with a session, leaves out
 * `BLOCKED_TITLE`, as the list API takes out the recipes of a creator the reader blocks (and the
 * next page still starts where the cached first page ended). `morePagesDelayMs`: each later page is
 * answered after it. `total`: the recipes the listing holds in all.
 */
async function answerListing(page: Page, {
  coverDelayMs = () => 120,
  firstPageHeld,
  blockedForReader = false,
  morePagesDelayMs = 0,
  total = TOTAL,
}: {
  coverDelayMs?: (index: number) => number;
  firstPageHeld?: Promise<void>;
  blockedForReader?: boolean;
  morePagesDelayMs?: number;
  total?: number;
} = {}) {
  const context = page.context();
  // Whatever else the page asks the API offline is answered as it fails there.
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  const firstResponse = await page.request.get('/api/marketplace/resources?sort=recent&offset=0&limit=4', { timeout: 0 });
  expect(firstResponse.ok()).toBe(true);
  const firstPage = await firstResponse.json() as { items: ListItem[]; pageInfo: Record<string, unknown> };
  expect(firstPage.items.map((item) => item.title)).toEqual(market.bundles.slice(0, FIRST_PAGE).map((bundle) => bundle.title));
  const more = Array.from({ length: total - FIRST_PAGE }, (_, offset) => moreRecipe(firstPage.items[0], FIRST_PAGE + offset + 1));

  const readersFirstPage = { ...firstPage, items: firstPage.items.filter((item) => item.title !== BLOCKED_TITLE) };

  await context.route('**/api/marketplace/resources?**', async (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? FIRST_PAGE);
    const first = blockedForReader && route.request().headers().authorization ? readersFirstPage : firstPage;
    if (offset === 0 && firstPageHeld) {
      await firstPageHeld;
      // A read the page gave up on meanwhile (React's development double effect) has nobody to answer.
      return route.fulfill({ json: first }).catch(() => undefined);
    }
    if (offset === 0) return route.fulfill({ json: first });
    if (morePagesDelayMs) await new Promise((resolve) => setTimeout(resolve, morePagesDelayMs));
    const items = more.slice(offset - FIRST_PAGE, offset - FIRST_PAGE + limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < total;
    // A page the list gave up on while it was on its way has nobody to answer.
    return route.fulfill({ json: { items, pageInfo: { hasMore, nextOffset: hasMore ? nextOffset : null, offset, limit } } })
      .catch(() => undefined);
  });
  await context.route('**/api/me/unlocked-recipes', (route) => route.fulfill({ json: { bundleIds: [] } }));
  // The covers, from the storage CDN as production serves them (kept by the browser an hour).
  await context.route('https://example.supabase.co/storage/v1/object/public/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const index = Number(/(\d+)\.preview/.exec(name)?.[1] ?? 0);
    await new Promise((resolve) => setTimeout(resolve, coverDelayMs(index)));
    await route.fulfill({
      contentType: 'image/svg+xml',
      headers: { 'cache-control': 'public, max-age=3600' },
      body: cover(`${index}`, (index * 47) % 360),
    });
  });
  // The post's picture goes through Next's image optimizer, whose fetch of the placeholder project fails.
  await context.route('**/_next/image**', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><rect width="1080" height="1920" fill="#2b1b4f"/></svg>',
  }));
}

/**
 * A session cookie for the placeholder project, sent with every request as a browser sends it, and
 * no E2E bypass: the page's auth provider asks `/auth/v1/user` who it is, answered here after a
 * delay as production answers it, so the page's first frames come before the reader is known.
 */
async function signIn(page: Page) {
  const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'market-reader@example.com',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { name: 'Market Reader' },
    identities: [],
    is_anonymous: false,
    created_at: '2026-01-01T00:00:00.000Z',
  };
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ sub: USER_ID, exp: 4_102_444_800, role: 'authenticated', aud: 'authenticated' }));
  const session = {
    access_token: `${header}.${payload}.c2lnbmF0dXJl`,
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 4_102_444_800,
    user,
  };
  await page.context().addCookies([
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: origin() },
    { name: 'mb_name_step_shown', value: USER_ID, url: origin() },
  ]);
  await page.context().route('https://example.supabase.co/auth/v1/user*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: user });
  });
  await page.context().route('https://example.supabase.co/rest/v1/profiles*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const row = { credits: 617, promotional_credits: 0, saver_notice_seen_at: null, display_name: 'Market Reader', avatar_url: null };
    const accept = route.request().headers().accept ?? '';
    await route.fulfill({ json: accept.includes('vnd.pgrst.object') ? row : [row] });
  });
}

const tiles = (page: Page) => page.getByRole('main').getByRole('link', { name: /^View free recipe: / });
const tile = (page: Page, index: number) => page.getByRole('link', { name: `View free recipe: Recipe ${index}`, exact: true });

/**
 * Turns the wheel the way the reader does: the page asks for more only on a gesture of the reader's
 * (`useReaderScrolled`), so a `window.scrollTo` from here would never bring a page.
 */
async function turnTheWheel(page: Page, deltaY: number) {
  const { width, height } = page.viewportSize()!;
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.wheel(0, deltaY);
}

/**
 * Turns the wheel on the first-paint shell, as the owner did, until it hands the list over to the
 * interactive one (its module comes in, compiled on its first request); never once the list is in,
 * which would scroll the longer page it draws.
 */
async function scrollShellToItsEnd(page: Page) {
  const shell = page.locator('[data-marketplace-bootstrap-shell]');
  await expect(async () => {
    if (await shell.count()) await turnTheWheel(page, 2000);
    await expect(shell).toHaveCount(0, { timeout: 1000 });
  }).toPass(COLD_PAGE);
}

/**
 * Opens Marketplace and scrolls to its end, as the owner did: the shell hands the list over to the
 * interactive one, which brings the next twelve recipes without a press.
 */
async function openAndHandOver(page: Page) {
  const firstRead = page.waitForRequest((request) => request.url().includes('/api/marketplace/resources?sort=recent&offset=0&limit=4'), COLD_PAGE);
  await page.goto('/marketplace', COLD_PAGE);
  // The page's own read of its first page is made by its script, once the reader is known: it has hydrated.
  await firstRead;
  await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);

  await scrollShellToItsEnd(page);
  await expect(tiles(page)).toHaveCount(FIRST_PAGE + MORE_PAGE, COLD_PAGE);
}

/** The wheel turned to the end of the page, as far as it goes. */
async function wheelToTheEnd(page: Page) {
  const left = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight - window.scrollY);
  await turnTheWheel(page, Math.max(left, 0) + 200);
}

/** A scroll to the end of the list: twelve more, without a press. */
async function scrollToTheEnd(page: Page) {
  const count = await tiles(page).count();
  await wheelToTheEnd(page);
  await expect(tiles(page)).toHaveCount(count + MORE_PAGE);
}

/** Marketplace, handed over on a scroll to its end, then scrolled to the end again: 28 recipes. */
async function loadSevenRows(page: Page) {
  await openAndHandOver(page);
  await scrollToTheEnd(page);
  await expect(tiles(page)).toHaveCount(LOADED);
}

type FrameAfterBack = {
  path: string;
  tiles: number;
  scrollY: number;
  shell: boolean;
  /**
   * The covers in the window: how many, how many not yet loaded, and how many of those the reader
   * had seen before leaving are fading or hidden.
   */
  covers: number;
  coversLoading: number;
  coversFading: number;
};

/**
 * Every frame from the press on Back until the listing has stood for 60 frames: how many recipes
 * it draws, the scroll, whether the first-paint shell is still up, and the covers in the window.
 */
async function recordFramesAfterBack(page: Page, coversSeen: string[]) {
  await page.evaluate((seen) => {
    const frames: FrameAfterBack[] = [];
    (window as unknown as { __framesAfterBack: typeof frames }).__framesAfterBack = frames;
    window.addEventListener('popstate', () => {
      const sample = () => {
        const covers = Array.from(document.querySelectorAll<HTMLImageElement>('main a[aria-label^="View free recipe: "] img'))
          .filter((image) => {
            const box = image.getBoundingClientRect();
            return box.bottom > 0 && box.top < window.innerHeight;
          });
        frames.push({
          path: window.location.pathname,
          tiles: document.querySelectorAll('main a[aria-label^="View free recipe: "]').length,
          scrollY: Math.round(window.scrollY),
          shell: document.querySelector('[data-marketplace-bootstrap-shell]') !== null,
          covers: covers.length,
          coversLoading: covers.filter((image) => !image.complete).length,
          coversFading: covers
            .filter((image) => seen.includes(image.getAttribute('src') ?? ''))
            .filter((image) => getComputedStyle(image).opacity !== '1' || image.getAnimations().length > 0).length,
        });
        if (frames.length < 60) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { once: true });
  }, coversSeen);
}

/** The covers in the window, once each has come: what the reader has seen of the listing. */
async function coversInView(page: Page) {
  const read = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLImageElement>('main a[aria-label^="View free recipe: "] img'))
    .filter((image) => {
      const box = image.getBoundingClientRect();
      return box.bottom > 0 && box.top < window.innerHeight;
    })
    .map((image) => ({ src: image.getAttribute('src') ?? '', loaded: image.complete && image.naturalWidth > 0 })));
  await expect.poll(async () => (await read()).every((cover) => cover.loaded)).toBe(true);
  return (await read()).map((cover) => cover.src);
}

async function framesAfterBack(page: Page) {
  return page.evaluate(() => (window as unknown as { __framesAfterBack: FrameAfterBack[] }).__framesAfterBack);
}

// A recipe opened from Marketplace started at the foot of its post (owner's recording, 5 opens
// of 5): its link named the recipe's section (`#recipe`), and on a post shorter than that the
// browser went to the page's end, the picture under the top bar and the title and the way back
// above the window. It opens the post at its top, as every other way in does.
test.describe('a recipe opened from Marketplace', () => {
  test('from the list "Load more" drew, opens its post at the top', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await answerListing(page);
    await loadSevenRows(page);
    const opened = tile(page, OPENED);
    await opened.scrollIntoViewIfNeeded();
    await opened.click();
    await page.waitForURL(`**/showcase/${imagePost.post.id}?**`, COLD_PAGE);
    const title = page.getByRole('heading', { level: 1, name: imagePost.post.title });
    const wayBack = page.getByRole('link', { name: 'Back to Marketplace' });
    await expect(wayBack).toBeVisible(COLD_PAGE);
    // Read after the page's own scroll, a few frames after it is drawn.
    await page.waitForTimeout(500);
    await page.screenshot({ path: test.info().outputPath('post-opened.png') });
    const viewport = page.viewportSize()!;
    const inView = async (box: { y: number; height: number } | null) => Boolean(box && box.y >= 0 && box.y + box.height <= viewport.height);
    expect({
      hash: new URL(page.url()).hash,
      scrollY: await page.evaluate(() => Math.round(window.scrollY)),
      titleInView: await inView(await title.boundingBox()),
      wayBackInView: await inView(await wayBack.boundingBox()),
    }).toEqual({ hash: '', scrollY: 0, titleInView: true, wayBackInView: true });
  });

  test('from the first-paint shell, links to its post with no section to jump to', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await answerListing(page);
    await page.goto('/marketplace', COLD_PAGE);
    // The shell's tiles are plain links, followed as a new page: an address without a section
    // opens at the top. (The stub draws the post of no recipe on this first page.)
    await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
    const hrefs = await tiles(page).evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    expect(hrefs).toEqual(market.bundles.slice(0, FIRST_PAGE).map((bundle) => (
      `/showcase/${bundle.post_id}?from=unlocks&returnTo=%2Fmarketplace%3Fsort%3Drecent`
    )));
  });
});

// A recipe "Load more" brought stayed solid black until its picture came (owner's recording, "NIGHT
// SHIFT", about 0.7 s), and every Back painted the tiles dark before their pictures showed. A cover on
// its way stands on a surface of its own; one the browser already has never fades in again (Back
// above holds that for every frame).
test.describe('a recipe tile while its picture loads', () => {
  test('stands on a surface of its own, not black, and its picture shows once it comes', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // The first page's covers come at once; the ones "Load more" brings, after 2.5 seconds.
    await answerListing(page, { coverDelayMs: (index) => (index > FIRST_PAGE ? 2500 : 120) });
    // The scroll that hands the list over brings them.
    await openAndHandOver(page);

    const waiting = tile(page, FIRST_PAGE + 1);
    await waiting.scrollIntoViewIfNeeded();
    // The tile's frame, the first thing in its link, while its picture is on its way.
    const frame = waiting.locator('xpath=./div[1]');
    const look = await frame.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      surface: getComputedStyle(document.documentElement).getPropertyValue('--ui-surface-1').trim(),
      pictureLoaded: Boolean(element.querySelector('img')?.complete),
    }));
    await frame.screenshot({ path: test.info().outputPath('cover-on-its-way.png') });
    expect(look.pictureLoaded, 'the picture is still on its way').toBe(false);
    // The card surface (`--ui-surface-1`, #19191c), drawn: not black, nor see-through to the page.
    expect(look.surface).toBe('#19191c');
    expect(look.background).toBe('rgb(25, 25, 28)');

    // Then the picture comes, and shows.
    const picture = frame.locator('img');
    await expect.poll(() => picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => picture.evaluate((image) => getComputedStyle(image).opacity)).toBe('1');
    await frame.screenshot({ path: test.info().outputPath('cover-arrived.png') });
  });
});

for (const viewer of ['signed in', 'signed out'] as const) {
  for (const back of ['the post\'s Back to Marketplace', 'the browser\'s Back'] as const) {
    test(`${viewer}, ${back} lands on the recipe it left, every recipe drawn from the first frame`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await answerListing(page);
      if (viewer === 'signed in') await signIn(page);

      await loadSevenRows(page);
      const opened = tile(page, OPENED);
      await opened.scrollIntoViewIfNeeded();
      // Read once the scroll has settled where the reader leaves it.
      await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(1000);
      const before = await page.evaluate(() => Math.round(window.scrollY));
      const coversSeen = await coversInView(page);
      await opened.click();
      await page.waitForURL(`**/showcase/${imagePost.post.id}?**`, COLD_PAGE);
      const wayBack = page.getByRole('link', { name: 'Back to Marketplace' });
      await expect(wayBack).toBeVisible(COLD_PAGE);

      await recordFramesAfterBack(page, coversSeen);
      if (back === 'the browser\'s Back') await page.goBack();
      else await wayBack.click();
      await page.waitForURL('**/marketplace', COLD_PAGE);
      await page.screenshot({ path: test.info().outputPath('first-frames-after-back.png') });

      await expect.poll(async () => (await framesAfterBack(page)).length).toBeGreaterThanOrEqual(30);
      const frames = await framesAfterBack(page);
      const record = test.info().outputPath('frames-after-back.json');
      fs.writeFileSync(record, JSON.stringify({ before, frames }, null, 1));
      await test.info().attach('frames-after-back.json', { path: record, contentType: 'application/json' });
      // The first frame the listing is drawn in holds every recipe, at the reader's place.
      const first = frames.find((frame) => frame.path === '/marketplace' && frame.tiles > 0);
      expect(first, 'a frame of the listing').toBeTruthy();
      expect(first).toMatchObject({ tiles: LOADED, scrollY: before, shell: false });
      // ...and nothing moves after it, and no cover the reader saw fades in again.
      expect(first!.covers).toBeGreaterThan(0);
      for (const frame of frames.slice(frames.indexOf(first!))) {
        expect(frame).toMatchObject({ tiles: LOADED, scrollY: before, coversFading: 0 });
      }
      await expect(tile(page, OPENED)).toBeInViewport();
      await page.waitForTimeout(1000);
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(before);
      await expect(tiles(page)).toHaveCount(LOADED);
      await page.screenshot({ path: test.info().outputPath('settled-after-back.png') });
    });
  }
}

/** Every request the page makes for the listing's second page (offset 4), as it finished or failed. */
function watchSecondPageRequests(page: Page) {
  const seen = { finished: [] as string[], failed: [] as string[], startedAt: [] as number[] };
  const isSecondPage = (url: string) => url.includes('/api/marketplace/resources?')
    && new URL(url).searchParams.get('offset') === String(FIRST_PAGE);
  page.on('request', (request) => {
    if (isSecondPage(request.url())) seen.startedAt.push(Date.now());
  });
  page.on('requestfinished', (request) => {
    if (isSecondPage(request.url())) seen.finished.push(new URL(request.url()).search);
  });
  page.on('requestfailed', (request) => {
    if (isSecondPage(request.url())) seen.failed.push(new URL(request.url()).search);
  });
  return seen;
}

const recipeTitles = (page: Page) => tiles(page).evaluateAll((links) => links.map((link) => link.getAttribute('aria-label')?.replace(/^View free recipe: /, '')));

// Live sweep, 2026-11-17: on a fresh Marketplace the first screen's "Load more recipes" stood in
// view without a scroll, and its first press only brought the interactive list in ("Opening buyer
// tools…"), which drew the same four recipes: the reader had to press again. (A scroll towards the
// end brings the list in and the next page with it, which a press made without a scroll never
// sets off.) One press opens the list and brings the next twelve, asked for once.
test.describe('one press of the first screen\'s "Load more recipes"', () => {
  for (const viewer of ['signed out', 'signed in'] as const) {
    test(`${viewer}, opens the list and brings the next recipes`, async ({ page }) => {
      // The button in the first screen with no scroll, as the live page drew it at 1440 × 900 (offline
      // it sits just below 900, so the window is taller).
      await page.setViewportSize({ width: 1440, height: 1200 });
      await answerListing(page);
      if (viewer === 'signed in') await signIn(page);
      const secondPage = watchSecondPageRequests(page);
      const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
      await page.goto('/marketplace', COLD_PAGE);
      // The page's own read of its first page is made by its script, once the reader is known: it has hydrated.
      await firstRead;
      await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);

      const loadMore = page.getByRole('button', { name: 'Load more recipes' });
      await expect(loadMore).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await page.screenshot({ path: test.info().outputPath('before-the-press.png') });
      await loadMore.click();

      // The interactive list's module comes in, compiled on its first request, then the page after.
      await expect(tiles(page)).toHaveCount(FIRST_PAGE + MORE_PAGE, COLD_PAGE);
      await page.screenshot({ path: test.info().outputPath('after-one-press.png') });
      expect(await recipeTitles(page)).toEqual([
        ...market.bundles.slice(0, FIRST_PAGE).map((bundle) => bundle.title),
        ...Array.from({ length: MORE_PAGE }, (_, index) => `Recipe ${FIRST_PAGE + index + 1}`),
      ]);
      await expect(page.locator('[data-marketplace-bootstrap-shell]')).toHaveCount(0);
      // Asked for once, and the list goes on from where that page ended, as the reader scrolls to it.
      expect(secondPage.finished).toEqual([`?offset=${FIRST_PAGE}&limit=${MORE_PAGE}`]);
      expect(secondPage.failed).toEqual([]);
      await scrollToTheEnd(page);
      await expect(tiles(page)).toHaveCount(FIRST_PAGE + 2 * MORE_PAGE);
    });
  }

  // Signed in, the page reads its first page again for the reader, their blocks taken out, and on
  // the live site that read took 1.5 s. A press made before it lands waits for it, and reads on from
  // the reader's own page: the read starts the list again, which cut short, and asked again for, a
  // page asked before it, and a page appended to the cached page it replaces brought a blocked
  // creator's recipe back (review of #837). A scroll to the end asks as a press does, and waits the
  // same way. The reader's page here leaves one recipe out.
  const readersListing = [
    ...market.bundles.slice(0, FIRST_PAGE).map((bundle) => bundle.title).filter((title) => title !== BLOCKED_TITLE),
    ...Array.from({ length: MORE_PAGE }, (_, index) => `Recipe ${FIRST_PAGE + index + 1}`),
  ];

  for (const ask of ['a press of the first screen\'s button', 'a scroll to the end'] as const) {
    test(`signed in, ${ask} made while the reader's first page is read waits for it, then reads on from it once`, async ({ page }) => {
      const byScroll = ask === 'a scroll to the end';
      // The first screen's button stands in view with no scroll; the scroll is made in a window the
      // first page fills.
      await page.setViewportSize(byScroll ? { width: 1280, height: 800 } : { width: 1440, height: 1200 });
      let settleFirstPage = () => undefined as void;
      const firstPageHeld = new Promise<void>((resolve) => {
        settleFirstPage = resolve;
      });
      // Each later page takes a while, so that one asked too early is still on its way when the
      // reader's first page lands.
      await answerListing(page, { firstPageHeld, blockedForReader: true, morePagesDelayMs: 1500 });
      await signIn(page);
      const secondPage = watchSecondPageRequests(page);
      let firstPageAnsweredAt = 0;
      page.on('requestfinished', (request) => {
        if (isFirstPageRead(request)) firstPageAnsweredAt = Date.now();
      });
      const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
      await page.goto('/marketplace', COLD_PAGE);
      await firstRead;
      // The cached page, the blocked recipe on it, while the reader's own is read.
      await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);

      if (byScroll) await scrollShellToItsEnd(page);
      else await page.getByRole('button', { name: 'Load more recipes' }).click();
      // The list is in and says it is loading; nothing is asked for while the reader's page is read.
      await expect(page.locator('[data-marketplace-bootstrap-shell]')).toHaveCount(0, COLD_PAGE);
      await expect(page.getByRole('button', { name: 'Loading' })).toBeVisible();
      await page.waitForTimeout(1000);
      expect(secondPage.startedAt).toEqual([]);
      await expect(tiles(page)).toHaveCount(FIRST_PAGE);

      settleFirstPage();
      await expect(tiles(page)).toHaveCount(readersListing.length, COLD_PAGE);
      expect(await recipeTitles(page)).toEqual(readersListing);
      expect(secondPage.finished).toEqual([`?offset=${FIRST_PAGE}&limit=${MORE_PAGE}`]);
      expect(secondPage.failed).toEqual([]);
      expect(secondPage.startedAt[0]).toBeGreaterThanOrEqual(firstPageAnsweredAt);
      expect(firstPageAnsweredAt).toBeGreaterThan(0);
      await expect(page.getByRole('button', { name: 'Load more recipes' })).toBeEnabled();
    });
  }
});

type FirstScreen = {
  scrollY: number;
  topBarBottom: number;
  bottomNavTop: number;
  cover: { top: number; bottom: number } | null;
  tiles: Array<{ title: string | null; documentTop: number }>;
};

/** Where the first recipe's cover stands in the window, and where every recipe stands on the page. */
function readFirstScreen(page: Page): Promise<FirstScreen> {
  return page.evaluate(() => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('main a[aria-label^="View free recipe: "]'));
    const cover = links[0]?.firstElementChild?.getBoundingClientRect() ?? null;
    return {
      scrollY: Math.round(window.scrollY),
      topBarBottom: Math.round(document.querySelector('header')?.getBoundingClientRect().bottom ?? 0),
      bottomNavTop: Math.round(document.querySelector('nav[aria-label="Primary mobile navigation"]')?.getBoundingClientRect().top ?? window.innerHeight),
      cover: cover && { top: Math.round(cover.top), bottom: Math.round(cover.bottom) },
      tiles: links.map((link) => ({
        title: link.getAttribute('aria-label'),
        documentTop: Math.round(link.getBoundingClientRect().top + window.scrollY),
      })),
    };
  });
}

/** How much of the first recipe's cover shows between the top bar and the bottom navigation. */
function coverShownShare({ cover, topBarBottom, bottomNavTop }: FirstScreen) {
  if (!cover) return 0;
  const shown = Math.min(cover.bottom, bottomNavTop) - Math.max(cover.top, topBarBottom);
  return Math.max(0, shown) / (cover.bottom - cover.top);
}

// Live sweep, 2026-11-17: at 375 × 812 the "RECIPES · Buy the reusable parts behind community posts"
// card and the open filter panel (the search, Access, Kind, Tool and the four orders) filled the first
// screen, and the first recipe started a screen below it. The card is compact on a phone and the
// filters wait behind a Filters button, as the interactive list already kept them and Explore does.
test.describe('the first screen', () => {
  test('on a phone, shows the first recipe, with the filters behind a Filters button', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await answerListing(page);
    const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
    await page.goto('/marketplace', COLD_PAGE);
    await firstRead;
    await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
    await expect.poll(() => page.evaluate(() => {
      const image = document.querySelector<HTMLImageElement>('main a[aria-label^="View free recipe: "] img');
      return Boolean(image?.complete && image.naturalWidth > 0);
    })).toBe(true);

    const firstScreen = await readFirstScreen(page);
    await page.screenshot({ path: test.info().outputPath('phone-first-screen.png') });
    expect(firstScreen.scrollY).toBe(0);
    // Most of the first recipe's cover shows, above the bottom navigation.
    expect(coverShownShare(firstScreen), JSON.stringify(firstScreen)).toBeGreaterThanOrEqual(0.5);

    // The search stays out; Access, Kind, Tool and the order wait behind Filters.
    await expect(page.getByRole('searchbox', { name: 'Search marketplace recipes' })).toBeVisible();
    const filters = page.getByRole('button', { name: 'Filters' });
    await expect(filters).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('link', { name: 'Paid' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Top sales' })).toBeHidden();
    await filters.click();
    await expect(filters).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('link', { name: 'Paid' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Top sales' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('phone-filters-open.png') });
    await filters.click();
    await expect(page.getByRole('link', { name: 'Paid' })).toBeHidden();
  });

  // The first screen's list hands over to the interactive one once the reader scrolls towards its
  // end; the two must draw the panel above the recipes alike, or every recipe jumps under the finger.
  for (const panel of ['closed', 'open'] as const) {
    test(`on a phone, the list taken over on a scroll moves no recipe, the filters ${panel}`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await answerListing(page);
      const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
      await page.goto('/marketplace', COLD_PAGE);
      await firstRead;
      await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
      if (panel === 'open') await page.getByRole('button', { name: 'Filters' }).click();
      const before = await readFirstScreen(page);

      await page.mouse.move(187, 400);
      await expect(async () => {
        await page.mouse.wheel(0, 1500);
        await expect(page.locator('[data-marketplace-bootstrap-shell]')).toHaveCount(0, { timeout: 1000 });
      }).toPass(COLD_PAGE);
      const after = await readFirstScreen(page);
      // The scroll asked for the next page too, which may have landed below them by now.
      expect(after.tiles.slice(0, before.tiles.length)).toEqual(before.tiles);
      await expect(page.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', panel === 'open' ? 'true' : 'false');
    });
  }

  test('on a laptop, keeps the filters open with no Filters button', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await answerListing(page);
    const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
    await page.goto('/marketplace', COLD_PAGE);
    await firstRead;
    await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
    await expect(page.getByRole('link', { name: 'Paid' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Top sales' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Filters' })).toBeHidden();
    await page.screenshot({ path: test.info().outputPath('laptop-first-screen.png') });
  });

  // Review of #837: on a phone `?sort=price-low` said nothing of the order, folded behind Filters with
  // the rest, and the line under "Buyer filters" left it out; only Clear showed anything was set.
  for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
    test(`at ${viewport.width} px, says an order other than Recent where it can be seen`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await answerListing(page);
      const read = page.waitForRequest((request) => request.url().includes('/api/marketplace/resources?sort=price-low&offset=0&limit=4'), COLD_PAGE);
      await page.goto('/marketplace?sort=price-low', COLD_PAGE);
      await read;
      await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
      const filters = page.getByRole('button', { name: 'Filters, 1 set' });
      if (viewport.width < 1024) {
        await expect(page.getByText('Sorted by Price low')).toBeVisible();
        await expect(filters).toBeVisible();
        await expect(page.getByRole('link', { name: 'Price low' })).toBeHidden();
      } else {
        // A laptop's order chips say it, and the line is the one it always was.
        await expect(page.getByRole('link', { name: 'Price low' })).toHaveAttribute('aria-current', 'page');
        await expect(page.getByText('All quality-checked public recipes from community posts.')).toBeVisible();
        await expect(page.getByText('Sorted by Price low')).toBeHidden();
        await expect(filters).toBeHidden();
      }
      await page.screenshot({ path: test.info().outputPath(`order-said-${viewport.width}.png`) });
    });
  }

  // Review of #837: Back to a listing a phone had left with its filters open drew them folded, so the
  // page above the grid was a panel shorter and the reader landed that far down from their recipe.
  test('on a phone, Back to a listing left with its filters open lands on the recipe it left', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await answerListing(page);
    const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
    await page.goto('/marketplace', COLD_PAGE);
    await firstRead;
    await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
    await page.getByRole('button', { name: 'Filters' }).click();
    // Scrolled to the end, the next twelve come (the button sits a screen below, and a press would
    // scroll there first, which asks by itself).
    await scrollShellToItsEnd(page);
    await expect(tiles(page)).toHaveCount(FIRST_PAGE + MORE_PAGE, COLD_PAGE);
    await expect(page.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'true');

    const opened = tile(page, 9);
    await opened.scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(2000);
    await coversInView(page);
    const before = { scrollY: await page.evaluate(() => Math.round(window.scrollY)), top: Math.round((await opened.boundingBox())!.y) };
    await opened.click();
    await page.waitForURL(`**/showcase/${imagePost.post.id}?**`, COLD_PAGE);
    await expect(page.getByRole('link', { name: 'Back to Marketplace' })).toBeVisible(COLD_PAGE);

    await page.goBack();
    await page.waitForURL('**/marketplace', COLD_PAGE);
    await expect(page.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'true');
    await expect(tiles(page)).toHaveCount(FIRST_PAGE + MORE_PAGE);
    await expect(tile(page, 9)).toBeInViewport();
    await expect.poll(async () => Math.round((await tile(page, 9).boundingBox())!.y)).toBe(before.top);
    expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(before.scrollY);
    await page.screenshot({ path: test.info().outputPath('phone-back-filters-open.png') });
  });
});

/** Every request the page makes for a page after the first: its offset, in the order asked, and those that failed. */
function watchMorePageRequests(page: Page) {
  const seen = { offsets: [] as number[], failed: [] as string[] };
  const offsetOf = (url: string) => (url.includes('/api/marketplace/resources?') ? Number(new URL(url).searchParams.get('offset') ?? 0) : 0);
  page.on('request', (request) => {
    const offset = offsetOf(request.url());
    if (offset > 0) seen.offsets.push(offset);
  });
  page.on('requestfailed', (request) => {
    if (offsetOf(request.url()) > 0) seen.failed.push(new URL(request.url()).search);
  });
  return seen;
}

// Owner's report, 2026-11-20: every page after the first needed a press of "Load more recipes". A
// reader who scrolls towards the end gets the next page by itself, from 600 px away as on Home, and
// the recipes drawn stay where they are as it lands. Nothing is asked for before the reader scrolls,
// and a page that fails is asked for again only after Home's waits.
test.describe('scrolling to the end of the recipes', () => {
  test('brings each next page without a press, and nothing before the reader scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await answerListing(page);
    const asked = watchMorePageRequests(page);
    const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
    await page.goto('/marketplace', COLD_PAGE);
    await firstRead;
    await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);

    // The first page ends within reach of the first screen, and nothing is asked for unscrolled.
    const listEnd = page.getByRole('button', { name: 'Load more recipes' });
    expect((await listEnd.boundingBox())!.y, 'the first page ends within 600 px of the window').toBeLessThan(800 + 600);
    await page.waitForTimeout(1500);
    expect(asked.offsets).toEqual([]);

    // A turn of the wheel: the list comes in and the next twelve with it.
    await turnTheWheel(page, 300);
    await expect(tiles(page)).toHaveCount(FIRST_PAGE + MORE_PAGE, COLD_PAGE);
    await expect(page.locator('[data-marketplace-bootstrap-shell]')).toHaveCount(0);
    const handedOver = await readFirstScreen(page);

    // Scrolled to the end again: the next twelve, below the recipes drawn, which do not move.
    await wheelToTheEnd(page);
    await expect(tiles(page)).toHaveCount(TOTAL);
    const after = await readFirstScreen(page);
    expect(after.tiles.slice(0, handedOver.tiles.length)).toEqual(handedOver.tiles);
    await page.screenshot({ path: test.info().outputPath('after-scrolling-to-the-end-twice.png') });

    // The listing has ended: no button, and nothing more is asked for.
    await expect(page.getByRole('button', { name: /^(Load more recipes|Loading)$/ })).toHaveCount(0);
    await wheelToTheEnd(page);
    await page.waitForTimeout(1000);
    expect(asked.offsets).toEqual([FIRST_PAGE, FIRST_PAGE + MORE_PAGE]);
    expect(asked.failed).toEqual([]);
  });

  // A press asks for one page; on a window tall enough that the list's end stays within reach, the
  // next waits for the reader to scroll, and a turn of the wheel brings it.
  test('after a press, the next page waits for the reader to scroll', async ({ page }) => {
    const height = 2400;
    await page.setViewportSize({ width: 1440, height });
    await answerListing(page);
    const asked = watchMorePageRequests(page);
    const firstRead = page.waitForRequest(isFirstPageRead, COLD_PAGE);
    await page.goto('/marketplace', COLD_PAGE);
    await firstRead;
    await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);
    await page.getByRole('button', { name: 'Load more recipes' }).click();
    await expect(tiles(page)).toHaveCount(FIRST_PAGE + MORE_PAGE, COLD_PAGE);

    const listEnd = page.getByRole('button', { name: 'Load more recipes' });
    await expect(listEnd).toBeEnabled();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect((await listEnd.boundingBox())!.y, 'the list ends within 600 px of the window').toBeLessThan(height + 600);
    await page.waitForTimeout(1500);
    expect(asked.offsets).toEqual([FIRST_PAGE]);

    await turnTheWheel(page, 200);
    await expect(tiles(page)).toHaveCount(TOTAL, COLD_PAGE);
    expect(asked.offsets).toEqual([FIRST_PAGE, FIRST_PAGE + MORE_PAGE]);
    expect(asked.failed).toEqual([]);
  });

  // Home's phone sent 225 failing requests in 5.5 s before #878 gave its Load more these waits.
  test('asks for a failed page again after 2 s, then 8 s more, then leaves it to the button', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await answerListing(page);
    const failing = { now: true };
    const asks: number[] = [];
    await page.context().route(
      (url) => url.pathname === '/api/marketplace/resources' && url.searchParams.get('offset') === String(FIRST_PAGE + MORE_PAGE),
      async (route) => {
        asks.push(Date.now());
        if (failing.now) return route.fulfill({ status: 503, json: { error: 'Could not load more recipes.' } });
        return route.fallback();
      },
    );
    await openAndHandOver(page);
    await wheelToTheEnd(page);
    await expect.poll(() => asks.length).toBe(1);
    await expect(page.getByText('Could not load more recipes.')).toBeVisible();

    // The list's end in reach the whole time: asked twice more by itself, then no more.
    await expect.poll(() => asks.length, { timeout: 15_000 }).toBe(3);
    const waits = [asks[1] - asks[0], asks[2] - asks[1]];
    expect(waits[0]).toBeGreaterThanOrEqual(2_000);
    expect(waits[0]).toBeLessThan(4_000);
    expect(waits[1]).toBeGreaterThanOrEqual(8_000);
    expect(waits[1]).toBeLessThan(11_000);
    await page.waitForTimeout(5_000);
    expect(asks).toHaveLength(3);

    // The button asks, and brings the page.
    failing.now = false;
    await page.getByRole('button', { name: 'Load more recipes' }).click();
    await expect(tiles(page)).toHaveCount(TOTAL);
    expect(asks).toHaveLength(4);
    await expect(page.getByText('Could not load more recipes.')).toHaveCount(0);
  });

  // Review of #888: on Back, React draws the listing and runs its effects inside the browser's
  // popstate, and only then does the browser put the reader back where they were. Read as the
  // reader's scroll, that jump asked for the next page as soon as Back landed near the end of a
  // listing with more to come. Here the page after the kept ones fails, so the end stays in reach.
  test('on Back near the end of a listing with more to come, asks for the next page only once the reader scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await answerListing(page, { total: LOADED + MORE_PAGE });
    const nextPageAsks: number[] = [];
    await page.context().route(
      (url) => url.pathname === '/api/marketplace/resources' && url.searchParams.get('offset') === String(LOADED),
      async (route) => {
        nextPageAsks.push(Date.now());
        await route.fulfill({ status: 503, json: { error: 'Could not load more recipes.' } });
      },
    );
    await loadSevenRows(page);
    // A recipe of the last row: near the end, the page after is asked for, and fails.
    const opened = tile(page, LOADED - 2);
    await opened.scrollIntoViewIfNeeded();
    await expect.poll(() => nextPageAsks.length).toBeGreaterThan(0);
    await opened.click();
    await page.waitForURL(`**/showcase/${imagePost.post.id}?**`, COLD_PAGE);
    await expect(page.getByRole('link', { name: 'Back to Marketplace' })).toBeVisible(COLD_PAGE);
    const askedBeforeBack = nextPageAsks.length;

    await page.goBack();
    await page.waitForURL('**/marketplace', COLD_PAGE);
    await expect(tiles(page)).toHaveCount(LOADED);
    await expect(tile(page, LOADED - 2)).toBeInViewport();
    const listEnd = page.getByRole('button', { name: 'Load more recipes' });
    expect((await listEnd.boundingBox())!.y, 'the list ends within 600 px of the window').toBeLessThan(800 + 600);
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: test.info().outputPath('back-near-the-end.png') });
    expect(nextPageAsks, 'asked for with no scroll of the reader\'s').toHaveLength(askedBeforeBack);

    await turnTheWheel(page, 100);
    await expect.poll(() => nextPageAsks.length).toBe(askedBeforeBack + 1);
  });
});
