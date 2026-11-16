import { expect, test, type Page } from '@playwright/test';

// A page opened on a search asks for the starter only where it draws it (2026-11-17): a live
// sweep found /search?q=cat asking /api/search/starter beside its own search (2.7 s on production,
// signed in) for an answer it drew nowhere. Answers are this file's (page.route).

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

async function answerSearch(page: Page) {
  const searches: string[] = [];
  const starters: string[] = [];
  await page.route((url) => url.pathname === '/api/search', async (route) => {
    const url = new URL(route.request().url());
    searches.push(url.search);
    await route.fulfill(json(searchAnswer(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')));
  });
  await page.route((url) => url.pathname === '/api/search/suggest', (route) => route.fulfill(json({
    query: '', normalizedQuery: '', creators: [], entities: [], completions: [],
  })));
  await page.route((url) => url.pathname === '/api/search/starter', async (route) => {
    starters.push(route.request().url());
    await route.fulfill(json(STARTER));
  });
  return { searches, starters };
}

test.describe.configure({ retries: 2 });

test.describe('the search starter is asked for where it is drawn', () => {
  test('a page opened on a search that finds something asks for none, and asks once the box is emptied', async ({ page }) => {
    const { searches, starters } = await answerSearch(page);
    await page.goto('/search?q=cat');
    await expect(page.getByText('Cat piece 3')).toBeVisible();
    // The old page asked for it as it mounted, beside the search: by now it would have.
    await page.waitForTimeout(1_000);
    expect(searches.length).toBeGreaterThan(0);
    expect(starters).toEqual([]);
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Clear search' }).first().click();
    await expect(page.getByRole('region', { name: 'Ideas to start a search' })).toBeVisible();
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
