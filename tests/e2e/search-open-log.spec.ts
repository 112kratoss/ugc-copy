import { expect, test } from '@playwright/test';

// What the search page tells the search log (ugc-mobile/lib/public-search-policy/search-open-log.ts):
// how each search was entered (`entry` on /api/search) and which result was opened from it
// (POST /api/search/opened), without getting in the way of the press that opens the result.

const SEARCH_API = (url: URL) => url.pathname === '/api/search';
const SUGGEST_API = (url: URL) => url.pathname === '/api/search/suggest';
const STARTER_API = (url: URL) => url.pathname === '/api/search/starter';
const OPENED_API = (url: URL) => url.pathname === '/api/search/opened';

const CREATOR_ID = '0b9e0000-0000-4000-8000-000000000002';
const POST_IDS = [
  '0b9e1000-0000-4000-8000-000000000011',
  '0b9e1000-0000-4000-8000-000000000012',
  '0b9e1000-0000-4000-8000-000000000013',
];
const MODEL = { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 14, postCountCapped: false };
const NO_FILTERS = { madeWith: null, mediaKind: null, hasRecipe: false, following: false };

function answer(query: string, type: string, filters = NO_FILTERS) {
  return {
    query,
    normalizedQuery: query,
    type,
    sort: 'top',
    entities: type === 'top' ? [MODEL] : [],
    filters,
    correctedQuery: { posts: null, recipes: null },
    exact: false,
    creators: {
      items: type === 'posts' ? [] : [{
        id: CREATOR_ID, username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 3, isFollowing: false,
      }],
      nextCursor: null,
    },
    posts: {
      items: POST_IDS.map((id, index) => ({
        id, title: `${query} piece ${index + 1}`, saveCount: 0, commentCount: 0, creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
      })),
      nextCursor: null,
    },
    recipes: { items: [], nextCursor: null },
  };
}

// As public-search.spec.ts: a page that reloads itself after another page's compile loses what
// was typed, on a run given several workers. The config's one worker does not meet it.
test.describe.configure({ retries: 2 });

test.describe('the search log', () => {
  test('says how each search was entered and which result was opened, and the press still opens it', async ({ page }) => {
    const searches: URLSearchParams[] = [];
    const opened: unknown[] = [];
    await page.route(SUGGEST_API, (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ query: '', normalizedQuery: '', creators: [], entities: [], completions: [] }),
    }));
    await page.route(STARTER_API, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ entities: [], creators: [], searches: [] }),
    }));
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      searches.push(url.searchParams);
      const madeWith = url.searchParams.get('madeWith');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(answer(
          url.searchParams.get('q') ?? '',
          url.searchParams.get('type') ?? 'top',
          madeWith ? { ...NO_FILTERS, madeWith: MODEL } as never : NO_FILTERS,
        )),
      });
    });
    const openedContentTypes: Array<string | undefined> = [];
    await page.route(OPENED_API, async (route) => {
      opened.push({ method: route.request().method(), body: route.request().postDataJSON() });
      openedContentTypes.push(route.request().headers()['content-type']);
      await route.fulfill({ status: 204 });
    });

    // Opened on an address: a link.
    await page.goto('/search?q=harbour');
    await expect(page.getByRole('link', { name: /harbour piece 1/ })).toBeVisible();
    expect(searches.at(-1)?.get('entry')).toBe('link');

    // Typed into the box: typed. A tab changes nothing of how the query was entered.
    const box = page.getByRole('combobox');
    await box.fill('harbour light');
    await expect(page.getByRole('link', { name: /harbour light piece 1/ })).toBeVisible();
    expect(searches.at(-1)?.get('q')).toBe('harbour light');
    expect(searches.at(-1)?.get('entry')).toBe('typed');
    expect(opened).toEqual([]);

    // A model among the results is an opened result too, at its place among them, and narrows
    // Posts to it for the same query under the same entry.
    await page.getByRole('button', { name: /Kling 2\.6/ }).first().click();
    await expect.poll(() => opened).toEqual([{
      method: 'POST',
      body: { q: 'harbour light', type: 'top', sort: 'top', entry: 'typed', kind: 'entity', id: 'model:kling-2.6', position: 1 },
    }]);
    await expect.poll(() => searches.at(-1)?.get('madeWith')).toBe('model:kling-2.6');
    expect(searches.at(-1)?.get('type')).toBe('posts');
    expect(searches.at(-1)?.get('entry')).toBe('typed');

    // The second post, pressed on Posts: its place in that list, and the press opens the post.
    await page.getByRole('link', { name: /harbour light piece 2/ }).click();
    await expect.poll(() => opened.at(-1)).toEqual({
      method: 'POST',
      body: { q: 'harbour light', type: 'posts', sort: 'top', entry: 'typed', kind: 'post', id: POST_IDS[1], position: 2 },
    });
    await expect(page).toHaveURL((url) => url.pathname === `/showcase/${POST_IDS[1]}`, { timeout: 60_000 });
    expect(opened).toHaveLength(2);

    // Back: the search as it was left, in the box and the address (the page's own address
    // writes are untouched), and nothing was asked or reported again.
    const asked = searches.length;
    await page.goBack();
    await expect(page.getByRole('combobox')).toHaveValue('harbour light');
    await expect(page).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === 'harbour light');
    await expect(page.getByRole('link', { name: /harbour light piece 2/ })).toBeVisible();
    await page.waitForTimeout(500);
    expect(searches.slice(asked)).toEqual([]);
    expect(opened).toHaveLength(2);
    // The route reads a JSON request only: the page says so on every report.
    expect(openedContentTypes).toEqual(['application/json', 'application/json']);
  });

  // Through the real proxy and the real route. The dev server's Supabase stub answers the route's
  // three calls (tests/e2e/support/supabase-server-stub.cjs): the rate limit, the day's visitor
  // key and the insert. What this shows: a visitor is admitted; a well-formed report is counted
  // and answered 204 with no body whatever its id names (the address the stub's limit refuses
  // gets a 429, which the "limit could not be counted" branch never answers, so the 204s came
  // through the count); and a malformed one is a 400. What it cannot show is the row: the insert
  // runs behind the answer, on the server. search-opened-route-adapter-service.test.ts holds the
  // row, and search_open_log.test.sql what the table takes.
  test('the real route counts a report and answers 204 whatever its id names, 429 past its limit, 400 to a malformed one', async ({ page }) => {
    const origin = 'http://127.0.0.1:3100';
    const report = { q: 'harbour', type: 'top', sort: 'top', entry: 'typed', kind: 'post', position: 1 };
    // Two ids nothing in the placeholder project could hold: the same answer for both.
    for (const id of ['00000000-0000-4000-8000-000000000000', POST_IDS[0]]) {
      const response = await page.request.post('/api/search/opened', {
        headers: { Origin: origin }, data: { ...report, id }, timeout: 0,
      });
      expect(response.status(), id).toBe(204);
      expect(await response.text(), id).toBe('');
      expect(response.headers()['cache-control'], id).toBe('private, no-store');
    }

    // The same report from the address whose share the stub says is spent: refused by the count.
    const limited = await page.request.post('/api/search/opened', {
      headers: { Origin: origin, 'x-vercel-forwarded-for': '203.0.113.77' }, data: { ...report, id: POST_IDS[0] }, timeout: 0,
    });
    expect(limited.status()).toBe(429);
    expect(limited.headers()['retry-after']).toBe('30');

    const malformed = await page.request.post('/api/search/opened', {
      headers: { Origin: origin }, data: { ...report, id: 'luna-studio' }, timeout: 0,
    });
    expect(malformed.status()).toBe(400);
    // A well-formed report that is not sent as JSON (what another site's page can send without
    // asking): refused before anything is read.
    const notJson = await page.request.post('/api/search/opened', {
      headers: { Origin: origin, 'Content-Type': 'text/plain;charset=UTF-8' },
      data: JSON.stringify({ ...report, id: POST_IDS[0] }),
      timeout: 0,
    });
    expect(notJson.status()).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'Content-Type must be application/json.' });

    const unknownEntry = await page.request.get('/api/search?q=harbour&entry=voice', { headers: { Origin: origin }, timeout: 0 });
    expect(unknownEntry.status()).toBe(400);
  });
});
