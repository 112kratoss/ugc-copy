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
//
// The dev server draws the storefront's first page from fixtures/marketplace-recipes.json
// (support/supabase-server-stub.cjs); the list API's pages and the covers are answered here, and
// the recipes "Load more" brings open the picture post with a free recipe the stub draws
// (fixtures/creation-post-free-recipe.json). A signed-in reader holds a session cookie, never the
// E2E bypass's: the page's auth provider asks Supabase who that is on every mount, as production's
// does, and the answer comes after a delay.

const ORIGIN = 'http://127.0.0.1:3100';
const COLD_PAGE = { timeout: 45_000 };
const USER_ID = 'e2e-market-reader';
const FIRST_PAGE = market.bundles.length - 1;
const MORE_PAGE = 12;
const TOTAL = 40;
/** After the shell's press hands over and two Load mores: 28 recipes, seven rows of four. */
const LOADED = FIRST_PAGE + 2 * MORE_PAGE;
/** The recipe opened: the second of the sixth row. */
const OPENED = 22;

test.describe.configure({ timeout: 180_000 });

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

/**
 * The list API's pages: the first as the dev server answers it (read once, as a visitor), the
 * rest made from it; and the covers, a picture each, each after `coverDelayMs(its recipe's number)`.
 */
async function answerListing(page: Page, { coverDelayMs = () => 120 }: { coverDelayMs?: (index: number) => number } = {}) {
  const context = page.context();
  // Whatever else the page asks the API offline is answered as it fails there.
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  const firstResponse = await page.request.get('/api/marketplace/resources?sort=recent&offset=0&limit=4', { timeout: 0 });
  expect(firstResponse.ok()).toBe(true);
  const firstPage = await firstResponse.json() as { items: ListItem[]; pageInfo: Record<string, unknown> };
  expect(firstPage.items.map((item) => item.title)).toEqual(market.bundles.slice(0, FIRST_PAGE).map((bundle) => bundle.title));
  const more = Array.from({ length: TOTAL - FIRST_PAGE }, (_, offset) => moreRecipe(firstPage.items[0], FIRST_PAGE + offset + 1));

  await context.route('**/api/marketplace/resources?**', (route) => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? FIRST_PAGE);
    if (offset === 0) return route.fulfill({ json: firstPage });
    const items = more.slice(offset - FIRST_PAGE, offset - FIRST_PAGE + limit);
    const nextOffset = offset + items.length;
    const hasMore = nextOffset < TOTAL;
    return route.fulfill({ json: { items, pageInfo: { hasMore, nextOffset: hasMore ? nextOffset : null, offset, limit } } });
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
    { name: 'sb-example-auth-token', value: `base64-${base64Url(JSON.stringify(session))}`, url: ORIGIN },
    { name: 'mb_name_step_shown', value: USER_ID, url: ORIGIN },
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
 * Opens Marketplace and scrolls to its end, as the owner did, which hands the list over from the
 * first-paint shell to the interactive one.
 */
async function openAndHandOver(page: Page) {
  const firstRead = page.waitForRequest((request) => request.url().includes('/api/marketplace/resources?sort=recent&offset=0&limit=4'), COLD_PAGE);
  await page.goto('/marketplace', COLD_PAGE);
  // The page's own read of its first page is made by its script, once the reader is known: it has hydrated.
  await firstRead;
  await expect(tiles(page)).toHaveCount(FIRST_PAGE, COLD_PAGE);

  // Scrolled to its end, the shell hands the list over (its module comes in, compiled on its first request).
  await page.mouse.move(640, 400);
  await expect(async () => {
    await page.mouse.wheel(0, 2000);
    await expect(page.locator('[data-marketplace-bootstrap-shell]')).toHaveCount(0, { timeout: 1000 });
  }).toPass(COLD_PAGE);
}

/** "Load more recipes", once: twelve more. */
async function loadMore(page: Page) {
  const count = await tiles(page).count();
  await page.getByRole('button', { name: 'Load more recipes' }).click();
  await expect(tiles(page)).toHaveCount(count + MORE_PAGE);
}

/** Marketplace, handed over, then "Load more recipes" twice: 28 recipes. */
async function loadSevenRows(page: Page) {
  await openAndHandOver(page);
  await loadMore(page);
  await loadMore(page);
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
    await openAndHandOver(page);
    await loadMore(page);

    const waiting = tile(page, FIRST_PAGE + 1);
    await waiting.scrollIntoViewIfNeeded();
    // The tile's frame, the first thing in its link, while its picture is on its way.
    const frame = waiting.locator('xpath=./div[1]');
    const look = await frame.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      pictureLoaded: Boolean(element.querySelector('img')?.complete),
    }));
    await frame.screenshot({ path: test.info().outputPath('cover-on-its-way.png') });
    expect(look.pictureLoaded, 'the picture is still on its way').toBe(false);
    expect(look.background).not.toBe('rgb(0, 0, 0)');

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
