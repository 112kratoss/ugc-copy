import { expect, test, type Page } from '@playwright/test';

// The workflow library, for an account with no workflows (live sweep of 941e2a55b, 2026-11-17):
//
// - While the list loaded, three 365px cards pulsed in the list's place, then the "Build your first
//   workflow" box, of another shape and height, took it. The loading state now promises only the
//   place: a box the empty state's size, whatever comes.
// - The Sort box (a 335x48 bordered field on a phone) opened its picker only on its words: the
//   select inside was 133x19 and the rest of the box did nothing when pressed. The select now
//   fills the box.

// In `next dev` the route compiles on its first request, and the library's chunk on its first use.
const COLD_PAGE = { timeout: 45_000 };
const LIST_DELAY_MS = 900;

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
});

/** No workflows, answered after a delay, as production answers the list. */
async function answerNoWorkflows(page: Page) {
  await page.route('**/api/workflow-canvases', async (route) => {
    if (route.request().method() !== 'GET') return route.abort();
    await new Promise((resolve) => setTimeout(resolve, LIST_DELAY_MS));
    return route.fulfill({ json: { canvases: [] } });
  });
}

type Frame = { t: number; top: number; height: number; heading: string | null };

/**
 * Records every frame whose drawing of the list's place, the element after the library's controls,
 * differs from the last: where it starts, how tall it is, and the heading it holds.
 */
const RECORDER = `(() => {
  const frames = [];
  window.__libraryFrames = frames;
  let last = '';
  function sample() {
    const controls = document.querySelector('section[aria-label="Workflow controls"]');
    const place = controls && controls.nextElementSibling;
    if (place && place.getClientRects().length > 0) {
      const box = place.getBoundingClientRect();
      const heading = place.querySelector('h2');
      const frame = {
        top: Math.round(box.top + window.scrollY),
        height: Math.round(box.height),
        heading: heading ? heading.textContent.trim() : null,
      };
      const key = JSON.stringify(frame);
      if (key !== last) {
        last = key;
        frames.push({ t: Math.round(performance.now()), ...frame });
      }
    }
    if (!window.__libraryFramesDone) requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
})();`;

async function recordedFrames(page: Page): Promise<Frame[]> {
  return page.evaluate(() => {
    const record = window as unknown as { __libraryFrames: Frame[]; __libraryFramesDone?: boolean };
    record.__libraryFramesDone = true;
    return record.__libraryFrames;
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
  test(`with no workflows, the list's place keeps its size from loading to the empty state at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await answerNoWorkflows(page);
    await page.addInitScript(RECORDER);
    await page.goto('/create-workflow', COLD_PAGE);
    const empty = page.getByRole('heading', { name: 'Build your first workflow' });
    await expect(empty).toBeVisible(COLD_PAGE);

    // The measured load: the route and the library are compiled, so its frames are a visit's.
    await page.reload();
    await expect(empty).toBeVisible(COLD_PAGE);
    const frames = await recordedFrames(page);

    const final = frames[frames.length - 1];
    expect(final.heading).toBe('Build your first workflow');
    const loading = frames.filter((frame) => frame.heading === null);
    expect(loading.length, 'the loading state was drawn').toBeGreaterThan(0);
    for (const frame of frames) {
      const shown = `${JSON.stringify(frame)}, empty state ${JSON.stringify(final)}`;
      expect(Math.abs(frame.top - final.top), shown).toBeLessThanOrEqual(1);
      expect(Math.abs(frame.height - final.height), shown).toBeLessThanOrEqual(1);
    }
  });
}

for (const viewport of [{ width: 375, height: 812 }, { width: 1440, height: 900 }]) {
  test(`the whole Sort box opens the picker, not only its words, at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await answerNoWorkflows(page);
    await page.goto('/create-workflow', COLD_PAGE);
    await expect(page.getByRole('heading', { name: 'Build your first workflow' })).toBeVisible(COLD_PAGE);
    const sort = page.getByRole('combobox', { name: 'Sort workflows' });
    await expect(sort).toBeVisible();

    // A native select opens its picker on a press on itself; a press on the box around it only
    // focuses it. So every point of the bordered box, its icon and its padding included, must be the
    // select's.
    const misses = await sort.evaluate((select) => {
      const box = select.closest('label')!.getBoundingClientRect();
      const points: Array<[number, number]> = [];
      for (const fx of [0.02, 0.1, 0.25, 0.5, 0.75, 0.9, 0.98]) {
        for (const fy of [0.12, 0.5, 0.88]) points.push([box.left + box.width * fx, box.top + box.height * fy]);
      }
      return points
        .filter(([x, y]) => document.elementFromPoint(x, y) !== select)
        .map(([x, y]) => {
          const hit = document.elementFromPoint(x, y);
          return `(${Math.round(x - box.left)}, ${Math.round(y - box.top)}) of ${Math.round(box.width)}x${Math.round(box.height)}: ${hit ? hit.tagName.toLowerCase() : 'nothing'}`;
        });
    });
    expect(misses).toEqual([]);

    // It still sorts, and keeps the order in the address.
    await sort.selectOption('name');
    await expect(page).toHaveURL(/[?&]sort=name(&|$)/);
  });
}
