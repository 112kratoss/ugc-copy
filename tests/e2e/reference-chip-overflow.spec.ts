import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * A long reference name never makes a creator wider than its window.
 *
 * Above the prompt, each reference has a chip that inserts its @handle: the
 * reference's name, then the handle. A chip could not shrink below its text and
 * a handle cannot break, so a name of 34 characters made a chip 425px wide in a
 * 308px row, and the whole document 466px wide in a 390px window (2026-10-02).
 * Typing "@" opens a panel of the same chips in a narrower row, which made it
 * wider still.
 *
 * A chip stops at its row now. The handle is what the prompt needs, so it keeps
 * its full width and the name is cut to what is left. Only a handle wider than
 * the row by itself wraps.
 *
 * The Kling video element card had a smaller fault of the same kind. From 1280px
 * up its cards were 160px wide, which left the Copy and Insert buttons a 108px
 * row for their 127px, so Insert stuck out past the row's border. Since
 * 2026-10-26 each Kling clip is a row of the column, as every reference is, and
 * Copy and Insert sat side by side under its name. Since 2026-10-31 each is a
 * tile in a row that scrolls sideways: its handle is its Insert button, on a
 * line of its own, with Copy under it, and both stay inside the tile.
 *
 * Vitest cannot reach this. Every name and handle was in the document, and only
 * the layout was wrong.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const OWNER_ID = '0b9f6c2e-51d7-4c3a-9e84-2f6a1d7c5b90';
const GENERATION_ID = '7c1e4a58-93bd-4f06-8a27-d5e0b6f3a914';
const POST_ID = '6f0d2b1c-8a47-4e9b-b3c5-1d2e3f4a5b6c';

function storagePath(fileName: string) {
  return `generation_inputs/${OWNER_ID}/${GENERATION_ID}/${fileName}`;
}

function mediaUrl(fileName: string) {
  return `https://example.supabase.co/storage/v1/object/sign/${storagePath(fileName)}?token=placeholder`;
}

/**
 * The three chips a row has to hold:
 * a default name, whose chip fits everywhere, so nothing about it may change;
 * the measured one, a single word of 34 characters;
 * and a name whose handle is wider than a phone's row by itself, so it has to wrap.
 */
const REFERENCES = [
  { name: 'Image reference 1', handle: '@image_reference_1' },
  { name: 'Supercalifragilisticexpialidocious', handle: '@supercalifragilisticexpialidocious' },
  {
    name: 'The quick brown fox jumps over the lazy dog by the old harbour wall',
    handle: '@the_quick_brown_fox_jumps_over_the_lazy_dog_by_the_old_harbour_wall',
  },
];

// Kling takes three clips. The first keeps its default name.
const CLIPS = [
  { name: 'Video element 1', handle: '@video_element_1' },
  REFERENCES[1],
  REFERENCES[2],
];

const imageElements = REFERENCES.map((reference, index) => ({
  id: `element-${index + 1}`,
  displayName: reference.name,
  handle: reference.handle,
  url: mediaUrl(`0${index + 1}-reference_image.png`),
  storagePath: storagePath(`0${index + 1}-reference_image.png`),
  sourceGenerationId: GENERATION_ID,
}));

const SEEDANCE_REMIX = {
  generation: {
    id: GENERATION_ID,
    title: 'Harbour at dusk',
    prompt: 'A slow dolly shot across a harbour at dusk.',
    category: 'video',
    model: 'seedance-2',
  },
  result: { mediaType: 'video', url: null },
  inputs: {
    video: {
      referenceMode: 'elements',
      startFrame: null,
      endFrame: null,
      elements: imageElements,
      referenceVideos: [],
      referenceAudios: [],
    },
  },
  workflowSettings: { model: 'seedance-2', duration: '5', aspectRatio: '16:9' },
  restoreIssues: [],
};

const KLING_REMIX = {
  generation: { ...SEEDANCE_REMIX.generation, model: 'kling-3.0-video' },
  result: { mediaType: 'video', url: null },
  inputs: {
    video: {
      referenceMode: 'elements',
      startFrame: null,
      endFrame: null,
      elements: [],
      referenceVideos: CLIPS.map((clip, index) => ({
        kind: 'video',
        label: clip.name,
        url: mediaUrl(`0${index + 1}-reference_video.mp4`),
        storagePath: storagePath(`0${index + 1}-reference_video.mp4`),
        sourceGenerationId: GENERATION_ID,
        durationSeconds: 5,
      })),
      referenceAudios: [],
    },
  },
  workflowSettings: { model: 'kling-3.0-video', duration: '5', aspectRatio: '16:9' },
  restoreIssues: [],
};

const IMAGE_REMIX = {
  generation: {
    id: GENERATION_ID,
    title: 'Harbour at dusk',
    prompt: 'A harbour at dusk, shot on a long lens.',
    category: 'image',
    model: 'nano-banana-2',
  },
  result: { mediaType: 'image', url: null },
  inputs: { image: { elements: imageElements } },
  workflowSettings: { model: 'nano-banana-2', aspectRatio: '1:1' },
  restoreIssues: [],
};

const VIEWPORTS = [
  // A phone. Two of the three chips are wider than their row, and this is where
  // the page itself grew wider than its window.
  { width: 390, height: 844 },
  // The column beside the canvas (two panes from 1120px wide).
  { width: 1280, height: 720 },
];

type Row = {
  /** How far the document is wider than its window, in pixels. */
  pageOverflow: number;
  /** The handle on each chip or card in order, as the page's own text has it. */
  handles: string[];
  /** One line for each thing the layout gets wrong. */
  faults: string[];
};

function contained(handles: string[]): Row {
  return { pageOverflow: 0, handles, faults: [] };
}

/** Answers "unknown" for a page the dev server reloaded mid-read, so the caller asks again. */
async function readPastDevServerReloads<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    // See kling-o3-named-subjects.spec.ts: the dev server reloads open pages on its own.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

/** Measures the chips under the label `label`, or answers null while there are none. */
function readChipRow(page: Page, label: string): Promise<Row | null> {
  return readPastDevServerReloads(() => page.evaluate((rowLabel) => {
    const isHandle = (element: Element | null) => (
      element !== null
      && /^@[a-z0-9_]+$/.test(element.textContent ?? '')
      && Array.from(element.children).every((child) => child.tagName === 'WBR')
    );
    // A chip is a button holding a name and then a handle.
    const isChip = (button: Element) => button.childElementCount === 2 && isHandle(button.lastElementChild);
    const title = Array.from(document.querySelectorAll<HTMLElement>('p'))
      .find((candidate) => candidate.textContent?.trim() === rowLabel);
    // The chips sit in the label's nearest ancestor that holds one.
    let block = title?.parentElement ?? null;
    while (block && !Array.from(block.querySelectorAll('button')).some(isChip)) {
      block = block.parentElement;
    }
    const row = Array.from(block?.querySelectorAll('button') ?? []).find(isChip)?.parentElement;
    if (!row) return null;

    const lineCount = (element: Element) => {
      const text = document.createRange();
      text.selectNodeContents(element);
      return new Set(Array.from(text.getClientRects()).map((line) => Math.round(line.top))).size;
    };
    const faults: string[] = [];

    // Content that runs out of its box where it shows. A name cut short is
    // clipped on purpose, so a box that hides its overflow is not counted.
    for (const element of [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]) {
      if (
        element.clientWidth > 0
        && getComputedStyle(element).overflowX === 'visible'
        && element.scrollWidth > element.clientWidth + 1
      ) {
        faults.push(`a ${element.clientWidth}px box holds ${element.scrollWidth}px of content: ${(element.textContent ?? '').slice(0, 40)}`);
      }
    }

    const rowBox = row.getBoundingClientRect();
    const chips = Array.from(row.children) as HTMLElement[];
    for (const chip of chips) {
      const [name, handle] = Array.from(chip.children) as HTMLElement[];
      const fault = (text: string) => faults.push(`${handle.textContent}: ${text}`);
      const chipBox = chip.getBoundingClientRect();

      if (chipBox.left < rowBox.left - 1 || chipBox.right > rowBox.right + 1) {
        fault(`its chip runs from ${Math.round(chipBox.left)} to ${Math.round(chipBox.right)}px, outside its row at ${Math.round(rowBox.left)} to ${Math.round(rowBox.right)}px`);
      }

      // An inline box reports no width, which would pass every check below.
      if (handle.clientWidth === 0) {
        fault('the handle has no box of its own to measure');
        continue;
      }
      if (handle.scrollWidth > handle.clientWidth + 1 || handle.scrollHeight > handle.clientHeight + 1) {
        fault(`a ${handle.clientWidth}x${handle.clientHeight}px box holds ${handle.scrollWidth}x${handle.scrollHeight}px of handle`);
      }
      const handleBox = handle.getBoundingClientRect();
      if (handleBox.left < chipBox.left - 1 || handleBox.right > chipBox.right + 1) {
        fault('the handle runs outside its chip');
      }

      // The name is cut, never wrapped: wrapped, a long one stood a dozen lines tall.
      if (lineCount(name) > 1) {
        fault(`the name wraps onto ${lineCount(name)} lines`);
      }
      // And it is cut only when its chip has no more row to grow into.
      if (name.scrollWidth > name.clientWidth + 1 && chipBox.width < row.clientWidth - 1) {
        fault(`the name is cut in a ${Math.round(chipBox.width)}px chip that has ${row.clientWidth}px of row`);
      }

      // The handle wraps last: by then the name has given up all of its room,
      // and the handle has everything inside the chip but the gap.
      const chipStyle = getComputedStyle(chip);
      const room = chip.clientWidth
        - parseFloat(chipStyle.paddingLeft)
        - parseFloat(chipStyle.paddingRight)
        - (parseFloat(chipStyle.columnGap) || 0);
      if (lineCount(handle) > 1 && handle.clientWidth < room - 1) {
        fault(`the handle wraps onto ${lineCount(handle)} lines in ${handle.clientWidth}px of the ${Math.round(room)}px its chip has`);
      }
    }

    const root = document.documentElement;
    return {
      pageOverflow: root.scrollWidth - root.clientWidth,
      handles: chips.map((chip) => chip.lastElementChild?.textContent ?? ''),
      faults,
    };
  }, label));
}

/** Measures the Kling video element tiles' Insert and Copy, or answers null while there are none. */
function readKlingCardRows(page: Page): Promise<Row | null> {
  return readPastDevServerReloads(() => page.evaluate(() => {
    const heading = Array.from(document.querySelectorAll<HTMLElement>('h2'))
      .find((candidate) => candidate.textContent === 'Kling video elements');
    // The panel is the heading's nearest ancestor that holds a tile's Insert button: its handle.
    let panel = heading?.parentElement ?? null;
    while (panel && !Array.from(panel.querySelectorAll('button')).some((button) => /^Insert @/.test(button.getAttribute('aria-label') ?? ''))) {
      panel = panel.parentElement;
    }
    if (!panel) return null;

    const handles = Array.from(panel.querySelectorAll<HTMLElement>('*')).filter((element) => (
      /^@[a-z0-9_]+$/.test(element.textContent ?? '')
      && Array.from(element.children).every((child) => child.tagName === 'WBR')
    ));
    if (handles.length === 0) return null;

    const faults: string[] = [];
    for (const handle of handles) {
      const tile = handle.closest<HTMLElement>('li');
      const fault = (text: string) => faults.push(`${handle.textContent}: ${text}`);
      if (!tile) {
        fault('has no tile');
        continue;
      }

      // The two buttons named for the handle: the handle itself, which inserts it, and Copy.
      const buttons = Array.from(tile.querySelectorAll<HTMLElement>('button'))
        .filter((button) => /^(Insert|Copy) @/.test(button.getAttribute('aria-label') ?? ''));
      if (buttons.length !== 2) {
        fault(`has ${buttons.length} of Insert and Copy`);
        continue;
      }

      const tileBox = tile.getBoundingClientRect();
      for (const button of buttons) {
        for (const element of [button, ...Array.from(button.querySelectorAll<HTMLElement>('*'))]) {
          if (
            element.clientWidth > 0
            && getComputedStyle(element).overflowX === 'visible'
            && element.scrollWidth > element.clientWidth + 1
          ) {
            fault(`a ${element.clientWidth}px box holds ${element.scrollWidth}px of content: ${(element.textContent ?? '').slice(0, 40)}`);
          }
        }
        const box = button.getBoundingClientRect();
        if (box.left < tileBox.left - 1 || box.right > tileBox.right + 1) {
          fault(`${button.getAttribute('aria-label')} runs from ${Math.round(box.left)} to ${Math.round(box.right)}px, outside its tile at ${Math.round(tileBox.left)} to ${Math.round(tileBox.right)}px`);
        }
      }
    }

    const root = document.documentElement;
    return {
      pageOverflow: root.scrollWidth - root.clientWidth,
      handles: handles.map((handle) => handle.textContent ?? ''),
      faults,
    };
  }));
}

/** Types at the end of what a field already holds. */
async function typeAtEnd(field: Locator, text: string) {
  await field.focus();
  await field.evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(element.value.length, element.value.length);
  });
  await field.pressSequentially(text);
}

/**
 * The same for a panel that only shows while the prompt ends in "@". A dev server
 * reload takes the "@" away and shuts the panel, so `open` types it again until
 * the row has been measured.
 */
async function expectSuggestionsInTheirRow(page: Page, label: string, handles: string[], open: () => Promise<void>) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect(async () => {
      if (!(await page.getByText(label, { exact: true }).isVisible())) {
        await open();
      }
      expect(await readChipRow(page, label), `"${label}" at ${viewport.width}px wide`).toEqual(contained(handles));
    }).toPass({ timeout: 30_000 });
  }
}

test.describe('reference chips', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.addCookies([
      // The bypass only accepts this exact value (see src/lib/e2e-auth.ts).
      { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
    ]);
    // The restored previews load from storage. Answer them here so the page stays offline.
    await page.route('https://example.supabase.co/storage/v1/object/sign/**', (route) => (
      route.request().url().includes('.png')
        ? route.fulfill({ contentType: 'image/png', body: ONE_PIXEL_PNG })
        : route.abort()
    ));
  });

  test('the video creator keeps a long reference name inside its chips', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: SEEDANCE_REMIX }));
    const handles = REFERENCES.map((reference) => reference.handle);

    await page.goto(`/create-video?remix=${GENERATION_ID}&remixPost=${POST_ID}`);
    await expect(page.getByRole('heading', { name: 'Reference images', exact: true })).toBeVisible();

    // The row of chips over the prompt went with the column layout (2026-10-26), as on the
    // image creator: each reference has its own Insert (its tile's handle, since 2026-10-31),
    // so the chips left are the "@" panel's. Those tiles are on the page while it is measured,
    // in a strip that scrolls inside its column, so a long name in one would show here as the
    // page's overflow.
    await expectSuggestionsInTheirRow(page, 'Insert reference', handles, () => (
      typeAtEnd(page.getByPlaceholder(/^Describe the .* scene/), ' @')
    ));
  });

  test('the video creator keeps Kling clip names inside their chips and the tiles\' buttons inside their tiles', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: KLING_REMIX }));
    const handles = CLIPS.map((clip) => clip.handle);

    await page.goto(`/create-video?remix=${GENERATION_ID}&remixPost=${POST_ID}`);
    await expect(page.getByRole('heading', { name: 'Kling video elements', exact: true })).toBeVisible();

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() => readKlingCardRows(page), { message: `the cards at ${viewport.width}px wide` })
        .toEqual(contained(handles));
    }
    await expectSuggestionsInTheirRow(page, 'Insert reference', handles, () => (
      typeAtEnd(page.getByPlaceholder(/^Describe the .* scene/), ' @')
    ));

    // Each shot of a multi-shot run has a prompt of its own, with the same panel.
    await expectSuggestionsInTheirRow(page, 'Insert video element', handles, async () => {
      const shot = page.getByPlaceholder('Describe shot 1...');
      if (!(await shot.isVisible())) {
        await page.getByRole('radio', { name: 'Multi-shot', exact: true }).click();
      }
      await typeAtEnd(shot, ' @');
    });
  });

  test('the image creator keeps a long element name inside its chips', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: IMAGE_REMIX }));
    const handles = REFERENCES.map((reference) => reference.handle);

    await page.goto(`/create-image?remix=${GENERATION_ID}&remixPost=${POST_ID}`);
    await expect(page.getByRole('heading', { name: 'Reference images', exact: true })).toBeVisible();

    // The row of chips over the prompt went with the column layout (2026-10-26): each
    // reference has its own Insert, its tile's handle (reference-card-handles.spec.ts), so
    // the chips left are the "@" panel's. Those tiles are on the page while it is measured,
    // so a long name in one would show here as the page's overflow.
    await expectSuggestionsInTheirRow(page, 'Insert element', handles, () => (
      typeAtEnd(page.getByPlaceholder('Describe the image you want to create...'), ' @')
    ));
  });
});
