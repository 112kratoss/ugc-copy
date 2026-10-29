import { expect, test, type Page } from '@playwright/test';

/**
 * Every reference input a video model declares can be reached, behind the inputs' switch
 * (the artboard Inputs, PR 4 of the creator redesign): frames on one side, the reference
 * groups on the other.
 *
 * The bug this covers was invisible to vitest for the reason the whole class is: the
 * reference slots were never *absent from the data*, only unreachable in the browser.
 * Capacity was read off the slots active for the current mode, so the picker that
 * entered the reference mode was hidden until you were already in it, and Seedance 2.5
 * rendered none of the 10 video and 10 audio reference slots it publishes.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function inputs(page: Page) {
  return page.getByRole('group', { name: 'Inputs' });
}

/**
 * Attaches a start image once the page answers for it. A file set before the page's script
 * runs is dropped (the old ":51" flake attached one before hydration), so it is set again
 * until the picture shows.
 */
async function attachStartImage(page: Page) {
  await expect(async () => {
    await page.locator('#video-start-frame-input').setInputFiles({ name: 'start.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG });
    await expect(page.getByAltText('Start image', { exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test.describe('video reference slots', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('Seedance 2.5 opens on frames, and References shows every reference group', async ({ page }) => {
    await page.goto('/create-video?model=seedance-2-5');

    await expect(inputs(page).getByRole('radio', { name: 'Frames' })).toBeChecked();
    await expect(page.getByRole('heading', { name: /^Start image/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^End image/ })).toBeVisible();

    await inputs(page).getByText('References', { exact: true }).click();
    await expect(inputs(page).getByRole('radio', { name: 'References' })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Reference images' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reference videos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reference audio' })).toBeVisible();
    // The old locked card and its notes are gone.
    await expect(page.getByText(/cannot combine|takes either frames or references/i)).toHaveCount(0);
  });

  test('a start image holds Seedance 2.5 on frames until the switch’s question is answered', async ({ page }) => {
    await page.goto('/create-video?model=seedance-2-5');
    await expect(inputs(page)).toBeVisible();
    await attachStartImage(page);

    await inputs(page).getByText('References', { exact: true }).click();
    const question = page.getByRole('alertdialog', { name: 'Switch to references?' });
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: 'Keep frames' }).click();

    await expect(question).toHaveCount(0);
    await expect(inputs(page).getByRole('radio', { name: 'Frames' })).toBeChecked();
    await expect(page.getByRole('heading', { name: 'Reference videos' })).toHaveCount(0);
  });

  test('Wan 2.7 keeps its start image beside its references, because its r2v endpoint takes both', async ({ page }) => {
    await page.goto('/create-video?model=wan-2.7');
    await expect(inputs(page)).toBeVisible();
    await attachStartImage(page);

    await inputs(page).getByText('References', { exact: true }).click();
    // Nothing to clear, so nothing is asked: wan/2-7-r2v accepts first_frame alongside reference_image.
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(inputs(page).getByRole('radio', { name: 'References' })).toBeChecked();
    await expect(page.getByAltText('Start image', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reference images' })).toBeVisible();
  });
});
