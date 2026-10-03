import { expect, test, type Page } from '@playwright/test';

/**
 * A reference card shows the whole @handle of its element.
 *
 * Each card names its element and gives the @handle the prompt has to mention.
 * The handle shared one line with the Insert button and was cut to whatever was
 * left. The cards are 160px wide on a desktop, which left it about 35px, so every
 * card read "@im…" (2026-10-02), and two Kling clips both read "@video_element…".
 * A handle is one run of letters, digits and underscores, so the browser could
 * not wrap it either.
 *
 * The row wraps now: a handle that does not fit beside the buttons takes a line
 * of its own, and it breaks after an underscore when that line is too short too.
 *
 * Vitest cannot reach this. The handle was always in the document, and only the
 * layout hid it.
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
 * The three kinds of handle a card has to show:
 * the one a restored reference gets by default, which is the handle from the report;
 * a long one made of several words, which can break after an underscore;
 * and one unbroken run, here a camera file name, which has no underscore to break at.
 */
const REFERENCES = [
  { name: 'Image reference 1', handle: '@image_reference_1' },
  { name: 'Protagonist in the crimson raincoat', handle: '@protagonist_in_the_crimson_raincoat' },
  { name: 'IMG20261002173045', handle: '@img20261002173045' },
];

// The second clip's default name. Its handle was three pixels too wide, which cost
// it the one character that tells it from the first clip's.
const CLIPS = [
  { name: 'Opening drone shot', handle: '@opening_drone_shot' },
  { name: 'Video element 2', handle: '@video_element_2' },
  { name: 'Protagonist in the crimson raincoat', handle: '@protagonist_in_the_crimson_raincoat' },
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
  // Three cards to a row, each about 160px wide. No handle fits beside its button.
  { width: 1280, height: 720 },
  // Two cards to a row. The default handle does not fit beside the button, and
  // fits on a line of its own.
  { width: 768, height: 1024 },
  // One card to a row. Only the long handle is too wide for the button's line.
  { width: 390, height: 844 },
];

type CardHandles = {
  /** The handle on each card in order, as the page's own text has it. */
  handles: string[];
  /** One line for each handle its card does not show whole. */
  hidden: string[];
};

/** Reads the handles on the cards under `title`, or answers null while there are none. */
async function readCardHandles(page: Page, title: string): Promise<CardHandles | null> {
  try {
    return await page.evaluate((panelTitle) => {
      const heading = Array.from(document.querySelectorAll<HTMLElement>('h2'))
        .find((candidate) => candidate.textContent === panelTitle);
      // The panel is the heading's nearest ancestor that holds a card's Insert button.
      let panel = heading?.parentElement ?? null;
      while (panel && !Array.from(panel.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Insert')) {
        panel = panel.parentElement;
      }
      if (!panel) return null;

      const handles = Array.from(panel.querySelectorAll<HTMLElement>('*')).filter((element) => (
        /^@[a-z0-9_]+$/.test(element.textContent ?? '')
        && Array.from(element.children).every((child) => child.tagName === 'WBR')
      ));
      if (handles.length === 0) return null;

      const hidden = handles.flatMap((handle) => {
        const row = handle.parentElement;
        if (!row) return [`${handle.textContent}: has no row`];
        // An inline box reports no width, which would pass every check below.
        if (handle.clientWidth === 0) return [`${handle.textContent}: has no box of its own to measure`];

        const faults: string[] = [];
        if (handle.scrollWidth > handle.clientWidth || handle.scrollHeight > handle.clientHeight) {
          faults.push(`a ${handle.clientWidth}x${handle.clientHeight}px box holds ${handle.scrollWidth}x${handle.scrollHeight}px of text`);
        }

        const box = handle.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        if (box.left < rowBox.left - 1 || box.right > rowBox.right + 1) {
          faults.push(`runs from ${Math.round(box.left)} to ${Math.round(box.right)}px, outside its row at ${Math.round(rowBox.left)} to ${Math.round(rowBox.right)}px`);
        }

        // A handle that has to wrap must have the row to itself. Squeezed into the
        // room beside the buttons it would be a ribbon four characters wide.
        const text = document.createRange();
        text.selectNodeContents(handle);
        const lines = new Set(Array.from(text.getClientRects()).map((line) => Math.round(line.top))).size;
        const rowStyle = getComputedStyle(row);
        const rowWidth = row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight);
        if (lines > 1 && handle.clientWidth < rowWidth - 1) {
          faults.push(`wraps onto ${lines} lines in ${handle.clientWidth}px of a ${Math.round(rowWidth)}px row`);
        }

        return faults.map((fault) => `${handle.textContent}: ${fault}`);
      });

      return { handles: handles.map((handle) => handle.textContent ?? ''), hidden };
    }, title);
  } catch (error) {
    // The dev server reloads open pages on its own (see kling-o3-named-subjects.spec.ts),
    // which tears the page down mid-read. Answer "unknown" and let the caller ask again.
    if (error instanceof Error && /Execution context was destroyed|frame was detached/.test(error.message)) {
      return null;
    }
    throw error;
  }
}

async function expectWholeHandles(page: Page, title: string, handles: string[]) {
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() => readCardHandles(page, title), { message: `at ${viewport.width}px wide` })
      .toEqual({ handles, hidden: [] });
  }
}

test.describe('reference card handles', () => {
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

  test('the video creator shows each reference image handle whole', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: SEEDANCE_REMIX }));

    await page.goto(`/create-video?remix=${GENERATION_ID}&remixPost=${POST_ID}`);

    await expectWholeHandles(page, 'Reusable image references', REFERENCES.map((reference) => reference.handle));
  });

  test('the video creator shows each Kling video element handle whole', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: KLING_REMIX }));

    await page.goto(`/create-video?remix=${GENERATION_ID}&remixPost=${POST_ID}`);

    await expectWholeHandles(page, 'Kling video elements', CLIPS.map((clip) => clip.handle));
  });

  test('the image creator shows each element handle whole', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: IMAGE_REMIX }));

    await page.goto(`/create-image?remix=${GENERATION_ID}&remixPost=${POST_ID}`);

    await expectWholeHandles(page, 'Elements', REFERENCES.map((reference) => reference.handle));
  });
});
