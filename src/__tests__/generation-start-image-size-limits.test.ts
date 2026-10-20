import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import type {
  ImageInputNodeData,
  TextInputNodeData,
  VideoGenerateNodeData,
} from '@/lib/workflow-canvas';

// A workflow step holds its credits with the service client the runner creates.
const serviceClientRef: { current: unknown } = { current: null };
vi.mock('@/lib/server-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
  createServiceClient: () => serviceClientRef.current,
}));

/**
 * Every start refuses a picture larger than Kie takes for its model before the run's
 * credits are held (provider-image-limits). Kie used to refuse it only after the hold, so
 * the run failed and was refunded. These drive the real start services; the service
 * client stands in for the database and storage, and the hold is the `start_generation`
 * call, which answers with an error so a start that gets that far stops there.
 */

const MB = 1024 * 1024;
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SUPABASE = 'https://project.supabase.co';

const OPERATIONS = new Map(buildCodeGenerationModelOperations().map((operation) => [operation.modelId, operation]));

function operation(modelId: string) {
  const found = OPERATIONS.get(modelId);
  if (!found) throw new Error(`no code operation for ${modelId}`);
  return found;
}

function signed(bucket: string, path: string): string {
  return `${SUPABASE}/storage/v1/object/sign/${bucket}/${path}?token=signed-token`;
}

/** Finalized uploads of the given sizes, by file name under the caller's folder. */
function createServiceClient(uploadSizes: Record<string, number> = {}) {
  const reservationReads: string[][] = [];
  const holds: string[] = [];
  const client = {
    rpc: vi.fn(async (fn: string) => {
      if (fn === 'claim_generation_start_request') return { data: 'claimed', error: null };
      if (fn === 'try_acquire_backend_job_lock' || fn === 'release_backend_job_lock') return { data: true, error: null };
      if (fn === 'start_generation' || fn === 'start_template_generation') {
        holds.push(fn);
        return { data: null, error: { message: 'Stopped at the credit hold.' } };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    }),
    from: vi.fn((table: string) => {
      const paths: string[] = [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: (column: string, values: string[]) => {
          if (column === 'storage_path') paths.push(...values);
          return builder;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) {
          if (table !== 'upload_byte_reservations') {
            return Promise.resolve({ data: null, error: { message: `unexpected table ${table}` } }).then(resolve, reject);
          }
          reservationReads.push(paths);
          const rows = paths.flatMap((storagePath) => {
            const fileName = storagePath.slice(`${USER_ID}/`.length);
            return Object.hasOwn(uploadSizes, fileName)
              ? [{
                  user_id: USER_ID,
                  bucket_id: 'uploads',
                  storage_path: storagePath,
                  actual_bytes: uploadSizes[fileName],
                  finalization_status: 'finalized',
                }]
              : [];
          });
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    }),
    storage: {
      from: vi.fn((bucket: string) => ({
        createSignedUrl: vi.fn(async (path: string) => ({ data: { signedUrl: signed(bucket, path) }, error: null })),
        info: vi.fn(async () => ({ data: null, error: { message: 'Object not found', statusCode: '404' } })),
      })),
    },
  };
  return { client, reservationReads, holds };
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the start to stop');
}

describe('generation starts hold pictures to Kie’s size limits before the credit hold', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('KIE_AI_API_KEY', 'test-key');
    vi.stubEnv('KIE_PROVIDER_WEBHOOK_SECRET', 'test-webhook-secret');
    vi.stubEnv('KIE_WEBHOOK_HMAC_KEY', 'hmac-key');
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://magicbooklet.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE);
    vi.stubEnv('GENERATION_MODEL_CATALOG_SOURCE', 'code');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function startQwen(uploadSizes: Record<string, number>) {
    const { startCatalogGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient(uploadSizes);
    const outcome = await settle(startCatalogGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      operation: operation('qwen3'),
      catalogRevision: 'code',
      prompt: 'Put the label on the bottle',
      settings: { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg' },
      inputs: [
        { slot: 'imageReferences', kind: 'image', url: `uploads/${USER_ID}/bottle.png` },
        { slot: 'imageReferences', kind: 'image', url: `uploads/${USER_ID}/label.png` },
      ],
      quotedCostCredits: 6,
      persistInputMedia: false,
    }));
    return { outcome, ...service };
  }

  it('refuses an oversized reference before the hold', async () => {
    const { outcome, holds, reservationReads } = await startQwen({ 'bottle.png': 2 * MB, 'label.png': 13_002_342 });

    expect(outcome).toMatchObject({
      name: 'GenerationServiceError',
      status: 400,
      message: 'Qwen Image 3.0 takes reference images up to 10 MB; Reference 2 is 12.4 MB.',
    });
    expect(holds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    // Both uploads in one read.
    expect(reservationReads).toEqual([[`${USER_ID}/bottle.png`, `${USER_ID}/label.png`]]);
  });

  it('starts a run whose pictures are at the limit', async () => {
    const { outcome, holds } = await startQwen({ 'bottle.png': 10 * MB, 'label.png': 10 * MB });

    expect(outcome).toMatchObject({ message: 'Stopped at the credit hold.' });
    expect(holds).toEqual(['start_generation']);
  });

  it('starts a run whose picture sizes cannot be learned', async () => {
    const { outcome, holds } = await startQwen({});

    expect(outcome).toMatchObject({ message: 'Stopped at the credit hold.' });
    expect(holds).toEqual(['start_generation']);
  });

  it('measures a model with no limit not at all', async () => {
    const { startCatalogGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient({ 'huge.png': 40 * MB });

    const outcome = await settle(startCatalogGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      operation: operation('gpt-image-2'),
      catalogRevision: 'code',
      prompt: 'A poster of the bottle',
      settings: { aspectRatio: '1:1', resolution: '1K' },
      inputs: [{ slot: 'imageReferences', kind: 'image', url: `uploads/${USER_ID}/huge.png` }],
      quotedCostCredits: 6,
      persistInputMedia: false,
    }));

    expect(outcome).toMatchObject({ message: 'Stopped at the credit hold.' });
    expect(service.holds).toEqual(['start_generation']);
    expect(service.reservationReads).toEqual([]);
    expect(service.client.storage.from).not.toHaveBeenCalled();
  });

  it('refuses through the image start’s own payload path (Grok Imagine)', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient({ 'look.png': 11 * MB });

    const outcome = await settle(startImageGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      prompt: 'Make it a watercolor',
      model: 'grok-imagine-image',
      imageUrls: [`uploads/${USER_ID}/look.png`],
      aspectRatio: '1:1',
      operationalConfig: operation('grok-imagine-image'),
      persistInputMedia: false,
    }));

    expect(outcome).toMatchObject({
      status: 400,
      message: 'Grok Imagine takes reference images up to 10 MB; Reference 1 is 11.0 MB.',
    });
    expect(service.holds).toEqual([]);
  });

  it('refuses through the image start’s catalog path once (Qwen Image 3.0)', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient({ 'label.png': 10 * MB + 1 });

    const outcome = await settle(startImageGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      prompt: 'Put the label on the bottle',
      model: 'qwen3',
      imageUrls: [`uploads/${USER_ID}/label.png`],
      aspectRatio: '1:1',
      operationalConfig: operation('qwen3'),
      persistInputMedia: false,
    }));

    expect(outcome).toMatchObject({
      status: 400,
      message: 'Qwen Image 3.0 takes reference images up to 10 MB; Reference 1 is 10.1 MB.',
    });
    expect(service.holds).toEqual([]);
    expect(service.reservationReads).toHaveLength(1);
  });

  it('holds Ideogram Character’s reference to the 10 MB its references may total', async () => {
    const { startImageGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient({ 'hero.png': 10.5 * MB });

    const outcome = await settle(startImageGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      prompt: 'The hero at the harbour',
      model: 'ideogram-character',
      imageUrls: [`uploads/${USER_ID}/hero.png`],
      aspectRatio: '1:1',
      qualityMode: 'turbo',
      operationalConfig: operation('ideogram-character'),
      persistInputMedia: false,
    }));

    expect(outcome).toMatchObject({
      status: 400,
      message: 'Ideogram Character takes up to 10 MB of reference images in total; yours come to 10.5 MB.',
    });
    expect(service.holds).toEqual([]);
  });

  it('refuses an oversized start frame through the video start (Hailuo 2.3)', async () => {
    const { startVideoGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient({ 'frame.png': 12 * MB });

    const outcome = await settle(startVideoGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      prompt: 'The dancer spins',
      model: 'hailuo-2.3',
      startImageUrl: `uploads/${USER_ID}/frame.png`,
      mode: 'standard',
      aspectRatio: 'Auto',
      duration: 6,
      resolution: '768P',
      operationalConfig: operation('hailuo-2.3'),
      persistInputMedia: false,
    }));

    expect(outcome).toMatchObject({
      status: 400,
      message: 'Hailuo 2.3 takes frames up to 10 MB; the start frame is 12.0 MB.',
    });
    expect(service.holds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an oversized character image through the motion start (Kling 2.6)', async () => {
    const { startMotionGeneration } = await import('@/lib/generation-services');
    const service = createServiceClient({ 'hero.png': 10 * MB + 1 });

    const outcome = await settle(startMotionGeneration({
      supabase: service.client as never,
      creditSupabase: service.client as never,
      userId: USER_ID,
      prompt: '',
      model: 'kling-2.6',
      characterImageUrl: signed('uploads', `${USER_ID}/hero.png`),
      referenceVideoUrl: signed('uploads', `${USER_ID}/dance.mp4`),
      duration: 5,
      referenceVideoSeconds: 5,
      operationalConfig: operation('kling-2.6'),
    }));

    expect(outcome).toMatchObject({
      status: 400,
      message: 'Kling 2.6 takes character images up to 10 MB; the character image is 10.1 MB.',
    });
    expect(service.holds).toEqual([]);
  });

  it('refuses through POST /api/generations’ unified start before anything is held', async () => {
    const { startUnifiedGenerationForRoute } = await import('@/lib/unified-generation-start-service');
    const { loadPublishedGenerationModelCatalog } = await import('@/lib/generation-model-catalog-store');
    const { catalog } = await loadPublishedGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
    const service = createServiceClient({ 'label.png': 13_002_342 });

    const outcome = await settle(startUnifiedGenerationForRoute(
      {
        request: new Request('http://localhost/api/generations', {
          method: 'POST',
          headers: { 'Idempotency-Key': 'image-size-limit-1' },
        }),
        body: {
          kind: 'image',
          modelId: 'qwen3',
          catalogRevision: catalog.revision,
          prompt: 'Put the label on the bottle',
          settings: { aspectRatio: '1:1', resolution: '1K', outputFormat: 'jpg' },
          inputs: [{ slot: 'imageReferences', kind: 'image', url: `uploads/${USER_ID}/label.png`, label: 'Label' }],
        },
        userId: USER_ID,
        supabase: service.client as never,
        adminSupabase: service.client as never,
      },
      {
        resolveSource: vi.fn(async () => null) as never,
        enforceRateLimit: vi.fn(async () => undefined) as never,
      },
    ));

    expect(outcome).toMatchObject({
      status: 400,
      message: 'Qwen Image 3.0 takes reference images up to 10 MB; Reference 1 is 12.4 MB.',
    });
    expect(service.holds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a workflow step, and a template run’s step, before anything is held', async () => {
    const { loadPublishedGenerationModelCatalog } = await import('@/lib/generation-model-catalog-store');
    const { catalog } = await loadPublishedGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
    const { createCanvasEdge, createWorkflowNode, normalizeWorkflowGraph } = await import('@/lib/workflow-canvas');
    const { executeWorkflowRunnableNode } = await import('@/lib/workflow-runner');
    const prompt = createWorkflowNode('text-input', { x: 0, y: 0 });
    const frame = createWorkflowNode('image-input', { x: 0, y: 160 });
    const video = createWorkflowNode('video-generate', { x: 320, y: 120 });
    const graph = normalizeWorkflowGraph({
      nodes: [
        { ...prompt, data: { ...(prompt.data as TextInputNodeData), text: 'The dancer spins.' } },
        {
          ...frame,
          data: {
            ...(frame.data as ImageInputNodeData),
            imageUrl: signed('uploads', `${USER_ID}/frame.png`),
            storagePath: `uploads/${USER_ID}/frame.png`,
          },
        },
        {
          ...video,
          data: {
            ...(video.data as VideoGenerateNodeData),
            model: 'kling-3.0-turbo',
            aspectRatio: '16:9',
            duration: 5,
            resolution: '720p',
            referenceMode: 'frames',
          },
        },
      ],
      edges: [
        createCanvasEdge(prompt.id, 'text', video.id, 'prompt'),
        createCanvasEdge(frame.id, 'image', video.id, 'start-frame'),
      ],
    });
    const service = createServiceClient({ 'frame.png': 12 * MB });
    serviceClientRef.current = service.client;

    for (const run of [
      {},
      // How the template worker runs a step.
      {
        privateRecipe: true,
        templateContext: { runId: 'run-1', stepId: 'step-1', templateId: 'template-1', templateVersionId: 'version-1' },
      },
    ]) {
      const outcome = await settle(executeWorkflowRunnableNode({
        supabase: service.client as never,
        userId: USER_ID,
        graph,
        node: graph.nodes.find((node) => node.id === video.id)!,
        catalogRevision: catalog.revision,
        clientRequestKeyHash: 'a'.repeat(64),
        persistInputMedia: false,
        ...run,
      }));

      expect(outcome).toMatchObject({
        status: 400,
        message: 'Kling 3 Turbo takes frames up to 10 MB; the start frame is 12.0 MB.',
      });
    }
    expect(service.holds).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
