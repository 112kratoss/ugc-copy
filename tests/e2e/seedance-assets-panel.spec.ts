import { expect, test, type Page } from '@playwright/test';

/**
 * A Seedance asset's source stays inside its box.
 *
 * A remix restores every reference from a signed storage link, and the video
 * creator's Seedance Assets panel printed that link as the reference's source.
 * Its token is several hundred characters with nowhere to break, so the text ran
 * out of its box and the whole document scrolled sideways: 3213px in a 2545px
 * window on production (2026-10-02). A fresh upload shows a short value, which
 * is how it went unseen. The workflow builder's card printed the same link, and
 * there it scrolled the node inspector sideways instead of the page.
 *
 * Vitest cannot reach this. The data was right and only the layout was wrong.
 */

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const OWNER_ID = '0b9f6c2e-51d7-4c3a-9e84-2f6a1d7c5b90';
const GENERATION_ID = '7c1e4a58-93bd-4f06-8a27-d5e0b6f3a914';
const POST_ID = '6f0d2b1c-8a47-4e9b-b3c5-1d2e3f4a5b6c';

const IMAGE_FILES = ['01-reference_image_1.png', '02-reference_image_2.png', '03-reference_image_3.png'];
// A creator's own file name can be one long run too, and it is what the panel
// shows once the link is gone.
const VIDEO_FILE = 'Screen_Recording_2026_10_02_at_10_15_33_AM_harbour_dolly_shot_final_export_4k.mp4';

function storagePath(fileName: string) {
  return `generation_inputs/${OWNER_ID}/${GENERATION_ID}/${fileName}`;
}

/**
 * Shaped like a signed storage link: the object path, then a token of three
 * dot-joined base64url segments. It is built here, so no token literal is committed.
 */
function signedUrl(fileName: string) {
  const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = [
    segment({ alg: 'HS256', typ: 'JWT' }),
    segment({ url: storagePath(fileName), iat: 1_790_000_000, exp: 1_790_003_600 }),
    segment({ placeholder: 'not a signature', pad: 'x'.repeat(16) }),
  ].join('.');
  return `https://example.supabase.co/storage/v1/object/sign/${storagePath(fileName)}?token=${token}`;
}

// An asset the provider refused on an earlier run. Its message quotes the link it
// could not read, so the error box holds the same unbreakable token.
const REFUSED_ASSET = {
  assetId: 'asset-20261002043000-7c1e4a5893bd4f068a27d5e0b6f3a914',
  assetType: 'Image',
  status: 'failed',
  sourceUrl: signedUrl(IMAGE_FILES[0]),
  error: `The provider could not read ${signedUrl(IMAGE_FILES[0])}`,
  lastCheckedAt: '2026-10-02T04:30:00.000Z',
};

const REMIX_SOURCE = {
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
      elements: IMAGE_FILES.map((fileName, index) => ({
        id: `element-${index + 1}`,
        displayName: `Image reference ${index + 1}`,
        handle: `@image_${index + 1}`,
        url: signedUrl(fileName),
        storagePath: storagePath(fileName),
        sourceGenerationId: GENERATION_ID,
      })),
      referenceVideos: [
        {
          kind: 'video',
          label: 'Video reference 1',
          url: signedUrl(VIDEO_FILE),
          storagePath: storagePath(VIDEO_FILE),
          sourceGenerationId: GENERATION_ID,
          durationSeconds: 12.2,
        },
      ],
      referenceAudios: [],
    },
  },
  workflowSettings: {
    model: 'seedance-2',
    duration: '5',
    aspectRatio: '16:9',
    seedanceAssets: { images: [REFUSED_ASSET] },
  },
  restoreIssues: [],
};

const WORKFLOW_CANVAS = {
  id: 'canvas-1',
  title: 'Workflow canvas',
  created_at: '2026-10-02T04:00:00.000Z',
  updated_at: '2026-10-02T04:00:00.000Z',
  revision: 0,
  graph: {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 0.85 },
    nodes: [
      {
        id: 'image-input-1',
        type: 'image-input',
        position: { x: 120, y: 160 },
        draggable: true,
        data: {
          title: 'Image input',
          subtitle: 'Upload or connect image',
          // No storage path: the node only knows the link it was restored from.
          imageUrl: signedUrl(IMAGE_FILES[0]),
          storagePath: null,
          seedanceAsset: REFUSED_ASSET,
          runState: { status: 'idle', generationId: null, outputUrl: null, error: null, cost: null, updatedAt: null },
        },
      },
    ],
    edges: [],
  },
};

type PanelMeasurement = {
  /** How far the document is wider than its viewport, in pixels. */
  pageOverflow: number;
  /** Every box in the panel whose content is wider than the box. */
  spilling: string[];
};

const CONTAINED: PanelMeasurement = { pageOverflow: 0, spilling: [] };

/** Measures the panel under `title`, or answers null while it is not on the page. */
async function measurePanel(page: Page, title: string): Promise<PanelMeasurement | null> {
  try {
    return await page.evaluate((panelTitle) => {
      const heading = Array.from(document.querySelectorAll<HTMLElement>('h2, div'))
        .find((candidate) => candidate.childElementCount === 0 && candidate.textContent === panelTitle);
      // Both panels end with their "Last checked" field.
      let panel = heading ?? null;
      while (panel && !panel.textContent?.includes('Last checked')) {
        panel = panel.parentElement;
      }
      if (!panel) return null;

      const spilling = Array.from(panel.querySelectorAll<HTMLElement>('*'))
        // An inline box reports no width of its own.
        .filter((element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1)
        .map((element) => `${element.clientWidth}px box, ${element.scrollWidth}px of content: ${(element.textContent ?? '').slice(0, 48)}`);
      const root = document.documentElement;

      return { pageOverflow: root.scrollWidth - root.clientWidth, spilling };
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

test.describe('Seedance asset panels', () => {
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

  test('a remix with signed reference links never widens the video creator', async ({ page }) => {
    await page.route('**/api/remix-source*', (route) => route.fulfill({ json: REMIX_SOURCE }));

    await page.goto(`/create-video?remix=${GENERATION_ID}&remixPost=${POST_ID}`);

    // The remix is restored: three images and a clip, each with a source, and the
    // first image carrying the provider's refusal.
    await expect(page.getByRole('heading', { name: 'Seedance Assets' })).toBeVisible();
    await expect(page.getByText('0/4 ready')).toBeVisible();
    await expect(page.getByText(/^Source: /)).toHaveCount(4);
    await expect(page.getByText(/^The provider could not read https:/)).toBeVisible();

    for (const viewport of [
      { width: 1280, height: 720 },
      // One column. Here a box that cannot shrink grows with its text, so nothing
      // spills out of it and only the page's own width shows the fault.
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() => measurePanel(page, 'Seedance Assets'), { message: `at ${viewport.width}px wide` })
        .toEqual(CONTAINED);
    }

    // Each source is named by its file. The link, and the token in it, stay out of it.
    for (const fileName of [...IMAGE_FILES, VIDEO_FILE]) {
      await expect(page.getByText(`Source: ${fileName}`, { exact: true })).toBeVisible();
    }
    await expect(page.getByText(/^Source: .*(https:|token=)/)).toHaveCount(0);
  });

  test('a signed source never scrolls the workflow builder node inspector sideways', async ({ page }) => {
    await page.route('**/api/workflow-canvases', (route) => route.fulfill({
      json: route.request().method() === 'GET'
        ? {
          canvases: [{
            id: WORKFLOW_CANVAS.id,
            title: WORKFLOW_CANVAS.title,
            updated_at: WORKFLOW_CANVAS.updated_at,
            revision: WORKFLOW_CANVAS.revision,
          }],
        }
        : { canvas: WORKFLOW_CANVAS },
    }));
    await page.route('**/api/workflow-canvases/*', (route) => route.fulfill({ json: { canvas: WORKFLOW_CANVAS } }));

    await page.goto(`/create-workflow?canvas=${WORKFLOW_CANVAS.id}`);

    const node = page.getByRole('application').getByText('Image input', { exact: true });
    const card = page.getByText('Seedance asset', { exact: true });
    // A double click opens the node's parameters. A dev server reload closes them
    // again, so reopen them until the card has been measured.
    await expect(async () => {
      if (!(await card.isVisible())) {
        await node.dblclick();
      }
      await expect(page.getByText(/^The provider could not read https:/)).toBeVisible();
      expect(await measurePanel(page, 'Seedance asset')).toEqual(CONTAINED);
      // The source is the file's name, in a box of its own.
      await expect(page.getByText(IMAGE_FILES[0], { exact: true })).toBeVisible();
    }).toPass({ timeout: 30_000 });
  });
});
