import { expect, test, type Page } from '@playwright/test';

/**
 * Prices and affordability on the video creator (PR 2 of the redesign, owner 2026-10-28),
 * for the E2E account, which holds 25 credits:
 * - every option of the settings is priced, "+N" past the balance, and Top up takes
 *   Generate's place for a run past it;
 * - the model list prices every model at this run's settings and splits it by the balance;
 * - a picked model opens on this run's settings where it offers them;
 * - a remix the balance cannot cover stays on its original's model and settings, with
 *   Top up in Generate's place (owner, 2026-11-01);
 * - a balance short of every video is offered an image first.
 *
 * Offline nothing can be priced, so both quote routes are answered here, at production's
 * prices for Seedance 2 Mini (release mini-default-video-20261028).
 */

const COLD_PAGE = { timeout: 45_000 };
const PROMPT = 'A paper boat drifting across a sunlit pond, gentle ripples, soft morning light, slow push-in.';
const MINI_PER_LENGTH: Record<number, number> = { 4: 16, 5: 19, 6: 23, 7: 27, 8: 31, 9: 35, 10: 38, 11: 42, 12: 46, 13: 50, 14: 54, 15: 57 };

type Run = { kind?: string; modelId?: string; catalogRevision?: string; settings?: Record<string, unknown> };
type Prices = (run: Run) => number;

/** Production's Mini; Grok Imagine Video at 7; Seedance 2.5 at 28 a second; every other video at 14 a second. */
const pricesNearProduction: Prices = (run) => {
  const seconds = Number(run.settings?.duration ?? 5);
  if (run.kind === 'image') return run.modelId === 'z-image' ? 1 : 8;
  if (run.modelId === 'seedance-2-mini') return run.settings?.resolution === '720p' ? 41 : MINI_PER_LENGTH[seconds] ?? 4 * seconds;
  if (run.modelId === 'grok-imagine-video') return 7;
  if (run.modelId === 'seedance-2-5') return 28 * seconds;
  return 14 * seconds;
};

/** Both quote routes, answered by `prices`: the run's own price, and a price list's. */
async function answerQuotes(page: Page, prices: Prices) {
  const quote = (run: Run) => ({
    modelId: run.modelId ?? 'unknown',
    catalogRevision: run.catalogRevision ?? 'unknown',
    normalizedSettings: run.settings ?? {},
    costCredits: prices(run),
  });
  await page.route('**/api/generation-models/quote', (route) => route.fulfill({ json: quote(route.request().postDataJSON() as Run) }));
  await page.route('**/api/generation-models/quotes', (route) => {
    const { quotes } = route.request().postDataJSON() as { quotes: Run[] };
    return route.fulfill({ json: { quotes: quotes.map((run) => ({ ok: true, quote: quote(run) })) } });
  });
}

async function signIn(page: Page) {
  await page.context().addCookies([{ name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' }]);
}

function settingsChip(page: Page) {
  return page.getByRole('button', { name: /^Generation settings: / });
}

test('every setting and every model is priced against the balance, and a picked model keeps the run\'s settings', async ({ page }) => {
  await signIn(page);
  await answerQuotes(page, pricesNearProduction);

  await page.goto('/create-video', COLD_PAGE);
  // Typed only once the page's script runs, or hydration resets the field.
  await expect(page.getByRole('button', { name: 'Generate · 19 credits' })).toBeVisible(COLD_PAGE);
  await page.getByRole('textbox', { name: 'Prompt' }).fill(PROMPT);
  const note = page.locator('[data-creator-bar-note]');
  await expect(note).toContainText('Balance 25');
  await expect(note).toContainText('Leaves 6');
  await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 480P · 16:9 · 5s · Sound off');

  await settingsChip(page).click();
  const settings = page.getByRole('dialog', { name: 'Generation settings' });
  await expect(settings.getByRole('radio', { name: '6s, 23 credits' })).toBeVisible();
  await expect(settings.getByRole('radio', { name: '8s, 31 credits, 6 more than your balance' })).toContainText('31 · +6');
  await expect(settings).toContainText('This run 19 credits · leaves 6');
  await expect(settings).toContainText('Same price for each');

  // A run past the balance can still be set up; Top up stands in Generate's place.
  await settings.getByRole('radio', { name: /^8s/ }).click();
  await expect(page.getByRole('link', { name: /Top Up Credits/ })).toBeVisible();
  await expect(settings).toContainText('This run 31 credits · 6 more than your balance');
  await settings.getByRole('radio', { name: /^5s/ }).click();
  await settings.getByRole('radio', { name: '9:16' }).click();
  await settings.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Generate · 19 credits' })).toBeEnabled();

  await page.locator('button[aria-haspopup="listbox"]').click();
  const fits = page.getByRole('group', { name: 'Fits your 25 credits' });
  await expect(fits.getByRole('option', { name: /Seedance 2 Mini/ })).toContainText('19 credits480P · 5s');
  await expect(fits.getByRole('option', { name: /^Grok Imagine Video(?! 1\.5)/ })).toContainText('7 credits480P · 6s', COLD_PAGE);
  await expect(page.getByRole('group', { name: 'Needs more credits' }).getByRole('option', { name: /Seedance 2\.5/ }))
    .toContainText('140 credits480P · 5s');

  await fits.getByRole('option', { name: /^Grok Imagine Video(?! 1\.5)/ }).click();
  // The ratio carries over; the length becomes the nearest the model makes (Grok's start at 6s).
  await expect(settingsChip(page)).toHaveAccessibleName(/^Generation settings: 480P · 9:16 · 6s/);
  await expect(page.getByRole('button', { name: 'Generate · 7 credits' })).toBeEnabled();
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(PROMPT);
});

test('a remix the balance cannot cover stays on its original, with Top up in Generate\'s place', async ({ page }) => {
  await signIn(page);
  await answerQuotes(page, pricesNearProduction);
  await page.route('**/api/remix-source**', (route) => route.fulfill({
    json: {
      generation: { id: 'gen-intense', title: 'intense', prompt: PROMPT, category: 'video', model: 'seedance-2-5' },
      result: { mediaType: 'video', url: 'https://example.com/intense.mp4' },
      inputs: { video: { referenceMode: 'frames', startFrame: null, endFrame: null, elements: [], referenceVideos: [], referenceAudios: [] } },
      workflowSettings: { model: 'seedance-2-5', aspectRatio: '9:16', resolution: '480p', duration: 5, sound: false },
      restoreIssues: [],
    },
  }));

  // Every run the page asks a price list for: a remix weighed against other models asks for theirs.
  const listed: Run[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/generation-models/quotes') {
      listed.push(...(request.postDataJSON() as { quotes: Run[] }).quotes);
    }
  });

  await page.goto('/create-video?remix=gen-intense&remixPost=post-intense', COLD_PAGE);

  await expect(page.getByText('Settings pre-filled from "intense".')).toBeVisible(COLD_PAGE);
  await expect(page.getByRole('link', { name: /Top Up Credits/ })).toHaveAttribute('href', '/pricing', COLD_PAGE);
  await expect(page.locator('[data-creator-bar-status]')).toContainText('This run costs 140 credits but you only have 25.');
  // The settings' options are priced by a price list, so once their "+N" line shows, a list has
  // been asked and answered. The fitting this replaced moved a short remix within a second of
  // its price: by the end of this wait it would have asked for other models and moved.
  await settingsChip(page).click();
  await expect(page.getByRole('dialog', { name: 'Generation settings' })).toContainText('show Top up in place of Generate', COLD_PAGE);
  await page.waitForTimeout(3_000);
  expect([...new Set(listed.filter((run) => run.kind === 'video').map((run) => run.modelId))]).toEqual(['seedance-2-5']);
  await expect(settingsChip(page)).toHaveAccessibleName('Generation settings: 480P · 9:16 · 5s · Sound off');
  await expect(page.locator('button[aria-haspopup="listbox"]')).toContainText('Seedance 2.5');
  await expect(page.getByRole('link', { name: /Top Up Credits/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Generate · / })).toHaveCount(0);
  await expect(page.getByText(/Fitted to your/)).toHaveCount(0);
});

test('a balance short of every video is offered an image first, with the prompt', async ({ page }) => {
  await signIn(page);
  // Every video costs more than the 25 credits; an image costs 1 on Z-Image.
  await answerQuotes(page, (run) => (run.kind === 'image' ? pricesNearProduction(run) : 30 + pricesNearProduction(run)));

  await page.goto('/create-video', COLD_PAGE);
  await expect(page.getByRole('link', { name: /Top Up Credits|Make an image instead/ })).toBeVisible(COLD_PAGE);
  await page.getByRole('textbox', { name: 'Prompt' }).fill(PROMPT);

  const offer = page.getByRole('link', { name: 'Make an image instead · from 1 credit' });
  await expect(offer).toBeVisible(COLD_PAGE);
  await expect(page.locator('[data-creator-bar-note]')).toContainText('Balance 25 · videos from 37');
  await expect(page.getByText('25 credits: enough for images')).toBeVisible();

  await offer.click();
  await expect(page).toHaveURL(/\/create-image\?model=z-image&prompt=/, COLD_PAGE);
  await expect(page.getByRole('textbox', { name: 'Prompt' })).toHaveValue(PROMPT, COLD_PAGE);
});
