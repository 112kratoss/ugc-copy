import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VIDEO_MODELS } from '@/lib/client-generation-models';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import { startPostRemix } from '@/lib/creator-start-posts';
import { buildStartPostRemixForecasts, loadCreatorStartPosts } from '@/lib/creator-start-posts-server';
import {
  fitVideoFormToModel,
  videoRunOnModel,
  type VideoFormHeld,
  type VideoFormSettings,
  type VideoModelLookup,
  type VideoRegistryEntry,
} from '@/lib/creator-video-candidates';
import {
  buildGenerationModelCatalog,
  CatalogError,
  quoteGenerationModel,
  type GenerationModelQuote,
  type GenerationModelQuoteInput,
} from '@/lib/generation-model-catalog';
import { applyGenerationModelCatalogToRegistries } from '@/lib/generation-model-client';
import type { HomeShelfCreationWithPost } from '@/lib/home-shelf-server';

const creationsMock = vi.hoisted(() => vi.fn());
const sharedCreationsMock = vi.hoisted(() => vi.fn());
const logBackendErrorMock = vi.hoisted(() => vi.fn());
const cacheCalls = vi.hoisted(() => [] as unknown[][]);
const generationRows = vi.hoisted(() => ({ rows: [] as unknown[], error: null as unknown }));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    cacheCalls.push(args);
    return fn(...args);
  },
}));

vi.mock('@/lib/backend-logger', () => ({ logBackendError: logBackendErrorMock }));

vi.mock('@/lib/home-shelf-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/home-shelf-server')>('@/lib/home-shelf-server');
  return { ...actual, loadHomeShelfCreationsWithPosts: creationsMock, loadSharedHomeShelfCreations: sharedCreationsMock };
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

const deps = (rows: ReturnType<typeof row>[], quote = async (inputs: readonly GenerationModelQuoteInput[]) => quoteAll(inputs)) => ({
  loadGenerations: async () => rows,
  loadCatalog: async () => CATALOG,
  quote,
});

async function forecastOf(stored: Record<string, unknown>) {
  return (await buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], deps([row('gen-1', stored)])))['post-1'];
}

const HOLDS_NOTHING: VideoFormHeld<VideoRunMedia> = {
  imageReferences: [], videoReferences: [], audioReferences: [], videoElements: [], subjects: [],
  hasStartFrame: false, hasEndFrame: false, preparedVoiceIds: [], characterIds: [], multiShotSeconds: 0,
};

/** The page's registry once the catalog is read, as the browser builds it (a copy: the page's own is left alone). */
function pageRegistryFrom(schemaVersion: 2 | 3): VideoModelLookup {
  const video = { ...(VIDEO_MODELS as unknown as Record<string, Record<string, unknown>>) };
  applyGenerationModelCatalogToRegistries(buildGenerationModelCatalog({ platform: 'web', schemaVersion }), { image: {}, video, motion: {} });
  return (modelId) => video[modelId] as unknown as VideoRegistryEntry | undefined;
}

describe('the start posts\' remix forecasts', () => {
  it('prices a video post\'s remix on every other model the web offers, at the run\'s settings moved to each', async () => {
    const forecast = await forecastOf(KLING_RUN);
    expect(forecast.original).toEqual({ modelId: 'kling-3.0-video', cost: 70, durationSeconds: 5 });
    expect(forecast.preferredModelId).toBe('seedance-2-mini');
    expect(forecast.candidates.map((candidate) => candidate.modelId)).not.toContain('kling-3.0-video');
    expect(forecast.candidates.find((candidate) => candidate.modelId === 'seedance-2-mini'))
      .toEqual({ modelId: 'seedance-2-mini', cost: 19, durationSeconds: 5, takesInputs: true });
    expect(forecast.modelNames['seedance-2-mini']).toBe('Seedance 2 Mini');
    // What the card then says for the welcome credits: Mini first.
    expect(startPostRemix({ ...cardOf('post-1'), remix: forecast }, 25)).toMatchObject({ cost: 19, fitted: { modelId: 'seedance-2-mini', sameLength: true } });
  });

  it('sends only the models a fitted remix can open on, each named', async () => {
    const forecast = await forecastOf({ ...KLING_RUN, sound: true });
    expect(forecast.candidates.length).toBeGreaterThan(0);
    expect(forecast.candidates.every((candidate) => candidate.takesInputs && candidate.cost !== null)).toBe(true);
    expect(Object.keys(forecast.modelNames).sort()).toEqual(forecast.candidates.map((candidate) => candidate.modelId).sort());
  });

  // The server's runs are the page's: a card can only say what the page will once it opens.
  it.each([
    ['standard, silent', KLING_RUN],
    // Pro costs more than standard, and sound narrows the models that can take the run.
    ['pro, with sound, 9:16, 8s', { ...KLING_RUN, mode: 'pro', sound: true, aspectRatio: '9:16', duration: 8 }],
  ])('builds every model\'s run as the page builds it from the same catalog (%s)', async (_name, stored) => {
    const forecast = await forecastOf(stored);
    const models = pageRegistryFrom(3);
    // The form the page restores from the run (`fetchRemixData`).
    const form: VideoFormSettings = fitVideoFormToModel('kling-3.0-video', {
      mode: stored.mode, aspectRatio: stored.aspectRatio, resolution: '', duration: stored.duration, sound: stored.sound, fixedLens: false, isMultiShot: false,
    }, models);
    const revision = CATALOG.revision;
    const original = videoRunOnModel({ modelId: 'kling-3.0-video', catalogRevision: revision, settings: form, held: HOLDS_NOTHING, models });
    const [originalAnswer] = quoteAll([original!.quoteInput]);
    expect(forecast.original).toEqual({
      modelId: 'kling-3.0-video',
      cost: originalAnswer.status === 'fulfilled' ? originalAnswer.value.costCredits : null,
      durationSeconds: stored.duration,
    });
    for (const candidate of forecast.candidates) {
      const pageRun = videoRunOnModel({ modelId: candidate.modelId, catalogRevision: revision, settings: fitVideoFormToModel(candidate.modelId, form, models), held: HOLDS_NOTHING, models });
      const [answer] = quoteAll([pageRun!.quoteInput]);
      expect({ id: candidate.modelId, cost: answer.status === 'fulfilled' ? answer.value.costCredits : null, seconds: pageRun!.durationSeconds })
        .toEqual({ id: candidate.modelId, cost: candidate.cost, seconds: candidate.durationSeconds });
    }
  });

  it('opens a setting the model no longer offers on the model\'s default, as the page does', async () => {
    const unoffered = await forecastOf({ ...KLING_RUN, aspectRatio: '21:9', duration: 40 });
    const defaults = await forecastOf({ model: KLING_RUN.model, mode: KLING_RUN.mode, sound: KLING_RUN.sound });
    expect(unoffered.original).toEqual(defaults.original);
    expect(unoffered.candidates).toEqual(defaults.candidates);
  });

  it('holds Gemini Omni\'s prepared voices and characters, which every remix keeps', async () => {
    const bare = await forecastOf({ model: 'gemini-omni-video' });
    const prepared = await forecastOf({ model: 'gemini-omni-video', preparedAudioIds: ['voice-1', ' '], characterIds: ['character-1'] });
    expect(bare.candidates.length).toBeGreaterThan(0);
    expect(prepared.original.modelId).toBe('gemini-omni-video');
    // No other model takes them, so a short balance leaves the remix on Omni.
    expect(prepared.candidates).toEqual([]);
    expect(prepared.shorter).toBeNull();
    expect(startPostRemix({ ...cardOf('post-1'), remix: prepared }, 1)).toEqual({ cost: prepared.original.cost, fitted: null });
  });

  it('prices the shorter lengths of the cheapest model that takes the run', async () => {
    const forecast = await forecastOf({ ...KLING_RUN, duration: 12 });
    expect(forecast.shorter).not.toBeNull();
    const cheapest = forecast.candidates.find((candidate) => candidate.modelId === forecast.shorter!.modelId)!;
    expect(cheapest.durationSeconds).toBe(12);
    expect(forecast.shorter!.prices.length).toBeGreaterThan(0);
    expect(forecast.shorter!.prices.every((price) => price.durationSeconds < 12)).toBe(true);
  });

  it('leaves out a model the catalog refuses the run, and fails the build on any other answer', async () => {
    const refusing = deps([row('gen-1', KLING_RUN)], async (inputs) => quoteAll(inputs).map((answer, index) => (
      inputs[index].modelId === 'seedance-2-mini'
        ? { status: 'rejected', reason: new CatalogError('Unsupported settings', 'INVALID_MODEL_SETTINGS', 422) }
        : answer
    )));
    const forecast = (await buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], refusing))['post-1'];
    expect(forecast.candidates.map((candidate) => candidate.modelId)).not.toContain('seedance-2-mini');
    expect(forecast.candidates.length).toBeGreaterThan(0);

    const changed = deps([row('gen-1', KLING_RUN)], async (inputs) => quoteAll(inputs).map((answer, index) => (
      index === inputs.length - 1
        ? { status: 'rejected', reason: new CatalogError('The catalog changed', 'CATALOG_CHANGED', 409) }
        : answer
    )));
    await expect(buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], changed)).rejects.toMatchObject({ code: 'CATALOG_CHANGED' });

    const unreadable = deps([row('gen-1', KLING_RUN)], async (inputs) => quoteAll(inputs).map((answer, index) => (
      index === 0 ? { status: 'rejected', reason: new Error('price table unreadable') } : answer
    )));
    await expect(buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], unreadable)).rejects.toThrow('price table unreadable');
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
    sharedCreationsMock.mockReset();
    logBackendErrorMock.mockReset();
    cacheCalls.length = 0;
    generationRows.error = null;
  });

  afterAll(() => {
    generationRows.rows = [];
  });

  it('sends the shelf\'s creations for this viewer without their posts, each video one with its forecast', async () => {
    const shelf = [creation('video-1'), creation('image-1', { tool: 'image', price: { kind: 'credits', credits: 8 } })];
    creationsMock.mockResolvedValue(shelf);
    sharedCreationsMock.mockResolvedValue(shelf);
    generationRows.rows = [row('gen-of-video-1', KLING_RUN)];

    const posts = await loadCreatorStartPosts(viewer);

    expect(creationsMock).toHaveBeenCalledWith(viewer);
    expect(posts.map((item) => item.id)).toEqual(['video-1', 'image-1']);
    expect(posts.every((item) => !('post' in item))).toBe(true);
    expect(posts[0].remix?.original).toEqual({ modelId: 'kling-3.0-video', cost: 70, durationSeconds: 5 });
    expect(posts[1].remix).toBeNull();
  });

  // One build for every viewer: their hides and blocks never make a build of their own, and a release is priced on its own.
  it('keys one build by the shelf\'s shared posts and the catalog release', async () => {
    creationsMock.mockResolvedValue([creation('video-2')]);
    sharedCreationsMock.mockResolvedValue([creation('video-1'), creation('video-2')]);
    generationRows.rows = [row('gen-of-video-1', KLING_RUN), row('gen-of-video-2', KLING_RUN)];

    const posts = await loadCreatorStartPosts(viewer);

    expect(cacheCalls).toEqual([[
      JSON.stringify([{ postId: 'video-1', generationId: 'gen-of-video-1' }, { postId: 'video-2', generationId: 'gen-of-video-2' }]),
      CATALOG.revision,
    ]]);
    expect(posts.map((item) => [item.id, item.remix?.original.cost])).toEqual([['video-2', 70]]);
  });

  it('keeps the shelf\'s price on a viewer\'s own post, whose remix brings their media back', async () => {
    const own = creation('video-1', { creator: { id: viewer.viewerUserId, username: 'me', name: 'Me' } });
    creationsMock.mockResolvedValue([own]);
    sharedCreationsMock.mockResolvedValue([own]);
    generationRows.rows = [row('gen-of-video-1', KLING_RUN)];

    const posts = await loadCreatorStartPosts(viewer);

    expect(posts[0].remix).toBeNull();
    expect(posts[0].price).toEqual({ kind: 'credits', credits: 70 });
  });

  it('keeps the shelf\'s prices when the forecasts cannot be built', async () => {
    creationsMock.mockResolvedValue([creation('video-1')]);
    sharedCreationsMock.mockResolvedValue([creation('video-1')]);
    generationRows.error = new Error('generations read failed');

    const posts = await loadCreatorStartPosts(viewer);

    expect(posts).toHaveLength(1);
    expect(posts[0].remix).toBeNull();
    expect(posts[0].price).toEqual({ kind: 'credits', credits: 70 });
    expect(logBackendErrorMock).toHaveBeenCalledWith('creator_start_post_remix_forecasts_failed', expect.anything());
  });
});
