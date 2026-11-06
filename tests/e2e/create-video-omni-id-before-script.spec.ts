import { expect, test, type Page } from '@playwright/test';

/**
 * A prepared Gemini Omni ID pasted into the video creator before the page's script has run is the
 * one Enter adds (2026-11-06).
 *
 * The server's HTML draws the Omni panel's ID fields before any script runs (signed out, with the
 * model in the link), so on a slow connection a visitor can paste an ID first. React never hears
 * that, and this React build hydrates an input without reading its value back: the field showed
 * the ID while the page's state stayed empty, so Enter or Add read nothing ("Enter a valid
 * prepared voice ID.") and the render that followed emptied the field (as on /login,
 * login-typed-before-script.spec.ts).
 *
 * The page's own chunk is held until both IDs are pasted. The page's first quote request is the
 * sign its script has run (creator-signed-out.spec.ts): only its mount asks for one.
 */

const COLD_PAGE = { timeout: 45_000 };
const PATH = '/create-video?model=gemini-omni-video';
const VOICE_ID = 'voice_prepared-early.01';
const CHARACTER_ID = 'character_prepared-early.02';

/** Holds the page's own script chunk until `release`; every request for it waits. */
async function holdPageChunk(page: Page) {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chunk = { requests: 0 };
  await page.route(/\/_next\/static\/chunks\/app\/create-video\/page\.js(\?|$)/, async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return { requests: () => chunk.requests, release: () => release() };
}

/** Offline the quote cannot be priced, so the page is given one. Returns how many the page asked for. */
async function answerQuote(page: Page) {
  const asked = { count: 0 };
  await page.route('**/api/generation-models/quote', async (route) => {
    asked.count += 1;
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    await route.fulfill({
      json: { modelId: request.modelId ?? 'unknown', catalogRevision: request.catalogRevision ?? 'unknown', normalizedSettings: {}, costCredits: 8 },
    });
  });
  return () => asked.count;
}

test(`/create-video: Omni IDs pasted before the page's script runs are the ones Enter and Add take`, async ({ page }) => {
  test.setTimeout(150_000);
  const quotes = await answerQuote(page);
  const chunk = await holdPageChunk(page);

  // No timeout of its own: the run's first request for the route waits for its compile.
  await page.goto(PATH, { waitUntil: 'commit' });
  const panel = page.getByRole('group', { name: 'Prepared Omni references' });
  const voice = panel.getByRole('textbox', { name: 'Gemini Omni audio ID' });
  const character = panel.getByRole('textbox', { name: 'Gemini Omni character ID' });
  await expect(voice).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the pasting below would reach a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(0);
  await voice.fill(VOICE_ID);
  await character.fill(CHARACTER_ID);
  chunk.release();

  await expect.poll(quotes, { ...COLD_PAGE, message: 'the page asks for its first quote' }).toBeGreaterThan(0);
  await expect(voice).toHaveValue(VOICE_ID);
  await expect(character).toHaveValue(CHARACTER_ID);

  await voice.press('Enter');
  await panel.getByRole('button', { name: 'Add' }).nth(1).click();

  await expect(panel.locator('code', { hasText: VOICE_ID })).toBeVisible();
  await expect(panel.locator('code', { hasText: CHARACTER_ID })).toBeVisible();
  await expect(page.getByText(/Enter a valid prepared (voice|character) ID\./)).toHaveCount(0);
  await expect(voice).toHaveValue('');
  await expect(character).toHaveValue('');
});
