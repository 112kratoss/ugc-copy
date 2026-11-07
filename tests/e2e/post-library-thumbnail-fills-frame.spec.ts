import { expect, test, type Page, type Route } from '@playwright/test';

// Post Library rows put a 180px-wide media frame beside the post's body. The
// grid stretches the row's media cell to the body's height (title, two-line
// summary, recipe box, actions), which is taller than a 4:5 image 180px wide,
// so the image used to sit at the top of the frame over an empty band
// (reported 2026-11-06). The frame now follows the row up to 1.5× its width
// with the image filling it edge to edge; a taller row (tablet widths, where
// the body wraps) centres the capped frame, so the image is never cropped to a
// sliver (owner's choice, 2026-11-07: "Cap and centre").
//
// The page reads its posts and the profile from the browser, so page.route
// answers them; the image itself is answered here too, as a 4:5 SVG.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const IMAGE_URL = 'https://media.e2e.test/post-library-thumb.svg';

const IMAGE_POST = {
  id: 'post-e2e-thumb-fill',
  generationId: null,
  visibility: 'public',
  archivedAt: null,
  mediaUrl: IMAGE_URL,
  mediaKind: 'image',
  mediaItems: [],
  title: 'Peeling off a fake mask',
  description: 'A high-fashion, dramatic conceptual portrait against a void-black background, illuminated by a single light source that carves out their features. They are stripping away a surreal, realistic mask that serves as a statement on identity.',
  prompt: '',
  body: '',
  category: 'image',
  postFormat: 'media',
  sourceKind: 'manual',
  sourceTool: null,
  sourceLabel: 'Created here',
  createdAt: '2026-10-30T10:00:00.000Z',
  updatedAt: '2026-10-30T16:07:00.000Z',
  publicPath: '/showcase/post-e2e-thumb-fill',
  ownerPath: '/post/post-e2e-thumb-fill/edit',
  resourcePath: null,
  canShare: true,
  bundle: null,
};

const PROFILE = {
  id: 'workflow-user',
  username: 'e2e-creator',
  suggestedUsername: 'e2e-creator',
  displayName: 'E2E Creator',
  bio: null,
  avatarUrl: null,
  coverUrl: null,
  websiteUrl: null,
  twitterHandle: null,
  instagramHandle: null,
  tiktokHandle: null,
  location: null,
};

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Draws the library with one image post and measures its row's media. */
async function measureRow(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/api/generations?**', (route) => json(route, { generations: [], pagination: { hasMore: false, nextCursor: null } }));
  await page.route('**/api/posts?**', (route) => json(route, { posts: [IMAGE_POST], pageInfo: { hasMore: false, nextOffset: null } }));
  // The page reads the profile beside the posts; answered so a slow failure
  // against the placeholder project cannot hold the list back.
  await page.route('**/api/profile', (route) => json(route, PROFILE));
  await page.route(IMAGE_URL, (route) => route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500"><rect width="400" height="500" fill="#c06"/></svg>',
  }));

  await page.goto('/creations?view=posts');
  const image = page.getByRole('img', { name: IMAGE_POST.title });
  await expect(image).toBeVisible(COLD_PAGE);
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);

  const geometry = await image.evaluate((node) => {
    // The frame wraps the fill; the grid stretches the cell around the frame.
    const frame = node.closest('[data-studio-media-fill]')?.parentElement;
    const cell = frame?.parentElement;
    if (!frame || !cell) return null;
    const cellBox = cell.getBoundingClientRect();
    const frameBox = frame.getBoundingClientRect();
    const imageBox = node.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(frame).borderTopWidth) || 0;
    return {
      cellHeight: cellBox.height,
      frameHeight: frameBox.height,
      frameTopInCell: frameBox.top - cellBox.top,
      frameBottomInCell: cellBox.bottom - frameBox.bottom,
      imageTopGap: imageBox.top - frameBox.top - border,
      imageBottomGap: frameBox.bottom - imageBox.bottom - border,
      imageRatio: imageBox.height / imageBox.width,
    };
  });
  expect(geometry).not.toBeNull();
  return geometry!;
}

test.describe('Post Library: a row\'s image fills its frame', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('a laptop row: the frame follows the row and the image fills it', async ({ page }) => {
    const row = await measureRow(page, 1440);
    // The case the bug needs: the row is taller than the 4:5 image.
    expect(row.imageRatio).toBeGreaterThan(1.3);
    expect(Math.abs(row.frameHeight - row.cellHeight)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.imageTopGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.imageBottomGap)).toBeLessThanOrEqual(1);
  });

  test('a tablet row taller than the cap: the frame is capped and centred, the image still fills it', async ({ page }) => {
    const row = await measureRow(page, 768);
    // The body wraps, so the row outgrows the capped frame.
    expect(row.cellHeight).toBeGreaterThan(row.frameHeight + 20);
    expect(row.imageRatio).toBeLessThanOrEqual(1.52);
    expect(Math.abs(row.frameTopInCell - row.frameBottomInCell)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.imageTopGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(row.imageBottomGap)).toBeLessThanOrEqual(1);
  });
});
