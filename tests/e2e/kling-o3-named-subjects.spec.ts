import { expect, test, type Page } from '@playwright/test';

/**
 * Kling O3 named multi-image subjects. The provider contract was live-verified
 * on 2026-08-24 (kling-3.0-omni/text-to-video, task
 * 7da3646b6a8362b9aa783c2176d0c71e); this spec covers the browser half that
 * vitest cannot reach: the grouping editor renders for O3 only, enforces the
 * 2–4 image range, publishes @handles the prompt can mention, and survives a
 * reload through IndexedDB draft persistence.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function attachSubjectImages(page: Page, names: string[]) {
  // The subjects card owns the only multi-select image input on this screen.
  await page.locator('label input[type="file"][accept="image/*"][multiple]').first().setInputFiles(
    names.map((name) => ({ name, mimeType: 'image/png', buffer: ONE_PIXEL_PNG })),
  );
}

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

    await attachSubjectImages(page, ['hero-front.png', 'hero-side.png']);

    // Two images satisfies the range, so the warning clears.
    await expect(page.getByText('2/4 images')).toBeVisible();
    await expect(page.getByText(/add at least 2/)).toHaveCount(0);
    await expect(page.getByText('Named subjects replace frames and reference images for this run.')).toBeVisible();
  });

  test('restores grouped subjects after a reload', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');

    await page.getByRole('button', { name: 'Add subject' }).click();
    await page.getByPlaceholder('Subject name').fill('Hero creator');
    await attachSubjectImages(page, ['hero-front.png', 'hero-side.png']);
    await expect(page.getByText('2/4 images')).toBeVisible();

    await page.reload();

    // The whole group comes back — name, handle, and both images.
    await expect(page.getByPlaceholder('Subject name')).toHaveValue('Hero creator');
    await expect(page.getByText('@Hero_creator')).toBeVisible();
    await expect(page.getByText('2/4 images')).toBeVisible();
  });

  test('forgets subjects once the last one is removed', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');

    await page.getByRole('button', { name: 'Add subject' }).click();
    await attachSubjectImages(page, ['hero-front.png', 'hero-side.png']);
    await expect(page.getByText('2/4 images')).toBeVisible();

    // The subject's own remove control, not the per-image ones.
    await page.getByRole('button', { name: 'Remove Subject 1', exact: true }).click();
    await expect(page.getByPlaceholder('Subject name')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Named subjects' })).toBeVisible();
    await expect(page.getByPlaceholder('Subject name')).toHaveCount(0);
  });

  test('does not offer named subjects on other Kling models', async ({ page }) => {
    await page.goto('/create-video?model=kling-3.0-video');

    await expect(page.getByRole('heading', { name: 'Kling video elements' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Named subjects' })).toHaveCount(0);
  });
});
