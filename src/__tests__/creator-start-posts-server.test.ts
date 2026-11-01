import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { VIDEO_MODELS } from '@/lib/client-generation-models';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import { startPostRemixCost } from '@/lib/creator-start-posts';
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
  // Owner, 2026-11-01: a remix opens on its original's model and settings whatever the
  // balance, so its card is priced on that model alone.
  it('prices a video post\'s remix on its own model, and asks for no other model\'s price', async () => {
    const asked: GenerationModelQuoteInput[] = [];
    const forecasts = await buildStartPostRemixForecasts(
      [{ postId: 'post-1', generationId: 'gen-1' }, { postId: 'post-2', generationId: 'gen-2' }],
      deps([row('gen-1', KLING_RUN), row('gen-2', { ...KLING_RUN, model: 'seedance-2-mini', mode: '' })], async (inputs) => {
        asked.push(...inputs);
        return quoteAll(inputs);
      }),
    );
    expect(forecasts['post-1']).toEqual({ cost: 70 });
    expect(forecasts['post-2']).toEqual({ cost: 19 });
    expect(asked.map((input) => input.modelId)).toEqual(['kling-3.0-video', 'seedance-2-mini']);
    // The card says that price, whatever the balance.
    expect(startPostRemixCost({ ...cardOf('post-1'), remix: forecasts['post-1'] })).toBe(70);
  });

  // The server's run is the page's: a card can only say what the page will once it opens.
  it.each([
    ['standard, silent', KLING_RUN],
    ['pro, with sound, 9:16, 8s', { ...KLING_RUN, mode: 'pro', sound: true, aspectRatio: '9:16', duration: 8 }],
  ])('builds the run as the page builds it from the same catalog (%s)', async (_name, stored) => {
    const forecast = await forecastOf(stored);
    const models = pageRegistryFrom(3);
    // The form the page restores from the run (`fetchRemixData`).
    const form: VideoFormSettings = fitVideoFormToModel('kling-3.0-video', {
      mode: stored.mode, aspectRatio: stored.aspectRatio, resolution: '', duration: stored.duration, sound: stored.sound, fixedLens: false, isMultiShot: false,
    }, models);
    const original = videoRunOnModel({ modelId: 'kling-3.0-video', catalogRevision: CATALOG.revision, settings: form, held: HOLDS_NOTHING, models });
    const [answer] = quoteAll([original!.quoteInput]);
    expect(answer.status).toBe('fulfilled');
    expect(forecast).toEqual({ cost: answer.status === 'fulfilled' ? answer.value.costCredits : null });
  });

  it('opens a setting the model no longer offers on the model\'s default, as the page does', async () => {
    const unoffered = await forecastOf({ ...KLING_RUN, aspectRatio: '21:9', duration: 40 });
    const defaults = await forecastOf({ model: KLING_RUN.model, mode: KLING_RUN.mode, sound: KLING_RUN.sound });
    expect(unoffered).toEqual(defaults);
  });

  it('holds Gemini Omni\'s prepared voices and characters, which every remix keeps', async () => {
    const asked: GenerationModelQuoteInput[] = [];
    const forecasts = await buildStartPostRemixForecasts(
      [{ postId: 'post-1', generationId: 'gen-1' }],
      deps([row('gen-1', { model: 'gemini-omni-video', preparedAudioIds: ['voice-1', ' '], characterIds: ['character-1'] })], async (inputs) => {
        asked.push(...inputs);
        return quoteAll(inputs);
      }),
    );
    expect(forecasts['post-1']?.cost).toEqual(expect.any(Number));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ modelId: 'gemini-omni-video', inputCounts: { preparedAudios: 1, characters: 1 } });
  });

  it('has no forecast where the catalog refuses the run, and fails the build on any other answer', async () => {
    const refusing = deps([row('gen-1', KLING_RUN)], async (inputs) => inputs.map(() => (
      { status: 'rejected', reason: new CatalogError('Unsupported settings', 'INVALID_MODEL_SETTINGS', 422) }
    )));
    expect(await buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], refusing)).toEqual({});

    const changed = deps([row('gen-1', KLING_RUN)], async (inputs) => inputs.map(() => (
      { status: 'rejected', reason: new CatalogError('The catalog changed', 'CATALOG_CHANGED', 409) }
    )));
    await expect(buildStartPostRemixForecasts([{ postId: 'post-1', generationId: 'gen-1' }], changed)).rejects.toMatchObject({ code: 'CATALOG_CHANGED' });

    const unreadable = deps([row('gen-1', KLING_RUN)], async (inputs) => inputs.map(() => (
      { status: 'rejected', reason: new Error('price table unreadable') }
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
    expect(posts[0].remix).toEqual({ cost: 70 });
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
    expect(posts.map((item) => [item.id, item.remix?.cost])).toEqual([['video-2', 70]]);
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
