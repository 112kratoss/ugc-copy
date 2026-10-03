import { expect, test, type Page } from '@playwright/test';

/**
 * A canvas run stores the catalog revision the editor starts it with, and the
 * run worker prices a step at the active revision only. The editor reads the
 * revision when the page loads and when a node's settings open, so a tab left
 * open across a catalog release used to start its next run at the old revision,
 * and every generate step of that run was refused.
 *
 * This covers the browser half vitest cannot reach: the real page with its
 * catalog session, a release published while the tab stays open, and the
 * request the node's own Run control sends afterwards.
 */

const RELEASED_REVISION = 'release-published-while-the-tab-was-open';
const IMAGE_MODEL = 'nano-banana-2';
const TIMESTAMP = '2026-10-03T04:00:00.000Z';

function createCanvas() {
  const idle = {
    status: 'idle',
    generationId: null,
    outputUrl: null,
    error: null,
    cost: null,
    updatedAt: null,
  };

  return {
    id: 'canvas-1',
    title: 'Release during a session',
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    revision: 0,
    graph: {
      version: 1,
      viewport: { x: 0, y: 0, zoom: 0.85 },
      nodes: [
        {
          id: 'text-input-1',
          type: 'text-input',
          position: { x: 120, y: 160 },
          draggable: true,
          data: {
            title: 'Prompt',
            subtitle: 'Text input',
            text: 'A product photo on a marble counter in soft morning light.',
            runState: idle,
          },
        },
        {
          id: 'image-generate-1',
          type: 'image-generate',
          position: { x: 480, y: 160 },
          draggable: true,
          data: {
            title: 'Image generator',
            subtitle: 'Nano Banana',
            model: IMAGE_MODEL,
            aspectRatio: '9:16',
            resolution: '1K',
            outputFormat: 'jpg',
            googleSearch: false,
            runState: idle,
          },
        },
      ],
      edges: [
        {
          id: 'text-input-1:text->image-generate-1:prompt',
          source: 'text-input-1',
          target: 'image-generate-1',
          sourceHandle: 'text',
          targetHandle: 'prompt',
        },
      ],
    },
  };
}

type CatalogModel = { id: string };

/**
 * Everything the dev server's catalog offers on the web, read once. The catalog
 * routes are then answered from this copy, so nothing a test waits on depends
 * on how fast the dev server compiles or answers them.
 */
async function readPublishedCatalog(page: Page) {
  const read = async (path: string) => {
    const response = await page.request.get(`/api/model-catalog/v1/${path}`);
    expect(response.ok(), `GET /api/model-catalog/v1/${path}`).toBe(true);
    return response.json();
  };
  const current = await read('current');
  const summaries: CatalogModel[] = [];
  let cursor: string | null = null;
  do {
    const list = await read(
      `models?revision=${current.revision}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    summaries.push(...list.models);
    cursor = list.nextCursor;
  } while (cursor);
  const models: CatalogModel[] = [];
  for (let index = 0; index < summaries.length; index += 8) {
    const ids = summaries.slice(index, index + 8).map((model) => model.id);
    models.push(...(await read(`details?revision=${current.revision}&ids=${ids.join(',')}`)).models);
  }
  return { current, summaries, models };
}

/**
 * Opens the canvas with persistence stubbed and the catalog under the test's
 * control, and waits until the editor holds the revision the server had then.
 * Moving `catalog.published` afterwards is a release the open tab never saw.
 */
async function openCanvasBeforeRelease(page: Page) {
  const canvas = createCanvas();
  const published = await readPublishedCatalog(page);
  const catalog = {
    loadedRevision: published.current.revision as string,
    published: published.current.revision as string,
    removedModels: [] as string[],
  };
  // In arrival order: 'current' for a read of the current revision, 'run' for
  // a run request, and 'click' pushed by the test before it starts a run.
  const events: string[] = [];
  const detailReads: string[] = [];
  const runRequests: Array<{ catalogRevision: unknown; startNodeId: unknown; mode: unknown }> = [];

  await page.context().addCookies([
    { name: 'e2e-auth', value: 'workflow-user', url: 'http://127.0.0.1:3100' },
  ]);

  await page.route('**/api/model-catalog/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/current')) {
      events.push('current');
      await route.fulfill({ json: { ...published.current, revision: catalog.published } });
      return;
    }

    // Pages and details are immutable per revision: they answer in the name of
    // the revision that was asked for, as the real routes do.
    const requested = url.searchParams.get('revision') ?? '';
    if (url.pathname.endsWith('/models')) {
      await route.fulfill({
        json: {
          transportVersion: 1,
          revision: requested,
          models: published.summaries.slice(0, 50),
          nextCursor: null,
        },
      });
      return;
    }

    const ids = (url.searchParams.get('ids') ?? '').split(',');
    // The release that takes a model away is the one published later.
    const removed = requested === catalog.loadedRevision ? [] : catalog.removedModels;
    const models = published.models.filter((model) => ids.includes(model.id) && !removed.includes(model.id));
    detailReads.push(requested);
    await route.fulfill({
      json: {
        transportVersion: 1,
        descriptorSchemaVersion: 3,
        revision: requested,
        models,
        missingIds: ids.filter((id) => !models.some((model) => model.id === id)),
      },
    });
  });

  await page.route('**/api/workflow-canvases', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        json: {
          canvases: [{
            id: canvas.id,
            title: canvas.title,
            updated_at: canvas.updated_at,
            revision: canvas.revision,
          }],
        },
      });
      return;
    }
    await route.fulfill({ json: { canvas } });
  });

  await page.route('**/api/workflow-canvases/*', async (route) => {
    await route.fulfill({ json: { canvas } });
  });

  await page.route('**/api/workflow-canvases/*/run', async (route) => {
    events.push('run');
    runRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { runId: 'run-1', status: 'processing' } });
  });

  await page.route('**/api/workflow-canvases/*/runs/*', async (route) => {
    await route.fulfill({
      json: {
        run: {
          id: 'run-1',
          canvas_id: canvas.id,
          start_node_id: 'image-generate-1',
          mode: 'node',
          status: 'succeeded',
          created_at: TIMESTAMP,
          finished_at: TIMESTAMP,
          steps: [],
        },
      },
    });
  });

  await page.goto(`/create-workflow?canvas=${canvas.id}`);
  await expect(page.getByText('Image generator', { exact: true }).first()).toBeVisible();
  // The editor asks for a revision's model details only once it holds that
  // revision, so this read is the page saying which one it loaded.
  await expect.poll(() => detailReads).toContain(catalog.loadedRevision);

  return { catalog, events, detailReads, runRequests };
}

async function runImageStep(page: Page, events: string[]) {
  const node = page.locator('.react-flow__node').filter({ hasText: 'Image generator' });
  // Select the node first: its run control opens the menu on a selected node.
  await node.click();
  await node.getByTestId('workflow-node-action-play').click();
  events.push('click');
  await page.getByTestId('workflow-node-run-node').click();
}

test.describe('workflow run after a catalog release', () => {
  // The editor keeps reading the catalog in the background. A read that is
  // still being answered when a test ends must not count against it.
  test.afterEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  });

  test('starts the run at the revision published while the tab was open', async ({ page }) => {
    const { catalog, events, detailReads, runRequests } = await openCanvasBeforeRelease(page);

    catalog.published = RELEASED_REVISION;
    await runImageStep(page, events);

    await expect.poll(() => runRequests.length).toBe(1);
    expect(runRequests[0]).toEqual({
      startNodeId: 'image-generate-1',
      mode: 'node',
      catalogRevision: RELEASED_REVISION,
    });
    // The run control asked for the current revision before it sent the run,
    // and read the canvas's model from the new release.
    const sinceClick = events.slice(events.lastIndexOf('click') + 1);
    expect(sinceClick.slice(0, sinceClick.indexOf('run'))).toContain('current');
    expect(detailReads).toContain(RELEASED_REVISION);
  });

  test('does not start a run when the release took away the canvas model', async ({ page }) => {
    const { catalog, events, runRequests } = await openCanvasBeforeRelease(page);

    catalog.published = RELEASED_REVISION;
    catalog.removedModels = [IMAGE_MODEL];
    await runImageStep(page, events);

    const refusal = page.getByText(
      `Unavailable models: ${IMAGE_MODEL}. Choose replacements before running; your workflow has been preserved.`,
    );
    await expect.poll(async () => runRequests.length > 0 || await refusal.isVisible()).toBe(true);
    expect(runRequests).toEqual([]);
    await expect(refusal).toBeVisible();
  });
});
