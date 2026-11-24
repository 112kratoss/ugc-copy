import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// The search UX pass that followed the top bar panel (owner, 2026-11-16: "make
// sure the ui ux of the search is improved and mistake free"). What a walk
// through every search state found and fixed, held in a browser:
//
//   - the page opened on its idle invitation, which the recent searches then
//     pushed down and the start screen replaced;
//   - a creator's name on the start screen was cut to three letters beside
//     Follow at widths where the shell's sidebar takes room ("Mag…");
//   - a creator result's post count was the part cut beside Follow on a phone
//     ("@harbour-studio · 48 p…");
//   - Top's "Models and tools" drew a glyph where the typeahead and the start
//     screen draw the model's picture.
//
// Answers are this file's (page.route); the pictures are the sign-in wall's.

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const emptyPage = { items: [], nextCursor: null };
const COLD_PAGE = { timeout: 60_000 };
const WALL = path.join(process.cwd(), 'src/app/login/wall');
const HOST = 'https://example.supabase.co/storage/v1/object/public/e2e-search';
const picture = (n: number) => `${HOST}/wall-${String(((n - 1) % 12) + 1).padStart(2, '0')}.webp`;
const thumbnail = (n: number) => ({ postId: `post-${n}`, url: picture(n), thumbhash: null, width: 900, height: 1200, mediaKind: 'image' });
const INVITATION = 'Find creators, posts and recipes';

test.describe.configure({ retries: 2, timeout: 180_000 });

const STARTER = {
  entities: [
    { kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro', thumbnail: thumbnail(1) },
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney', thumbnail: null },
  ],
  creators: [
    { id: 'creator-magic', username: 'magicbooklet', displayName: 'Magic Booklet', bio: null, avatarUrl: picture(9), publicPostCount: 39, isFollowing: false },
    { id: 'creator-sas', username: 'sasikumar', displayName: 'Sasikumar R', bio: null, avatarUrl: null, publicPostCount: 12, isFollowing: false },
    { id: 'creator-luna', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: picture(4), publicPostCount: 42, isFollowing: false },
    { id: 'creator-neon', username: 'neon-fox', displayName: 'Neon Fox', bio: null, avatarUrl: null, publicPostCount: 7, isFollowing: false },
  ],
  searches: [{ text: 'portrait', thumbnail: thumbnail(3) }, { text: 'anime', thumbnail: null }],
  periods: { entities: 'week', creators: 'week', searches: 'all' },
};

const CREATORS = [
  { id: 'creator-harbour', username: 'harbour-studio', displayName: 'Harbour Studio', avatarUrl: picture(4), bio: 'Night harbours and long exposures from the old port.', publicPostCount: 48, isFollowing: false },
  { id: 'creator-long', username: 'sasikumar-rajendran-photography', displayName: 'Sasikumar Rajendran Photography', avatarUrl: null, bio: null, publicPostCount: 1240, isFollowing: false },
];
const ENTITIES = [
  { kind: 'model', key: 'harbour-xl', label: 'Harbour XL', postCount: 14, postCountCapped: false },
  { kind: 'tool', key: 'harbourcraft', label: 'Harbourcraft', postCount: 3, postCountCapped: false },
];

function searchAnswer(params: URLSearchParams) {
  const query = params.get('q') ?? '';
  const type = params.get('type') ?? 'top';
  const found = query.includes('harb');
  return {
    query, normalizedQuery: query, type, sort: 'top',
    entities: found && type === 'top' ? ENTITIES : [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null }, exact: false,
    creators: found && (type === 'top' || type === 'creators') ? { items: CREATORS, nextCursor: null } : emptyPage,
    posts: emptyPage, recipes: emptyPage,
  };
}

function suggestions(query: string) {
  const harb = query.startsWith('har');
  return {
    query, normalizedQuery: query, creators: [],
    entities: harb ? [
      { kind: 'model', key: 'harbour-xl', label: 'Harbour XL', postCount: 14, postCountCapped: false, thumbnail: thumbnail(6), inCatalog: false, catalogModel: null, query: null },
      { kind: 'tool', key: 'harbourcraft', label: 'Harbourcraft', postCount: 3, postCountCapped: false, thumbnail: null, inCatalog: false, catalogModel: null, query: null },
    ] : [],
    completions: harb ? [{ text: 'harbour at night' }] : [],
  };
}

async function answer(page: Page, { starterDelayMs = 0, starter = STARTER as unknown, starterStatus = 200 } = {}) {
  await page.route(`${HOST}/**`, (route) => {
    const source = path.join(WALL, path.basename(new URL(route.request().url()).pathname));
    return fs.existsSync(source) ? route.fulfill({ path: source, contentType: 'image/webp' }) : route.fulfill({ status: 404, body: '' });
  });
  await page.route((url) => url.pathname === '/api/search/starter', async (route) => {
    if (starterDelayMs) await new Promise((resolve) => setTimeout(resolve, starterDelayMs));
    await route.fulfill(json(starter, starterStatus));
  });
  await page.route((url) => url.pathname === '/api/search/suggest', (route) => route.fulfill(json(suggestions(new URL(route.request().url()).searchParams.get('q') ?? ''))));
  await page.route((url) => url.pathname === '/api/search', (route) => route.fulfill(json(searchAnswer(new URL(route.request().url()).searchParams))));
  await page.route((url) => url.pathname === '/api/search/opened', (route) => route.fulfill({ status: 204, body: '' }));
}

/** From the document's first moment: whether the invitation's words were ever on the page, at any animation frame. */
async function watchInvitation(page: Page) {
  await page.addInitScript((words) => {
    const seen = { invitation: false };
    (window as unknown as { __searchSeen: typeof seen }).__searchSeen = seen;
    const look = () => {
      if (document.body?.textContent?.includes(words)) seen.invitation = true;
      requestAnimationFrame(look);
    };
    look();
  }, INVITATION);
  return () => page.evaluate(() => (window as unknown as { __searchSeen: { invitation: boolean } }).__searchSeen.invitation);
}

const cut = (page: Page, selector: string) => page.locator(selector).evaluateAll(
  (nodes) => nodes.filter((node) => node.scrollWidth > node.clientWidth).map((node) => node.textContent),
);

test.describe('search UX pass', () => {
  test('opens on the start screen with no invitation flashed first, and keeps the recent searches where they first stood', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // The starter takes a moment, as it does over a network.
    await answer(page, { starterDelayMs: 600 });
    const invitationSeen = await watchInvitation(page);
    await page.addInitScript(() => window.localStorage.setItem('magicbooklet:public-search-history:v1', JSON.stringify(['neon harbor', 'glowing lumen'])));
    // The server's own HTML has none either: the page used to be sent with it drawn.
    const html = await (await page.request.get('/search', { timeout: 0 })).text();
    expect(html).not.toContain(INVITATION);

    await page.goto('/search', COLD_PAGE);
    const recents = page.getByRole('heading', { name: 'Recent searches' });
    await expect(recents).toBeVisible(COLD_PAGE);
    const before = await recents.boundingBox();
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible(COLD_PAGE);
    expect(await invitationSeen()).toBe(false);
    // The start screen came in under them: nothing above it moved.
    expect(await recents.boundingBox()).toEqual(before);
  });

  test('draws the invitation once it is known there is no start screen to draw', async ({ page }) => {
    await answer(page, { starterStatus: 404, starter: {} });
    await page.goto('/search', COLD_PAGE);
    await expect(page.getByText(INVITATION)).toBeVisible(COLD_PAGE);
  });

  // 800px is where the owner's live check read "Mag…": the sidebar is on show and takes room.
  for (const width of [1440, 1024, 800, 390]) {
    test(`shows a creator’s name whole on the start screen at ${width}px, beside Follow`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await answer(page);
      await page.goto('/search', COLD_PAGE);
      const starter = page.getByRole('region', { name: 'Ideas to start a search' });
      await expect(starter.getByRole('button', { name: 'Follow Magic Booklet' })).toBeVisible(COLD_PAGE);
      const names = '[data-search-starter] [data-search-creator-name]';
      await expect(page.locator(names)).toHaveText(['Magic Booklet', 'Sasikumar R', 'Luna Studio', 'Neon Fox']);
      expect(await cut(page, names)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
  }

  test('never cuts a creator result’s post count on a phone: the handle gives way', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await answer(page);
    await page.goto('/search?q=harbour&type=creators', COLD_PAGE);
    const cards = page.locator('[data-search-result="creator"]');
    await expect(cards).toHaveCount(2, COLD_PAGE);
    // The counts are drawn whole, each beside its handle on one line.
    const counts = cards.locator('[data-search-creator-count]');
    await expect(counts).toHaveText([' · 48 posts', ' · 1240 posts']);
    for (const count of await counts.all()) {
      const box = (await count.boundingBox())!;
      const card = (await count.locator('xpath=ancestor::a').boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
      expect(await count.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    // The long handle is what was shortened.
    expect(await cut(page, '[data-search-result="creator"] [data-search-creator-handle]')).toContain('@sasikumar-rajendran-photography');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });

  test('draws a model’s picture on Top’s card once a suggestion has named it, and again after Back', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await answer(page);
    await page.goto('/search', COLD_PAGE);
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible(COLD_PAGE);
    const box = page.getByRole('main').getByRole('combobox');
    await box.click();
    await box.pressSequentially('harbour', { delay: 40 });
    await box.press('Enter');

    const models = page.getByRole('region', { name: 'Models and tools' });
    const model = models.getByRole('button', { name: /^Harbour XL, model/ });
    await expect(model.locator('img')).toHaveAttribute('src', picture(6));
    // The start screen's card: the same 48px frame, and the glyph in it where nothing named a picture.
    const frame = (await model.locator('[data-search-picture]').boundingBox())!;
    expect([Math.round(frame.width), Math.round(frame.height)]).toEqual([48, 48]);
    await expect(models.getByRole('button', { name: /^Harbourcraft, tool/ }).locator('[data-search-picture="placeholder"] svg')).toHaveCount(1);

    // Away to a creator and Back: the page is drawn as it was left, picture included.
    await page.request.get('/creators/harbour-studio', { timeout: 0 });
    await page.getByRole('link', { name: /Harbour Studio's profile/ }).click();
    await page.waitForURL(/\/creators\/harbour-studio$/, COLD_PAGE);
    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=harbour$/, COLD_PAGE);
    await expect(page.getByRole('region', { name: 'Models and tools' }).getByRole('button', { name: /^Harbour XL, model/ }).locator('img')).toHaveAttribute('src', picture(6), COLD_PAGE);
  });
});
