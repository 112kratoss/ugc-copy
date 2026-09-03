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

/**
 * How many subjects the draft store currently holds. Reads localforage's own
 * layout for `PERSISTED_MEDIA_KEYS.createVideoKlingSubjects` — database
 * `magicbooklet-persisted-media`, object store `keyvaluepairs` — creating
 * neither, so probing cannot disturb what the app stores.
 *
 * The editor persists fire-and-forget (`void persistKlingSubjects(...)` in
 * CreateVideoClient), so the DOM settles a beat before IndexedDB does. Waiting
 * on the store is what makes a reload assertion mean anything: reload mid-write
 * and the reload tests nothing in particular, while an editor found empty
 * afterwards may simply not have restored *yet*.
 */
async function countPersistedSubjects(page: Page): Promise<number> {
  try {
    return await readPersistedSubjectCount(page);
  } catch (error) {
    // A dev server reload (see below) can tear the execution context down
    // mid-read. `expect.poll` re-throws whatever its generator throws, so
    // answer "unknown" and let the next poll ask the fresh document.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return -1;
    }
    throw error;
  }
}

function readPersistedSubjectCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'magicbooklet-persisted-media')) return 0;

    return new Promise<number>((resolve, reject) => {
      const open = indexedDB.open('magicbooklet-persisted-media');
      open.onerror = () => reject(open.error ?? new Error('could not open the persisted media store'));
      open.onsuccess = () => {
        const database = open.result;
        if (!database.objectStoreNames.contains('keyvaluepairs')) {
          database.close();
          resolve(0);
          return;
        }
        const read = database
          .transaction('keyvaluepairs', 'readonly')
          .objectStore('keyvaluepairs')
          .get('create-video:kling-subjects');
        read.onerror = () => {
          database.close();
          reject(read.error ?? new Error('could not read the persisted subjects'));
        };
        read.onsuccess = () => {
          database.close();
          resolve(Array.isArray(read.result) ? read.result.length : 0);
        };
      };
    });
  });
}

/**
 * Reload, tolerating the dev server reloading the page out from under us.
 *
 * `next dev` tells every open page to `window.location.reload()` whenever a
 * Fast Refresh update cannot be hot-applied, and CI runs two Playwright workers
 * against one dev server that is still compiling routes on demand — so this
 * page navigates itself several times a minute through no doing of the test's.
 * A self-reload that lands in the same tick as ours cancels ours, and Playwright
 * surfaces that as `page.reload: net::ERR_ABORTED` (Quality run 33009507821).
 *
 * Both navigations go to the same URL and this page's state lives in IndexedDB
 * rather than in memory, so letting the dev server's reload finish and then
 * reloading again is equivalent to the reload that was cancelled.
 */
async function reloadPastDevServerReloads(page: Page) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.reload();
      return;
    } catch (error) {
      const wasCancelled = error instanceof Error && error.message.includes('net::ERR_ABORTED');
      if (!wasCancelled || attempt === 3) throw error;
      await page.waitForLoadState('load');
    }
  }
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
    // The handle now shows in two places: the subjects editor's own chip and the
    // @-mention quick-insert row beside the prompt, which O3 reaches now that its
    // reference capacity is no longer reported as zero.
    await expect(page.getByText('@Hero_creator').first()).toBeVisible();

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
    // Reloading before the group reaches storage would prove nothing about it.
    await expect.poll(() => countPersistedSubjects(page)).toBe(1);

    await reloadPastDevServerReloads(page);

    // The whole group comes back — name, handle, and both images.
    await expect(page.getByPlaceholder('Subject name')).toHaveValue('Hero creator');
    // The handle now shows in two places: the subjects editor's own chip and the
    // @-mention quick-insert row beside the prompt, which O3 reaches now that its
    // reference capacity is no longer reported as zero.
    await expect(page.getByText('@Hero_creator').first()).toBeVisible();
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
    // Forgotten in storage too, not just on screen — and with the store empty
    // before the reload, an editor that comes back empty can only have stayed
    // that way, rather than having been asserted a beat ahead of a restore.
    await expect.poll(() => countPersistedSubjects(page)).toBe(0);

    await reloadPastDevServerReloads(page);
    await expect(page.getByRole('heading', { name: 'Named subjects' })).toBeVisible();
    await expect(page.getByPlaceholder('Subject name')).toHaveCount(0);
  });

  test('does not offer named subjects on other Kling models', async ({ page }) => {
    await page.goto('/create-video?model=kling-3.0-video');

    await expect(page.getByRole('heading', { name: 'Kling video elements' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Named subjects' })).toHaveCount(0);
  });
});
