import { expect, test, type Locator } from '@playwright/test';

import freeRecipePost from './fixtures/creation-post-free-recipe.json';

// Live sweep of 2026-11-17: "Report post or recipe", the rail's way to report a post, was a 164×20
// target, under the 24px every pointer target is given. It grows to 24px with padding that a
// negative margin of the same size takes back out of the layout, so nothing around it moves.
//
// Drawn signed out, as the sweep found it. The dev server answers the post's reads
// (support/supabase-server-stub.cjs, fixtures/creation-post-free-recipe.json); the browser's calls
// are left unanswered.

// In `next dev` a page compiles on its first request.
const COLD_PAGE = { timeout: 45_000 };
const POST_PATH = `/showcase/${freeRecipePost.post.id}`;

/** Where the button and what is around it are drawn, from the rail's own top. */
function measure(report: Locator) {
  return report.evaluate((button) => {
    const rail = button.closest('[data-testid="canonical-post-actions"]') as HTMLElement;
    const railTop = rail.getBoundingClientRect().top;
    const box = button.getBoundingClientRect();
    // The icon and the words, wherever the button's own box reaches.
    const contents = document.createRange();
    contents.selectNodeContents(button);
    const drawn = contents.getBoundingClientRect();
    const comments = rail.querySelector('[data-testid="canonical-post-comments"]');
    return {
      targetHeight: box.height,
      targetWidth: box.width,
      contentsTop: drawn.top - railTop,
      contentsLeft: drawn.left,
      rowHeight: (button.parentElement as HTMLElement).getBoundingClientRect().height,
      commentsTop: comments ? comments.getBoundingClientRect().top - railTop : null,
      railHeight: rail.getBoundingClientRect().height,
    };
  });
}

test('"Report post or recipe" is a target at least 24px tall, and nothing around it moved for it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));

  await page.goto(POST_PATH);
  const report = page.getByTestId('canonical-post-actions').getByRole('button', { name: 'Report post or recipe' });
  await expect(report).toBeVisible(COLD_PAGE);

  const drawn = await measure(report);
  expect(drawn.targetHeight, JSON.stringify(drawn)).toBeGreaterThanOrEqual(24);
  expect(drawn.targetWidth, JSON.stringify(drawn)).toBeGreaterThanOrEqual(24);

  // The same rail with the button as it was drawn before, with no padding or margin of its own.
  await report.evaluate((button) => {
    button.style.setProperty('padding', '0', 'important');
    button.style.setProperty('margin', '0', 'important');
  });
  const asBefore = await measure(report);
  expect(asBefore.targetHeight, JSON.stringify(asBefore)).toBeLessThan(drawn.targetHeight);
  // Its icon and words, its row, Comments under it and the rail are where they were.
  expect({ ...drawn, targetHeight: null }).toEqual({ ...asBefore, targetHeight: null });
});
