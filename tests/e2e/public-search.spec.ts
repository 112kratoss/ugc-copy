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

// The shared dev server compiles routes on demand, and a page reloads itself
// when another page connects after such a compile (see
// kling-o3-named-subjects.spec.ts for the same behaviour surfacing as aborted
// navigations). A self-reload mid-journey wipes typed input and in-memory
// results, so environmental retries keep this spec stable on a run given several
// workers (`--workers`) without loosening any assertion. The config's one worker,
// in CI and out of it, does not meet it.
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

  test('reads Posts as Top or Latest, keeps the choice in the address, and pages the order it shows', async ({ page }) => {
    const post = (id: string, title: string) => ({
      id,
      title,
      saveCount: 0,
      commentCount: 0,
      creator: { name: 'Luna Studio' },
      mediaItems: [],
      mediaKind: null,
      mediaUrl: null,
    });
    const top = [post('post-saved', 'Most saved portrait'), post('post-new', 'Newest portrait')];
    const latest = [post('post-new', 'Newest portrait'), post('post-saved', 'Most saved portrait')];
    const requests: string[] = [];
    await page.route('**/api/search**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const sort = url.searchParams.get('sort') ?? 'top';
      const cursor = url.searchParams.get('cursor');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...searchResponse(url.searchParams.get('q') ?? '', 'posts'),
          sort,
          creators: emptyPage,
          posts: cursor
            ? { items: [post('post-old', 'Oldest portrait')], nextCursor: null }
            : { items: sort === 'latest' ? latest : top, nextCursor: sort === 'latest' ? 'latest-page-2' : null },
        }),
      });
    });
    const cardTitles = () => page.locator('a[href*="/showcase/"] .font-semibold').allTextContents();

    await page.goto('/search?q=portrait&type=posts');

    // Top is the order a search opens in, and the address does not name it.
    const sorts = page.getByRole('radiogroup', { name: 'Sort posts' });
    await expect(sorts.getByRole('radio', { name: 'Top' })).toBeChecked();
    await expect.poll(cardTitles).toEqual(['Most saved portrait', 'Newest portrait']);
    expect(requests[0]).not.toContain('sort=');

    // Latest asks again, reorders the cards and moves into the address.
    await sorts.getByRole('radio', { name: 'Latest' }).click();
    await expect(sorts.getByRole('radio', { name: 'Latest' })).toBeChecked();
    await expect.poll(cardTitles).toEqual(['Newest portrait', 'Most saved portrait']);
    await expect(page).toHaveURL(/[?&]type=posts&sort=latest$/);
    expect(requests.at(-1)).toContain('sort=latest');

    // The next page is asked for in the order on screen.
    await page.getByRole('button', { name: 'Show more' }).click();
    await expect.poll(cardTitles).toEqual(['Newest portrait', 'Most saved portrait', 'Oldest portrait']);
    expect(requests.at(-1)).toContain('sort=latest');
    expect(requests.at(-1)).toContain('cursor=latest-page-2');

    // A post opened from here is told where to come back to, order included.
    const firstCard = page.locator('a[href*="/showcase/"]').first();
    const returnTo = new URL((await firstCard.getAttribute('href')) ?? '', 'http://127.0.0.1:3100').searchParams.get('returnTo');
    expect(returnTo).toBe('/search?q=portrait&type=posts&sort=latest');

    // The keyboard moves the choice, as in every radio group; back on Top the address drops it.
    await sorts.getByRole('radio', { name: 'Latest' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(sorts.getByRole('radio', { name: 'Top' })).toBeChecked();
    await expect(sorts.getByRole('radio', { name: 'Top' })).toBeFocused();
    await expect.poll(cardTitles).toEqual(['Most saved portrait', 'Newest portrait']);
    await expect(page).toHaveURL(/[?&]type=posts$/);

    // Creators have one order: no control, and nothing about it in the request.
    await page.getByRole('tab', { name: 'Creators' }).click();
    await expect(page).toHaveURL(/type=creators$/);
    await expect(page.getByRole('radiogroup')).toHaveCount(0);
    expect(requests.at(-1)).not.toContain('sort=');
  });

  test('opens a shared Latest link on Latest and comes back to it', async ({ page }) => {
    const requests: string[] = [];
    await page.route('**/api/search**', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...searchResponse(url.searchParams.get('q') ?? '', 'posts'),
          sort: url.searchParams.get('sort') ?? 'top',
          creators: emptyPage,
          posts: {
            items: [{
              id: 'post-new', title: 'Newest portrait', saveCount: 0, commentCount: 0,
              creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
            }],
            nextCursor: null,
          },
        }),
      });
    });

    await page.goto('/search?q=portrait&type=posts&sort=latest');
    const latest = page.getByRole('radiogroup', { name: 'Sort posts' }).getByRole('radio', { name: 'Latest' });
    await expect(latest).toBeChecked();
    await expect(page.getByText('Newest portrait')).toBeVisible();
    expect(requests[0]).toContain('sort=latest');

    // Leaving and pressing Back lands on the same search in the same order.
    await page.goto('/pricing');
    await page.goBack();
    await expect(page).toHaveURL(/[?&]type=posts&sort=latest$/);
    await expect(latest).toBeChecked();
    await expect(page.getByText('Newest portrait')).toBeVisible();
    expect(requests.at(-1)).toContain('sort=latest');
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
