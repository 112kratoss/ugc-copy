import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import creatorFixture from './fixtures/creator-profile.json';

// The web half of the search benchmark's fixes (2026-11-15) in a browser, at a
// desktop's width and a phone's: the start screen's pictures and "this week"
// headings, the typeahead's catalog rows (a picture, a model nobody has posted
// with that opens its creator), related searches over an answer, the blended
// order once a search is settled on (with no mark on its posts), and Follow on
// a creator row, signed in and signed out. Answers are this file's
// (page.route); the pictures are the sign-in wall's, served as if from the
// project's storage. search-ui-web-client.test.tsx holds the same rules in
// vitest.

const SEARCH_API = (url: URL) => url.pathname === '/api/search';
const SUGGEST_API = (url: URL) => url.pathname === '/api/search/suggest';
const STARTER_API = (url: URL) => url.pathname === '/api/search/starter';
const OPENED_API = (url: URL) => url.pathname === '/api/search/opened';
const FOLLOW_API = (url: URL) => url.pathname === '/api/profile/follow';
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const emptyPage = { items: [], nextCursor: null };

const SIZES = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const;
// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 60_000 };

test.describe.configure({ retries: 2, timeout: 180_000 });

// SEARCH_UI_WEB_SHOTS=<dir> keeps a picture of each state, and a recording of the motion, for a person to look at.
const SHOTS = process.env.SEARCH_UI_WEB_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// ─── Pictures ────────────────────────────────────────────────────────────────

const WALL = path.join(process.cwd(), 'src/app/login/wall');
const PICTURE_HOST = 'https://example.supabase.co/storage/v1/object/public/e2e-search';
const picture = (n: number) => `${PICTURE_HOST}/wall-${String(((n - 1) % 12) + 1).padStart(2, '0')}.jpg`;
const MISSING_PICTURE = `${PICTURE_HOST}/missing.jpg`;
const thumbnail = (n: number, url = picture(n)) => ({ postId: `post-${n}`, url, thumbhash: null, width: 900, height: 1200, mediaKind: 'image' });

/** The pictures, from the sign-in wall's files; `delayMs` holds each back, for a recording of it arriving. */
async function servePictures(page: Page, { delayMs = 0 }: { delayMs?: number } = {}) {
  await page.route(`${PICTURE_HOST}/**`, async (route) => {
    const file = path.basename(new URL(route.request().url()).pathname);
    const source = path.join(WALL, file);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (!fs.existsSync(source)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ path: source, contentType: 'image/jpeg' });
  });
}

// ─── Answers ─────────────────────────────────────────────────────────────────

const STARTER = {
  entities: [
    { kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro', thumbnail: thumbnail(1) },
    { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 64, postCountCapped: false, query: 'kling 2.6', thumbnail: thumbnail(5) },
    // Its picture fails to load: the glyph comes back, never a broken image.
    { kind: 'model', key: 'seedance-2', label: 'Seedance 2', postCount: 31, postCountCapped: false, query: 'seedance 2', thumbnail: thumbnail(2, MISSING_PICTURE) },
    // No picture at all: the glyph in the same frame.
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney', thumbnail: null },
  ],
  creators: [
    { id: 'creator-luna', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: picture(9), publicPostCount: 42, isFollowing: false },
    { id: 'creator-neon', username: 'neon-fox', displayName: 'Neon Fox', bio: null, avatarUrl: null, publicPostCount: 12, isFollowing: false },
  ],
  searches: [
    { text: 'portrait', thumbnail: thumbnail(3) },
    { text: 'cinematic night city', thumbnail: thumbnail(7) },
    { text: 'anime', thumbnail: null },
    { text: 'product photo', thumbnail: thumbnail(11) },
  ],
  periods: { entities: 'week', creators: 'all', searches: 'week' },
};

const TITLES = ['Harbour at blue hour', 'Lights on the pier', 'Fog over the docks', 'Night ferry', 'Lantern row', 'Rain on the quay', 'Signal tower', 'Low tide glow'];
function postItem(index: number, matchedBy: 'words' | 'meaning' | 'both' = 'words') {
  const url = picture(index + 1);
  return {
    id: `post-${index}`,
    title: TITLES[index % TITLES.length],
    saveCount: (index * 7) % 23,
    commentCount: index % 4,
    createdAt: '2026-11-12T10:00:00.000Z',
    creator: { name: 'Harbour Studio', username: 'harbour-studio' },
    mediaKind: 'image',
    mediaUrl: url,
    mediaItems: [{ id: `media-${index}`, url, previewUrl: url, mediaKind: 'image', width: 900, height: [1200, 900, 1125][index % 3], sortOrder: 0 }],
    matchedBy,
  };
}

const CREATORS = [
  { id: 'creator-harbour', username: 'harbour-studio', displayName: 'Harbour Studio', avatarUrl: picture(4), bio: 'Night harbours and long exposures.', publicPostCount: 48, isFollowing: false },
  { id: 'creator-neon', username: 'neon-fox', displayName: 'Neon Fox', avatarUrl: null, bio: null, publicPostCount: 12, isFollowing: true },
];
const RELATED = ['neon harbour', 'harbour at night', 'fog lights', 'rainy pier', 'lighthouse', 'sea glass', 'one too many'];

function searchAnswer(params: URLSearchParams) {
  const query = params.get('q') ?? '';
  const type = params.get('type') ?? 'top';
  const blended = params.get('blend') === '1';
  const found = query.includes('harbour');
  // The blended order mixes in posts that mean the query without its words; the word order has only those with them.
  const posts = blended
    ? [postItem(0, 'both'), postItem(5, 'meaning'), postItem(1), postItem(6, 'meaning'), postItem(2), postItem(3), postItem(7, 'meaning'), postItem(4)]
    : [postItem(0), postItem(1), postItem(2), postItem(3), postItem(4)];
  return {
    query,
    normalizedQuery: query,
    type,
    sort: params.get('sort') ?? 'top',
    entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: found && (type === 'top' || type === 'creators') ? { items: CREATORS, nextCursor: null } : emptyPage,
    posts: found && (type === 'top' || type === 'posts') ? { items: posts, nextCursor: null } : emptyPage,
    recipes: emptyPage,
    // Never the query itself, as the server leaves it out; six at most are drawn of what comes.
    ...(found && params.get('relatedSearches') === '1' ? { relatedSearches: RELATED.filter((text) => text !== query).map((text) => ({ text })) } : {}),
    ...(blended ? { blended: true } : {}),
  };
}

const SUGGESTIONS = {
  query: 'sdx',
  normalizedQuery: 'sdx',
  creators: [],
  entities: [
    // A model of the catalog nobody has posted with: it opens the video creator with it chosen.
    {
      kind: 'model', key: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro', postCount: 0, postCountCapped: false, thumbnail: null,
      inCatalog: true, catalogModel: { id: 'seedance-1.5-pro', kind: 'video', web: true, mobile: true }, query: null,
    },
    // The name the text means, by an alias: its posts, searched for its own query.
    {
      kind: 'tool', key: 'stability-ai', label: 'Stability AI', postCount: 5, postCountCapped: false, thumbnail: thumbnail(6),
      inCatalog: false, catalogModel: null, query: 'stability ai',
    },
    // The app's alone: the web has no creator for it, so it is not offered here.
    {
      kind: 'model', key: 'app-only-model', label: 'App Only Model', postCount: 0, postCountCapped: false, thumbnail: null,
      inCatalog: true, catalogModel: { id: 'app-only-model', kind: 'image', web: false, mobile: true }, query: null,
    },
  ],
  completions: [{ text: 'stability ai' }, { text: 'sdxl portraits of rainy harbours at night, cinematic lighting' }, { text: 'sdxl anime' }],
};

type Asked = { searches: URLSearchParams[]; opened: unknown[]; follows: { body: unknown; authorization: string | undefined }[] };

async function answerSearch(page: Page, { followAnswer = { following: true } }: { followAnswer?: unknown } = {}): Promise<Asked> {
  const asked: Asked = { searches: [], opened: [], follows: [] };
  await servePictures(page);
  await page.route(SEARCH_API, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    asked.searches.push(params);
    await route.fulfill(json(searchAnswer(params)));
  });
  await page.route(STARTER_API, (route) => route.fulfill(json(STARTER)));
  await page.route(SUGGEST_API, (route) => route.fulfill(json(SUGGESTIONS)));
  await page.route(OPENED_API, (route) => {
    asked.opened.push(route.request().postDataJSON());
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route(FOLLOW_API, (route) => {
    asked.follows.push({ body: route.request().postDataJSON(), authorization: route.request().headers().authorization });
    return route.fulfill(json(followAnswer));
  });
  return asked;
}

// ─── A signed-in viewer ──────────────────────────────────────────────────────

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}
const VIEWER = {
  id: creatorFixture.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const SESSION = {
  access_token: [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({ sub: VIEWER.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES_AT, email: VIEWER.email, is_anonymous: false, session_id: 'e2e-session' })),
    'e2e-signature',
  ].join('.'),
  token_type: 'bearer',
  expires_in: 365 * 24 * 3600,
  expires_at: EXPIRES_AT,
  refresh_token: 'e2e-refresh-token',
  user: VIEWER,
};

/**
 * The E2E user, signed in on the server (the e2e-auth cookie) and in the browser's Supabase client
 * (a session cookie of its own, as creator-profile-editor.spec.ts plants it). Supabase and every
 * API the page calls are answered here, so the made-up token never reaches the dev server.
 */
async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, `sb-example-auth-token=base64-${base64url(JSON.stringify(SESSION))}`);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: VIEWER });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: SESSION });
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: creatorFixture.display_name, avatar_url: null, credits: 25, username: creatorFixture.username };
      const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  // Whatever else the shell asks while signed in, never the dev server with a made-up token.
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
}

const field = (page: Page) => page.getByRole('main').getByRole('combobox');

/**
 * The page's own errors, as the console and uncaught exceptions report them: none expected. Left
 * out: a resource the offline run refuses (the shell's signed-in requests answered 503 here, the
 * picture that is missing on purpose) and the shell's notification sync, which says so when its 503 comes.
 */
function pageErrors(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/Failed to load resource|Generation notification sync failed \(503\)/.test(text)) return;
    errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** What reaches past the screen's right edge outside a sideways scroller: nothing, or the page scrolls sideways. */
function overflowing(page: Page) {
  return page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (element: Element) => ['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(element).overflowX);
    const clipped = (element: Element) => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (scrolls(parent)) return true;
      }
      return false;
    };
    return [...document.querySelectorAll('body *')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.right > width + 0.5 && !clipped(element);
      })
      .slice(0, 8)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '').split(/\s+/).slice(0, 6).join('.')} right=${Math.round(element.getBoundingClientRect().right)}`);
  });
}

// ─── The start screen ────────────────────────────────────────────────────────

test.describe('search, the web half of the benchmark fixes', () => {
  for (const [name, size] of SIZES) {
    test(`draws the start screen's pictures, says "this week" only of a week's list, and never a broken image (${name})`, async ({ page }) => {
      await page.setViewportSize(size);
      const errors = pageErrors(page);
      await answerSearch(page);
      await page.goto('/search');
      const starter = page.getByRole('region', { name: 'Ideas to start a search' });
      await expect(starter).toBeVisible(COLD_PAGE);
      await expect(starter.getByRole('heading', { level: 2 })).toHaveText(['Popular this week', 'Creators to follow', 'Popular searches this week']);

      const nano = starter.getByRole('button', { name: /^Nano Banana Pro, model/ });
      const nanoPicture = nano.locator('[data-search-picture="picture"] img');
      await expect.poll(() => nanoPicture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      await expect(nanoPicture).toHaveCSS('opacity', '1');
      await expect(starter.getByRole('button', { name: 'Search for portrait' }).locator('img')).toHaveCount(1);
      // No picture, and a picture that failed: the row's glyph in the same frame.
      await expect(starter.getByRole('button', { name: /^Midjourney, tool/ }).locator('[data-search-picture="placeholder"] svg')).toHaveCount(1);
      await expect(starter.getByRole('button', { name: /^Seedance 2, model/ }).locator('[data-search-picture="placeholder"]')).toHaveCount(1);
      await expect(starter.getByRole('button', { name: /^Seedance 2, model/ }).locator('img')).toHaveCount(0);
      // Each frame is the same size, picture or none, so the rows line up.
      const frames = await starter.locator('ul').first().locator('[data-search-picture]').evaluateAll(
        (nodes) => nodes.map((node) => `${node.getBoundingClientRect().width}x${node.getBoundingClientRect().height}`),
      );
      expect(new Set(frames).size).toBe(1);
      // Follow on a creator row, beside its link; signed out it is still offered.
      await expect(starter.getByRole('button', { name: 'Follow Luna Studio' })).toBeVisible();
      // Nothing of the start screen is a result the search log counts.
      await expect(starter.locator('[data-search-result]')).toHaveCount(0);
      // Nothing is wider than the screen.
      expect(await overflowing(page)).toEqual([]);
      await shot(page, `${name}-01-start-screen`);

      // Under a search that found nothing, the same pictures under "Try one of these instead".
      await page.goto('/search?q=zzzznope');
      await expect(page.getByText('No results for “zzzznope”')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Ideas to start a search' }).getByRole('heading', { level: 3 }))
        .toHaveText(['Popular this week', 'Creators to follow', 'Popular searches this week']);
      await shot(page, `${name}-02-no-results-start-screen`);
      expect(errors).toEqual([]);
    });

    test(`offers a catalog model nobody has posted with as a way into its creator, and a row's own query (${name})`, async ({ page }) => {
      await page.setViewportSize(size);
      const asked = await answerSearch(page);
      // Posts: the tab whose box offers models and tools (Top draws them live under it).
      await page.goto('/search?type=posts');
      await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible(COLD_PAGE);
      await field(page).click();
      await field(page).fill('sdx');
      const list = page.getByRole('listbox', { name: 'Search suggestions' });
      await expect(list).toBeVisible();
      await expect(list.getByRole('option')).toHaveCount(4);
      await expect(list.getByRole('option', { name: 'Seedance 1.5 Pro, video model, no posts yet. Open the video creator with it' })).toContainText('Video model · Generate with it');
      await expect(list.getByRole('option', { name: /App Only Model/ })).toHaveCount(0);
      // Its name once: a row, never again as a search.
      await expect(list.getByRole('option', { name: 'Search for stability ai' })).toHaveCount(0);
      await expect.poll(() => list.getByRole('option', { name: /^Stability AI/ }).locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
      // A long phrase keeps its end: it wraps to a second line before it is cut.
      const long = list.getByRole('option', { name: /^Search for sdxl portraits of rainy harbours/ }).locator('span.line-clamp-2');
      expect(await long.evaluate((node) => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
      if (name === 'phone') expect(await long.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(24);
      await expect(list).not.toHaveAttribute('aria-busy', 'true');
      await shot(page, `${name}-03-typeahead-catalog-rows`);

      // A row's own query, narrowed to it.
      await list.getByRole('option', { name: /^Stability AI/ }).click();
      await expect(field(page)).toHaveValue('stability ai');
      await expect.poll(() => asked.searches.at(-1)?.toString()).toBe('q=stability+ai&type=posts&madeWith=tool%3Astability-ai&relatedSearches=1&entry=entity');

      // The catalog model: its creator, the model chosen, never an empty Posts page.
      await field(page).fill('sdx');
      await expect(list).toBeVisible();
      await expect(list).not.toHaveAttribute('aria-busy', 'true');
      await list.getByRole('option', { name: /^Seedance 1\.5 Pro/ }).click();
      await page.waitForURL(/\/create-video\?model=seedance-1\.5-pro$/, COLD_PAGE);
      expect(asked.searches.some((params) => params.get('madeWith') === 'model:seedance-1.5-pro')).toBe(false);
    });
  }

  test('the top bar offers the same rows, and opens the creator from them (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await answerSearch(page);
    await page.goto('/contact');
    const bar = page.getByRole('banner').getByRole('combobox', { name: 'Search creators, posts, and recipes' });
    await expect(bar).toBeVisible(COLD_PAGE);
    await bar.click();
    await bar.fill('sdx');
    const list = page.getByRole('listbox', { name: 'Search suggestions' });
    await expect(list.getByRole('option', { name: /^Seedance 1\.5 Pro/ })).toBeVisible();
    await expect(list).not.toHaveAttribute('aria-busy', 'true');
    await shot(page, 'desktop-04-top-bar-typeahead');
    await list.getByRole('option', { name: /^Seedance 1\.5 Pro/ }).click();
    await page.waitForURL(/\/create-video\?model=seedance-1\.5-pro$/, COLD_PAGE);
  });

  // ─── Results ───────────────────────────────────────────────────────────────

  for (const [name, size] of SIZES) {
    test(`draws related searches over the answer, follows from a creator row, and blends a search once it is settled on (${name})`, async ({ page, context }) => {
      await page.setViewportSize(size);
      await signIn(context);
      const errors = pageErrors(page);
      const asked = await answerSearch(page);
      await page.goto('/search?q=harbour+lights');
      const related = page.getByRole('region', { name: 'Related searches' });
      await expect(related).toBeVisible(COLD_PAGE);
      // An address opened as it was: not settled on, so in the word order, and related searches asked for.
      expect(asked.searches[0].toString()).toBe('q=harbour+lights&type=top&relatedSearches=1&entry=link');
      await expect(related.getByRole('button')).toHaveCount(6);
      await expect(related.getByRole('button').first()).toHaveAccessibleName('Search for neon harbour');
      await expect(related.locator('[data-search-result]')).toHaveCount(0);
      // Over the answer's own sections.
      const relatedTop = (await related.boundingBox())!.y;
      expect(relatedTop).toBeLessThan((await page.getByRole('heading', { name: 'Creators', level: 2 }).boundingBox())!.y);
      if (name === 'phone') {
        // One row, scrolled sideways, inside the screen's width.
        const rowTops = await related.getByRole('button').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
        expect(new Set(rowTops).size).toBe(1);
      }
      expect(await overflowing(page)).toEqual([]);
      // Follow beside each creator's link, as the creator page draws it.
      const follow = page.getByRole('button', { name: 'Follow Harbour Studio' });
      await expect(follow).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('button', { name: 'Following Neon Fox' })).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-search-result="creator"]')).toHaveCount(2);
      await expect(page.locator('button[data-search-result]')).toHaveCount(0);
      await shot(page, `${name}-05-results-related-searches`);

      await follow.click();
      await expect(page.getByRole('button', { name: 'Following Harbour Studio' })).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => asked.follows.length).toBe(1);
      expect(asked.follows[0]).toEqual({ body: { followingId: 'creator-harbour', following: true }, authorization: `Bearer ${SESSION.access_token}` });
      // It opened nothing: the same page, and no result told to the search log.
      await expect(page).toHaveURL(/\/search\?q=harbour\+lights$/);
      expect(asked.opened).toEqual([]);
      await page.getByRole('button', { name: 'Following Harbour Studio' }).scrollIntoViewIfNeeded();
      await shot(page, `${name}-06-following`);

      // Enter settles on it: the same search again in the blended order, posts matched by meaning among the rest, unmarked.
      await page.evaluate(() => window.scrollTo(0, 0));
      await field(page).click();
      await field(page).press('Enter');
      await expect.poll(() => asked.searches.at(-1)?.toString()).toBe('q=harbour+lights&type=top&related=1&relatedSearches=1&blend=1&entry=link');
      // Signal tower holds none of the query's words: only the blended order has it.
      await expect(page.getByText('Signal tower')).toBeVisible();
      await expect(page.locator('[data-search-result="post"]')).toHaveCount(8);
      await expect(page.getByText(/meaning/i)).toHaveCount(0);
      await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
      await shot(page, `${name}-07-blended-answer`);

      // A related search pressed: searched as one settled on, entered from the chips.
      await related.getByRole('button', { name: 'Search for neon harbour' }).click();
      await expect(field(page)).toHaveValue('neon harbour');
      await expect.poll(() => asked.searches.at(-1)?.toString()).toBe('q=neon+harbour&type=top&related=1&relatedSearches=1&blend=1&entry=related');
      await expect(page).toHaveURL(/\/search\?q=neon\+harbour$/);
      await expect(related.getByRole('button', { name: 'Search for harbour at night' })).toBeVisible();
      await expect(related.getByRole('button', { name: 'Search for neon harbour' })).toHaveCount(0);
      expect(asked.opened).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test('a visitor’s Follow asks them to sign in, and comes back to the search', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const asked = await answerSearch(page);
    await page.goto('/search?q=harbour+lights');
    const follow = page.getByRole('button', { name: 'Follow Harbour Studio' });
    await expect(follow).toBeVisible(COLD_PAGE);
    // The sign-in page compiles on its first request: asked for now, so the wait below holds only the press.
    await page.request.get('/login', { timeout: 0 });
    await follow.click();
    await page.waitForURL(/\/login\?returnUrl=%2Fsearch%3Fq%3Dharbour%2Blights$/, COLD_PAGE);
    expect(asked.follows).toEqual([]);
    expect(asked.opened).toEqual([]);
  });

  test('draws the pictures at once, without their fade, for a reader who asks for less motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await answerSearch(page);
    await page.goto('/search');
    const row = page.getByRole('region', { name: 'Ideas to start a search' }).getByRole('button', { name: /^Nano Banana Pro, model/ });
    const img = row.locator('img');
    await expect(img).toHaveCount(1, COLD_PAGE);
    expect(await img.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe('none');
    // A press does not scale the row either (Tailwind's `scale-*` is the `scale` property). Read once its
    // ease would have ended, and let go away from the row: no click, so the page stays.
    const pressed = async () => {
      await row.hover();
      await page.mouse.down();
      await page.waitForTimeout(250);
      const scale = await row.evaluate((node) => getComputedStyle(node).scale);
      await page.mouse.move(1, 1);
      await page.mouse.up();
      return scale;
    };
    expect(await pressed()).toBe('none');

    // Without the request: the fade, and the press.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await img.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0.2s');
    expect(await pressed()).toBe('0.985');
    await expect(row).toBeVisible();
  });
});

// ─── A recording of the motion, for a person to look at ──────────────────────

test('records the pictures arriving and a Follow pressed (SEARCH_UI_WEB_SHOTS only)', async ({ browser }) => {
  test.skip(!SHOTS, 'Records only when SEARCH_UI_WEB_SHOTS names a folder.');
  const dir = path.join(SHOTS!, 'recordings');
  for (const motion of ['no-preference', 'reduce'] as const) {
    const context = await browser.newContext({
      baseURL: 'http://127.0.0.1:3100',
      viewport: { width: 1280, height: 800 },
      reducedMotion: motion,
      recordVideo: { dir, size: { width: 1280, height: 800 } },
    });
    // Signed in, so Follow turns to Following where it is (a visitor is sent to sign in).
    await signIn(context);
    const page = await context.newPage();
    await answerSearch(page);
    // Pictures held back, so they arrive after the rows are drawn.
    await page.unroute(`${PICTURE_HOST}/**`);
    await servePictures(page, { delayMs: 900 });
    await page.goto('/search');
    const starter = page.getByRole('region', { name: 'Ideas to start a search' });
    await expect(starter).toBeVisible(COLD_PAGE);
    await page.waitForTimeout(1_800);
    const follow = starter.getByRole('button', { name: 'Follow Luna Studio' });
    await follow.hover();
    await page.mouse.down();
    await page.waitForTimeout(250);
    await page.mouse.up();
    await expect(starter.getByRole('button', { name: 'Following Luna Studio' })).toBeVisible();
    await page.waitForTimeout(800);
    const video = page.video();
    await context.close();
    if (video) fs.renameSync(await video.path(), path.join(dir, `start-screen-${motion}.webm`));
  }
});
