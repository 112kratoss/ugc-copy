import { beforeEach, describe, expect, it, vi } from 'vitest';

import { catalogVideoEntryFields } from '@/lib/catalog-video-entry';
import { VIDEO_MODELS } from '@/lib/client-generation-models';
import { creatorOpeningFromCatalog, openingCost, openingSetting, type CreatorOpening } from '@/lib/creator-opening';
import { loadCreatorOpening } from '@/lib/creator-page-server';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import { getCatalogDescriptorDefaultSettings } from '@/lib/generation-model-client';
import {
  videoRunOnModel,
  type VideoFormHeld,
  type VideoFormSettings,
  type VideoRegistryEntry,
} from '@/lib/creator-video-candidates';
import {
  buildGenerationModelCatalog,
  quoteGenerationModel,
  type GenerationModelCatalog,
} from '@/lib/generation-model-catalog';

const logBackendErrorMock = vi.hoisted(() => vi.fn());
// What the catalog store does in place of answering: a failed read, or a price it refuses or fails to give.
const store = vi.hoisted(() => ({ readFails: false, quote: null as 'refused' | 'failed' | null }));

vi.mock('@/lib/backend-logger', () => ({ logBackendError: logBackendErrorMock }));

vi.mock('@/components/RouteAuthBoundary', () => ({ requestHasAuthHint: async () => false }));

vi.mock('@/lib/generation-model-catalog-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-model-catalog-store')>();
  return {
    ...actual,
    loadPublishedGenerationModelCatalog: (...args: Parameters<typeof actual.loadPublishedGenerationModelCatalog>) => (
      store.readFails ? Promise.reject(new Error('catalog read failed')) : actual.loadPublishedGenerationModelCatalog(...args)
    ),
  };
});

vi.mock('@/lib/generation-model-catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/generation-model-catalog')>();
  return {
    ...actual,
    quoteGenerationModel: (...args: Parameters<typeof actual.quoteGenerationModel>) => {
      if (store.quote === 'refused') throw new actual.CatalogError('Pick a start frame.', 'INVALID_MODEL_SETTINGS', 422);
      if (store.quote === 'failed') throw new Error('pricing broke');
      return actual.quoteGenerationModel(...args);
    },
  };
});

// The code catalog: the E2E server's and this suite's, with production's defaults and prices.
const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });

const MINI_SETTINGS = { aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false, referenceMode: 'frames' };

describe('creatorOpeningFromCatalog', () => {
  it('opens each creator on the catalog default at its published settings', () => {
    expect(creatorOpeningFromCatalog(catalog, 'video')).toEqual({
      revision: catalog.revision,
      modelId: 'seedance-2-mini',
      settings: MINI_SETTINGS,
    });
    expect(creatorOpeningFromCatalog(catalog, 'image')).toMatchObject({
      modelId: 'nano-banana-2',
      settings: { aspectRatio: 'auto', resolution: '1K', outputFormat: 'jpg' },
    });
    expect(creatorOpeningFromCatalog(catalog, 'motion')).toMatchObject({
      modelId: 'kling-2.6',
      settings: { resolution: '720p', characterOrientation: 'video', duration: 10 },
    });
  });

  it('opens on a link\'s model, with the link\'s ratio and length where the model offers them', () => {
    expect(creatorOpeningFromCatalog(catalog, 'video', { model: 'kling-3.0-video', aspectRatio: '9:16', duration: '10' }))
      .toMatchObject({ modelId: 'kling-3.0-video', settings: { aspectRatio: '9:16', duration: 10, mode: 'std', sound: false } });
    // A ratio and a length Kling 3.0 does not offer leave its own.
    expect(creatorOpeningFromCatalog(catalog, 'video', { model: 'kling-3.0-video', aspectRatio: '4:5', duration: '99' }))
      .toMatchObject({ settings: { aspectRatio: '16:9', duration: 5 } });
    // A length offered as a choice is the choice's own value.
    const gemini = catalog.models.find((model) => model.id === 'gemini-omni-video')!;
    expect(gemini.controls.find((control) => control.key === 'duration')).toMatchObject({ type: 'choice', defaultValue: '4' });
    expect(creatorOpeningFromCatalog(catalog, 'video', { model: 'gemini-omni-video', duration: '8' })?.settings.duration).toBe('8');
    expect(creatorOpeningFromCatalog(catalog, 'video', { model: 'gemini-omni-video', duration: '5' })?.settings.duration).toBe('4');
    // A ratio alone applies to the default.
    expect(creatorOpeningFromCatalog(catalog, 'video', { aspectRatio: '9:16' }))
      .toMatchObject({ modelId: 'seedance-2-mini', settings: { ...MINI_SETTINGS, aspectRatio: '9:16' } });
  });

  it('opens every model on the settings the page\'s first pick gives it', () => {
    // The first pick sets a model's controls to `getCatalogDescriptorDefaultSettings` (a client module the
    // server cannot call): the opening must agree for every model, or the first pick changes the drawn form.
    for (const model of catalog.models) {
      const opening = creatorOpeningFromCatalog(catalog, model.kind, { model: model.id });
      if (!opening) continue;
      expect(opening.settings, model.id).toEqual(getCatalogDescriptorDefaultSettings(model));
    }
  });

  it('draws no opening for a link to a model the catalog does not offer the tool', () => {
    // The page names the link's model, then says it is gone: a default drawn first would flash.
    expect(creatorOpeningFromCatalog(catalog, 'video', { model: 'kling-1.5' })).toBeNull();
    expect(creatorOpeningFromCatalog(catalog, 'video', { model: 'nano-banana-2' })).toBeNull();
    expect(creatorOpeningFromCatalog(catalog, 'motion', { model: 'kling-3.0-video' })).toBeNull();
  });

  it('draws no opening for a default the page\'s built-in table lacks, which it would draw under another name', () => {
    const mini = catalog.models.find((model) => model.id === 'seedance-2-mini')!;
    const ahead: GenerationModelCatalog = {
      ...catalog,
      defaults: { ...catalog.defaults, video: 'video-from-a-later-release' },
      models: [...catalog.models, { ...mini, id: 'video-from-a-later-release' }],
    };
    expect(creatorOpeningFromCatalog(ahead, 'video')).toBeNull();
  });
});

describe('openingCost', () => {
  const opening: CreatorOpening = { revision: 'rev-1', modelId: 'seedance-2-mini', settings: MINI_SETTINGS, costCredits: 19 };
  // The video page's run as it opened: its own settings, in its own order.
  const opened = {
    modelId: 'seedance-2-mini',
    settings: { duration: 5, mode: '', aspectRatio: '16:9', sound: false, resolution: '480p', fixedLens: false, isMultiShot: false, referenceMode: 'frames' },
    inputs: [] as unknown[],
  };
  const page = (overrides: Partial<Parameters<typeof openingCost>[1]> = {}) => ({
    run: opened,
    quoteStatus: 'idle' as const,
    confirmedRevision: null,
    catalogFailed: false,
    ...overrides,
  });

  it('prices the run the page opened on until the page\'s own price is in or fails', () => {
    expect(openingCost(opening, page())).toBe(19);
    expect(openingCost(opening, page({ quoteStatus: 'pending' }))).toBe(19);
    expect(openingCost(opening, page({ quoteStatus: 'ready' }))).toBeNull();
    expect(openingCost(opening, page({ quoteStatus: 'error' }))).toBeNull();
  });

  it('reads a setting the page has yet to set as its default, and a length in either type', () => {
    const { referenceMode: _unset, ...withoutReferenceMode } = opened.settings;
    void _unset;
    expect(openingCost(opening, page({ run: { ...opened, settings: withoutReferenceMode } }))).toBe(19);
    expect(openingCost(opening, page({ run: { ...opened, settings: { ...opened.settings, duration: '5' } } }))).toBe(19);
  });

  it('stands for that run only', () => {
    expect(openingCost(opening, page({ run: { ...opened, modelId: 'kling-3.0-video' } }))).toBeNull();
    expect(openingCost(opening, page({ run: { ...opened, settings: { ...opened.settings, aspectRatio: '9:16' } } }))).toBeNull();
    expect(openingCost(opening, page({ run: { ...opened, inputs: [{ slot: 'startFrame' }] } }))).toBeNull();
    expect(openingCost({ ...opening, costCredits: null }, page())).toBeNull();
    expect(openingCost(null, page())).toBeNull();
  });

  it('stops once the network confirms another revision than the one the server priced', () => {
    expect(openingCost(opening, page({ confirmedRevision: 'rev-2' }))).toBeNull();
    expect(openingCost(opening, page({ confirmedRevision: 'rev-1' }))).toBe(19);
  });

  it('stops when the page cannot price the run at all: its catalog or the model will not load', () => {
    expect(openingCost(opening, page({ catalogFailed: true }))).toBeNull();
  });
});

describe('openingSetting', () => {
  const opening: CreatorOpening = { revision: 'rev-1', modelId: 'seedance-2-mini', settings: MINI_SETTINGS, costCredits: 19 };

  it('reads a published setting of the type the page holds, and the page\'s own otherwise', () => {
    expect(openingSetting<string>(opening, 'resolution', '720p')).toBe('480p');
    expect(openingSetting<boolean>(opening, 'sound', true)).toBe(false);
    expect(openingSetting<string>(opening, 'mode', 'std')).toBe('std');
    expect(openingSetting<string>(opening, 'duration', '10')).toBe('10');
    expect(openingSetting<string>(null, 'resolution', '720p')).toBe('720p');
  });
});

describe('loadCreatorOpening', () => {
  beforeEach(() => {
    logBackendErrorMock.mockReset();
    store.readFails = false;
    store.quote = null;
  });

  it('opens the video creator on Seedance 2 Mini at 19 credits, the price the page\'s own run gets', async () => {
    const opening = await loadCreatorOpening('video');
    expect(opening).toEqual({ revision: catalog.revision, modelId: 'seedance-2-mini', settings: MINI_SETTINGS, costCredits: 19 });

    // The page prices the run it sends (`videoRunOnModel` is that run), on its built-in table
    // before its catalog is in and on the catalog's entries after: the same price either way.
    const form: VideoFormSettings = { mode: '', aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false, fixedLens: false, isMultiShot: false };
    const held: VideoFormHeld<VideoRunMedia> = {
      imageReferences: [], videoReferences: [], audioReferences: [], videoElements: [], subjects: [],
      hasStartFrame: false, hasEndFrame: false, preparedVoiceIds: [], characterIds: [], multiShotSeconds: 0,
    };
    const mini = catalog.models.find((model) => model.id === 'seedance-2-mini')!;
    const withCatalog = (modelId: string) => (modelId === mini.id
      ? { ...VIDEO_MODELS['seedance-2-mini'], ...catalogVideoEntryFields(mini) } as unknown as VideoRegistryEntry
      : undefined);
    for (const run of [
      videoRunOnModel({ modelId: mini.id, catalogRevision: catalog.revision, settings: form, held }),
      videoRunOnModel({ modelId: mini.id, catalogRevision: catalog.revision, settings: form, held, models: withCatalog }),
    ]) {
      expect(run?.quoteInput.settings).toMatchObject(MINI_SETTINGS);
      expect(openingCost(opening, {
        run: { modelId: mini.id, settings: run!.quoteInput.settings ?? {}, inputs: run!.inputs },
        quoteStatus: 'pending',
        confirmedRevision: catalog.revision,
        catalogFailed: false,
      })).toBe(19);
      expect(quoteGenerationModel({ ...run!.quoteInput, catalogRevision: undefined }).costCredits).toBe(19);
    }
  });

  it('opens the image creator priced and the motion creator unpriced, as a motion run takes a clip', async () => {
    expect(await loadCreatorOpening('image')).toMatchObject({ modelId: 'nano-banana-2', costCredits: 8 });
    expect(await loadCreatorOpening('motion')).toMatchObject({ modelId: 'kling-2.6', costCredits: null });
  });

  it('answers no opening when the catalog cannot be read, and the page draws its own stand-in', async () => {
    store.readFails = true;
    expect(await loadCreatorOpening('video')).toBeNull();
    expect(logBackendErrorMock).toHaveBeenCalledWith('creator_opening_load_failed', expect.objectContaining({ kind: 'video' }));
  });

  it('keeps the model unpriced when the catalog will not price the run, and says so only for a fault', async () => {
    store.quote = 'refused';
    expect(await loadCreatorOpening('video')).toMatchObject({ modelId: 'seedance-2-mini', costCredits: null });
    expect(logBackendErrorMock).not.toHaveBeenCalled();

    store.quote = 'failed';
    expect(await loadCreatorOpening('video')).toMatchObject({ modelId: 'seedance-2-mini', costCredits: null });
    expect(logBackendErrorMock).toHaveBeenCalledWith('creator_opening_price_failed', expect.objectContaining({ modelId: 'seedance-2-mini' }));
  });
});
