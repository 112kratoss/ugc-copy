import { expect, test, type Route } from '@playwright/test';

import ownPost from './fixtures/post-composer-saved-twice.json';

// An edit opened from Studio goes back to the view it was opened from once
// saved, as the app's edit does (owner, 2026-11-03), and Studio rings the
// post's card. Back from Studio then leaves Studio: the editor steps back onto
// it when it is the entry before, rather than put a second Studio behind it.
//
// The editor reads its post on the server, which the placeholder project
// cannot answer: tests/e2e/support/supabase-server-stub.cjs answers those reads
// with fixtures/post-composer-saved-twice.json, the E2E user's public image
// post (post-composer-edit-saves-twice.spec.ts draws the same editor). Studio
// and the save are answered here.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
// Three pages compile in a test, and page.goto spends the test's own timeout.
test.describe.configure({ timeout: 180_000 });

const POST_ID = ownPost.post.id;
const EDITOR = `/post/${POST_ID}/edit`;
const STUDIO_VIEW = '/creations?view=posts&visibility=public';

// The fixture post as Studio's Posts view lists it.
const OWNER_POST = {
  id: POST_ID,
  generationId: null,
  visibility: 'public',
  archivedAt: null,
  mediaUrl: null,
  mediaKind: null,
  title: ownPost.post.title,
  description: '',
  prompt: '',
  body: 'The post Studio lists.',
  category: 'image',
  postFormat: 'media',
  sourceKind: 'external',
  sourceTool: null,
  sourceLabel: 'External',
  createdAt: ownPost.post.created_at,
  updatedAt: ownPost.post.updated_at,
  publicPath: `/showcase/${POST_ID}`,
  ownerPath: EDITOR,
  resourcePath: null,
  canShare: false,
  bundle: null,
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('an edit opened from Studio', () => {
  let saves: Array<{ title?: string }>;

  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
    // From 1024px the phone bar is gone and the Publish section's buttons are the ones on screen.
    await page.setViewportSize({ width: 1280, height: 900 });
    saves = [];
    await page.route('**/api/source-tools**', (route) => json(route, { tools: [] }));
    await page.route('**/api/generations?**', (route) => json(route, { generations: [] }));
    await page.route('**/api/posts?**', (route) => json(route, { posts: [OWNER_POST] }));
    await page.route(`**/api/posts/${POST_ID}`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      saves.push(route.request().postDataJSON() as { title?: string });
      await json(route, {
        success: true,
        postId: POST_ID,
        visibility: 'public',
        showcasePath: `/showcase/${POST_ID}`,
        ownerPath: EDITOR,
        resourceBundlePath: null,
        resourceBundleStatus: null,
      });
    });
  });

  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('goes back to its view once saved, rings the post, and Back then leaves Studio', async ({ page }, testInfo) => {
    // A page before Studio, for Back to reach once Studio is left.
    await page.goto('/search');
    await page.request.get(EDITOR, { timeout: 0 });
    await page.goto(STUDIO_VIEW);

    const card = page.getByTestId(`post-card-${POST_ID}`);
    await expect(card).toBeVisible(COLD_PAGE);
    await card.getByRole('link', { name: 'Edit post' }).click();

    await expect(page).toHaveURL(
      `${EDITOR}?from=creations&returnTo=${encodeURIComponent(STUDIO_VIEW)}`,
      COLD_PAGE,
    );
    const title = page.getByRole('textbox', { name: /^title/i });
    await expect(title).toHaveValue(ownPost.post.title, COLD_PAGE);
    // An edit puts the leave guard up, so the save leaves through it.
    await title.fill(`${ownPost.post.title}, retitled`);
    await page.getByRole('button', { name: /^save changes/i }).click();

    await expect(page).toHaveURL(STUDIO_VIEW, COLD_PAGE);
    expect(saves).toEqual([expect.objectContaining({ title: `${ownPost.post.title}, retitled` })]);
    await expect(card).toHaveAttribute('data-highlighted', 'true', COLD_PAGE);
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('studio-after-save.png') });
    // The ring is for the return, and goes a few seconds later.
    await expect(card).not.toHaveAttribute('data-highlighted', 'true', { timeout: 10_000 });

    await page.goBack();
    await expect(page).toHaveURL(/\/search$/, COLD_PAGE);
  });

  // Opened by its address, nothing before it is Studio: the save puts Studio
  // in the editor's place.
  test('goes to the view its address names when it was not opened from Studio', async ({ page }) => {
    await page.goto('/search');
    await page.request.get(STUDIO_VIEW, { timeout: 0 });
    // The page's own first request: its script has run once it is sent.
    const mounted = page.waitForRequest('**/api/source-tools**');
    await page.goto(`${EDITOR}?from=creations&returnTo=${encodeURIComponent(STUDIO_VIEW)}`);
    await mounted;

    const title = page.getByRole('textbox', { name: /^title/i });
    await expect(title).toHaveValue(ownPost.post.title, COLD_PAGE);
    await title.fill(`${ownPost.post.title}, retitled`);
    await page.getByRole('button', { name: /^save changes/i }).click();

    await expect(page).toHaveURL(STUDIO_VIEW, COLD_PAGE);
    await expect(page.getByTestId(`post-card-${POST_ID}`)).toHaveAttribute('data-highlighted', 'true', COLD_PAGE);

    await page.goBack();
    await expect(page).toHaveURL(/\/search$/, COLD_PAGE);
  });
});
