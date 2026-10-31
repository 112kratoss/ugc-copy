import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A visitor who types into a creator's prompt before the page's script has run keeps
 * what they typed (2026-10-31).
 *
 * The server's HTML draws the prompt box before any script runs, so on a slow connection
 * a visitor can start typing first. React never hears that typing, and this React build
 * hydrates the box without reading it back: the text stayed in the box while the page's
 * state kept what the server drew, and the box's next render, a moment later, wrote that
 * state over it.
 *
 * The page's own chunk is held here until the text is typed, which makes that window as
 * long as the test needs. Each test types twice: on a first visit, then after a reload,
 * when the page also reads back the draft it saved the first time; what was just typed
 * wins over that older draft. The draft the page saves is the sign that it has settled,
 * because it saves only once it has read its saved draft back.
 */

const COLD_PAGE = { timeout: 45_000 };
const FIRST_VISIT = 'A lighthouse at dusk, waves breaking on the rocks below';
const RETURN_VISIT = 'A paper boat drifting across a sunlit pond, soft morning light';

type Creator = {
  path: string;
  tool: 'image' | 'video' | 'motion';
  box: (page: Page) => Locator;
  counter: (page: Page) => Locator;
  counted: (text: string) => RegExp;
};

const CREATORS: Creator[] = [
  {
    path: '/create-image',
    tool: 'image',
    box: (page) => page.locator('#create-image-prompt'),
    counter: (page) => page.locator('#create-image-prompt + div').getByTestId('prompt-length'),
    counted: (text) => new RegExp(`^${text.length} / [\\d,]+ characters$`),
  },
  {
    path: '/create-video',
    tool: 'video',
    box: (page) => page.locator('#create-video-prompt'),
    counter: (page) => page.locator('#create-video-prompt + div').getByTestId('prompt-length'),
    counted: (text) => new RegExp(`^${text.length} / [\\d,]+$`),
  },
  {
    // The motion box opens with a prompt of its own, which the typing replaces.
    path: '/create-motion',
    tool: 'motion',
    box: (page) => page.locator('#create-motion-prompt'),
    counter: (page) => page.locator('#create-motion-prompt + div'),
    counted: (text) => new RegExp(`^${text.length}/[\\d,]+$`),
  },
];

/** Holds the page's own script chunk while `held` is on; every request for it waits. */
async function holdPageChunk(page: Page, path: string) {
  let release = () => {};
  let gate: Promise<void> = Promise.resolve();
  const chunk = { requests: 0 };
  await page.route(new RegExp(`/_next/static/chunks/app${path}/page\\.js(\\?|$)`), async (route) => {
    chunk.requests += 1;
    await gate;
    await route.continue();
  });
  return {
    requests: () => chunk.requests,
    hold() {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
}

/** Offline the quote cannot be priced, so the page is given one. */
async function answerQuote(page: Page) {
  await page.route('**/api/generation-models/quote', async (route) => {
    const request = (route.request().postDataJSON() ?? {}) as { modelId?: string; catalogRevision?: string };
    await route.fulfill({
      json: { modelId: request.modelId ?? 'unknown', catalogRevision: request.catalogRevision ?? 'unknown', normalizedSettings: {}, costCredits: 8 },
    });
  });
}

/**
 * The prompt of the visitor's draft as the page last saved it (`creator-draft:<tool>:visitor`
 * in its IndexedDB store), or null before its first save. The store is never opened before
 * the page has made it: an open of a missing database would make an empty one.
 */
function savedPrompt(page: Page, tool: Creator['tool']) {
  return page.evaluate(async (key) => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'magicbooklet-persisted-media')) return null;
    return new Promise<string | null>((resolve) => {
      const opened = indexedDB.open('magicbooklet-persisted-media');
      opened.onerror = () => resolve(null);
      opened.onsuccess = () => {
        const db = opened.result;
        db.onversionchange = () => db.close();
        if (!db.objectStoreNames.contains('keyvaluepairs')) {
          db.close();
          resolve(null);
          return;
        }
        const read = db.transaction('keyvaluepairs', 'readonly').objectStore('keyvaluepairs').get(key);
        read.onsuccess = () => {
          db.close();
          const prompt = (read.result as { draft?: { prompt?: unknown } } | undefined)?.draft?.prompt;
          resolve(typeof prompt === 'string' ? prompt : null);
        };
        read.onerror = () => {
          db.close();
          resolve(null);
        };
      };
    });
  }, `creator-draft:${tool}:visitor`);
}

/** Types into the server's HTML while the page's chunk is held, then lets the script run. */
async function typeBeforeScript(page: Page, creator: Creator, chunk: Awaited<ReturnType<typeof holdPageChunk>>, text: string) {
  const requestsBefore = chunk.requests();
  await expect(creator.box(page)).toBeVisible(COLD_PAGE);
  // Else the page's script was never asked for here, and the typing below would land on a live page.
  await expect.poll(chunk.requests, { ...COLD_PAGE, message: 'the page asks for its own chunk, which is held' }).toBeGreaterThan(requestsBefore);
  await creator.box(page).fill(text);
  chunk.release();
}

for (const creator of CREATORS) {
  test(`${creator.path}: a prompt typed before the page's script runs stays, over a saved draft too`, async ({ page }) => {
    test.setTimeout(180_000);
    await answerQuote(page);
    const chunk = await holdPageChunk(page, creator.path);

    chunk.hold();
    await page.goto(creator.path, { ...COLD_PAGE, waitUntil: 'commit' });
    await typeBeforeScript(page, creator, chunk, FIRST_VISIT);

    await expect.poll(() => savedPrompt(page, creator.tool), { ...COLD_PAGE, message: 'the draft the page saves holds what was typed' }).toBe(FIRST_VISIT);
    await expect(creator.box(page)).toHaveValue(FIRST_VISIT);
    await expect(creator.counter(page)).toHaveText(creator.counted(FIRST_VISIT));

    // Back on the page: it reads that draft back as it opens, after this typing.
    chunk.hold();
    await page.reload({ ...COLD_PAGE, waitUntil: 'commit' });
    await typeBeforeScript(page, creator, chunk, RETURN_VISIT);

    await expect.poll(() => savedPrompt(page, creator.tool), { ...COLD_PAGE, message: 'the draft the page saves holds what was typed' }).toBe(RETURN_VISIT);
    await expect(creator.box(page)).toHaveValue(RETURN_VISIT);
    await expect(creator.counter(page)).toHaveText(creator.counted(RETURN_VISIT));
  });
}
