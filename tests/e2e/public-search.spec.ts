import { expect, test } from '@playwright/test';

const emptyPage = { items: [], nextCursor: null };

function searchResponse(query: string, type: string) {
  return {
    query,
    normalizedQuery: query,
    type,
    creators: {
      items: [{
        id: 'creator-1',
        username: 'luna-studio',
        displayName: 'Luna Studio',
        bio: 'Cinematic product artist',
        avatarUrl: null,
        publicPostCount: 3,
        isFollowing: false,
      }],
      nextCursor: null,
    },
    posts: emptyPage,
    recipes: emptyPage,
  };
}

// The shared dev server compiles routes on demand and full-reloads connected
// pages when Fast Refresh cannot hot-apply (see kling-o3-named-subjects.spec.ts
// for the same behaviour surfacing as aborted navigations). A self-reload
// mid-journey wipes typed input and in-memory results, so environmental
// retries keep this spec stable without loosening any assertion.
test.describe.configure({ retries: 2 });

test.describe('public search', () => {
  test('searches from the shareable URL, switches tabs, and shows the zero state', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/search**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const query = url.searchParams.get('q') ?? '';
      const type = url.searchParams.get('type') ?? 'top';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          query === 'zzzznope'
            ? { ...searchResponse(query, type), creators: emptyPage }
            : searchResponse(query, type),
        ),
      });
    });

    await page.goto('/search?q=luna');

    // The shareable URL runs its query after hydration and renders results.
    await expect(page.getByText('Luna Studio')).toBeVisible();
    // The app shell mounts a toast viewport with role="status" too, so target
    // the search page's own summary element.
    await expect(page.locator('p[role="status"]')).toContainText('1 result for luna');
    expect(requests[0]).toContain('q=luna');
    expect(requests[0]).toContain('type=top');

    // Entity tabs re-query for that section only and update the URL.
    await page.getByRole('tab', { name: 'Creators' }).click();
    await expect
      .poll(() => requests.some((search) => search.includes('type=creators')))
      .toBe(true);
    await expect(page).toHaveURL(/type=creators/);

    // A query with no matches lands on the explicit zero state.
    const field = page.getByRole('searchbox');
    await field.fill('zzzznope');
    await expect(page.getByText('No results for “zzzznope”')).toBeVisible();

    // Escape clears back to the initial guidance state.
    await field.press('Escape');
    await expect(page.getByText('Start with a creator or idea')).toBeVisible();
  });

  test('keeps two-character queries on creator search only', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/search**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResponse(url.searchParams.get('q') ?? '', 'creators')),
      });
    });

    await page.goto('/search?q=lu&type=posts');

    // The page coerces a two-character content search onto Creators and
    // disables the content tabs until a third character arrives.
    await expect(page.getByRole('tab', { name: 'Creators' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Posts' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Recipes' })).toBeDisabled();
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    expect(requests.every((search) => search.includes('type=creators'))).toBe(true);
  });
});
