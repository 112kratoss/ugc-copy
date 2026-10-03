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

/**
 * Runs `steps` on a page that has one subject called `name`, and runs them again
 * from the top when a dev server reload (see above) interrupts them. A subject
 * with no images is not saved, and a prompt never is, so such a reload empties
 * both and the steps have to start over.
 */
async function withNamedSubject(page: Page, name: string, steps: () => Promise<void>) {
  await expect(async () => {
    const nameField = page.getByPlaceholder('Subject name');
    if (await nameField.count() === 0) {
      await page.getByRole('button', { name: 'Add subject' }).click({ timeout: 5_000 });
    }
    await nameField.fill(name, { timeout: 5_000 });
    await steps();
  }).toPass({ timeout: 30_000 });
}

/** The panel that typing "@" in the prompt opens: its title and the references to insert. */
function mentionPanel(page: Page) {
  return page
    .getByText('Insert reference', { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-[20px]")][1]');
}

/** The panel that typing "@" in a shot prompt opens: its title and the subjects to insert. */
function shotMentionPanel(page: Page) {
  return page
    .getByText('Insert subject', { exact: true })
    .locator('xpath=ancestor::div[contains(@class,"rounded-[20px]")][1]');
}

/** Switches to shot prompts. A dev server reload puts the page back on its single prompt. */
async function showShotPrompts(page: Page) {
  if (await page.getByPlaceholder('Describe shot 1...').count() === 0) {
    await page.getByRole('button', { name: 'Multi-Shot', exact: true }).click({ timeout: 5_000 });
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
    await expect(page.getByText('@hero_creator', { exact: true }).first()).toBeVisible();

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
    await expect(page.getByText('@hero_creator', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('2/4 images')).toBeVisible();
  });

  // A subject's handle kept the capitals of its name ("@Hero_creator"), and the
  // prompt reads handles in lower case only. Typed as its card showed it the
  // handle was not read, and typed in lower case it was refused (2026-10-03).
  test('reads a subject handle typed into the prompt as its card shows it', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    const prompt = page.getByPlaceholder(/^Describe the .* scene/);

    await withNamedSubject(page, 'Hero creator', async () => {
      await expect(page.getByText('@hero_creator', { exact: true }).first()).toBeVisible({ timeout: 5_000 });

      // Half typed, the handle keeps the "@" panel open with the subject in it.
      await prompt.fill('A scene with @hero');
      await expect(mentionPanel(page).getByRole('button', { name: /@hero_creator/ })).toBeVisible({ timeout: 5_000 });

      // Typed in full, it is a mention the prompt knows. The character count shows
      // that the page has taken the new prompt in, so a missing warning means none.
      await prompt.fill('A scene with @hero_creator walking');
      await expect(page.getByText('34/2500')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText(/^Unknown element mention/)).toHaveCount(0);
    });
  });

  // The "@" panel also finds a reference by its name, and a name starts with a
  // capital. The panel shut at the first capital typed after "@".
  test('keeps the "@" panel open at a capital letter and inserts the handle from it', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    const prompt = page.getByPlaceholder(/^Describe the .* scene/);

    await withNamedSubject(page, 'Hero creator', async () => {
      await prompt.fill('A scene with @H');
      const suggestion = mentionPanel(page).getByRole('button', { name: /@hero_creator/ });
      await expect(suggestion).toBeVisible({ timeout: 5_000 });

      // Picking the subject replaces what was typed with the handle as it is written.
      await suggestion.click();
      await expect(prompt).toHaveValue('A scene with @hero_creator', { timeout: 5_000 });
      await expect(page.getByText(/^Unknown element mention/)).toHaveCount(0);
    });
  });

  // The subject card says "mention its @handle in the prompt or shot prompts", but
  // a shot prompt offered nothing at "@". Its panel opened for Kling 3.0's video
  // elements only, and the row of handles to click is on the single prompt's card,
  // which multi-shot mode does not show (2026-10-03).
  test('offers a subject under a shot prompt at "@" and inserts the handle from it', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    const shot = page.getByPlaceholder('Describe shot 1...');

    await withNamedSubject(page, 'Hero creator', async () => {
      await showShotPrompts(page);

      // The name is "Hero creator", so this is how a creator starts to look for it.
      await shot.fill('Open on @H', { timeout: 5_000 });
      const suggestion = shotMentionPanel(page).getByRole('button', { name: /@hero_creator/ });
      await expect(suggestion).toBeVisible({ timeout: 5_000 });

      // Picking the subject replaces what was typed with the handle as it is written.
      await suggestion.click();
      await expect(shot).toHaveValue('Open on @hero_creator', { timeout: 5_000 });
    });
  });

  // The page read shot prompts for unknown mentions on Kling 3.0 only. On Kling O3
  // a mistyped handle got as far as the server, which refuses it, after the run
  // had uploaded every subject image.
  test('stops a run at an unknown mention in a shot prompt', async ({ page }) => {
    // Generate stays disabled without a price, and this suite's server cannot quote one.
    await page.route('**/api/generation-models/quote', async (route) => {
      const asked = route.request().postDataJSON() as { modelId: string; catalogRevision: string };
      await route.fulfill({
        json: { modelId: asked.modelId, catalogRevision: asked.catalogRevision, normalizedSettings: {}, costCredits: 10 },
      });
    });
    await page.goto('/create-video?model=kling-o3');

    await withNamedSubject(page, 'Hero creator', async () => {
      // A run needs two images of each subject. With them the subject is saved, so a
      // dev server reload brings it back as it was, and it needs no second pair.
      if (await page.getByText(/^[24]\/4 images$/).count() === 0) {
        await attachSubjectImages(page, ['hero-front.png', 'hero-side.png']);
      }
      await showShotPrompts(page);

      // One letter short.
      await page.getByPlaceholder('Describe shot 1...').fill('Open on @hero_creatr in the rain', { timeout: 5_000 });
      await page.getByRole('button', { name: 'Generate Video' }).click({ timeout: 5_000 });

      // The words the server refuses the run with. Past this check the run starts
      // to upload, and the line under the button would be about that instead.
      await expect(page.getByText('Unknown element mention: @hero_creatr', { exact: true })).toBeVisible({ timeout: 5_000 });
    });
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
