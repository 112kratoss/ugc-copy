import { expect, test } from '@playwright/test';

/**
 * Kling O3 named multi-image subjects. The provider contract was live-verified
 * on 2026-08-24 (kling-3.0-omni/text-to-video, task
 * 7da3646b6a8362b9aa783c2176d0c71e); this spec covers the browser half that
 * vitest cannot reach: the grouping editor renders for O3 only, enforces the
 * 2–4 image range, and publishes @handles the prompt can mention.
 */
test.describe('Kling O3 named subjects', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  test('groups subject images and exposes their @handles for prompt mentions', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');

    const subjectsCard = page.getByRole('heading', { name: 'Named subjects' });
    await expect(subjectsCard).toBeVisible();

    await page.getByRole('button', { name: 'Add subject' }).click();

    const nameField = page.getByPlaceholder('Subject name');
    await expect(nameField).toHaveValue('Subject 1');
    // Empty subject is below the documented 2-image floor.
    await expect(page.getByText(/0\/4 images — add at least 2/)).toBeVisible();

    await nameField.fill('Hero creator');
    // The @handle is derived from the display name and is what the prompt mentions.
    await expect(page.getByText('@Hero_creator')).toBeVisible();

    const onePixelPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    // The subjects card owns the only multi-select image input on this screen.
    await page.locator('label input[type="file"][accept="image/*"][multiple]').first().setInputFiles([
      { name: 'hero-front.png', mimeType: 'image/png', buffer: onePixelPng },
      { name: 'hero-side.png', mimeType: 'image/png', buffer: onePixelPng },
    ]);

    // Two images satisfies the range, so the warning clears.
    await expect(page.getByText('2/4 images')).toBeVisible();
    await expect(page.getByText(/add at least 2/)).toHaveCount(0);
    await expect(page.getByText('Named subjects replace frames and reference images for this run.')).toBeVisible();
  });

  test('does not offer named subjects on other Kling models', async ({ page }) => {
    await page.goto('/create-video?model=kling-3.0-video');

    await expect(page.getByRole('heading', { name: 'Kling video elements' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Named subjects' })).toHaveCount(0);
  });
});
