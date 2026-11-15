import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import creationPost from './fixtures/creation-post.json';
import recipePost from './fixtures/post-with-recipe.json';

// Owner, 2026-11-15, of the "Back to Community" above a post: "is it needed? actually its home
// right". It was neither: Community is Explore's old name, and a link that named no page was given
// it too. A post opened by its own address (a shared link, a refresh, a new tab) now draws no way
// back, since no page of the site is behind the reader and the menu's Home and Explore lead on;
// one opened from another page of the site names that page and goes back to it as it was left.
// The dev server answers the post's reads (support/supabase-server-stub.cjs,
// fixtures/creation-post.json); search, the invite's visit and the cover are answered here.

const COLD_PAGE = { timeout: 45_000 };
const POST_PATH = `/showcase/${creationPost.post.id}`;
const TITLE = creationPost.post.title;
const CODE = '30b5f916c7aa';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PICTURE = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#2b1b4f"/><stop offset="0.55" stop-color="#e2725b"/><stop offset="1" stop-color="#f6c177"/>
</linearGradient></defs>
<rect width="1080" height="1920" fill="url(#sky)"/>
</svg>`;

test.describe.configure({ timeout: 180_000 });

const wayBack = (page: Page) => page.getByRole('link', { name: /^Back\b/ });
const title = (page: Page) => page.getByRole('heading', { level: 1, name: TITLE });

/** Answers the invite's visit, whose offer the page's script draws once it has read the address. */
async function answerInviteVisit(page: Page) {
  await page.route('**/api/referrals/visit', (route) => route.fulfill({
    json: { success: true, code: CODE, preserved: false, program: null },
  }));
  return page.getByRole('complementary', { name: 'Your invite' });
}

/** Signed out, with the browser's other requests answered as they fail offline. */
async function visitSignedOut(page: Page) {
  const context = page.context();
  await context.route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await context.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  // The cover goes through Next's image optimizer, whose fetch of the placeholder project fails.
  await context.route('**/_next/image**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PICTURE }));
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test.describe('a post opened by its own address', () => {
  test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, hasTouch: true });

  test('draws no way back, from a shared link or an in-site address loaded on its own', async ({ page }) => {
    await visitSignedOut(page);
    // The invite's offer is drawn by the page's script once it has read the address and the
    // viewer: the page has hydrated by the time it shows.
    const offer = await answerInviteVisit(page);

    // A shared link.
    await page.goto(`${POST_PATH}?s=feed&r=${CODE}`);
    await expect(offer).toBeVisible(COLD_PAGE);
    await expect(title(page)).toBeVisible();
    await expect(wayBack(page)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('shared-link-phone.png') });

    // The address a Home card opens, loaded on its own: a refresh, or a new tab.
    await page.goto(`${POST_PATH}?from=home&returnTo=%2F&r=${CODE}`);
    await expect(offer).toBeVisible(COLD_PAGE);
    await expect(title(page)).toBeVisible();
    await expect(wayBack(page)).toHaveCount(0);
  });
});

/** Answers Search with the post as its one result, for a page or for every page of a context. */
async function answerSearch(target: Page | BrowserContext) {
  await target.route((url) => url.pathname === '/api/search/suggest', (route) => route.fulfill({
    json: { query: '', normalizedQuery: '', creators: [], entities: [], completions: [] },
  }));
  await target.route((url) => url.pathname === '/api/search/starter', (route) => route.fulfill({
    json: { entities: [], creators: [], searches: [] },
  }));
  await target.route((url) => url.pathname === '/api/search/opened', (route) => route.fulfill({ status: 204 }));
  await target.route((url) => url.pathname === '/api/search', (route) => {
    const url = new URL(route.request().url());
    const query = url.searchParams.get('q') ?? '';
    return route.fulfill({
      json: {
        query,
        normalizedQuery: query,
        type: url.searchParams.get('type') ?? 'top',
        sort: 'top',
        entities: [],
        filters: { madeWith: null, mediaKind: null, hasRecipe: false, following: false },
        correctedQuery: { posts: null, recipes: null },
        exact: false,
        creators: { items: [], nextCursor: null },
        posts: {
          items: [{
            id: creationPost.post.id, title: TITLE, saveCount: 0, commentCount: 0, creator: { name: 'Luna Studio' }, mediaItems: [], mediaKind: null, mediaUrl: null,
          }],
          nextCursor: null,
        },
        recipes: { items: [], nextCursor: null },
      },
    });
  });
}

const searchResult = (page: Page) => page.getByRole('link', { name: new RegExp(TITLE) });

test('a post opened from search says Search, and goes back to the search as it was left', async ({ page }) => {
  await visitSignedOut(page);
  await answerSearch(page);

  await page.goto('/search?q=rooftop');
  const result = searchResult(page);
  await expect(result).toBeVisible(COLD_PAGE);
  await result.click();

  await expect(title(page)).toBeVisible(COLD_PAGE);
  expect(new URL(page.url()).pathname).toBe(POST_PATH);
  await expect(wayBack(page)).toHaveText('Back to Search');
  await page.screenshot({ path: test.info().outputPath('opened-from-search.png') });

  await wayBack(page).click();
  await expect(page).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === 'rooftop');
  await expect(result).toBeVisible();
});

// Review of #829: the way back was drawn only after a counted link click, so a post the
// router opened after the first page (an alert's tap, the composer's Publish replacing the
// composer) drew none. A replace leaves no page of the site behind the post, so the way back
// opens the page it names instead of stepping back out of the site.
test('a post the router opened after the first page draws its way back, which opens the page it names', async ({ page }) => {
  await visitSignedOut(page);
  const offer = await answerInviteVisit(page);

  await page.goto(`/showcase/${recipePost.post.id}?r=${CODE}`);
  await expect(offer).toBeVisible(COLD_PAGE);
  await expect(wayBack(page)).toHaveCount(0);

  await page.evaluate((href) => (
    window as unknown as { next: { router: { replace: (target: string) => void } } }
  ).next.router.replace(href), `${POST_PATH}?from=home&returnTo=%2F`);

  await expect(title(page)).toBeVisible(COLD_PAGE);
  await expect(wayBack(page)).toHaveText('Back to Home');

  await wayBack(page).click();
  // Home, not the blank page the replaced first page left behind the post.
  await expect(page).toHaveURL((url) => url.pathname === '/', COLD_PAGE);
});

// The browser's Back to a post opened by its own address returns to the first page: no page
// of the site is behind it there either. The old rule drew "Back" once any link was clicked,
// and stepping back from it left the site.
test("the browser's Back to a post opened by its own address draws no way back", async ({ page }) => {
  await visitSignedOut(page);
  const offer = await answerInviteVisit(page);

  await page.goto(`${POST_PATH}?r=${CODE}`);
  await expect(offer).toBeVisible(COLD_PAGE);
  await expect(wayBack(page)).toHaveCount(0);

  await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('link', { name: 'Explore', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/showcase', COLD_PAGE);

  await page.goBack();
  await expect(title(page)).toBeVisible(COLD_PAGE);
  expect(new URL(page.url()).pathname).toBe(POST_PATH);
  await expect(wayBack(page)).toHaveCount(0);
});

// Second re-review of #829: a trip from the post the tab opened on that comes back to it by a
// replace (a sign-in from the post lands back on it, the sign-in page's entry replaced) has only
// the post's own first entry behind it, so it draws no way back.
test('a trip from the first post that comes back to it by a replace draws no way back', async ({ page }) => {
  await visitSignedOut(page);
  const offer = await answerInviteVisit(page);

  await page.goto(`${POST_PATH}?r=${CODE}`);
  await expect(offer).toBeVisible(COLD_PAGE);

  await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('link', { name: 'Explore', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/showcase', COLD_PAGE);
  await page.evaluate((href) => (
    window as unknown as { next: { router: { replace: (target: string) => void } } }
  ).next.router.replace(href), POST_PATH);

  await expect(title(page)).toBeVisible(COLD_PAGE);
  expect(new URL(page.url()).pathname).toBe(POST_PATH);
  await expect(wayBack(page)).toHaveCount(0);
});

// Re-review of #829: a link back to the post the tab opened on is an arrival from inside the
// site, and draws its way back. Only the browser's Back or Forward to that first page does not.
test('a link back to the post the tab opened on draws its way back', async ({ page }) => {
  await visitSignedOut(page);
  const offer = await answerInviteVisit(page);
  await answerSearch(page);

  await page.goto(`${POST_PATH}?r=${CODE}`);
  await expect(offer).toBeVisible(COLD_PAGE);
  await expect(wayBack(page)).toHaveCount(0);

  await page.evaluate((href) => (
    window as unknown as { next: { router: { push: (target: string) => void } } }
  ).next.router.push(href), '/search?q=rooftop');
  const result = searchResult(page);
  await expect(result).toBeVisible(COLD_PAGE);
  await result.click();

  await expect(title(page)).toBeVisible(COLD_PAGE);
  await expect(wayBack(page)).toHaveText('Back to Search');
  await wayBack(page).click();
  await expect(page).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === 'rooftop');
  await expect(result).toBeVisible();
});

// Re-review of #829: the router adds the post's entry only after the page has rendered, so in a
// tab whose first page led to the post (one entry, as a link opened in a new tab has) the way back
// must still step back, not reload the search as a new page on top of it.
test('in a tab of its own, the way back steps back to the page the post was opened from', async ({ page, context }) => {
  await visitSignedOut(page);
  await answerSearch(context);

  await page.goto('/search?q=rooftop');
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    page.evaluate(() => { window.open(window.location.href); }),
  ]);
  const result = searchResult(tab);
  await expect(result).toBeVisible(COLD_PAGE);
  expect(await tab.evaluate(() => window.history.length)).toBe(1);
  await result.click();

  await expect(title(tab)).toBeVisible(COLD_PAGE);
  await expect(wayBack(tab)).toHaveText('Back to Search');
  await wayBack(tab).click();
  await expect(tab).toHaveURL((url) => url.pathname === '/search' && url.searchParams.get('q') === 'rooftop');
  await expect(result).toBeVisible();
  // Stepped back: the search's own entry, not a third one pushed on top of the post.
  expect(await tab.evaluate(() => window.history.length)).toBe(2);
});
