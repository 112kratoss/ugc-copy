import { expect, test } from '@playwright/test';

const BASE_TIMESTAMP = '2026-03-30T04:00:00.000Z';
const UPDATED_TIMESTAMP = '2026-03-30T04:01:00.000Z';

function createStarterCanvas() {
  const promptId = 'text-input-1';
  const imageInputId = 'image-input-1';
  const imageGeneratorId = 'image-generate-1';
  const videoGeneratorId = 'video-generate-1';
  const motionControlId = 'motion-generate-1';
  const noteId = 'note-1';

  return {
    id: 'canvas-1',
    title: 'Workflow canvas',
    created_at: BASE_TIMESTAMP,
    updated_at: BASE_TIMESTAMP,
    revision: 0,
    graph: {
      version: 1,
      viewport: {
        x: 0,
        y: 0,
        zoom: 0.85,
      },
      nodes: [
        {
          id: promptId,
          type: 'text-input',
          position: { x: 120, y: 140 },
          draggable: true,
          data: {
            title: 'Prompt',
            subtitle: 'Text input',
            text: 'UGC creator in a warmly lit room introducing the product and landing a strong CTA.',
            runState: {
              status: 'idle',
              generationId: null,
              outputUrl: null,
              error: null,
              cost: null,
              updatedAt: null,
            },
          },
        },
        {
          id: imageInputId,
          type: 'image-input',
          position: { x: 120, y: 360 },
          draggable: true,
          data: {
            title: 'Image input',
            subtitle: 'Upload or connect image',
            imageUrl: null,
            storagePath: null,
            runState: {
              status: 'idle',
              generationId: null,
              outputUrl: null,
              error: null,
              cost: null,
              updatedAt: null,
            },
          },
        },
        {
          id: videoGeneratorId,
          type: 'video-generate',
          position: { x: 460, y: 320 },
          draggable: true,
          data: {
            title: 'Video generator',
            subtitle: 'Kling / Seedance / Veo',
            model: 'kling-3.0-video',
            aspectRatio: '9:16',
            duration: 5,
            mode: 'std',
            sound: false,
            resolution: '720p',
            fixedLens: false,
            runState: {
              status: 'idle',
              generationId: null,
              outputUrl: null,
              error: null,
              cost: null,
              updatedAt: null,
            },
          },
        },
        {
          id: imageGeneratorId,
          type: 'image-generate',
          position: { x: 460, y: 120 },
          draggable: true,
          data: {
            title: 'Image generator',
            subtitle: 'Nano Banana',
            model: 'nano-banana-2',
            aspectRatio: '9:16',
            resolution: '1K',
            outputFormat: 'jpg',
            googleSearch: false,
            runState: {
              status: 'idle',
              generationId: null,
              outputUrl: null,
              error: null,
              cost: null,
              updatedAt: null,
            },
          },
        },
        {
          id: motionControlId,
          type: 'motion-generate',
          position: { x: 840, y: 320 },
          draggable: true,
          data: {
            title: 'Motion control',
            subtitle: 'Character motion transfer',
            model: 'kling-3.0',
            mode: '720p',
            characterOrientation: 'video',
            runState: {
              status: 'idle',
              generationId: null,
              outputUrl: null,
              error: null,
              cost: null,
              updatedAt: null,
            },
          },
        },
        {
          id: noteId,
          type: 'note',
          position: { x: 120, y: 580 },
          draggable: true,
          data: {
            title: 'Note',
            subtitle: 'Canvas note',
            text: 'Starter template: prompt can branch into image and video generation. Image output can feed the video generator for first-frame setups.',
            runState: {
              status: 'idle',
              generationId: null,
              outputUrl: null,
              error: null,
              cost: null,
              updatedAt: null,
            },
          },
        },
      ],
      edges: [
        {
          id: `${promptId}:text->${imageGeneratorId}:prompt`,
          source: promptId,
          target: imageGeneratorId,
          sourceHandle: 'text',
          targetHandle: 'prompt',
        },
        {
          id: `${promptId}:text->${videoGeneratorId}:prompt`,
          source: promptId,
          target: videoGeneratorId,
          sourceHandle: 'text',
          targetHandle: 'prompt',
        },
        {
          id: `${imageInputId}:image->${videoGeneratorId}:reference-image`,
          source: imageInputId,
          target: videoGeneratorId,
          sourceHandle: 'image',
          targetHandle: 'reference-image',
        },
        {
          id: `${videoGeneratorId}:video->${motionControlId}:reference-video`,
          source: videoGeneratorId,
          target: motionControlId,
          sourceHandle: 'video',
          targetHandle: 'reference-video',
        },
        {
          id: `${imageInputId}:image->${motionControlId}:reference-image`,
          source: imageInputId,
          target: motionControlId,
          sourceHandle: 'image',
          targetHandle: 'reference-image',
        },
      ],
    },
  };
}

test.describe('workflow builder smoke tests', () => {
  test('redirects unauthenticated visitors to login', async ({ page }) => {
    await page.goto('/create-workflow');
    await expect(page).toHaveURL(/\/login\?returnUrl=%2Fcreate-workflow/);
  });

  test('loads the workflow page, saves title edits, and shows blocked run affordances', async ({ context, page }) => {
    const canvas = createStarterCanvas();
    const savePayloads: Array<{ title?: string }> = [];
    let listRequestCount = 0;
    let detailRequestCount = 0;

    await context.addCookies([
      {
        name: 'e2e-auth',
        value: 'workflow-user',
        url: 'http://127.0.0.1:3100',
      },
    ]);

    await page.route('**/api/workflow-canvases', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        listRequestCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            canvases: [{
              id: canvas.id,
              title: canvas.title,
              updated_at: canvas.updated_at,
              revision: canvas.revision,
            }],
          }),
        });
        return;
      }

      if (method === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ canvas }),
        });
        return;
      }

      await route.continue();
    });

    await page.route('**/api/workflow-canvases/*', async (route) => {
      const method = route.request().method();

      if (method === 'GET') {
        detailRequestCount += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ canvas }),
        });
        return;
      }

      if (method === 'PATCH') {
        const payload = route.request().postDataJSON() as { title?: string };
        savePayloads.push(payload);
        canvas.title = payload.title ?? canvas.title;
        canvas.updated_at = UPDATED_TIMESTAMP;
        canvas.revision += 1;

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ canvas }),
        });
        return;
      }

      await route.continue();
    });

    await page.route('**/api/workflow-canvases/*/run', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runId: 'run-1' }),
      });
    });

    await page.route('**/api/workflow-canvases/*/runs/run-1', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run: {
            id: 'run-1',
            canvas_id: canvas.id,
            start_node_id: 'video-generate-1',
            mode: 'node',
            status: 'processing',
            created_at: UPDATED_TIMESTAMP,
            finished_at: null,
            steps: [],
          },
        }),
      });
    });

    await page.goto('/create-workflow');
    await expect.poll(() => listRequestCount).toBeGreaterThan(0);
    await expect.poll(() => detailRequestCount).toBeGreaterThan(0);

    const videoGeneratorNode = page.getByText('Video generator', { exact: true }).first();

    await expect(page.getByText('Workflow Canvas', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('textbox').first()).toHaveValue('Workflow canvas');
    await expect(videoGeneratorNode).toBeVisible();

    await page.getByRole('button', { name: /^planner$/i }).click();
    await expect(page.getByTestId('planner-assistant-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('planner-assistant-drawer')).toBeHidden();

    const titleInput = page.getByRole('textbox').first();
    await titleInput.fill('Updated workflow canvas');
    await page.getByRole('button', { name: /^save$/i }).click();

    await expect.poll(() => savePayloads.length).toBe(1);
    await expect.poll(() => savePayloads[0]?.title).toBe('Updated workflow canvas');

    await videoGeneratorNode.click();
    await expect(page.getByText('Image input has no image output yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Run node' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Run from here' })).toBeDisabled();
  });
});
