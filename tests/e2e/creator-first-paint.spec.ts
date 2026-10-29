import { expect, test, type Page } from '@playwright/test';

/**
 * A creator's first paint is the run the published catalog opens it on (2026-10-29).
 *
 * The pages drew a stand-in form until their catalog came back from the network, Kling 3.0's in the
 * video and motion creators. On magicbooklet.com the video creator's chip read "Kling 3.0 Cinematic"
 * for two to three seconds before Seedance 2 Mini, the default since 2026-10-28, took over with its
 * price, and the motion creator's swapped Kling 3.0 for Kling 2.6. The server now hands each
 * creator the model it opens on, that model's published settings and the run's price
 * (`loadCreatorOpening`).
 *
 * With scripts off the page is the server's HTML, which is what a browser paints before any script
 * runs. The E2E server reads the code catalog (GENERATION_MODEL_CATALOG_SOURCE is unset outside
 * production), whose defaults and prices are production's, and the server stub's welcome grant of
 * 25 credits.
 */

const COLD_PAGE = { timeout: 45_000 };

const modelChip = (page: Page) => page.getByRole('main').locator('button[aria-haspopup="listbox"]').first();
const settingsChip = (page: Page) => page.getByRole('main').getByRole('button', { name: /^Generation settings: / });
const barNote = (page: Page) => page.getByRole('main').locator('[data-creator-bar-note]');

test.describe('scripts off: the server’s HTML', () => {
  test.use({ javaScriptEnabled: false });

  test('the video creator opens on the catalog default, priced', async ({ page }) => {
    await page.goto('/create-video', COLD_PAGE);

    await expect(modelChip(page)).toHaveText('Seedance 2 Mini');
    await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 480P · 16:9 · 5s · Sound off');
    await expect(barNote(page)).toHaveText('New accounts get 25 free creditsThis run 19 · leaves 6');
  });

  test('a link to a model opens on that model, at its own settings and price', async ({ page }) => {
    await page.goto('/create-video?model=kling-3.0-video&aspectRatio=9:16', COLD_PAGE);

    await expect(modelChip(page)).toHaveText('Kling 3.0 Cinematic');
    // The link's ratio, Kling 3.0's own mode and length; its price is past the welcome credits.
    await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 720P · 9:16 · 5s · Sound off');
    await expect(barNote(page)).toHaveText('New accounts get 25 free creditsThis run 70');
  });

  test('the motion creator opens on the catalog default', async ({ page }) => {
    await page.goto('/create-motion', COLD_PAGE);

    await expect(modelChip(page)).toHaveText('Kling 2.6Stable');
    await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 720P · Add motion');
  });

  test('a link with a ratio opens the image creator on it, priced', async ({ page }) => {
    // The /create image starter's link.
    await page.goto('/create-image?model=nano-banana-2&aspectRatio=4:5', COLD_PAGE);

    await expect(modelChip(page)).toHaveText('Nano Banana 2.0Recommended');
    await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 1K · 4:5 · JPG');
    await expect(barNote(page)).toHaveText(/^New accounts get 25 free creditsThis run \d+ · leaves \d+$/);
  });

  test('the image creator opens on the catalog default, priced', async ({ page }) => {
    await page.goto('/create-image', COLD_PAGE);

    await expect(modelChip(page)).toHaveText('Nano Banana 2.0Recommended');
    // The output format is the descriptor's, which the page reads with its catalog: the opening's until then.
    await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 1K · AUTO · JPG');
    await expect(barNote(page)).toHaveText('New accounts get 25 free creditsThis run 8 · leaves 17');
  });
});

test('the video creator keeps the default from its first paint through its first pick', async ({ page }) => {
  // Every model the chip names, from the moment the document starts to parse.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { chipNames: string[] }).chipNames = seen;
    const read = () => {
      const chip = document.querySelector('main button[aria-haspopup="listbox"]');
      const name = chip?.textContent?.trim();
      if (name && seen.at(-1) !== name) seen.push(name);
    };
    new MutationObserver(read).observe(document, { childList: true, subtree: true, characterData: true });
  });
  // Offline the page's own quote cannot be priced; the server's answer for this run is 19.
  const quoted: Array<{ modelId?: string; settings?: Record<string, unknown> }> = [];
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string; settings?: Record<string, unknown> };
    quoted.push(request);
    await route.fulfill({
      json: { modelId: request.modelId, catalogRevision: request.catalogRevision, normalizedSettings: {}, costCredits: 19 },
    });
  });

  await page.goto('/create-video', COLD_PAGE);
  // The first pick is done once the page asks its own price: it waits for the catalog the network confirms.
  await expect.poll(() => quoted.length, COLD_PAGE).toBeGreaterThan(0);
  await expect(barNote(page)).toHaveText('New accounts get 25 free creditsThis run 19 · leaves 6');
  expect(quoted[0]).toMatchObject({ modelId: 'seedance-2-mini', settings: { resolution: '480p', aspectRatio: '16:9', duration: 5, sound: false } });

  expect(await page.evaluate(() => (window as unknown as { chipNames: string[] }).chipNames)).toEqual(['Seedance 2 Mini']);
});
