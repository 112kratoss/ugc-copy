import { expect, test, type Page } from '@playwright/test';

/**
 * Every reference input a video model declares is on screen at once, and the pair a
 * provider cannot combine greys the other out.
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

async function attachStartFrame(page: Page) {
  await page.locator('#video-start-frame-input').setInputFiles({
    name: 'start.png',
    mimeType: 'image/png',
    buffer: ONE_PIXEL_PNG,
  });
}

test.describe('video reference slots', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('Seedance 2.5 shows frames and every reference group together', async ({ page }) => {
    await page.goto('/create-video?model=seedance-2-5');

    // The frame slots and all three reference groups, with nothing attached and no
    // mode to switch first.
    await expect(page.getByRole('heading', { name: 'Start Frame' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Video and audio references' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reference videos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reference audio' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reusable image references' })).toBeVisible();

    // No reference-mode picker survives.
    await expect(page.getByRole('button', { name: 'Reusable references' })).toHaveCount(0);
    await expect(page.getByText(/takes either frames or references/i)).toBeVisible();
  });

  test('attaching a frame greys the reference groups rather than hiding them', async ({ page }) => {
    await page.goto('/create-video?model=seedance-2-5');
    await expect(page.getByRole('heading', { name: 'Reference videos' })).toBeVisible();

    await attachStartFrame(page);

    // Kie documents frames and references as mutually exclusive scenarios for this
    // model, so the group locks — but stays readable, so the capability is still
    // discoverable while unavailable.
    await expect(page.getByText(/cannot combine references with frames/i)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reference videos' })).toBeVisible();
    const locked = page.locator('[aria-disabled="true"]');
    await expect(locked.first()).toBeVisible();
  });

  test('Wan 2.7 keeps both groups live, because its r2v endpoint takes both', async ({ page }) => {
    await page.goto('/create-video?model=wan-2.7');

    await expect(page.getByRole('heading', { name: 'Reusable image references' })).toBeVisible();
    await expect(page.getByText(/takes either frames or references/i)).toHaveCount(0);

    await attachStartFrame(page);
    // Still no lock: wan/2-7-r2v accepts first_frame alongside reference_image.
    await expect(page.locator('[aria-disabled="true"]')).toHaveCount(0);
  });
});
