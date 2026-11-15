import { expect, test, type Page } from '@playwright/test';

import creationPost from './fixtures/creation-post.json';

// The order a reader chose for a post's comments (Top or Newest) was the thread's own state:
// a refresh, or Back to the post from a page it linked to, drew Top again (owner, 2026-11-15:
// "fix the comment sort … too"). The order is kept for the post in this tab now
// (src/lib/post-comment-sort-memory.ts). The dev server answers the post's reads
// (support/supabase-server-stub.cjs, fixtures/creation-post.json); the thread is answered here.

const COLD_PAGE = { timeout: 45_000 };
const POST_ID = creationPost.post.id;
test.describe.configure({ timeout: 150_000 });

const author = { id: 'someone-else', username: 'lena', displayName: 'Lena', avatarUrl: null };
function comment(id: string, body: string) {
  return {
    id, parentId: null, body, status: 'active', createdAt: '2026-11-10T08:00:00.000Z', replyCount: 0, author,
    likeCount: 0, viewerReaction: null, editedAt: null, hearted: false, pinned: false,
  };
}

/** Answers the thread by its order, and keeps the order of every read the page made. */
async function answerThread(page: Page) {
  const orders: string[] = [];
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));
  await page.route(`**/api/showcase/posts/${POST_ID}/comments**`, (route) => {
    const sort = new URL(route.request().url()).searchParams.get('sort') ?? 'top';
    orders.push(sort);
    return route.fulfill({
      json: {
        postId: POST_ID,
        postCreatorId: creationPost.creator.id,
        commentCount: 2,
        comments: sort === 'newest'
          ? [comment('c-new', 'The newest comment'), comment('c-top', 'The top comment')]
          : [comment('c-top', 'The top comment'), comment('c-new', 'The newest comment')],
        pageInfo: { hasMore: false, nextOffset: null, limit: 50, offset: 0 },
      },
    });
  });
  return orders;
}

async function chosenOrder(page: Page) {
  await page.getByRole('button', { name: 'Sort comments' }).click();
  const newest = page.getByRole('menuitemradio', { name: /^Newest/ });
  const chosen = (await newest.getAttribute('aria-checked')) === 'true' ? 'newest' : 'top';
  await page.keyboard.press('Escape');
  return chosen;
}

test("a post's comments keep the order chosen for them across a refresh and Back", async ({ page }) => {
  const orders = await answerThread(page);
  await page.goto(`/showcase/${POST_ID}`, COLD_PAGE);
  await expect(page.getByText('The top comment')).toBeVisible(COLD_PAGE);

  await page.getByRole('button', { name: 'Sort comments' }).click();
  await page.getByRole('menuitemradio', { name: /^Newest/ }).click();
  await expect.poll(() => orders.at(-1)).toBe('newest');

  orders.length = 0;
  await page.reload(COLD_PAGE);
  await expect(page.getByText('The newest comment')).toBeVisible(COLD_PAGE);
  expect(await chosenOrder(page)).toBe('newest');
  expect(orders.at(-1)).toBe('newest');

  // Away through the app to another page and Back, both without a load: the thread mounts again
  // on the order chosen (the tab's copy, not a reload's read of storage).
  await page.getByRole('complementary', { name: 'Primary navigation' }).getByRole('link', { name: 'Home' }).click();
  await expect.poll(() => new URL(page.url()).pathname, COLD_PAGE).toBe('/');
  orders.length = 0;
  await page.goBack(COLD_PAGE);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/showcase/${POST_ID}`);
  await expect(page.getByText('The newest comment')).toBeVisible(COLD_PAGE);
  expect(await chosenOrder(page)).toBe('newest');
  expect(orders.at(-1)).toBe('newest');
});
