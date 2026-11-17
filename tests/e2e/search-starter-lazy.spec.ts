import { expect, test, type Page } from '@playwright/test';

// A page opened on a search asks for the starter after its own search, never beside it, and has it
// in hand when the box is emptied (2026-11-17): a live sweep found /search?q=cat asking
// /api/search/starter beside its search (2.7 s on production, signed in), and the first fix, which
// asked only once the box was emptied, left the page blank under the box meanwhile (review of
// #839; owner, 2026-11-16: a click on a search field shows something). Answers are this file's
// (page.route); the starter's takes two seconds, as it can over a network.

const emptyPage = { items: [], nextCursor: null };
const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const STARTER = {
  entities: [{ kind: 'model', key: 'nano-banana-pro', label: 'Nano Banana Pro', postCount: 200, postCountCapped: true, query: 'nano banana pro' }],
  creators: [{ id: 'creator-1', username: 'luna-studio', displayName: 'Luna Studio', bio: null, avatarUrl: null, publicPostCount: 42, isFollowing: false }],
  searches: [{ text: 'portrait' }, { text: 'anime' }],
};

const post = (index: number) => ({
  id: `post-${index}`, title: `Cat piece ${index}`, saveCount: 0, commentCount: 0, createdAt: '2026-11-12T10:00:00.000Z',
  creator: { name: 'Luna Studio', username: 'luna-studio' }, mediaKind: 'image', mediaUrl: null,
  mediaItems: [{ id: `m-${index}`, url: '', previewUrl: null, mediaKind: 'image', width: 900, height: 900, sortOrder: 0 }],
});

function searchAnswer(query: string, type: string) {
  const found = query === 'cat' && (type === 'top' || type === 'posts');
  return {
    query, normalizedQuery: query, type, sort: 'top', entities: [],
    filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
    correctedQuery: { posts: null, recipes: null }, exact: false,
    creators: emptyPage,
    posts: found ? { items: Array.from({ length: 4 }, (_, index) => post(index)), nextCursor: null } : emptyPage,
    recipes: emptyPage,
  };
}

async function answerSearch(page: Page, { starterDelayMs = 0 }: { starterDelayMs?: number } = {}) {
  const searches: string[] = [];
  const starters: string[] = [];
  // When each request reached the browser's router, and when the search was answered.
  const asked: Array<{ kind: 'search' | 'starter' | 'search answered'; at: number }> = [];
  await page.route((url) => url.pathname === '/api/search', async (route) => {
    const url = new URL(route.request().url());
    searches.push(url.search);
    asked.push({ kind: 'search', at: Date.now() });
    await route.fulfill(json(searchAnswer(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
    asked.push({ kind: 'search answered', at: Date.now() });
  });
  await page.route((url) => url.pathname === '/api/search/suggest', (route) => route.fulfill(json({
    query: '', normalizedQuery: '', creators: [], entities: [], completions: [],
  })));
  await page.route((url) => url.pathname === '/api/search/starter', async (route) => {
    starters.push(route.request().url());
    asked.push({ kind: 'starter', at: Date.now() });
    if (starterDelayMs) await new Promise((resolve) => setTimeout(resolve, starterDelayMs));
    await route.fulfill(json(STARTER));
  });
  return { searches, starters, asked };
}

test.describe.configure({ retries: 2 });

test.describe('the search starter comes after the search, never beside it', () => {
  test('a page opened on a search asks for the starter after its answer, and shows it at once when the box is emptied', async ({ page }) => {
    const { starters, asked } = await answerSearch(page, { starterDelayMs: 2_000 });
    const starterAnswered = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/search/starter');
    await page.goto('/search?q=cat');
    await expect(page.getByText('Cat piece 3')).toBeVisible();
    // Asked once, and only after the search was answered: never beside it.
    await expect.poll(() => starters.length).toBe(1);
    const searchAnsweredAt = asked.find((entry) => entry.kind === 'search answered')!.at;
    const starterAskedAt = asked.find((entry) => entry.kind === 'starter')!.at;
    expect(starterAskedAt).toBeGreaterThanOrEqual(searchAnsweredAt);
    // Nothing of it over the results.
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toHaveCount(0);

    // The person reads the results while the slow starter comes in, then empties the box: the
    // starter is there at once, with no request of its own and no blank wait.
    await starterAnswered;
    await page.getByRole('button', { name: 'Clear search' }).first().click();
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible({ timeout: 500 });
    await expect(page.getByText('Find creators, posts and recipes')).toHaveCount(0);
    expect(starters).toHaveLength(1);
  });

  test('a page opened on a search that finds nothing asks for it, and draws it under the verdict', async ({ page }) => {
    const { starters } = await answerSearch(page);
    await page.goto('/search?q=zzzznope');
    await expect(page.getByText('No results for “zzzznope”')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible();
    expect(starters).toHaveLength(1);
  });

  test('an empty search page asks for it as it opens, as before', async ({ page }) => {
    const { searches, starters } = await answerSearch(page);
    await page.goto('/search');
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible();
    expect(starters).toHaveLength(1);
    expect(searches).toEqual([]);
  });
});
