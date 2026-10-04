import { expect, test, type Page } from '@playwright/test';

/**
 * A reference saved in the browser on one video model does not shape the run of a
 * model that cannot take it.
 *
 * The browser keeps a creator's references when the model changes. Two images saved
 * on Seedance 2 made Kling 3.0 and Hailuo 2.3 references runs (2026-10-03): the page
 * asked the price quote for two reference images on models that take none, the server
 * refused ("Kling 3.0 Cinematic does not support the imageReferences input."), the
 * cost read "Unavailable" and Generate stayed off. A card on the same page said the
 * references were on standby and to use frames for this run, and the page had no
 * card to remove them by. A saved clip did the same to the models that take images
 * and no clip, and greyed their frames out under "Clear your references".
 *
 * Vitest holds the rule (generation-model-affordances.test.ts) and the page on a
 * catalog built in the test (create-video-client.test.tsx). This is the page as a
 * browser runs it: the catalog paged in from the server, and the references read
 * back from IndexedDB.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

type QuoteRequest = {
  modelId?: string;
  catalogRevision?: string;
  settings?: { referenceMode?: string };
  inputCounts?: { images?: number; videos?: number; audios?: number };
  inputMetadata?: { slots?: Record<string, { count?: number }> };
};

/**
 * Offline the price quote fails, and the page asks for none until it has a catalog.
 * Every request is kept, so a test can read what the page asked for a model.
 */
async function answerQuote(page: Page) {
  const requests: QuoteRequest[] = [];
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as QuoteRequest;
    requests.push(request);
    await route.fulfill({
      json: {
        modelId: request.modelId ?? 'unknown',
        catalogRevision: request.catalogRevision ?? 'unknown',
        normalizedSettings: {},
        costCredits: 10,
      },
    });
  });
  /** The newest request for a model that counts one of a slot, or null while there is none. */
  return (modelId: string, slot: 'startFrame' | 'imageReferences') => [...requests].reverse().find((request) => (
    request.modelId === modelId && request.inputMetadata?.slots?.[slot]?.count === 1
  )) ?? null;
}

/**
 * How many records the draft store holds under a key, or -1 while it cannot be read.
 * Reads localforage's own layout (database `magicbooklet-persisted-media`, object
 * store `keyvaluepairs`) and creates neither.
 */
async function savedCount(page: Page, key: string): Promise<number> {
  try {
    return await page.evaluate(async (storageKey) => {
      const databases = await indexedDB.databases();
      if (!databases.some((database) => database.name === 'magicbooklet-persisted-media')) return 0;
      return new Promise<number>((resolve) => {
        const open = indexedDB.open('magicbooklet-persisted-media');
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('keyvaluepairs')) {
            database.close();
            resolve(0);
            return;
          }
          const read = database.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get(storageKey);
          read.onerror = () => { database.close(); resolve(-1); };
          read.onsuccess = () => {
            database.close();
            resolve(Array.isArray(read.result) ? read.result.length : 0);
          };
        };
      });
    }, key);
  } catch (error) {
    // A dev server reload can tear the page down in the middle of a read.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) return -1;
    throw error;
  }
}

/**
 * Opens a model and waits for its prompt box. `next dev` can reload an open page under
 * a spec (see kling-o3-named-subjects.spec.ts), which cancels a navigation made in the
 * same moment, so the navigation is tried again.
 */
async function openModel(page: Page, modelId: string) {
  await expect(async () => {
    await page.goto(`/create-video?model=${modelId}`);
    await expect(page.getByPlaceholder(/^Describe the .* scene/)).toBeVisible();
  }).toPass({ timeout: 45_000 });
}

/** One line of the run summary, by its label. */
function runSummary(page: Page, label: 'Reference' | 'Inputs') {
  return page.getByText(label, { exact: true }).locator('xpath=following-sibling::div[1]');
}

async function attachStartFrame(page: Page) {
  await page.locator('#video-start-frame-input').setInputFiles({ name: 'start.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG });
}

test.describe('references saved on another video model', () => {
  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
  });

  // The three models with frame slots and no slot for a reference of any kind.
  for (const { modelId, name, inputs } of [
    { modelId: 'kling-3.0-video', name: 'Kling 3.0', inputs: '1 frame + 0 video refs' },
    { modelId: 'kling-3.0-turbo', name: 'Kling 3.0 Turbo', inputs: '1 frame' },
    { modelId: 'hailuo-2.3', name: 'Hailuo 2.3', inputs: '1 frame' },
  ]) {
    test(`two saved images leave ${name} a frames run`, async ({ page }) => {
      const newestQuote = await answerQuote(page);

      // Two reference images, saved on a model that takes them. A reload under the
      // upload starts this over, and what is already saved is not uploaded twice.
      await expect(async () => {
        await openModel(page, 'seedance-2');
        const heading = page.getByRole('heading', { name: 'Reusable image references' });
        await expect(heading).toBeVisible();
        if (await savedCount(page, 'create-video:elements') !== 2) {
          await heading.locator('xpath=ancestor::div[.//input[@type="file"]][1]').locator('input[type="file"]').first().setInputFiles([
            { name: 'hero.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
            { name: 'scarf.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
          ]);
        }
        await expect.poll(() => savedCount(page, 'create-video:elements')).toBe(2);
      }).toPass({ timeout: 50_000 });

      await openModel(page, modelId);
      // The saved images are read back, and the page has no card for them here.
      await expect(page.getByText('Saved references are on standby')).toBeVisible();
      await expect(page.getByPlaceholder('Rename element')).toHaveCount(0);

      // A start frame makes a new request for a price, after the images were read back.
      await attachStartFrame(page);
      await expect.poll(() => newestQuote(modelId, 'startFrame')).not.toBeNull();
      const request = newestQuote(modelId, 'startFrame')!;
      expect(request.settings?.referenceMode).toBe('frames');
      expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
      expect(request.inputMetadata?.slots?.imageReferences?.count).toBe(0);

      // The page says of the run what its standby card says.
      await expect(runSummary(page, 'Reference')).toHaveText('Start / end frames');
      await expect(runSummary(page, 'Inputs')).toHaveText(inputs);
      await expect(page.getByText(/Reusable references keep their @handles/)).toHaveCount(0);
      await expect(page.getByText(/Upload reference images below/)).toHaveCount(0);
    });
  }

  test('a saved clip is left out of a references run on a model that takes images and no clip', async ({ page }) => {
    const newestQuote = await answerQuote(page);

    // An image and a clip, saved on a model that takes both. A file the browser cannot
    // play still counts as a clip: its length reads as unknown.
    await expect(async () => {
      await openModel(page, 'seedance-2');
      const heading = page.getByRole('heading', { name: 'Reusable image references' });
      await expect(heading).toBeVisible();
      if (await savedCount(page, 'create-video:elements') !== 1) {
        await heading.locator('xpath=ancestor::div[.//input[@type="file"]][1]').locator('input[type="file"]').first().setInputFiles(
          { name: 'hero.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
        );
      }
      if (await savedCount(page, 'create-video:reference-videos') !== 1) {
        await page.locator('input[type="file"][accept="video/*"]').setInputFiles({ name: 'camera-move.mp4', mimeType: 'video/mp4', buffer: Buffer.from('a clip') });
      }
      await expect.poll(() => savedCount(page, 'create-video:elements')).toBe(1);
      await expect.poll(() => savedCount(page, 'create-video:reference-videos')).toBe(1);
    }).toPass({ timeout: 50_000 });

    // Seedance 1.5 Pro takes two images and has no place for a clip, and says so.
    await openModel(page, 'seedance-1.5-pro');
    await expect(page.getByPlaceholder('Rename element')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Reference videos' })).toHaveCount(0);
    await expect(page.getByText('Saved references are on standby')).toBeVisible();
    await expect(page.getByText('Your saved clip stays saved. Seedance 1.5 Pro takes no reference clip, so this run does not use it.')).toBeVisible();

    await expect(runSummary(page, 'Reference')).toHaveText('Reusable references');
    await expect(runSummary(page, 'Inputs')).toHaveText('1 reference');
    await expect.poll(() => newestQuote('seedance-1.5-pro', 'imageReferences')).not.toBeNull();
    const request = newestQuote('seedance-1.5-pro', 'imageReferences')!;
    expect(request.settings?.referenceMode).toBe('elements');
    expect(request.inputCounts).toMatchObject({ images: 1, videos: 0, audios: 0 });
    expect(request.inputMetadata?.slots?.videoReferences?.count).toBe(0);
  });

  test('a prompt that mentions an image on standby is told so, and Generate names it', async ({ page }) => {
    await answerQuote(page);
    const NAME = 'Protagonist in the crimson raincoat';
    const HANDLE = '@protagonist_in_the_crimson_raincoat';

    // One image, saved on Seedance 2 under a name long enough to need more than one line
    // on a phone.
    await expect(async () => {
      await openModel(page, 'seedance-2');
      const heading = page.getByRole('heading', { name: 'Reusable image references' });
      await expect(heading).toBeVisible();
      if (await savedCount(page, 'create-video:elements') !== 1) {
        await heading.locator('xpath=ancestor::div[.//input[@type="file"]][1]').locator('input[type="file"]').first().setInputFiles(
          { name: 'hero.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
        );
      }
      const name = page.getByPlaceholder('Rename element');
      await expect(name).toHaveCount(1);
      await name.fill(NAME);
      await name.press('Enter');
      await expect(page.getByText(HANDLE, { exact: true }).first()).toBeVisible();
      await expect.poll(() => savedCount(page, 'create-video:elements')).toBe(1);
    }).toPass({ timeout: 50_000 });

    const prompt = page.getByPlaceholder(/^Describe the .* scene/);
    const line = page.getByText(/^On standby here:/);
    await expect(async () => {
      await page.goto(`/create-video?model=kling-3.0-video&prompt=${encodeURIComponent(`A harbour at dusk where ${HANDLE} walks home`)}`);
      await expect(page.getByText('Saved references are on standby')).toBeVisible();
      // The handle is the one the image was saved under, so the page knows it.
      await expect(line).toHaveText(`On standby here: ${HANDLE}`);
    }).toPass({ timeout: 45_000 });
    await expect(page.getByText(/^Unknown element mention/)).toHaveCount(0);

    // On a phone the line stays in the row under the prompt, and the page does not
    // scroll sideways for it.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(line).toBeVisible();
    expect(await page.evaluate(() => {
      const sentence = Array.from(document.querySelectorAll('span')).find((span) => (span.textContent ?? '').startsWith('On standby here:'));
      const row = sentence?.parentElement;
      if (!sentence || !row) return 'the line is not on the page';
      const box = sentence.getBoundingClientRect();
      const room = row.getBoundingClientRect();
      const faults: string[] = [];
      if (box.width === 0) faults.push('the line has no width');
      if (box.left < room.left - 1 || box.right > room.right + 1) faults.push(`the line runs from ${Math.round(box.left)} to ${Math.round(box.right)}, outside its row (${Math.round(room.left)} to ${Math.round(room.right)})`);
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth) faults.push('the page scrolls sideways');
      return faults.join('; ');
    })).toBe('');
    await page.setViewportSize({ width: 1280, height: 720 });

    // Generate refuses the prompt before anything is uploaded, and says which word.
    const generate = page.getByRole('button', { name: 'Generate Video' });
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(page.getByText(`Kling 3.0 Cinematic cannot use ${HANDLE}. Remove it from the prompt, or pick a model that takes reusable references.`)).toBeVisible();
    await expect(prompt).toHaveValue(`A harbour at dusk where ${HANDLE} walks home`);
    expect(new URL(page.url()).pathname).toBe('/create-video');
  });
});
