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

async function attachSubjectImages(page: Page, names: string[], subject = 0) {
  // The subject cards own the only multi-select image inputs on this screen, one
  // to a card. `subject` counts the cards from 0.
  await page.locator('label input[type="file"][accept="image/*"][multiple]').nth(subject).setInputFiles(
    names.map((name) => ({ name, mimeType: 'image/png', buffer: ONE_PIXEL_PNG })),
  );
}

/**
 * The @handle saved with each subject the draft store currently holds, in card
 * order. Reads localforage's own layout for
 * `PERSISTED_MEDIA_KEYS.createVideoKlingSubjects` — database
 * `magicbooklet-persisted-media`, object store `keyvaluepairs` — creating
 * neither, so probing cannot disturb what the app stores.
 *
 * The editor persists fire-and-forget (`void persistKlingSubjects(...)` in
 * CreateVideoClient), so the DOM settles a beat before IndexedDB does. Waiting
 * on the store is what makes a reload assertion mean anything: reload mid-write
 * and the reload tests nothing in particular, while an editor found empty
 * afterwards may simply not have restored *yet*.
 */
async function persistedSubjectHandles(page: Page): Promise<Array<string | null> | 'unknown'> {
  try {
    return await readPersistedSubjectHandles(page);
  } catch (error) {
    // A dev server reload (see below) can tear the execution context down
    // mid-read. `expect.poll` re-throws whatever its generator throws, so
    // answer "unknown" and let the next poll ask the fresh document.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return 'unknown';
    }
    throw error;
  }
}

/** How many subjects the draft store currently holds, or -1 while it cannot be read. */
async function countPersistedSubjects(page: Page): Promise<number> {
  const handles = await persistedSubjectHandles(page);
  return handles === 'unknown' ? -1 : handles.length;
}

function readPersistedSubjectHandles(page: Page): Promise<Array<string | null>> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'magicbooklet-persisted-media')) return [];

    return new Promise<Array<string | null>>((resolve, reject) => {
      const open = indexedDB.open('magicbooklet-persisted-media');
      open.onerror = () => reject(open.error ?? new Error('could not open the persisted media store'));
      open.onsuccess = () => {
        const database = open.result;
        if (!database.objectStoreNames.contains('keyvaluepairs')) {
          database.close();
          resolve([]);
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
          const subjects: Array<{ handle?: unknown }> = Array.isArray(read.result) ? read.result : [];
          resolve(subjects.map((subject) => (typeof subject.handle === 'string' ? subject.handle : null)));
        };
      };
    });
  });
}

/**
 * Reload, tolerating the dev server reloading the page out from under us.
 *
 * `next dev` sends its "sync" message to every open page whenever any page
 * connects, and a page calls `window.location.reload()` when that message names
 * a build other than the one it loaded — which every route compiled on demand
 * makes true. With more than one worker, another worker's test compiling a route
 * and then opening a page is enough, so this page can navigate itself through no
 * doing of the test's. CI runs one worker for that reason (playwright.config.ts);
 * a local run with several still meets it.
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
    await nameSubject(page, name);
    await steps();
  }).toPass({ timeout: 30_000 });
}

/**
 * Types a subject's name and commits it. A name is a draft while it is typed:
 * the subject takes it, and its handle and the prompt follow, on Enter or when
 * the field is left. `subject` counts the cards from 0.
 */
async function nameSubject(page: Page, name: string, subject = 0) {
  const nameField = page.getByPlaceholder('Subject name').nth(subject);
  await nameField.fill(name, { timeout: 5_000 });
  await nameField.press('Enter', { timeout: 5_000 });
}

/** What each subject card shows, in card order: its @handle and how many images it holds. */
function subjectCards(page: Page): Promise<Array<{ handle: string; images: number }>> {
  return page.getByPlaceholder('Subject name').evaluateAll((fields) => fields.map((field) => {
    // A subject's card is its name field's nearest ancestor that holds the image picker.
    let card = field.parentElement;
    while (card && !card.querySelector('input[type="file"]')) card = card.parentElement;
    const pill = Array.from(card?.querySelectorAll('span') ?? []).find((span) => /^@\w+$/.test(span.textContent ?? ''));
    return { handle: pill?.textContent ?? '', images: card?.querySelectorAll('img').length ?? 0 };
  }));
}

/** The @handle each subject card shows, in card order. */
async function subjectCardHandles(page: Page): Promise<string[]> {
  return (await subjectCards(page)).map((card) => card.handle);
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

    await nameSubject(page, 'Hero creator');
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
    await nameSubject(page, 'Hero creator');
    await attachSubjectImages(page, ['hero-front.png', 'hero-side.png']);
    await expect(page.getByText('2/4 images')).toBeVisible();
    // Reloading before the group reaches storage would prove nothing about it.
    await expect.poll(() => persistedSubjectHandles(page)).toEqual(['@hero_creator']);

    await reloadPastDevServerReloads(page);

    // The whole group comes back — name, handle, and both images.
    await expect(page.getByPlaceholder('Subject name')).toHaveValue('Hero creator');
    // The handle now shows in two places: the subjects editor's own chip and the
    // @-mention quick-insert row beside the prompt, which O3 reaches now that its
    // reference capacity is no longer reported as zero.
    await expect(page.getByText('@hero_creator', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('2/4 images')).toBeVisible();
  });

  // A subject keeps its handle, and a rename takes the prompt with it. The handle
  // was built from the subjects' names each time the cards were drawn, so a renamed
  // subject left its old mention in the prompt as an unknown one (2026-10-03).
  test('lets the prompt follow a renamed subject, once the new name is entered', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    const prompt = page.getByPlaceholder(/^Describe the .* scene/);
    const nameField = page.getByPlaceholder('Subject name');

    await withNamedSubject(page, 'Hero', async () => {
      await prompt.fill('A scene with @hero walking', { timeout: 5_000 });
      await expect(page.getByText('26/2500')).toBeVisible({ timeout: 5_000 });

      // While the new name is typed the subject is still "@hero" to the prompt.
      await nameField.fill('Villain', { timeout: 5_000 });
      expect(await subjectCardHandles(page)).toEqual(['@hero']);
      await expect(prompt).toHaveValue('A scene with @hero walking', { timeout: 5_000 });
      await expect(page.getByText(/^Unknown element mention/)).toHaveCount(0);

      await nameField.press('Enter', { timeout: 5_000 });
      await expect(prompt).toHaveValue('A scene with @villain walking', { timeout: 5_000 });
      expect(await subjectCardHandles(page)).toEqual(['@villain']);
      await expect(page.getByText(/^Unknown element mention/)).toHaveCount(0);
    });
  });

  // Renaming or removing the first of two subjects with one name gave its handle
  // to the second, so a mention in the prompt named the other subject. The handle
  // is saved with the subject now: built from the names again after a reload, the
  // second "Hero" would come back as "@hero".
  test('keeps the handle of the second of two subjects with one name through a rename and a reload', async ({ page }) => {
    await page.goto('/create-video?model=kling-o3');
    const nameFields = page.getByPlaceholder('Subject name');

    // A subject is saved once it has images, so a dev server reload (see above)
    // brings back the ones that had theirs. These steps make up whatever is
    // missing, and so can run again from the top after such a reload.
    await expect(async () => {
      for (const subject of [0, 1]) {
        if (await nameFields.count() <= subject) {
          await page.getByRole('button', { name: 'Add subject' }).click({ timeout: 5_000 });
        }
        await nameSubject(page, 'Hero', subject);
        if ((await subjectCards(page))[subject]?.images === 0) {
          await attachSubjectImages(page, [`hero-${subject}-front.png`, `hero-${subject}-side.png`], subject);
        }
      }
      await expect.poll(() => persistedSubjectHandles(page), { timeout: 5_000 }).toEqual(['@hero', '@hero_2']);
      expect(await subjectCardHandles(page)).toEqual(['@hero', '@hero_2']);

      await nameSubject(page, 'Villain', 0);
      await expect.poll(() => subjectCardHandles(page), { timeout: 5_000 }).toEqual(['@villain', '@hero_2']);
      await expect.poll(() => persistedSubjectHandles(page), { timeout: 5_000 }).toEqual(['@villain', '@hero_2']);
    }).toPass({ timeout: 45_000 });

    await reloadPastDevServerReloads(page);

    await expect(nameFields).toHaveCount(2);
    await expect(nameFields.nth(0)).toHaveValue('Villain');
    await expect(nameFields.nth(1)).toHaveValue('Hero');
    expect(await subjectCardHandles(page)).toEqual(['@villain', '@hero_2']);
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

  // A remix of a run that used named subjects brought back its prompt and no
  // subject: a run kept nothing of them. The mentions in the prompt then named
  // nothing, and Generate refused the prompt until the creator had built a subject
  // of each name again (2026-10-04).
  test('brings the subjects of a remixed run back under the handles its prompt mentions', async ({ page }) => {
    const kept = 'generation_inputs/0b9f6c2e-51d7-4c3a-9e84-2f6a1d7c5b90/7c1e4a58-93bd-4f06-8a27-d5e0b6f3a914';
    const picture = (place: string, label: string) => ({
      kind: 'image',
      label,
      storagePath: `${kept}/${place}-subject_image.png`,
      sourceGenerationId: null,
      url: `https://example.supabase.co/storage/v1/object/sign/${kept}/${place}-subject_image.png?token=placeholder`,
    });
    const prompt = '@lead lifts @bottle and smiles at the camera in a bright studio, slow push in.';
    // What /api/remix-source answers for a run with two subjects. Neither handle is
    // the one its subject's name would give ("@hero_creator", "@serum_bottle").
    await page.route('**/api/remix-source*', (route) => route.fulfill({
      json: {
        generation: { id: 'gen-1', title: 'Serum launch', prompt, category: 'video', model: 'kling-o3' },
        result: null,
        inputs: {
          video: {
            referenceMode: 'elements',
            startFrame: null,
            endFrame: null,
            elements: [],
            referenceVideos: [],
            referenceAudios: [],
            subjects: [
              { handle: '@lead', displayName: 'Hero creator', images: ['00', '01', '02'].map((place) => picture(place, 'Hero creator')) },
              { handle: '@bottle', displayName: 'Serum bottle', images: ['03', '04'].map((place) => picture(place, 'Serum bottle')) },
            ],
          },
        },
        workflowSettings: { model: 'kling-o3', aspectRatio: '16:9', duration: 5, resolution: '720p', referenceMode: 'elements' },
        restoreIssues: [],
      },
    }));
    // The kept pictures load from storage. Answer them here so the page stays offline.
    await page.route('https://example.supabase.co/storage/v1/object/sign/**', (route) => (
      route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG })
    ));

    await page.goto('/create-video?remix=gen-1&remixPost=post-1');

    // A dev server reload makes the page ask for the remix again, so every check
    // below finds the same restore however often the page started over.
    await expect.poll(() => subjectCards(page)).toEqual([
      { handle: '@lead', images: 3 },
      { handle: '@bottle', images: 2 },
    ]);
    await expect(page.getByPlaceholder('Subject name').nth(0)).toHaveValue('Hero creator');
    await expect(page.getByPlaceholder('Subject name').nth(1)).toHaveValue('Serum bottle');
    await expect(page.getByPlaceholder(/^Describe the .* scene/)).toHaveValue(prompt);
    // Each card draws the pictures the run kept, from the links the remix was given.
    await expect.poll(() => page.locator('img[src*="subject_image"]').evaluateAll((pictures) => (
      pictures.map((drawn) => (drawn as HTMLImageElement).naturalWidth > 0)
    ))).toEqual([true, true, true, true, true]);
    await expect(page.getByText(/Unknown element mention/)).toHaveCount(0);
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
