import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import creationPost from './fixtures/creation-post.json';

// Owner, 2026-11-13: the post page's conversation sat under the post and its recipe, a screen or
// more down, and a post without a recipe printed its prompt in the rail's card while a post with
// one kept it under the picture. The thread is now a panel in the rail beside the post, as a
// Shorts thread sits beside its clip: a header with the count, the order and a close button, the
// list scrolling inside the panel, the composer on its bottom edge. The prompt is under the post
// on every post. The dev server answers the post's reads (support/supabase-server-stub.cjs,
// fixtures/creation-post.json); the thread is answered here.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
const POST_ID = creationPost.post.id;

test.describe.configure({ timeout: 180_000 });

function base64url(value: string) {
  return Buffer.from(value).toString('base64url');
}

// The E2E user (src/lib/e2e-auth.ts) as Supabase's auth describes them to the browser.
const user = {
  id: 'workflow-user',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'workflow-user@example.com',
  is_anonymous: false,
  app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {},
  identities: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};
const EXPIRES_AT = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
const session = {
  access_token: [
    base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64url(JSON.stringify({
      sub: user.id, aud: 'authenticated', role: 'authenticated', exp: EXPIRES_AT,
      email: user.email, is_anonymous: false, session_id: 'e2e-session',
    })),
    'e2e-signature',
  ].join('.'),
  token_type: 'bearer',
  expires_in: 365 * 24 * 3600,
  expires_at: EXPIRES_AT,
  refresh_token: 'e2e-refresh-token',
  user,
};

/** Signed in as the E2E user, who is not the post's creator. */
async function signIn(context: BrowserContext) {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
  const cookie = `sb-example-auth-token=base64-${base64url(JSON.stringify(session))}`;
  await context.addInitScript((value) => {
    document.cookie = `${value}; path=/; SameSite=Lax`;
  }, cookie);
  await context.route('https://example.supabase.co/**', (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/auth/v1/user') return route.fulfill({ json: user });
    if (pathname === '/auth/v1/token') return route.fulfill({ json: session });
    const single = (route.request().headers().accept ?? '').includes('vnd.pgrst.object');
    if (pathname === '/rest/v1/profiles') {
      const row = { display_name: 'E2E Creator', avatar_url: null, credits: 25 };
      return route.fulfill({ json: single ? row : [row] });
    }
    if (pathname.startsWith('/rest/v1/')) return route.fulfill(single ? { status: 406, json: {} } : { json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
}

const creatorAuthor = {
  id: creationPost.creator.id,
  username: creationPost.creator.username,
  displayName: creationPost.creator.display_name,
  avatarUrl: null,
};
const viewerAuthor = { id: user.id, username: 'e2e-viewer', displayName: 'E2E Viewer', avatarUrl: null };
const strangerAuthor = { id: 'someone-else', username: 'lena', displayName: 'Lena', avatarUrl: null };
const LONG_COMMENT = Array.from({ length: 12 }, (_, index) => `Line ${index + 1} of a long comment about the light on this rooftop.`).join(' ');

function comment(id: string, body: string, author: typeof creatorAuthor, extra: Record<string, unknown> = {}) {
  return { id, parentId: null, body, status: 'active', createdAt: '2026-11-10T08:00:00.000Z', replyCount: 0, author, ...extra };
}

// More comments than a short panel holds, so the list has to scroll inside it.
const THREAD = [
  comment('c-creator', 'Shot on the first try, thanks all.', creatorAuthor, { replyCount: 2 }),
  comment('c-viewer', 'My own comment on this.', viewerAuthor),
  comment('c-long', LONG_COMMENT, strangerAuthor),
  ...Array.from({ length: 21 }, (_, index) => comment(`c-${index + 4}`, `Comment ${index + 4}`, strangerAuthor)),
];
const REPLIES = [
  comment('r-1', 'Which lens?', strangerAuthor, { parentId: 'c-creator' }),
  comment('r-2', 'A 35mm, wide open.', creatorAuthor, { parentId: 'c-creator' }),
];

/** Every API call unanswered but the post's thread; the posts the page sends are kept. */
async function answerThread(page: Page, posted: Array<Record<string, unknown>> = []) {
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/showcase/posts/${POST_ID}/comments**`, (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      posted.push(body);
      return route.fulfill({
        json: {
          comment: comment(`posted-${posted.length}`, String(body.body), viewerAuthor, { parentId: body.parentId ?? null }),
          commentCount: THREAD.length + REPLIES.length + posted.length,
        },
      });
    }
    const parentId = new URL(request.url()).searchParams.get('parentId');
    const comments = parentId ? REPLIES : THREAD;
    return route.fulfill({
      json: {
        postId: POST_ID,
        postCreatorId: creationPost.creator.id,
        commentCount: THREAD.length + REPLIES.length + posted.length,
        comments,
        pageInfo: { hasMore: false, nextOffset: null, limit: 50, offset: 0 },
      },
    });
  });
}

const box = (page: Page, testId: string) => page.getByTestId(testId).evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
});

test('the thread is a panel beside the post: its list scrolls inside it and the composer keeps the bottom edge', async ({ page, context }, testInfo) => {
  const posted: Array<Record<string, unknown>> = [];
  await signIn(context);
  await answerThread(page, posted);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(`/showcase/${POST_ID}`);

  await expect(page.getByRole('heading', { level: 1, name: creationPost.post.title })).toBeVisible(COLD_PAGE);
  const rail = page.getByTestId('canonical-post-actions');
  const panel = rail.getByTestId('canonical-post-comments');
  await expect(panel.getByText('Comment 24')).toBeAttached(COLD_PAGE);
  // The session reaches the page after its script runs; the composer comes with it.
  const composer = panel.getByRole('textbox', { name: 'Write a comment' });
  await expect(composer).toBeVisible(COLD_PAGE);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });

  // Beside the post, never under it, and wholly inside the window.
  const [media, panelBox] = await Promise.all([box(page, 'canonical-post-media'), box(page, 'canonical-post-comments')]);
  expect(panelBox.left).toBeGreaterThanOrEqual(media.right);
  expect(panelBox.bottom).toBeLessThanOrEqual(800);
  // Scrolled until the rail sticks under the top bar, it still ends inside the window, and it
  // has grown by what the masthead above it had taken.
  const railTop = (await box(page, 'canonical-post-actions')).top;
  expect(railTop).toBeGreaterThan(76);
  await page.mouse.move(400, 500);
  // Just past where it sticks: at the page's very end the layout's own end lifts the rail.
  await page.mouse.wheel(0, railTop - 76 + 24);
  await expect.poll(async () => (await box(page, 'canonical-post-actions')).top).toBe(76);
  const stuck = await box(page, 'canonical-post-comments');
  expect(stuck.bottom).toBeLessThanOrEqual(800);
  expect(stuck.bottom - stuck.top).toBeGreaterThan(panelBox.bottom - panelBox.top);
  await page.mouse.wheel(0, -(railTop - 76 + 24));
  await expect.poll(async () => (await box(page, 'canonical-post-comments')).top).toBe(panelBox.top);
  await expect(page.getByTestId('canonical-post-media').getByTestId('canonical-post-comments')).toHaveCount(0);

  // The header: the count, the order and a close button.
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^Comments\s*26$/);
  // The list scrolls inside the panel; the page itself has not moved.
  const scroller = panel.locator('.post-comments__scroll');
  const sizes = await scroller.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client);
  // The composer is under the list, on the panel's bottom edge.
  const [scrollerBottom, composerTop, composerBottom] = await Promise.all([
    scroller.evaluate((element) => element.getBoundingClientRect().bottom),
    composer.evaluate((element) => element.getBoundingClientRect().top),
    composer.evaluate((element) => element.getBoundingClientRect().bottom),
  ]);
  expect(composerTop).toBeGreaterThanOrEqual(scrollerBottom);
  expect(composerBottom).toBeLessThanOrEqual(panelBox.bottom);

  // The post's creator is marked, a long comment opens folded, and a comment's other actions
  // are behind its menu.
  const thread = panel.getByRole('list', { name: 'Comment thread' });
  await expect(thread.getByRole('listitem').first().getByText('Creator', { exact: true })).toBeVisible();
  const readMore = thread.getByRole('button', { name: 'Read more' });
  await expect(readMore).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('post-page-comments-rail-desktop.png') });

  // A press before the page's script has taken the thread over is dropped (the fifth gotcha in
  // .claude/rules/e2e.md), so the first press is repeated until the page answers it.
  await expect(async () => {
    if (await page.getByRole('menu').count() === 0) {
      await panel.getByRole('button', { name: 'More actions for your comment' }).click({ timeout: 2_000 });
    }
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Delete' })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  await page.screenshot({ path: testInfo.outputPath('post-page-comment-menu.png') });
  await page.keyboard.press('Escape');
  await panel.getByRole('button', { name: `More actions for @lena's comment` }).first().click();
  await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(['Report']);
  await page.keyboard.press('Escape');

  // Replies open under their comment, and a reply to a reply joins the same thread by name.
  await panel.getByRole('button', { name: 'View 2 replies' }).click();
  await expect(panel.getByText('A 35mm, wide open.')).toBeVisible();
  await panel.getByRole('button', { name: 'Reply to @lena' }).first().click();
  const replyBox = panel.getByRole('textbox', { name: 'Write a reply' });
  await expect(replyBox).toHaveValue('@lena ');
  await expect(replyBox).toBeFocused();
  await replyBox.pressSequentially('thanks');
  await page.screenshot({ path: testInfo.outputPath('post-page-comments-reply.png') });
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => posted).toEqual([{ body: '@lena thanks', parentId: 'c-creator' }]);

  // The order is a menu, the one in use checked.
  await panel.getByRole('button', { name: 'Sort comments' }).click();
  await expect(page.getByRole('menuitemradio', { name: /^Top/ })).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: testInfo.outputPath('post-page-comments-sort.png') });
  await page.keyboard.press('Escape');

  // Close folds the panel to one row; the post's Comment link opens it again, the thread as it was.
  await panel.getByRole('button', { name: 'Close comments' }).click();
  await expect(composer).toBeHidden();
  await expect(panel.getByRole('button', { name: /^Comments/ })).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('canonical-post-media').locator('a[href="#comments"]').click();
  await expect(composer).toBeVisible();
  await expect(panel.getByText('A 35mm, wide open.')).toBeVisible();
});

test('a post with no recipe shows its prompt under the post, not in the rail', async ({ page }, testInfo) => {
  await page.context().route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await answerThread(page);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(`/showcase/${POST_ID}`);

  const prompt = page.getByTestId('canonical-post-media').getByTestId('canonical-post-prompt');
  await expect(prompt).toBeVisible(COLD_PAGE);
  await expect(prompt.getByRole('heading', { level: 2, name: 'Prompt' })).toBeVisible();
  await expect(prompt).toContainText(creationPost.post.prompt);
  await expect(page.getByTestId('canonical-post-actions')).not.toContainText(creationPost.post.prompt);
  // Under the post's own actions, as a recipe is.
  const [rowBottom, promptTop] = await Promise.all([
    page.getByTestId('canonical-post-media').locator('a[href="#comments"]').evaluate((element) => element.getBoundingClientRect().bottom),
    prompt.evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(promptTop).toBeGreaterThanOrEqual(rowBottom);
  // A signed-out visitor gets the way in where the composer goes.
  await expect(page.getByTestId('canonical-post-comments').getByRole('link', { name: /Sign in to join/ })).toBeVisible();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await prompt.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('post-page-prompt-under-post.png') });
});

test('on a phone the thread follows the post in one column, composer first, with no scroll of its own', async ({ page, context }, testInfo) => {
  await signIn(context);
  await answerThread(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/showcase/${POST_ID}`);

  const panel = page.getByTestId('canonical-post-comments');
  const composer = panel.getByRole('textbox', { name: 'Write a comment' });
  await expect(composer).toBeVisible(COLD_PAGE);
  await expect(panel.getByText('Comment 24')).toBeAttached();

  const [media, panelBox] = await Promise.all([box(page, 'canonical-post-media'), box(page, 'canonical-post-comments')]);
  expect(panelBox.top).toBeGreaterThanOrEqual(media.bottom);
  const scroller = panel.locator('.post-comments__scroll');
  const sizes = await scroller.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight }));
  expect(sizes.scroll).toBe(sizes.client);
  const [composerBottom, scrollerTop] = await Promise.all([
    composer.evaluate((element) => element.getBoundingClientRect().bottom),
    scroller.evaluate((element) => element.getBoundingClientRect().top),
  ]);
  expect(scrollerTop).toBeGreaterThanOrEqual(composerBottom);
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('post-page-comments-phone.png') });
});
