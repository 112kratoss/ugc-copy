import { expect, test, type Route } from '@playwright/test';

// Post Library rows put a 180px-wide media frame beside the post's body. The
// grid stretches the frame to the body's height (title, two-line summary,
// recipe box, actions), which is taller than a 4:5 image 180px wide, so the
// image used to sit at the top of the frame over an empty band (reported
// 2026-11-06). The image now fills the frame from edge to edge.
//
// The page reads its posts from the browser, so page.route answers them; the
// image itself is answered here too, as a 4:5 SVG.

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });
test.use({ viewport: { width: 1440, height: 900 } });

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

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

test.describe('Post Library: a row\'s image fills its frame', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('leaves no band above or below the image when the body is taller', async ({ page }) => {
    await page.route('**/api/generations?**', (route) => json(route, { generations: [], pagination: { hasMore: false, nextCursor: null } }));
    await page.route('**/api/posts?**', (route) => json(route, { posts: [IMAGE_POST], pageInfo: { hasMore: false, nextOffset: null } }));
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
      // The row's media frame: the rounded box the grid stretches.
      const frame = node.closest('.rounded-xl');
      if (!frame) return null;
      const frameBox = frame.getBoundingClientRect();
      const imageBox = node.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(frame).borderTopWidth) || 0;
      return {
        frameHeight: frameBox.height,
        topGap: imageBox.top - frameBox.top - border,
        bottomGap: frameBox.bottom - imageBox.bottom - border,
        // The 4:5 height the image would keep on its own at this width.
        naturalHeight: imageBox.width * 5 / 4,
      };
    });

    expect(geometry).not.toBeNull();
    // The case the bug needs: the row is taller than the 4:5 image.
    expect(geometry!.frameHeight).toBeGreaterThan(geometry!.naturalHeight + 8);
    expect(Math.abs(geometry!.topGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(geometry!.bottomGap)).toBeLessThanOrEqual(1);
  });
});
