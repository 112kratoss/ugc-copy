import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

// The top bar's search field as the owner tried it on the live site
// (2026-11-16): "we still dont see anything when i click on the searchbar",
// and "the search area fades, dimms those are not ideal search ui ux". Before
// the fix this file's first run found no list on a click, and the list's own
// opacity at 0.6 with its moved rows at 0.6 inside it while "see" became
// "seed" and "seeda", so the page showed through the panel. Now: a click opens
// a panel with what the search page starts from, the first letters fill that
// same panel in place, and nothing in it is ever fainter than full strength.
// Answers are this file's (page.route); the pictures are the sign-in wall's.

const SEARCH_API = (url: URL) => url.pathname === '/api/search';
const SUGGEST_API = (url: URL) => url.pathname === '/api/search/suggest';
const STARTER_API = (url: URL) => url.pathname === '/api/search/starter';
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const emptyPage = { items: [], nextCursor: null };
const COLD_PAGE = { timeout: 60_000 };
const HISTORY_KEY = 'magicbooklet:public-search-history:v1';

test.describe.configure({ retries: 2, timeout: 180_000 });

// SEARCH_TOPBAR_SHOTS=<dir> keeps pictures and a recording, for a person to look at.
const SHOTS = process.env.SEARCH_TOPBAR_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const WALL = path.join(process.cwd(), 'src/app/login/wall');
const PICTURE_HOST = 'https://example.supabase.co/storage/v1/object/public/e2e-search';
const picture = (n: number) => `${PICTURE_HOST}/wall-${String(((n - 1) % 12) + 1).padStart(2, '0')}.jpg`;
const thumbnail = (n: number) => ({ postId: `post-${n}`, url: picture(n), thumbhash: null, width: 900, height: 1200, mediaKind: 'image' });

const STARTER = {
  entities: [
    { kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro', thumbnail: thumbnail(1) },
    { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 64, postCountCapped: false, query: 'kling 2.6', thumbnail: thumbnail(5) },
    { kind: 'model', key: 'seedance-2', label: 'Seedance 2', postCount: 31, postCountCapped: false, query: 'seedance 2', thumbnail: thumbnail(2) },
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney', thumbnail: null },
    { kind: 'model', key: 'veo-3', label: 'Veo 3', postCount: 9, postCountCapped: false, query: 'veo 3', thumbnail: thumbnail(8) },
  ],
  creators: [
    { id: 'creator-luna', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false },
  ],
  searches: [
    { text: 'portrait', thumbnail: thumbnail(3) },
    { text: 'cinematic night city', thumbnail: thumbnail(7) },
    { text: 'anime', thumbnail: null },
    { text: 'product photo', thumbnail: thumbnail(11) },
    { text: 'one too many', thumbnail: null },
  ],
  periods: { entities: 'week', creators: 'all', searches: 'all' },
};

const model = (key: string, label: string, postCount: number, n: number) => ({
  kind: 'model', key, label, postCount, postCountCapped: false, thumbnail: thumbnail(n), inCatalog: false, catalogModel: null, query: null,
});
const SEEDREAM = model('seedream-5-pro', 'Seedream 5 Pro', 4, 4);
const SEEDANCE = [model('seedance-2.5', 'Seedance 2.5', 1, 6), model('seedance-2', 'Seedance 2', 3, 2), model('seedance-2-fast', 'Seedance 2 Fast', 2, 9)];
const SEEDANCE_MINI = model('seedance-2-mini', 'Seedance 2 Mini', 2, 10);

/** What the owner typed: "see" and "seed" find both families, "seeda" only Seedance, and one more of it. */
function suggestions(query: string) {
  const entities = query.startsWith('seeda') ? [...SEEDANCE, SEEDANCE_MINI] : query.startsWith('s') ? [SEEDREAM, ...SEEDANCE] : [];
  return { query, normalizedQuery: query, creators: [], entities, completions: query.startsWith('s') ? [{ text: `${query} portrait` }] : [] };
}

function searchResponse(query: string, type: string) {
  return {
    query, normalizedQuery: query, type, sort: 'top', entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null }, exact: false,
    creators: { items: [{ id: 'creator-1', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 3, isFollowing: false }], nextCursor: null },
    posts: emptyPage, recipes: emptyPage,
  };
}

type Asked = { starter: number; suggests: string[]; searches: string[] };

/** `suggestDelayMs` holds each suggestion back, so what the list does while an answer is on its way can be seen. */
async function answer(page: Page, { suggestDelayMs = 0, recents = [] as string[] } = {}): Promise<Asked> {
  const asked: Asked = { starter: 0, suggests: [], searches: [] };
  await page.route(`${PICTURE_HOST}/**`, (route) => {
    const source = path.join(WALL, path.basename(new URL(route.request().url()).pathname));
    return fs.existsSync(source) ? route.fulfill({ path: source, contentType: 'image/jpeg' }) : route.fulfill({ status: 404, body: '' });
  });
  await page.route(STARTER_API, (route) => {
    asked.starter += 1;
    return route.fulfill(json(STARTER));
  });
  await page.route(SUGGEST_API, async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? '';
    asked.suggests.push(query);
    if (suggestDelayMs) await new Promise((resolve) => setTimeout(resolve, suggestDelayMs));
    // The page aborts a request the next letter ends.
    await route.fulfill(json(suggestions(query))).catch(() => {});
  });
  await page.route(SEARCH_API, async (route) => {
    const url = new URL(route.request().url());
    asked.searches.push(url.search);
    await route.fulfill(json(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
  });
  if (recents.length) {
    await page.addInitScript(([key, kept]) => {
      // Once, as the browser opens: a search forgotten in the test stays forgotten over a navigation.
      if (!window.sessionStorage.getItem('e2e-recents-kept')) {
        window.sessionStorage.setItem('e2e-recents-kept', '1');
        window.localStorage.setItem(key as string, JSON.stringify(kept));
      }
    }, [HISTORY_KEY, recents] as const);
  }
  return asked;
}

/** React has committed the page's hydration: until then a click is heard by nobody (.claude/rules/e2e.md). */
async function hydrated(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const key = Object.keys(document).find((name) => name.startsWith('__reactContainer$'));
    const root = key ? (document as unknown as Record<string, { stateNode?: { current?: { memoizedState?: { isDehydrated?: boolean } } } }>)[key] : undefined;
    return root?.stateNode?.current?.memoizedState?.isDehydrated === false;
  }), { timeout: 60_000, message: 'React commits the page’s hydration' }).toBe(true);
}

type Strength = { list: number; row: number; frames: number; gone: number };

/**
 * Every animation frame from now on: the list's own opacity, its faintest
 * row's, and whether the list was on the page at all. `stop()` answers the
 * lowest of each and the frames that had no list.
 */
async function watchStrength(page: Page, within = 'body') {
  await page.evaluate((scope) => {
    const seen = { list: 1, row: 1, frames: 0, gone: 0, on: true };
    (window as unknown as { __searchStrength: typeof seen }).__searchStrength = seen;
    const tick = () => {
      if (!seen.on) return;
      seen.frames += 1;
      const list = document.querySelector(`${scope} [role="listbox"]`);
      if (!list) seen.gone += 1;
      else {
        seen.list = Math.min(seen.list, Number(getComputedStyle(list).opacity));
        for (const row of list.querySelectorAll('[role="option"]')) seen.row = Math.min(seen.row, Number(getComputedStyle(row).opacity));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, within);
  return async (): Promise<Strength> => page.evaluate(() => {
    const seen = (window as unknown as { __searchStrength: Strength & { on: boolean } }).__searchStrength;
    seen.on = false;
    return { list: seen.list, row: seen.row, frames: seen.frames, gone: seen.gone };
  });
}

/** The panel's skin is solid: nothing of the page shows through it. */
async function expectSolid(list: Locator) {
  const skin = await list.evaluate((element) => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, background: style.backgroundColor };
  });
  expect(skin.opacity).toBe('1');
  // rgb(…), or rgba(…, 1): never a see-through colour.
  expect(skin.background).toMatch(/^rgb\(|^rgba\([^)]*,\s*1\)$/);
}

const topBarField = (page: Page) => page.getByRole('banner').getByRole('combobox', { name: 'Search creators, posts, and recipes' });
const panel = (page: Page) => page.getByRole('banner').getByRole('listbox', { name: 'Search suggestions' });

async function openHome(page: Page) {
  await page.goto('/', COLD_PAGE);
  await hydrated(page);
}

test.describe('the top bar’s search panel', () => {
  test('a click on the empty field opens the start panel, drawn over the page, and it is asked for once', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const asked = await answer(page, { recents: ['neon harbor', 'glowing lumen'] });
    await openHome(page);
    // Nothing is asked of a page that is never searched from.
    expect(asked.starter).toBe(0);

    const box = topBarField(page);
    const banner = page.getByRole('banner');
    const before = { banner: await banner.boundingBox(), field: await box.boundingBox(), height: await page.evaluate(() => document.documentElement.scrollHeight) };

    await box.click();
    const list = panel(page);
    await expect(list).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(10);
    await expect(list.getByRole('option').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')))).resolves.toEqual([
      'Search again for neon harbor',
      'Search again for glowing lumen',
      'Nano Banana Pro, model, 200+ posts. Show posts made with it',
      'Kling 2.6, model, 64 posts. Show posts made with it',
      'Seedance 2, model, 31 posts. Show posts made with it',
      'Midjourney, tool, 14 posts. Show posts made with it',
      'Search for portrait',
      'Search for cinematic night city',
      'Search for anime',
      'Search for product photo',
    ]);
    // The search page's own headings; "this week" only where the answer says so. No creators: their rows carry Follow.
    await expect(list.getByRole('group')).toHaveCount(3);
    await expect(list.locator('[role="group"] > [role="presentation"]:first-child, [role="group"] > div:first-child > [role="presentation"]'))
      .toHaveText(['Recent searches', 'Popular this week', 'Try searching for']);
    await expect(list.getByText('Luna Studio')).toHaveCount(0);
    await expect(box).toHaveAttribute('aria-expanded', 'true');
    await expect(box).toHaveAttribute('aria-controls', (await list.getAttribute('id')) ?? 'no id');
    // A model's and a search's picture; the glyph in the same frame where the starter has none.
    await expect(list.getByRole('option', { name: /^Nano Banana Pro/ }).locator('img')).toHaveJSProperty('complete', true);
    await expect(list.getByRole('option', { name: 'Search for portrait' }).locator('img')).toHaveCount(1);
    await expect(list.getByRole('option', { name: /^Midjourney/ }).locator('[data-search-picture="placeholder"] svg')).toHaveCount(1);
    await expect(list.getByRole('option', { name: 'Search for anime' }).locator('[data-search-picture="placeholder"] svg')).toHaveCount(1);
    await expectSolid(list);
    await shot(page, 'desktop-panel-open');

    // Over the page, never in its flow: the bar, the field and the page keep their sizes and places.
    expect(await banner.boundingBox()).toEqual(before.banner);
    expect(await box.boundingBox()).toEqual(before.field);
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(before.height);
    // Under the field, at its width, inside the window, every row a finger's height.
    const frame = (await list.boundingBox())!;
    const field = (await box.locator('xpath=ancestor::form').boundingBox())!;
    expect(frame.y).toBeGreaterThanOrEqual(field.y + field.height);
    // The field's own hairline is the two pixels between them.
    expect(Math.abs(frame.x - field.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.width - field.width)).toBeLessThanOrEqual(2);
    expect(frame.y + frame.height).toBeLessThanOrEqual(900);
    for (const option of await list.getByRole('option').all()) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(44);

    // Leaving the field closes it; coming back opens it again without asking again.
    await box.blur();
    await expect(list).toBeHidden();
    await box.click();
    await expect(list.getByRole('option')).toHaveCount(10);
    expect(asked.starter).toBe(1);
    // Nothing was typed: no suggestion was asked for.
    expect(asked.suggests).toEqual([]);
  });

  test('the keys walk it, Escape closes it, a recent search can be forgotten, and each row goes where the search page would', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const asked = await answer(page, { recents: ['neon harbor', 'glowing lumen', 'lumen city', 'fourth search'] });
    await openHome(page);
    const box = topBarField(page);
    const list = panel(page);
    await box.click();
    const options = list.getByRole('option');
    await expect(options).toHaveCount(11);

    // Down and Up walk the rows; the focus stays in the field, which names the highlighted row.
    await box.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await expect(box).toHaveAttribute('aria-activedescendant', (await options.nth(0).getAttribute('id')) ?? 'no id');
    await box.press('ArrowUp');
    await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);
    await box.press('ArrowUp');
    await expect(options.nth(10)).toHaveAttribute('aria-selected', 'true');
    await expect(box).toBeFocused();

    // Escape closes it; Down opens it again on its first row.
    await box.press('Escape');
    await expect(list).toBeHidden();
    await expect(box).toHaveAttribute('aria-expanded', 'false');
    await box.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');

    // One recent search forgotten: the next one kept comes in, and the focus stays in the field.
    await list.getByRole('button', { name: 'Remove glowing lumen from recent searches' }).click();
    await expect(options).toHaveCount(11);
    await expect(options.nth(1)).toHaveAttribute('aria-label', 'Search again for lumen city');
    await expect(options.nth(2)).toHaveAttribute('aria-label', 'Search again for fourth search');
    await expect(box).toBeFocused();
    expect(await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key) ?? '[]'), HISTORY_KEY)).toEqual(['neon harbor', 'lumen city', 'fourth search']);
    // All of them.
    await list.getByRole('button', { name: 'Clear all recent searches' }).click();
    await expect(options).toHaveCount(8);
    await expect(list.getByRole('group')).toHaveCount(2);
    await expect(box).toBeFocused();
    await shot(page, 'desktop-panel-no-recents');

    // A model with Enter: the search page's Posts for its own query, narrowed to it, entered from a model's row.
    await page.request.get('/search', { timeout: 0 });
    await box.press('ArrowDown');
    await expect(options.nth(0)).toHaveAttribute('aria-label', /^Nano Banana Pro/);
    await box.press('Enter');
    await expect(page).toHaveURL(/\/search\?q=nano\+banana\+pro&type=posts&madeWith=model%3Anano-banana-pro$/, COLD_PAGE);
    await expect.poll(() => asked.searches.some((search) => search.includes('q=nano+banana+pro') && search.includes('entry=entity')), { timeout: 30_000 }).toBe(true);

    // A search the starter offers, pressed: searched on the search page, entered from the starter.
    await page.goBack();
    await hydrated(page);
    await topBarField(page).click();
    await panel(page).getByRole('option', { name: 'Search for cinematic night city' }).click();
    await expect(page).toHaveURL(/\/search\?q=cinematic\+night\+city$/, COLD_PAGE);
    await expect.poll(() => asked.searches.some((search) => search.includes('q=cinematic+night+city') && search.includes('entry=starter')), { timeout: 30_000 }).toBe(true);
    // The focus came on into the search page's field, with no list over the search just made.
    const pageBox = page.getByRole('main').getByRole('combobox', { name: 'Search creators, posts, and recipes' });
    await expect(pageBox).toBeFocused();
    await expect(pageBox).toHaveValue('cinematic night city');
    await expect(page.getByRole('listbox')).toHaveCount(0);
  });

  test('a recent search pressed is searched again, entered as a recent search', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const asked = await answer(page, { recents: ['neon harbor'] });
    await openHome(page);
    await page.request.get('/search', { timeout: 0 });
    await topBarField(page).click();
    await panel(page).getByRole('option', { name: 'Search again for neon harbor' }).click();
    await expect(page).toHaveURL(/\/search\?q=neon\+harbor$/, COLD_PAGE);
    await expect.poll(() => asked.searches.some((search) => search.includes('q=neon+harbor') && search.includes('entry=recent')), { timeout: 30_000 }).toBe(true);
  });

  test('typing fills the same panel in place: never gone, never fainter, never see-through, while answers are on their way', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    // Each answer takes most of a second, as on a slow connection: the rows of the text before stay meanwhile.
    await answer(page, { suggestDelayMs: 700 });
    await openHome(page);
    const box = topBarField(page);
    const list = panel(page);
    // Watched from before the click: the panel has no entrance to fade it in, so its first frame counts too.
    const stop = await watchStrength(page, 'header');
    await box.click();
    await expect(list.getByRole('option')).toHaveCount(8);
    const element = await list.elementHandle();
    await page.evaluate(() => { (window as unknown as { __searchStrength: { gone: number } }).__searchStrength.gone = 0; });

    // The first letters: their answer is not here yet, and the start panel stays, said to be busy.
    await box.pressSequentially('see', { delay: 70 });
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expect(list.getByRole('option').first()).toHaveAttribute('aria-label', /^Nano Banana Pro/);
    await shot(page, 'desktop-typing-start-kept');
    // The answer replaces the rows in place: the same element.
    await expect(list.getByRole('option')).toHaveText([/Seedream 5 Pro/, /Seedance 2\.5/, /Seedance 2Model/, /Seedance 2 Fast/, 'see portrait']);
    expect(await list.evaluate((now, was) => now === was, element)).toBe(true);
    await shot(page, 'desktop-typing-see');

    // "seed", then "seeda": the rows of the text before stay at full strength until the answer lands.
    await box.press('d');
    await page.waitForTimeout(450);
    await expect(list).toHaveAttribute('aria-busy', 'true');
    await expectSolid(list);
    await shot(page, 'desktop-typing-seed-waiting');
    await expect(list.getByRole('option').last()).toHaveText('seed portrait');
    await box.press('a');
    // A model the text no longer names goes at once, and the rest move up: marked for the press rule, drawn as before.
    await expect(list.getByRole('option')).toHaveText([/Seedance 2\.5/, /Seedance 2Model/, /Seedance 2 Fast/, 'seed portrait']);
    await expect(list.getByRole('option').first()).toHaveCSS('opacity', '1');
    await page.waitForTimeout(450);
    await expectSolid(list);
    await shot(page, 'desktop-typing-seeda-waiting');
    await expect(list.getByRole('option', { name: /Seedance 2 Mini/ })).toBeVisible();
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await page.waitForTimeout(400);
    await shot(page, 'desktop-typing-seeda');

    const strength = await stop();
    expect(strength.frames).toBeGreaterThan(60);
    // On the page at every frame, and at full strength at every frame, the list and each of its rows.
    expect(strength).toMatchObject({ gone: 0, list: 1, row: 1 });
    expect(await list.evaluate((now, was) => now === was, element)).toBe(true);
  });

  test('fits the narrowest window the field is drawn in, and nothing in it animates, with or without reduced motion', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await answer(page, { recents: ['neon harbor', 'glowing lumen', 'lumen city'] });
    await openHome(page);
    const box = topBarField(page);
    const list = panel(page);
    // No entrance and no exit: the list and its rows run no animation and no transition of their
    // own, whatever the person's motion setting (a picture's own load fade is inside a row).
    const motion = () => list.evaluate((element) => [element, ...element.querySelectorAll('[role="option"]')].map((part) => {
      const style = getComputedStyle(part);
      return `${style.opacity} ${style.animationName} ${part.getAnimations().length}`;
    }).filter((value, index, all) => all.indexOf(value) === index));
    for (const reducedMotion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion });
      await box.click();
      await expect(list.getByRole('option')).toHaveCount(11);
      expect(await motion()).toEqual(['1 none 0']);
      await box.press('Escape');
      await expect(list).toHaveCount(0);
      await box.blur();
    }
    await box.click();
    await expect(list.getByRole('option')).toHaveCount(11);
    await shot(page, 'narrow-panel-open');

    // Inside the window: taller than it has room for, it scrolls inside itself, and the page gains no sideways scroll.
    const frame = (await list.boundingBox())!;
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(1024);
    expect(frame.y + frame.height).toBeLessThanOrEqual(700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
    // A long search wraps inside its row; no row is wider than the panel.
    for (const option of await list.getByRole('option').all()) {
      const row = (await option.boundingBox())!;
      expect(row.x + row.width).toBeLessThanOrEqual(frame.x + frame.width);
    }
    // The last row is reached with the keys, scrolled into the panel.
    await box.press('ArrowUp');
    await expect(list.getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  });

  test('on a phone the bar’s magnifier opens the search page, whose start screen is the page, and its typing list never dims', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await answer(page, { suggestDelayMs: 500, recents: ['seedance tests'] });
    await openHome(page);
    // No field in the bar below 1024px: its magnifier leads to the search page.
    await expect(topBarField(page)).toBeHidden();
    await page.request.get('/search', { timeout: 0 });
    await page.getByRole('banner').getByRole('link', { name: 'Search creators, posts, and recipes' }).click();
    await expect(page).toHaveURL(/\/search$/, COLD_PAGE);
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible(COLD_PAGE);
    await shot(page, 'phone-search-page-start');

    const box = page.getByRole('main').getByRole('combobox');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await box.click();
    await box.pressSequentially('seed', { delay: 70 });
    await expect(list.getByRole('option')).toHaveCount(2);
    const stop = await watchStrength(page);
    await box.press('a');
    await page.waitForTimeout(350);
    await expectSolid(list);
    await shot(page, 'phone-typing-waiting');
    await expect(list.getByRole('option').last()).toHaveText('seeda portrait');
    await page.waitForTimeout(300);
    expect(await stop()).toMatchObject({ list: 1, row: 1 });
    const frame = (await list.boundingBox())!;
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(390);
  });
});

// ─── A recording, for a person to look at ────────────────────────────────────

test('records a click on the field and "see", "seed", "seeda" typed into it (SEARCH_TOPBAR_SHOTS only)', async ({ browser }) => {
  test.skip(!SHOTS, 'Records only when SEARCH_TOPBAR_SHOTS names a folder.');
  const dir = path.join(SHOTS!, 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir, size: { width: 1440, height: 900 } } });
  const page = await context.newPage();
  try {
    await answer(page, { suggestDelayMs: 700, recents: ['neon harbor'] });
    await openHome(page);
    const box = topBarField(page);
    await page.waitForTimeout(500);
    await box.click();
    await expect(panel(page).getByRole('option')).toHaveCount(9);
    await page.waitForTimeout(1200);
    await box.pressSequentially('see', { delay: 90 });
    await expect(panel(page).getByRole('option').first()).toHaveText(/Seedream 5 Pro/);
    await page.waitForTimeout(500);
    await box.press('d');
    await page.waitForTimeout(1100);
    await box.press('a');
    await expect(panel(page).getByRole('option', { name: /Seedance 2 Mini/ })).toBeVisible();
    await page.waitForTimeout(900);
  } finally {
    await context.close();
  }
});
