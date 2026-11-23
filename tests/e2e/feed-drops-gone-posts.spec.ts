import { expect, test, type Page } from '@playwright/test';

// A post that leaves public view while Home is open (its creator archives it,
// makes it private, or it is hidden) has its media refused from then on: the
// media route answers 404 to a new read (`post-media-read-service.ts`). Before
// 2026-11-23 a feed image never reported the failure, so the card sat on its
// blurred placeholder for good (seen on production on 2026-11-14). Now the
// feed asks the live-post resolver about the post: a post that is gone leaves
// the feed quietly, as a feed drops a post that is no longer there, and a post
// still public offers a retry, its failure being the media's or the network's.
//
// Signed out: offline the feed's server read fails, so the feed asks
// `/api/showcase/feed` from the browser, which this spec answers, as
// home-logo-top-and-refresh.spec.ts does.

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const SLOW_PAGE = { timeout: 30_000 };

// 1×1 PNG: an image that loads.
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const POSTS = {
  gone: { id: '0f1c2d3e-0000-4000-8000-000000000001', title: 'Archived while the feed was open', media: 404 },
  live: { id: '0f1c2d3e-0000-4000-8000-000000000002', title: 'Still public, network hiccup', media: 503 },
  fine: { id: '0f1c2d3e-0000-4000-8000-000000000003', title: 'Loads as it should', media: 200 },
} as const;

type PostKey = keyof typeof POSTS;

function mediaPath(postId: string, file: string) {
  return `/api/media?${new URLSearchParams({ bucket: 'post_media', path: `private-posts/${postId}/${file}` })}`;
}

function feedItem(key: PostKey) {
  const { id, title } = POSTS[key];
  return {
    isNsfw: false,
    nsfwRevealed: false,
    id,
    mediaUrl: mediaPath(id, 'photo.jpg'),
    mediaKind: 'image',
    mediaItems: [{
      id: `${id}-media`,
      mediaKey: 'media-1',
      url: mediaPath(id, 'photo.jpg'),
      previewUrl: mediaPath(id, 'photo.preview.webp'),
      displayUrl: null,
      previewThumbhash: '3lcOJBCq+IqoaX2XR4jRb6QEdw==',
      previewStatus: 'ready',
      gridReady: true,
      mediaKind: 'image',
      contentType: 'image/jpeg',
      originalName: 'photo.jpg',
      width: 898,
      height: 1598,
      durationSeconds: null,
      sortOrder: 0,
    }],
    model: 'external',
    title,
    prompt: '',
    body: '',
    category: 'image',
    creationMode: null,
    postFormat: 'media',
    saveCount: 0,
    remixCount: 0,
    commentCount: 0,
    createdAt: '2026-11-14T13:38:04.953Z',
    creator: { id: 'e2e-feed-creator', username: 'e2e-feed-creator', name: 'Feed Creator', avatar: null },
    isSaved: false,
    sourceKind: 'external',
    sourceTool: null,
    sourceToolSlug: null,
    sourceTools: [],
    generationId: null,
    asset: null,
    canRemix: false,
  };
}

/**
 * Answers the feed with the three posts, their media as each post's case
 * needs, and the resolver as the server would: 404 for the archived post, the
 * post itself for the others. Returns the posts the resolver was asked about.
 */
async function answerHome(page: Page) {
  const asked: string[] = [];
  await page.route('**/api/showcase/feed?*', (route) => route.fulfill({
    json: {
      items: (['gone', 'live', 'fine'] as const).map(feedItem),
      pageInfo: { hasMore: false, nextOffset: null, nextCursor: null, limit: 12, offset: 0 },
    },
  }));
  await page.route((url) => url.pathname === '/api/media', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? '';
    const post = Object.values(POSTS).find(({ id }) => path.includes(id));
    if (post?.media === 200) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    // The archived post's media is refused as the route refuses it (404); the
    // live post's fails as a storage hiccup would (503).
    return route.fulfill({ status: post?.media ?? 404, json: { error: 'Media not found' } });
  });
  await page.route((url) => /^\/api\/showcase\/posts\/[^/]+\/resolve$/.test(url.pathname), (route) => {
    const postId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[4] ?? '');
    asked.push(postId);
    return postId === POSTS.gone.id
      ? route.fulfill({ status: 404, json: { error: 'Post not found.' } })
      : route.fulfill({ status: 200, json: { success: true, postId } });
  });
  return asked;
}

function card(page: Page, key: PostKey) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name: POSTS[key].title }) });
}

test('a post that left public view leaves the feed; a live one whose image failed offers a retry', async ({ page }) => {
  test.slow();
  const asked = await answerHome(page);

  await page.goto('/');
  await expect(card(page, 'fine')).toBeVisible(SLOW_PAGE);

  // The archived post's card goes, with no error drawn in its place.
  await expect(card(page, 'gone')).toHaveCount(0, SLOW_PAGE);

  // The live post stays, its image offering a retry.
  const live = card(page, 'live');
  await expect(live).toBeVisible();
  await expect(live.getByRole('button', { name: 'Retry image' })).toBeVisible();

  // The image that loaded raised no question, and the card that loaded stays.
  await expect(card(page, 'fine').getByRole('img', { name: POSTS.fine.title })).toBeVisible();
  expect(asked).not.toContain(POSTS.fine.id);
  expect(asked).toContain(POSTS.gone.id);
  expect(asked).toContain(POSTS.live.id);
});

test('a retried image that loads clears the retry', async ({ page }) => {
  test.slow();
  await answerHome(page);

  await page.goto('/');
  const live = card(page, 'live');
  const retry = live.getByRole('button', { name: 'Retry image' });
  await expect(retry).toBeVisible(SLOW_PAGE);

  // The network is back: the live post's media now loads.
  await page.route((url) => url.pathname === '/api/media'
    && (url.searchParams.get('path') ?? '').includes(POSTS.live.id), (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: PIXEL,
  }));
  await retry.click();

  await expect(retry).toHaveCount(0);
  await expect(live.getByRole('img', { name: POSTS.live.title })).toBeVisible();
});
