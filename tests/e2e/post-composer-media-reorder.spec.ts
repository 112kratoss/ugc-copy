import { expect, test } from '@playwright/test';
import path from 'node:path';

// The media reorder is a pointer gesture: pick a card up, carry it, drop it in a
// slot. jsdom can assert the handlers ran, but only a real browser exercises
// pointer capture, touch-action and the transform actually painting — so this
// runs the interaction the way a person performs it.
const MEDIA_ROW = '[aria-label="Post media order"]';

async function seedComposerWithTwoImages(page: import('@playwright/test').Page) {
  await page.goto('/post/new');
  await page.setInputFiles('input[type="file"]', [
    path.join(__dirname, 'fixtures/red.png'),
    path.join(__dirname, 'fixtures/blue.png'),
  ]);
  await expect(page.locator(`${MEDIA_ROW} > div`)).toHaveCount(2);
}

/** Cards are keyed by their preview alt text, which is positional. */
async function slotAlts(page: import('@playwright/test').Page) {
  return page.locator(`${MEDIA_ROW} > div img`).evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLImageElement).alt)
  );
}

test.describe('post composer media reorder', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('carrying a card a full slot reorders it', async ({ page }) => {
    await seedComposerWithTwoImages(page);
    expect(await slotAlts(page)).toEqual(['Media 1', 'Media 2']);

    const second = page.locator(`${MEDIA_ROW} > div`).nth(1);
    const box = (await second.boundingBox())!;
    const y = box.y + box.height / 2;
    const startX = box.x + box.width / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    // A slot is 124px; move past it in steps so pointermove actually fires.
    await page.mouse.move(startX - 60, y, { steps: 5 });
    await page.mouse.move(startX - 140, y, { steps: 5 });
    await page.mouse.up();

    await expect
      .poll(async () => (await slotAlts(page))[0])
      .toBe('Media 1');
    // The carried card now sits in the cover slot.
    await expect(page.locator(`${MEDIA_ROW} > div`).first()).toContainText('Cover');
  });

  test('a short carry settles back without reordering', async ({ page }) => {
    await seedComposerWithTwoImages(page);

    const second = page.locator(`${MEDIA_ROW} > div`).nth(1);
    const box = (await second.boundingBox())!;
    const y = box.y + box.height / 2;
    const startX = box.x + box.width / 2;

    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 30, y, { steps: 4 });
    await page.mouse.up();

    // Under half a slot, so it returns to where it started and clears its offset.
    // Clearing the transform drops the style attribute entirely, so read the
    // inline value rather than asserting on the attribute.
    await expect
      .poll(async () => second.evaluate((node) => (node as HTMLElement).style.transform))
      .toBe('');
    expect(await slotAlts(page)).toEqual(['Media 1', 'Media 2']);
  });

  test('pressing remove does not pick the card up', async ({ page }) => {
    await seedComposerWithTwoImages(page);

    await page.getByRole('button', { name: /remove media 1/i }).click();
    await expect(page.locator(`${MEDIA_ROW} > div`)).toHaveCount(1);
  });
});
