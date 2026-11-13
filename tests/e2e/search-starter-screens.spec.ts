import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

// The search page's starting and ending screens in a browser (search UX audit
// 2026-11-13, findings 2 and 8): the starter under the empty box and under a
// search that found nothing, an empty tab that points at another, the real
// route's answer drawn signed out, and the idle invitation when the route
// cannot answer. Answers are this file's (page.route), but for the case
// that leaves /api/search/starter to the dev server.

const SEARCH_API = (url: URL) => url.pathname === '/api/search';
const SUGGEST_API = (url: URL) => url.pathname === '/api/search/suggest';
const STARTER_API = (url: URL) => url.pathname === '/api/search/starter';
const emptyPage = { items: [], nextCursor: null };
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

// SEARCH_STARTER_SHOTS=<dir> keeps a picture of each state, for a person to look at.
const SHOTS = process.env.SEARCH_STARTER_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const STARTER = {
  entities: [
    { kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro' },
    { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 64, postCountCapped: false, query: 'kling 2.6' },
    { kind: 'tool', key: 'midjourney', label: 'Midjourney', postCount: 14, postCountCapped: false, query: 'midjourney' },
  ],
  creators: [
    { id: 'creator-1', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false },
    { id: 'creator-2', username: 'neon-fox', displayName: 'Neon Fox', bio: null, avatarUrl: null, publicPostCount: 12, isFollowing: false },
  ],
  searches: [{ text: 'portrait' }, { text: 'anime' }, { text: 'cinematic' }, { text: 'product photo' }],
};

const post = (index: number) => ({
  id: `post-${index}`, title: `Nano piece ${index}`, saveCount: 0, commentCount: 0, createdAt: '2026-11-12T10:00:00.000Z',
  creator: { name: 'Luna Studio', username: 'luna-studio' }, mediaKind: 'image', mediaUrl: null,
  mediaItems: [{ id: `m-${index}`, url: '', previewUrl: null, mediaKind: 'image', width: 900, height: 900, sortOrder: 0 }],
});

function searchAnswer(query: string, type: string) {
  const nano = query === 'nano' || query === 'nano banana pro';
  return {
    query, normalizedQuery: query, type, sort: 'top', entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null }, exact: false,
    creators: emptyPage,
    posts: nano && (type === 'top' || type === 'posts') ? { items: Array.from({ length: 12 }, (_, index) => post(index)), nextCursor: null } : emptyPage,
    recipes: emptyPage,
  };
}

/** `starter: null` leaves /api/search/starter to the dev server's own route. */
async function answerSearch(page: Page, { starter = STARTER as unknown }: { starter?: unknown } = {}) {
  const searches: string[] = [];
  const starters: string[] = [];
  await page.route(SEARCH_API, async (route) => {
    const url = new URL(route.request().url());
    searches.push(url.search);
    await route.fulfill(json(searchAnswer(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
  });
  await page.route(SUGGEST_API, (route) => route.fulfill(json({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] })));
  if (starter !== null) {
    await page.route(STARTER_API, async (route) => {
      starters.push(route.request().url());
      await route.fulfill(json(starter));
    });
  }
  return { searches, starters };
}

test.describe.configure({ retries: 2 });

test.describe('search starting and ending screens', () => {
  for (const [name, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const) {
    test(`draws the starter before a search, and its rows lead where they say (${name})`, async ({ page }) => {
      await page.setViewportSize(size);
      const { searches, starters } = await answerSearch(page);
      await page.goto('/search');
      const starter = page.getByRole('region', { name: 'Ideas to start a search' });
      await expect(starter).toBeVisible();
      await expect(starter.getByRole('heading', { level: 2 })).toHaveText(['Popular models and tools', 'Creators to follow', 'Try searching for']);
      await expect(page.getByText('Find creators, posts and recipes')).toHaveCount(0);
      await shot(page, `${name}-01-starter`);
      expect(starters).toHaveLength(1);

      // A model: Posts for its own query, narrowed to it.
      await starter.getByRole('button', { name: /^Nano Banana Pro, model/ }).click();
      await expect(page).toHaveURL(/[?&]q=nano\+banana\+pro&type=posts&madeWith=model%3Anano-banana-pro/);
      await expect(page.getByRole('main').getByRole('combobox')).toHaveValue('nano banana pro');
      await expect(page.getByRole('button', { name: 'Remove filter: made with Nano Banana Pro' })).toBeVisible();
      await expect(page.getByText('Nano piece 11')).toBeVisible();

      // Back to an empty box: the starter again, from the answer the page already has.
      await page.getByRole('button', { name: 'Clear search' }).first().click();
      await page.getByRole('tab', { name: 'Top' }).click();
      await expect(starter).toBeVisible();
      // A suggested search: filled in and searched at once, as Enter does.
      await starter.getByRole('button', { name: 'Search for anime' }).click();
      await expect(page.getByRole('main').getByRole('combobox')).toHaveValue('anime');
      await expect.poll(() => searches.some((search) => search.includes('q=anime&type=top&related=1'))).toBe(true);
      expect(starters).toHaveLength(1);
    });
  }

  test('a creator row opens the profile', async ({ page }) => {
    await answerSearch(page);
    await page.goto('/search');
    const link = page.getByRole('region', { name: 'Ideas to start a search' }).getByRole('link', { name: /Luna Studio's profile/ });
    await expect(link).toHaveAttribute('href', '/creators/luna-studio');
  });

  test('draws the real route’s answer: through the real proxy and /api/search/starter, signed out', async ({ page }) => {
    // The dev server's own route, whose read the server stub answers
    // (tests/e2e/fixtures/search-starter.json): one tool, one creator, one search.
    const { searches } = await answerSearch(page, { starter: null });
    const answered: number[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/api/search/starter') answered.push(response.status());
    });
    await page.goto('/search');
    const starter = page.getByRole('region', { name: 'Ideas to start a search' });
    await expect(starter).toBeVisible({ timeout: 30_000 });
    await expect(starter.getByRole('button', { name: /^E2E Tool, tool, 2 posts/ })).toBeVisible();
    await expect(starter.getByRole('link', { name: /E2E Creator's profile, @e2e-creator/ })).toBeVisible();
    await expect(starter.getByRole('button', { name: 'Search for portrait' })).toBeVisible();
    expect(answered).toEqual([200]);
    expect(searches).toEqual([]);
  });

  for (const [name, reply] of [
    ['a 404 (the route not there)', json({}, 404)],
    ['a failure', json({ error: 'Failed to load search starter.' }, 500)],
    ['the switch off', json({ entities: [], creators: [], searches: [] })],
  ] as const) {
    test(`keeps the idle invitation for ${name}`, async ({ page }) => {
      await answerSearch(page, { starter: null });
      let asked = 0;
      await page.route(STARTER_API, async (route) => {
        asked += 1;
        await route.fulfill(reply);
      });
      await page.goto('/search');
      await expect(page.getByText('Find creators, posts and recipes')).toBeVisible();
      await expect.poll(() => asked).toBe(1);
      await page.waitForTimeout(300);
      await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toHaveCount(0);
      await expect(page.locator('[role="alert"]:not(#__next-route-announcer__)')).toHaveCount(0);
    });
  }

  test('draws "No results" and then the starter for a search that found nothing', async ({ page }) => {
    await answerSearch(page);
    await page.goto('/search?q=zzzznope');
    await expect(page.getByText('No results for “zzzznope”')).toBeVisible();
    const starter = page.getByRole('region', { name: 'Ideas to start a search' });
    await expect(starter.getByRole('heading', { level: 2 })).toHaveText('Try one of these instead');
    await shot(page, 'desktop-02-nothing-found');
  });

  test('an empty tab says what another holds and opens it', async ({ page }) => {
    const { searches } = await answerSearch(page);
    await page.goto('/search?q=nano');
    await expect(page.getByText('Nano piece 11')).toBeVisible();
    await page.getByRole('tab', { name: 'Recipes' }).click();
    await expect(page.getByText('No recipes for “nano”')).toBeVisible();
    await expect(page.getByText('12+ posts match')).toBeVisible();
    await shot(page, 'desktop-03-empty-tab');
    // Read from Top's answer on hand: nothing more was asked.
    expect(searches).toEqual(['?q=nano&type=top', '?q=nano&type=recipes']);
    await page.getByRole('button', { name: 'See posts' }).click();
    await expect(page.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/[?&]type=posts/);
  });

  // Explore's search bar (SearchEntryLink) is not drawn here: Explore's server
  // render reads the feed from Supabase, which the E2E server cannot reach, so
  // the page draws its error card. search-starter-client.test.tsx renders the
  // bar; the PR's record has it at 390 px from a dev server.
});
