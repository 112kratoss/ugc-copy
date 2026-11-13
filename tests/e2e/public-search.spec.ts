import { expect, test } from '@playwright/test';

const emptyPage = { items: [], nextCursor: null };

// /api/search alone: the typeahead's /api/search/suggest (search-typeahead.spec.ts) is answered
// apart, with nothing to offer, so each test's `requests` holds the searches and only the searches.
const SEARCH_API = (url: URL) => url.pathname === '/api/search';
const SUGGEST_API = (url: URL) => url.pathname === '/api/search/suggest';
const NO_SUGGESTIONS = { query: '', normalizedQuery: '', creators: [], entities: [], completions: [] };

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
  test.beforeEach(async ({ page }) => {
    await page.route(SUGGEST_API, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(NO_SUGGESTIONS),
    }));
  });

  test('searches from the shareable URL, switches tabs, and shows the zero state', async ({ page }) => {
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
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
    // The title names the search, so history and tabs tell searches apart.
    await expect(page).toHaveTitle('luna · Search | Magic Booklet');
    expect(requests[0]).toContain('q=luna');
    expect(requests[0]).toContain('type=top');

    // Entity tabs re-query for that section only and update the URL.
    await page.getByRole('tab', { name: 'Creators' }).click();
    await expect
      .poll(() => requests.some((search) => search.includes('type=creators')))
      .toBe(true);
    await expect(page).toHaveURL(/type=creators/);

    // A query with no matches lands on the explicit zero state.
    const field = page.getByRole('combobox');
    // Plain "Search" in every field, the app's included: no product name.
    await expect(field).toHaveAttribute('placeholder', 'Search');
    await field.fill('zzzznope');
    await expect(page.getByText('No results for “zzzznope”')).toBeVisible();

    // Escape clears back to the idle invitation.
    await field.press('Escape');
    await expect(page.getByText('Find creators, posts and recipes')).toBeVisible();
  });

  test('reads Posts as Best match or Latest, keeps the choice in the address, and pages the order it shows', async ({ page }) => {
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
    await page.route(SEARCH_API, async (route) => {
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

    // Best match is the order a search opens in, and the address does not name it.
    const sorts = page.getByRole('radiogroup', { name: 'Sort posts' });
    await expect(sorts.getByRole('radio', { name: 'Best match' })).toBeChecked();
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

    // The keyboard moves the choice, as in every radio group; back on Best match the address drops it.
    await sorts.getByRole('radio', { name: 'Latest' }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(sorts.getByRole('radio', { name: 'Best match' })).toBeChecked();
    await expect(sorts.getByRole('radio', { name: 'Best match' })).toBeFocused();
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
    await page.route(SEARCH_API, async (route) => {
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

  test('offers a model as a result, narrows Posts by it and by the filter switches, and keeps it all in the address', async ({ page }) => {
    const post = (id: string, title: string) => ({
      id, title, saveCount: 0, commentCount: 0, creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
    });
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const type = url.searchParams.get('type') ?? 'top';
      const madeWith = url.searchParams.get('madeWith');
      const kind = url.searchParams.get('kind');
      const recipe = url.searchParams.get('recipe') === '1';
      const base = { ...searchResponse(url.searchParams.get('q') ?? '', type), sort: 'top', correctedQuery: { posts: null, recipes: null }, exact: false };
      const body = type === 'top'
        ? {
          ...base,
          entities: [
            { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 14, postCountCapped: false },
            { kind: 'tool', key: 'klingon-fx', label: 'Klingon FX', postCount: 1000, postCountCapped: true },
          ],
          filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
        }
        : {
          ...base,
          entities: [],
          creators: emptyPage,
          filters: {
            madeWith: madeWith ? { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6' } : null,
            mediaKind: kind,
            hasRecipe: recipe,
            following: false,
          },
          posts: {
            items: recipe
              ? []
              : kind === 'video'
                ? [post('post-video', 'Kling harbor clip')]
                : [post('post-video', 'Kling harbor clip'), post('post-image', 'Kling harbor still')],
            nextCursor: null,
          },
        };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    const cardTitles = () => page.locator('a[href*="/showcase/"] .font-semibold').allTextContents();

    await page.goto('/search?q=kling');

    // The Top tab names the models and tools the query holds, each with its posts.
    const entities = page.getByRole('region', { name: 'Models and tools' });
    await expect(entities.getByRole('button')).toHaveText(['Kling 2.6Model · 14 posts', 'Klingon FXTool · 1,000+ posts']);

    // Pressing one opens Posts narrowed to it, named on its chip, and the address says so.
    await entities.getByRole('button', { name: /^Kling 2\.6, model, 14 posts/ }).click();
    await expect(page.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    const filters = page.getByRole('group', { name: 'Filter posts' });
    const madeWith = filters.getByRole('button', { name: 'Remove filter: made with Kling 2.6' });
    await expect(madeWith).toHaveAttribute('aria-pressed', 'true');
    await expect(madeWith).toHaveText('Made with Kling 2.6');
    await expect(page).toHaveURL(/[?&]type=posts&madeWith=model%3Akling-2\.6$/);
    expect(requests.at(-1)).toContain('madeWith=model%3Akling-2.6');
    await expect.poll(cardTitles).toEqual(['Kling harbor clip', 'Kling harbor still']);

    // The switches are toggle buttons: a visitor is offered three, none pressed.
    await expect(filters.getByRole('button', { name: 'Following' })).toHaveCount(0);
    const videos = filters.getByRole('button', { name: 'Videos' });
    await expect(videos).toHaveAttribute('aria-pressed', 'false');
    // From the keyboard, as any button.
    await videos.focus();
    await page.keyboard.press('Enter');
    await expect(videos).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]madeWith=model%3Akling-2\.6&kind=video$/);
    await expect.poll(cardTitles).toEqual(['Kling harbor clip']);

    // A post opened from here is told where to come back to, filters included.
    const returnTo = new URL((await page.locator('a[href*="/showcase/"]').first().getAttribute('href')) ?? '', 'http://127.0.0.1:3100').searchParams.get('returnTo');
    expect(returnTo).toBe('/search?q=kling&type=posts&madeWith=model%3Akling-2.6&kind=video');

    // Filters no post passes: the switches stay, so one can be removed.
    await filters.getByRole('button', { name: 'Has recipe' }).click();
    await expect(page.getByText('No post matches these filters. Remove one, or clear them all.')).toBeVisible();
    await expect(page).toHaveURL(/[?&]kind=video&recipe=1$/);
    await filters.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/[?&]type=posts$/);
    await expect(filters.getByRole('button', { name: /made with/i })).toHaveCount(0);
    await expect.poll(cardTitles).toEqual(['Kling harbor clip', 'Kling harbor still']);
    expect(requests.at(-1)).not.toMatch(/madeWith|kind=|recipe=/);
  });

  test('opens a shared filtered link filtered and comes back to it', async ({ page }) => {
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...searchResponse(url.searchParams.get('q') ?? '', 'posts'),
          sort: 'top',
          entities: [],
          correctedQuery: { posts: null, recipes: null },
          exact: false,
          creators: emptyPage,
          filters: { madeWith: { kind: 'model', key: 'kling-2.6', label: 'Kling 2.6' }, mediaKind: 'video', hasRecipe: false, following: false },
          posts: {
            items: [{
              id: 'post-video', title: 'Kling harbor clip', saveCount: 0, commentCount: 0,
              creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
            }],
            nextCursor: null,
          },
        }),
      });
    });

    await page.goto('/search?q=harbor&type=posts&madeWith=model%3Akling-2.6&kind=video');
    const filters = page.getByRole('group', { name: 'Filter posts' });
    // Named by the answer: the address holds only the entity's key.
    await expect(filters.getByRole('button', { name: 'Remove filter: made with Kling 2.6' })).toBeVisible();
    await expect(filters.getByRole('button', { name: 'Videos' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Kling harbor clip')).toBeVisible();
    expect(requests[0]).toContain('madeWith=model%3Akling-2.6');
    expect(requests[0]).toContain('kind=video');

    await page.goto('/pricing');
    await page.goBack();
    await expect(page).toHaveURL(/[?&]type=posts&madeWith=model%3Akling-2\.6&kind=video$/);
    await expect(filters.getByRole('button', { name: 'Videos' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Kling harbor clip')).toBeVisible();
  });

  test('reads a shared link’s "following" for a visitor as not there, and offers no entity for two characters', async ({ page }) => {
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const type = url.searchParams.get('type') ?? 'top';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...searchResponse(url.searchParams.get('q') ?? '', type),
          sort: 'top',
          // Whatever a server sends: the page draws an entity only where Posts can be searched.
          entities: [{ kind: 'model', key: 'kling-2.6', label: 'Kling 2.6', postCount: 14, postCountCapped: false }],
          filters: { madeWith: null, mediaKind: url.searchParams.get('kind'), hasRecipe: false, following: false },
          correctedQuery: { posts: null, recipes: null },
          exact: false,
          creators: type === 'posts' ? emptyPage : searchResponse('', type).creators,
        }),
      });
    });

    // A link an account shared, opened signed out: the filter a visitor cannot have is dropped.
    await page.goto('/search?q=portrait&type=posts&kind=video&following=1');
    const filters = page.getByRole('group', { name: 'Filter posts' });
    await expect(filters.getByRole('button', { name: 'Videos' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page).toHaveURL(/[?&]type=posts&kind=video$/);
    await expect(filters.getByRole('button', { name: 'Following' })).toHaveCount(0);
    expect(requests.every((search) => !search.includes('following'))).toBe(true);

    // With only that filter, nothing is left to clear.
    await page.goto('/search?q=portrait&type=posts&following=1');
    await expect(page).toHaveURL(/[?&]type=posts$/);
    await expect(page.getByText('No results for “portrait”')).toBeVisible();
    await expect(filters.getByRole('button', { name: 'Clear filters' })).toHaveCount(0);
    await expect(page.getByText('No post matches these filters. Remove one, or clear them all.')).toHaveCount(0);

    // Two characters search creators alone: no model or tool to press into a Posts search that cannot run.
    await page.goto('/search?q=kl');
    await expect(page.getByText('Luna Studio')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Models and tools' })).toHaveCount(0);
    await page.getByRole('combobox').fill('kli');
    await expect(page.getByRole('region', { name: 'Models and tools' })).toBeVisible();
  });

  test('says when it read the query as something else, and searches for it as typed on request', async ({ page }) => {
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const exact = url.searchParams.get('exact') === '1';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...searchResponse(url.searchParams.get('q') ?? '', 'posts'),
          sort: 'top',
          entities: [],
          filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
          creators: emptyPage,
          correctedQuery: { posts: exact ? null : 'portrait', recipes: null },
          exact,
          posts: {
            items: exact ? [] : [{
              id: 'post-portrait', title: 'Harbor portrait', saveCount: 0, commentCount: 0,
              creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
            }],
            nextCursor: null,
          },
        }),
      });
    });

    await page.goto('/search?q=portriat&type=posts');
    // The line on the page; the live region below says it too, with the count.
    const notice = page.getByText('Showing results for “portrait”', { exact: true });
    await expect(notice).toBeVisible();
    await expect(page.getByText('Harbor portrait')).toBeVisible();
    // Announced with the count, in the page's one live region.
    await expect(page.locator('p[role="status"]')).toContainText('Showing results for “portrait”. 1 result for portriat');

    await page.getByRole('button', { name: 'Search instead for “portriat”' }).click();
    await expect(page).toHaveURL(/[?&]type=posts&exact=1$/);
    expect(requests.at(-1)).toContain('exact=1');
    await expect(page.getByText('Showing results for “portriat” as typed', { exact: true })).toBeVisible();
    await expect(page.getByText('No results for “portriat”')).toBeVisible();
    await expect(notice).toHaveCount(0);

    // And back to the suggested spelling.
    await page.getByRole('button', { name: 'Use suggested spelling' }).click();
    await expect(page).toHaveURL(/[?&]type=posts$/);
    await expect(page.getByText('Harbor portrait')).toBeVisible();
    await expect(notice).toBeVisible();
  });

  test('keeps recent searches in this browser and offers them when the empty box is focused', async ({ page }) => {
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')),
      });
    });

    await page.goto('/search?q=luna');
    await expect(page.getByText('Luna Studio')).toBeVisible();
    const field = page.getByRole('combobox');
    // Enter commits the search: it found something, so it is kept.
    await field.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('magicbooklet:public-search-history:v1')))
      .toBe('["luna"]');

    // A second search, kept by opening a result of it.
    await field.fill('luna studio');
    await expect(page).toHaveURL(/q=luna\+studio/);
    await expect(page.locator('p[role="status"]')).toContainText('1 result for luna studio');
    await page.evaluate(() => {
      // The card is a link to the creator's page: keep the search page for the rest of the test.
      document.querySelector('a[href^="/creators/"]')?.addEventListener('click', (event) => event.preventDefault());
    });
    await page.getByRole('link', { name: /Luna Studio/ }).click();
    // "luna" was a step on the way to "luna studio": one entry, the longer one.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('magicbooklet:public-search-history:v1')))
      .toBe('["luna studio"]');
    // Committed before its answer: kept once the answer finds something.
    await field.fill('luna');
    await field.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('magicbooklet:public-search-history:v1')))
      .toBe('["luna","luna studio"]');

    // Emptied, the focused box offers them, newest first.
    await field.press('Escape');
    await field.focus();
    const recents = page.getByRole('list', { name: 'Recent searches' });
    await expect(recents.getByRole('listitem')).toHaveText(['luna', 'luna studio']);

    // One is removed, and the removal is kept.
    await page.getByRole('button', { name: 'Remove luna studio from recent searches' }).click();
    await expect(recents.getByRole('listitem')).toHaveText(['luna']);
    // The box keeps the focus through a press on the list.
    await expect(field).toBeFocused();

    // Pressing one searches for it again.
    await page.getByRole('button', { name: 'Search again for luna' }).click();
    await expect(field).toHaveValue('luna');
    await expect(page.getByText('Luna Studio')).toBeVisible();
    await expect(recents).toHaveCount(0);

    // They survive a new visit. An empty search focuses its box before the
    // page's script runs, and the list is there without another press.
    await page.goto('/search');
    await expect(field).toBeFocused();
    await expect(recents.getByRole('listitem')).toHaveText(['luna']);
    await page.getByRole('button', { name: 'Clear all recent searches' }).click();
    await expect(recents).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem('magicbooklet:public-search-history:v1'))).toBeNull();
    await expect(page.getByText('Find creators, posts and recipes')).toBeVisible();
  });

  test('keeps a two-character query on its tab: Posts waits, idle and undimmed, for a third character', async ({ page }) => {
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top')),
      });
    });

    await page.goto('/search?q=lu&type=posts');

    // No tab is dimmed or switched for another: Posts stays chosen and shows
    // the idle invitation, asking nothing until a third character.
    await expect(page.getByRole('tab', { name: 'Posts' })).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Top', 'Creators', 'Posts', 'Recipes']) await expect(page.getByRole('tab', { name })).toBeEnabled();
    await expect(page.getByText('Find creators, posts and recipes')).toBeVisible();
    await expect(page.getByText(/No results/)).toHaveCount(0);

    // Top searches creators from two characters.
    await page.getByRole('tab', { name: 'Top' }).click();
    await expect(page.getByText('Luna Studio')).toBeVisible();
    expect(requests.every((search) => search.includes('type=top'))).toBe(true);
  });

  test('never says "No results" for two characters: a creator search that finds none leaves the idle state', async ({ page }) => {
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const query = url.searchParams.get('q') ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...searchResponse(query, url.searchParams.get('type') ?? 'top'), creators: emptyPage }),
      });
    });

    await page.goto('/search?q=na');
    await expect.poll(() => requests.length).toBeGreaterThan(0);
    // The answer has landed: the results are no longer busy.
    await expect(page.locator('[aria-busy="false"]')).toHaveCount(1);
    await expect(page.getByText('Find creators, posts and recipes')).toBeVisible();
    // The live region gives no verdict on half a word either (review of #784).
    await expect(page.locator('p[role="status"]')).toHaveText('');
    await expect(page.getByText(/No results/)).toHaveCount(0);

    // From three characters a search that finds nothing says so.
    await page.getByRole('combobox').fill('nax');
    await expect(page.getByText('No results for “nax”')).toBeVisible();
  });

  // The page writes its address behind Next's back (search-address.ts), so
  // Next holds the address the page was first opened at. A link to the search
  // page drawn on the search page would therefore do the wrong thing: one to
  // that first address is, to Next, a press on where it already is. The shell
  // draws none there today (the bar's search link gives way to the page's own
  // box, and no group of the side navigation or the drawer lists Search). If
  // this fails, such a link has been added: make it start the search over in
  // the page itself before it ships.
  for (const viewer of ['a visitor', 'an account'] as const) {
    test(`draws no link to the search page on the search page, for ${viewer}`, async ({ page, context }) => {
      if (viewer === 'an account') {
        await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
      }
      await page.route(SEARCH_API, (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchResponse('luna', 'top')),
      }));
      const linksToSearch = () => page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
        // The skip link is a fragment of the page, not a navigation to it.
        .filter((link) => new URL(link.href).pathname === '/search' && !link.getAttribute('href')?.startsWith('#'))
        .map((link) => link.getAttribute('href')));
      for (const width of [1440, 900, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/search?q=luna');
        await expect(page.getByText('Luna Studio')).toBeVisible();
        expect(await linksToSearch(), `at ${width}px`).toEqual([]);
        const menu = page.getByRole('button', { name: /^Open navigation/ });
        if (await menu.isVisible()) {
          await menu.click();
          await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible();
          expect(await linksToSearch(), `at ${width}px, the drawer open`).toEqual([]);
        }
      }
    });
  }

  test('asks for related posts only for a search left alone or settled on, and draws them under its own results', async ({ page }) => {
    // Each new query asked about with related=1 spends one of the viewer's
    // forty a day, so the page never asks at a step of the typing. The page's
    // clock is the test's: a second and a half passes when the test says so.
    await page.clock.install();
    const card = (id: string, title: string) => ({
      id, title, saveCount: 0, commentCount: 0, creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
    });
    const requests: string[] = [];
    await page.route(SEARCH_API, async (route) => {
      const url = new URL(route.request().url());
      requests.push(url.search);
      const query = url.searchParams.get('q') ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...searchResponse(query, url.searchParams.get('type') ?? 'top'),
          sort: 'top',
          creators: emptyPage,
          posts: { items: query === 'ocean at dusk' ? [card('own-1', 'Ocean at dusk, long exposure')] : [], nextCursor: null },
          // The server looks for them only when asked.
          ...(url.searchParams.get('related') === '1'
            ? { related: { posts: [card('related-1', 'Sea after sunset'), card('related-2', 'Cliffs in mist')] } }
            : {}),
        }),
      });
    });
    await page.goto('/search');
    const box = page.getByRole('combobox');
    await expect(page.getByText('Find creators, posts and recipes')).toBeVisible();
    const related = page.getByRole('region', { name: 'Related posts' });
    const status = page.locator('p[role="status"]');

    // Typed and left: the search is asked without the parameter, and its answer drawn.
    await page.clock.pauseAt(new Date(Date.now() + 5_000));
    await box.fill('ocean at dusk');
    await page.clock.runFor(300);
    await expect(page.getByRole('link', { name: /Ocean at dusk, long exposure/ })).toBeVisible();
    expect(requests).toEqual(['?q=ocean+at+dusk&type=top']);
    await expect(related).toHaveCount(0);
    // Not while the answer has stood for less than the settle time.
    await page.clock.runFor(1_499);
    expect(requests).toHaveLength(1);
    await page.clock.runFor(1);
    await expect(related.getByRole('link')).toHaveText([/Sea after sunset/, /Cliffs in mist/]);
    expect(requests).toEqual(['?q=ocean+at+dusk&type=top', '?q=ocean+at+dusk&type=top&related=1']);
    // Under the search's own posts, with the same cards, which come back to this search.
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Posts', 'Related posts']);
    const href = await related.getByRole('link').first().getAttribute('href');
    expect(new URL(href ?? '', 'http://127.0.0.1').searchParams.get('returnTo')).toBe('/search?q=ocean+at+dusk');
    // Said after the search's own count, once the box is left.
    await page.getByRole('heading', { level: 1 }).click();
    await expect(status).toHaveText('1 result for ocean at dusk. 2 related posts');
    // Once per answer.
    await page.clock.runFor(10_000);
    expect(requests).toHaveLength(2);

    // Enter inside the pause: the person has settled on it, so the search itself asks.
    await box.fill('quiet harbour');
    await box.press('Enter');
    await page.clock.runFor(300);
    await expect(related.getByRole('link')).toHaveCount(2);
    await expect(page.getByText('No results for “quiet harbour”')).toBeVisible();
    expect(requests.slice(2)).toEqual(['?q=quiet+harbour&type=top&related=1']);
    await page.clock.runFor(10_000);
    expect(requests).toHaveLength(3);

    // Recipes bring none: the parameter is not sent there, settled or not.
    await page.getByRole('tab', { name: 'Recipes' }).click();
    await page.clock.runFor(10_000);
    expect(requests.slice(3)).toEqual(['?q=quiet+harbour&type=recipes']);
    await expect(related).toHaveCount(0);
    await page.clock.resume();
  });

  // The page writes its address a pause after the last letter. It used to do
  // so through Next's patched history.replaceState, which Next's router takes
  // for a navigation, and a navigation discards the one still loading: any
  // link pressed inside the pause, on a page slower than the pause, opened
  // nothing (first seen on CI as a suggestion's press, #778). The write now
  // carries the entry's own state, which Next hands straight to the browser
  // (src/app/search/search-address.ts), and a press writes it first, so the
  // entry being left names the search left. The page's clock is the test's
  // here, so the pause passes exactly while the page being opened is held back.
  for (const way of [
    { name: 'a result', path: '/creators/e2e-creator', link: { name: /E2E Creator/ }, within: 'main' },
    { name: 'a link of the sidebar', path: '/marketplace', link: { name: 'Marketplace' }, within: 'complementary' },
  ] as const) {
    test(`opens ${way.name} pressed inside the search’s pause, however slowly its page answers and whatever is typed meanwhile, and Back returns to the search left`, async ({ page }) => {
      await page.clock.install();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      const requests: string[] = [];
      await page.route(SEARCH_API, async (route) => {
        const url = new URL(route.request().url());
        requests.push(url.search);
        const answer = searchResponse(url.searchParams.get('q') ?? '', url.searchParams.get('type') ?? 'top');
        answer.creators.items[0] = { ...answer.creators.items[0], id: 'workflow-user', username: 'e2e-creator', displayName: 'E2E Creator' };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
      });
      await page.goto('/search?q=luna');
      await expect(page.getByRole('main').getByRole('link', { name: /E2E Creator/ })).toBeVisible();
      // The page is compiled before it is held: the hold is the page's answer, not the compiler's.
      await page.request.get(way.path, { timeout: 0 });
      await page.route((url) => url.pathname === way.path, async (route) => {
        await held;
        await route.continue();
      });
      const box = page.getByRole('combobox');

      // Time stands still: the letter's pause (300 ms) passes only when the test says so.
      await page.clock.pauseAt(new Date(Date.now() + 5_000));
      await box.press('End');
      await box.press('r');
      await expect(box).toHaveValue('lunar');
      expect(new URL(page.url()).searchParams.get('q')).toBe('luna');
      // The cards of "luna" stay up while "lunar" waits; the link is pressed inside the pause.
      await page.getByRole(way.within).getByRole('link', way.link).first().click();
      // The press wrote the search being left, ahead of the way out.
      expect(new URL(page.url()).pathname).toBe('/search');
      expect(new URL(page.url()).searchParams.get('q')).toBe('lunar');

      // The person types on while the page they pressed is still loading, and
      // the pause passes. The page's write for the new text lands with the
      // navigation on its way: told to Next's router, it would discard it.
      // The search the page says it is running is asked too: a navigation
      // that failed here would not leave "Searching…" with no request behind it.
      await box.fill('lunars');
      await page.clock.runFor(1_000);
      expect(new URL(page.url()).pathname).toBe('/search');
      expect(new URL(page.url()).searchParams.get('q')).toBe('lunars');
      expect(requests.filter((search) => /[?&]q=lunars(&|$)/.test(search))).toHaveLength(1);

      release();
      await page.clock.resume();
      await expect(page).toHaveURL((url) => url.pathname === way.path, { timeout: 30_000 });

      // Back: the search the person left, in the box, in the address and run again.
      const asked = requests.length;
      await page.goBack();
      await expect(page).toHaveURL(/\/search\?q=lunars$/);
      await expect(page.getByRole('combobox')).toHaveValue('lunars');
      await expect.poll(() => requests.slice(asked)).toEqual(['?q=lunars&type=top']);
      await expect(page.locator('p[role="status"]')).toContainText('1 result for lunars');
    });
  }
});
