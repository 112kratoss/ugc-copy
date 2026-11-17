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

/**
 * `measure` once two reads 300 ms apart agree. After the page's script runs, the rail's own parts
 * below the button (Comments, which the 503s here end in their error state) settle in their own
 * time. A read taken while they still change measures them, not the button: on CI the rail grew
 * 6 px between the two reads while nothing near the button moved (main's run of 2026-11-17).
 */
async function settledMeasure(report: Locator) {
  let last = await measure(report);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await report.page().waitForTimeout(300);
    const next = await measure(report);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  throw new Error(`the rail never stopped changing: ${JSON.stringify(last)}`);
}

test('"Report post or recipe" is a target at least 24px tall, and nothing around it moved for it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().route('https://example.supabase.co/**', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'Not answered offline' } }));

  await page.goto(POST_PATH);
  const report = page.getByTestId('canonical-post-actions').getByRole('button', { name: 'Report post or recipe' });
  await expect(report).toBeVisible(COLD_PAGE);

  const drawn = await settledMeasure(report);
  expect(drawn.targetHeight, JSON.stringify(drawn)).toBeGreaterThanOrEqual(24);
  expect(drawn.targetWidth, JSON.stringify(drawn)).toBeGreaterThanOrEqual(24);

  // The same rail with the button as it was drawn before, with no padding or margin of its own.
  await report.evaluate((button) => {
    button.style.setProperty('padding', '0', 'important');
    button.style.setProperty('margin', '0', 'important');
  });
  const asBefore = await settledMeasure(report);
  expect(asBefore.targetHeight, JSON.stringify(asBefore)).toBeLessThan(drawn.targetHeight);
  // Its icon and words, its row, Comments under it and the rail are where they were.
  expect({ ...drawn, targetHeight: null }).toEqual({ ...asBefore, targetHeight: null });
});
