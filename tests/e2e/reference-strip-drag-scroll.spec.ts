import { expect, test, type Page } from '@playwright/test';

/**
 * A mouse drags a creator's row of references sideways, as a finger swipes it (owner,
 * 2026-11-02: "can we enable the drag swipe for scrolling here"). A drag that starts on a
 * tile's picture or its Remove presses neither, and a press that does not move still opens
 * the picture. Vitest has no layout to scroll, so the row's own overflow is checked here.
 */

const COLD_PAGE = { timeout: 45_000 };
test.describe.configure({ timeout: 120_000 });

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** Offline the quote cannot be priced, so the page is given one. Its first request says the page's script runs. */
async function answerQuote(page: Page) {
  const asked: unknown[] = [];
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    asked.push(request);
    await route.fulfill({
      json: { modelId: request.modelId ?? 'unknown', catalogRevision: request.catalogRevision ?? 'unknown', normalizedSettings: {}, costCredits: 19 },
    });
  });
  return asked;
}

/** Presses at the middle of `box` and drags the mouse sideways by `dx`, in steps as a hand does. */
async function dragFrom(page: Page, box: { x: number; y: number; width: number; height: number }, dx: number) {
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test('a mouse drags the references row sideways, and a drag presses no picture and no Remove', async ({ page, context }) => {
  await context.addCookies([
    // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
    { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
  ]);
  await page.setViewportSize({ width: 1400, height: 900 });
  const quotes = await answerQuote(page);
  await page.goto('/create-video?model=seedance-2-5', COLD_PAGE);
  await expect.poll(() => quotes.length, COLD_PAGE).toBeGreaterThan(0);

  const references = page.getByRole('radio', { name: 'References' });
  if (!(await references.isChecked())) {
    await page.getByRole('group', { name: 'Inputs' }).getByText('References', { exact: true }).click();
  }
  await expect(references).toBeChecked();
  await page.getByLabel('Add images', { exact: true }).setInputFiles(
    ['one', 'two', 'three', 'four', 'five'].map((name) => ({ name: `${name}.png`, mimeType: 'image/png', buffer: ONE_PIXEL_PNG })),
  );
  const row = page.getByRole('list', { name: 'Reference images' });
  await expect(row.getByRole('listitem')).toHaveCount(5);
  // The column at its narrowest (Home on its width's grip), so the five pictures run well past the
  // row whatever width the layout gives the column: the drags below have room to scroll.
  await page.getByRole('separator', { name: 'Column width' }).press('Home');
  await expect.poll(() => row.evaluate((list) => list.scrollWidth - list.clientWidth)).toBeGreaterThan(220);
  // In the middle of the window, where a press lands on it (low in the column, the pictures sat under
  // the window's foot and the mouse pressed nothing). Added pictures scroll into view at the row's end;
  // the drags start from its start.
  await row.evaluate((list) => list.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await row.evaluate((list) => list.scrollTo({ left: 0, behavior: 'instant' }));
  await expect.poll(() => row.evaluate((list) => list.scrollLeft)).toBeLessThan(8);

  // A drag that starts on a picture scrolls the row and opens nothing.
  await dragFrom(page, (await row.getByRole('button', { name: 'Preview Element 2' }).boundingBox())!, -200);
  await expect.poll(() => row.evaluate((list) => list.scrollLeft)).toBeGreaterThan(100);
  await expect(page.getByRole('dialog', { name: 'Reference details' })).toHaveCount(0);

  // A drag that starts on a Remove scrolls back and removes nothing: one the row shows, since a tile
  // past its edge is clipped and a press there lands on something else.
  const rowBox = (await row.boundingBox())!;
  let removeBox: { x: number; y: number; width: number; height: number } | null = null;
  for (const remove of await row.getByRole('button', { name: /^Remove Element/ }).all()) {
    const box = await remove.boundingBox();
    if (box && box.x >= rowBox.x && box.x + box.width <= rowBox.x + rowBox.width) {
      removeBox = box;
      break;
    }
  }
  expect(removeBox).not.toBeNull();
  await dragFrom(page, removeBox!, 200);
  await expect.poll(() => row.evaluate((list) => list.scrollLeft)).toBeLessThan(50);
  await expect(row.getByRole('listitem')).toHaveCount(5);
  // Remove asks first (#732), so a pressed Remove would show its question rather than drop a tile.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  // A press that does not move still opens the picture, in its Reference details.
  await row.getByRole('button', { name: 'Preview Element 1' }).click();
  const details = page.getByRole('dialog', { name: 'Reference details' });
  await expect(details).toBeVisible();
  await expect(details.getByRole('textbox', { name: 'Reference name' })).toHaveValue('Element 1');
});
