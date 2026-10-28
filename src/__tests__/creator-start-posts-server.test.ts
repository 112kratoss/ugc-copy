import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VIDEO_MODELS } from '@/lib/client-generation-models';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import { startPostRemix } from '@/lib/creator-start-posts';
import { buildStartPostRemixForecasts, loadCreatorStartPosts } from '@/lib/creator-start-posts-server';
import { fitVideoFormToModel, videoRunOnModel, type VideoFormHeld, type VideoFormSettings } from '@/lib/creator-video-candidates';
import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { applyGenerationModelCatalogToRegistries } from '@/lib/generation-model-client';
import type { HomeShelfCreationWithPost } from '@/lib/home-shelf-server';

const creationsMock = vi.hoisted(() => vi.fn());
const logBackendErrorMock = vi.hoisted(() => vi.fn());
const generationRows = vi.hoisted(() => ({ rows: [] as unknown[], error: null as unknown }));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

vi.mock('@/lib/backend-logger', () => ({ logBackendError: logBackendErrorMock }));

vi.mock('@/lib/home-shelf-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/home-shelf-server')>('@/lib/home-shelf-server');
  return { ...actual, loadHomeShelfCreationsWithPosts: creationsMock };
});

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ in: () => Promise.resolve({ data: generationRows.rows, error: generationRows.error }) }),
    }),
  }),
}));

// The published catalog is the code catalog here, the one the dev server and these tests price with.
vi.mock('@/lib/generation-model-catalog-store', () => ({
  loadPublishedGenerationModelCatalog: async ({ schemaVersion }: { schemaVersion: number }) => ({
    catalog: buildGenerationModelCatalog({ platform: 'web', schemaVersion }),
  }),
  quotePublishedGenerationModels: async (inputs: readonly GenerationModelQuoteInput[]) => quoteAll(inputs),
  quotePublishedGenerationModel: async () => {
    throw new Error('the shelf\'s own pricing is not under test here');
  },
}));

function quoteAll(inputs: readonly GenerationModelQuoteInput[]): Array<PromiseSettledResult<GenerationModelQuote>> {
  return inputs.map((input) => {
    try {
      return { status: 'fulfilled', value: quoteGenerationModel(input, { catalog: buildGenerationModelCatalog({ platform: 'web', schemaVersion: input.schemaVersion ?? 2 }) }) };
    } catch (reason) {
      return { status: 'rejected', reason };
    }
  });
}

const CATALOG = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

/** A Kling 3.0 Cinematic run as the start stores it: 16:9, standard, 5s, no sound. */
const KLING_RUN = { model: 'kling-3.0-video', aspectRatio: '16:9', mode: 'std', duration: 5, sound: false, isMultiShot: false };

function row(id: string, workflowSettings: Record<string, unknown> | null, shareInputs = false) {
  return { id, workflow_settings: workflowSettings, share_input_media_for_remix: shareInputs };
}

const deps = (rows: ReturnType<typeof row>[]) => ({
  loadGenerations: async () => rows,
  loadCatalog: async () => CATALOG,
  quote: async (inputs: readonly GenerationModelQuoteInput[]) => quoteAll(inputs),
});

const HOLDS_NOTHING: VideoFormHeld<VideoRunMedia> = {
  imageReferences: [], videoReferences: [], audioReferences: [], videoElements: [], subjects: [],
  hasStartFrame: false, hasEndFrame: false, preparedVoiceIds: [], characterIds: [], multiShotSeconds: 0,
};

describe('the start posts\' remix forecasts', () => {
  it('prices a video post\'s remix on every other model the web offers, at the run\'s settings moved to each', async () => {
    const forecasts = await buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], deps([row('gen-1', KLING_RUN)]));
    const forecast = forecasts['post-1'];
    expect(forecast.original).toEqual({ modelId: 'kling-3.0-video', cost: 70, durationSeconds: 5 });
    expect(forecast.preferredModelId).toBe('seedance-2-mini');
    expect(forecast.candidates.map((candidate) => candidate.modelId)).not.toContain('kling-3.0-video');
    expect(forecast.candidates.find((candidate) => candidate.modelId === 'seedance-2-mini'))
      .toEqual({ modelId: 'seedance-2-mini', cost: 19, durationSeconds: 5, takesInputs: true });
    expect(forecast.modelNames['seedance-2-mini']).toBe('Seedance 2 Mini');
    // What the card then says for the welcome credits: Mini first.
    expect(startPostRemix({ ...cardOf('post-1'), remix: forecast }, 25)).toMatchObject({ cost: 19, fitted: { modelId: 'seedance-2-mini', sameLength: true } });
  });

  // The server's runs are the page's: a card can only say what the page will once it opens.
  it.each([
    ['standard, silent', KLING_RUN],
    // Pro costs more than standard, and sound narrows the models that can take the run.
    ['pro, with sound, 9:16, 8s', { ...KLING_RUN, mode: 'pro', sound: true, aspectRatio: '9:16', duration: 8 }],
  ])('builds every model\'s run as the page builds it from the same catalog (%s)', async (_name, stored) => {
    const forecasts = await buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], deps([row('gen-1', stored)]));
    const pageRegistry = VIDEO_MODELS as unknown as Record<string, unknown>;
    const saved = Object.fromEntries(Object.keys(pageRegistry).map((id) => [id, pageRegistry[id]]));
    applyGenerationModelCatalogToRegistries(buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 }));
    try {
      // The form the page restores from the run (`fetchRemixData`).
      const form: VideoFormSettings = fitVideoFormToModel('kling-3.0-video', {
        mode: stored.mode, aspectRatio: stored.aspectRatio, resolution: '', duration: stored.duration, sound: stored.sound, fixedLens: false, isMultiShot: false,
      });
      const revision = CATALOG.revision;
      const original = videoRunOnModel({ modelId: 'kling-3.0-video', catalogRevision: revision, settings: form, held: HOLDS_NOTHING });
      const [originalAnswer] = quoteAll([original!.quoteInput]);
      expect(forecasts['post-1'].original).toEqual({
        modelId: 'kling-3.0-video',
        cost: originalAnswer.status === 'fulfilled' ? originalAnswer.value.costCredits : null,
        durationSeconds: stored.duration,
      });
      for (const candidate of forecasts['post-1'].candidates) {
        const pageRun = videoRunOnModel({ modelId: candidate.modelId, catalogRevision: revision, settings: fitVideoFormToModel(candidate.modelId, form), held: HOLDS_NOTHING });
        const [answer] = quoteAll([pageRun!.quoteInput]);
        expect({ id: candidate.modelId, cost: answer.status === 'fulfilled' ? answer.value.costCredits : null, seconds: pageRun!.durationSeconds })
          .toEqual({ id: candidate.modelId, cost: candidate.cost, seconds: candidate.durationSeconds });
      }
    } finally {
      for (const id of Object.keys(pageRegistry)) {
        if (id in saved) pageRegistry[id] = saved[id];
        else delete pageRegistry[id];
      }
    }
  });

  it('prices the shorter lengths of the cheapest model that takes the run', async () => {
    const twelveSeconds = { ...KLING_RUN, duration: 12 };
    const forecast = (await buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], deps([row('gen-1', twelveSeconds)])))['post-1'];
    expect(forecast.shorter).not.toBeNull();
    const cheapest = forecast.candidates.find((candidate) => candidate.modelId === forecast.shorter!.modelId)!;
    expect(cheapest.durationSeconds).toBe(12);
    expect(forecast.shorter!.prices.length).toBeGreaterThan(0);
    expect(forecast.shorter!.prices.every((price) => price.durationSeconds < 12)).toBe(true);
  });

  it('has nothing to forecast where the page would not read the run alone', async () => {
    const forecasts = await buildStartPostRemixForecasts([
      { postId: 'shared', generationId: 'gen-shared' },
      { postId: 'shots', generationId: 'gen-shots' },
      { postId: 'retired', generationId: 'gen-retired' },
      { postId: 'missing', generationId: 'gen-missing' },
    ], deps([
      // A creator who shared their media hands it to every remix, which the page prices.
      row('gen-shared', KLING_RUN, true),
      row('gen-shots', { ...KLING_RUN, isMultiShot: true }),
      row('gen-retired', { ...KLING_RUN, model: 'kling-1.0' }),
    ]));
    expect(forecasts).toEqual({});
  });
});

function cardOf(id: string) {
  return {
    kind: 'creation' as const,
    id,
    title: 'Kung fu cats',
    tool: 'video' as const,
    posterUrl: 'https://cdn.example/poster.webp',
    posterThumbhash: null,
    clipUrl: null,
    modelName: 'Kling 3.0 Cinematic',
    price: { kind: 'credits' as const, credits: 70 },
    fitsWelcomeCredits: false,
    badge: null,
    creator: { id: 'creator-1', username: 'fluffy', name: 'Fluffy' },
    makeHref: `/create-video?remix=gen-of-${id}&remixPost=${id}`,
  };
}

function creation(id: string, overrides: Partial<HomeShelfCreationWithPost> = {}): HomeShelfCreationWithPost {
  return { ...cardOf(id), post: { id, generationId: `gen-of-${id}` } as HomeShelfCreationWithPost['post'], ...overrides };
}

describe('the creators\' start posts', () => {
  const viewer = { viewerUserId: 'viewer-1', isAnonymous: false };

  beforeAll(() => {
    generationRows.rows = [];
  });

  beforeEach(() => {
    creationsMock.mockReset();
    logBackendErrorMock.mockReset();
    generationRows.error = null;
  });

  afterAll(() => {
    generationRows.rows = [];
  });

  it('sends the shelf\'s creations for this viewer without their posts, each video one with its forecast', async () => {
    creationsMock.mockResolvedValue([
      creation('video-1'),
      creation('image-1', { tool: 'image', price: { kind: 'credits', credits: 8 } }),
    ]);
    generationRows.rows = [row('gen-of-video-1', KLING_RUN)];

    const posts = await loadCreatorStartPosts(viewer);

    expect(creationsMock).toHaveBeenCalledWith(viewer);
    expect(posts.map((item) => item.id)).toEqual(['video-1', 'image-1']);
    expect(posts.every((item) => !('post' in item))).toBe(true);
    expect(posts[0].remix?.original).toEqual({ modelId: 'kling-3.0-video', cost: 70, durationSeconds: 5 });
    expect(posts[1].remix).toBeNull();
  });

  it('keeps the shelf\'s prices when the forecasts cannot be built', async () => {
    creationsMock.mockResolvedValue([creation('video-1')]);
    generationRows.error = new Error('generations read failed');

    const posts = await loadCreatorStartPosts(viewer);

    expect(posts).toHaveLength(1);
    expect(posts[0].remix).toBeNull();
    expect(posts[0].price).toEqual({ kind: 'credits', credits: 70 });
    expect(logBackendErrorMock).toHaveBeenCalledWith('creator_start_post_remix_forecasts_failed', expect.anything());
  });
});
