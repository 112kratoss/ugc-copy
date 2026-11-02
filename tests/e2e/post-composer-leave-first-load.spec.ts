import { expect, test, type Page, type Route } from '@playwright/test';

// The composer opened by its address, the document's first load, with work
// typed into it, then left by one of its ways out: a link it asked about, or a
// publish. Each steps off the leave guard's history entry with Back, and that
// Back's popstate reaches Next's router too, which restores the page for it;
// the last navigation or restore asked for wins. On a first load the guard's
// listener comes before the router's (React runs a child's effects before its
// parent's, and the router adds its listener in an effect), and the guard used
// to start the way out's navigation inside it: the router's restore came after
// and dropped it, so the next page was fetched and the address never changed.
// A composer reached by a link finds the router's listener there first, which
// is why these open it by its address (archive/leave-guard-first-page-2026-11-03).
//
// The composer reads all it draws from the browser, so page.route answers each
// request, and the post's page too. The page the link opens reads its feed on
// the server, which fails here as on every page; only its address is read.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
// page.goto and the warm-up, which have no timeout of their own, spend the
// test's on their compiles, so the test's has to hold them and a COLD_PAGE wait.
test.describe.configure({ timeout: 120_000 });

const POST_ID = 'post-e2e-first-load';

// Ready to post publicly, so the composer asks for no name or handle.
const READY_PROFILE = {
  id: 'workflow-user',
  username: 'maya-k',
  suggestedUsername: 'maya-k',
  displayName: 'Maya K',
  bio: null,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Opens the composer by its address and types a text post into it, which puts its leave guard up. */
async function openComposerWithWorkTyped(page: Page) {
  // The composer's own first request: its script has run once it is sent.
  const mounted = page.waitForRequest('**/api/source-tools**');
  await page.goto('/post/new');
  await mounted;

  await page.getByRole('button', { name: /^text$/i }).click();
  await page.getByRole('textbox', { name: /^post text/i }).fill('A note that stands on its own for the community.');
  await page.getByRole('textbox', { name: /^title/i }).fill('Soft window light on a first visit');
  // Unsaved: the guard's entry is on top of the composer's own.
  await expect.poll(() => page.evaluate(() => Boolean(window.history.state?.postComposerLeaveGuard))).toBe(true);
}

test.describe('the post composer, opened by its address with work typed', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    await page.route('**/api/profile', (route) => json(route, READY_PROFILE));
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('a link it asked about opens its page once Leave is chosen', async ({ page }) => {
    // Compiled before the composer opens: a compile while it is open can refresh it.
    await page.request.get('/showcase', { timeout: 0 });
    await openComposerWithWorkTyped(page);

    await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('link', { name: 'Explore', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Leave this post?' }).getByRole('button', { name: 'Leave without saving' }).click();

    await expect(page).toHaveURL(/\/showcase(\?.*)?$/, COLD_PAGE);
  });

  test('a publish opens the post’s own address', async ({ page }) => {
    const posted: string[] = [];
    await page.route('**/api/posts', (route) => {
      posted.push(route.request().method());
      return json(route, {
        postId: POST_ID,
        showcasePath: `/showcase/${POST_ID}`,
        ownerPath: `/post/${POST_ID}/edit`,
        visibility: 'public',
        resourceBundleStatus: null,
      });
    });
    // Where the composer goes once the post is out: this test reads the address, not the post page.
    await page.route(`**/showcase/${POST_ID}**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Post</title><h1>The new post</h1>',
    }));
    await openComposerWithWorkTyped(page);

    await page.getByRole('button', { name: /publish public/i }).first().click();

    await expect.poll(() => posted).toEqual(['POST']);
    // The post takes the composer's place, with the composer's own way back
    // (Explore, for one opened by its address).
    await expect(page).toHaveURL(`/showcase/${POST_ID}?returnTo=%2Fshowcase`, COLD_PAGE);
  });
});
