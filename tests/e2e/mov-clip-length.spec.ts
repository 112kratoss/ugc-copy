import fs from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * The video page reads a QuickTime clip's length (2026-10-31).
 *
 * Chrome types a picked .mov, what an iPhone exports, video/quicktime and answers '' for that type
 * in canPlayType, yet reads the file's metadata as it reads an MP4's. The page's length reader gave
 * up on an empty answer without loading the file, so on Chrome every .mov had no length: a Kling 3.0
 * video element under 3 seconds was not held before Generate, and a Seedance reference clip, whose
 * slot needs every clip's length, could not be priced. jsdom has no media pipeline, so only a
 * browser shows which files it reads.
 */

const COLD_PAGE = { timeout: 45_000 };
// Two seconds of ffmpeg's test pattern, H.264 in a QuickTime container, 64x36. It goes in as the
// file a Mac or Windows Chrome hands the page, typed video/quicktime, whatever the runner's own
// table says of .mov.
const CLIP = { name: 'clip-2s.mov', mimeType: 'video/quicktime', buffer: fs.readFileSync(path.join(__dirname, 'fixtures/clip-2s.mov')) };

type QuoteRequest = { inputMetadata?: { slots?: Record<string, { durationsSeconds?: number[] }> } };

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
    { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
  ]);
});

/** Every price question the page asks, as it asked it. */
function recordQuotes(page: Page) {
  const asked: QuoteRequest[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/generation-models/quote') asked.push(request.postDataJSON() ?? {});
  });
  return asked;
}

/**
 * Waits for the page's first price question. Only the page's script asks it, once the model's
 * catalog details are in, so a press or a pick after it is not dropped by a hydration a compile
 * still holds (.claude/rules/e2e.md), and the clip's slot already knows its shortest length.
 */
async function pageAsked(asked: readonly QuoteRequest[]) {
  await expect.poll(() => asked.length, { ...COLD_PAGE, message: 'the page asks for its quote once its script runs' }).toBeGreaterThan(0);
}

test('a 2 s .mov video element holds Kling 3.0 before Generate', async ({ page }) => {
  const asked = recordQuotes(page);
  await page.goto('/create-video?model=kling-3.0-video', COLD_PAGE);
  await pageAsked(asked);

  await page.locator('input[type="file"][accept="video/mp4,video/quicktime,.mp4,.mov"]').setInputFiles(CLIP);

  // Unread, the card said "MP4 or MOV, 50MB max" and nothing held the run.
  await expect(page.getByRole('button', { name: 'Preview Video element 1', exact: true })).toBeVisible();
  await expect(page.getByText('2.0s clip', { exact: true })).toBeVisible();
  await expect(page.getByText(
    'Kling 3.0 Cinematic video elements must be at least 3 seconds long. Video element 1 runs 2 seconds.',
    { exact: true },
  )).toBeVisible();
});

test('a .mov reference clip gives Seedance 2 its length to price', async ({ page }) => {
  const asked = recordQuotes(page);
  await page.goto('/create-video?model=seedance-2', COLD_PAGE);
  await pageAsked(asked);
  await page.getByRole('group', { name: 'Inputs' }).getByText('References', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reference videos' })).toBeVisible();

  await page.locator('input[type="file"][accept="video/*"][multiple]').setInputFiles(CLIP);

  // Unread, the card said "Duration unavailable" and the quote refused the run: "Reference videos
  // requires duration metadata for every asset." The clip's name shows twice (its card and the
  // Seedance assets panel); the remove button is the card's.
  await expect(page.getByRole('button', { name: 'Remove Video reference 1', exact: true })).toBeVisible();
  await expect(page.getByText('2.0s clip', { exact: true })).toBeVisible();
  await expect.poll(() => asked.at(-1)?.inputMetadata?.slots?.videoReferences?.durationsSeconds ?? null).toEqual([2]);
});
