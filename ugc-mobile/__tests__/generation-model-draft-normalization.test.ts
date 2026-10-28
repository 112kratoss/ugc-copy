import { describe, expect, it } from 'vitest';

import type { GenerationModelCatalog, GenerationModelDescriptor } from '../lib/generation-model-catalog';
import { normalizeCreationDraftForCatalog } from '../lib/generation-model-draft';
import { GUIDED_CREATION_STARTERS, guidedCreationStarter } from '../lib/guided-creation-starter';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';
import { createRemixRestoreCatalog, seedance15ProModel, seedance2MiniModel } from './fixtures/generation-model-catalog';

describe('normalizeCreationDraftForCatalog', () => {
  const catalog = createRemixRestoreCatalog();

  it('gives an untouched draft the catalog default model and its published defaults', () => {
    const video = normalizeCreationDraftForCatalog(createDefaultCreationDraft('video'), catalog, { modelSelectionTouched: false });

    expect(video).toMatchObject({ warning: null, missingModel: false });
    expect(video.draft).toMatchObject({
      model: 'kling-3.0-video',
      aspectRatio: '16:9',
      catalogRevision: 'gpt-image-2-5-20260911',
      catalogSettings: { aspectRatio: '16:9', mode: 'std', duration: 5, sound: false, isMultiShot: false },
    });
    // The bundled motion draft names a model the catalog does not default to.
    expect(normalizeCreationDraftForCatalog(createDefaultCreationDraft('motion'), catalog, { modelSelectionTouched: false }).draft.model)
      .toBe('kling-2.6');
  });

  it('reconciles a started or model-chosen draft against its own model', () => {
    const started = {
      ...createDefaultCreationDraft('video'),
      model: 'seedance-2' as const,
      prompt: 'The girl is crying',
      catalogSettings: { aspectRatio: '16:9', mode: 'std', isMultiShot: false },
    };
    const reconciled = normalizeCreationDraftForCatalog(started, catalog, { modelSelectionTouched: false });

    expect(reconciled.draft.model).toBe('seedance-2');
    expect(reconciled.warning).toBe('Some saved settings are no longer supported and were reset: mode, isMultiShot.');

    const chosen = normalizeCreationDraftForCatalog(
      { ...createDefaultCreationDraft('video'), model: 'seedance-2' as const },
      catalog,
      { modelSelectionTouched: true },
    );
    expect(chosen.draft.model).toBe('seedance-2');
  });

  it('hands back a draft whose model the catalog does not carry untouched', () => {
    const draft = { ...createDefaultCreationDraft('image'), model: 'retired-image-model' as never, prompt: 'Keep me' };
    const result = normalizeCreationDraftForCatalog(draft, catalog, { modelSelectionTouched: false });

    expect(result).toEqual({ draft, warning: null, missingModel: true });
    expect(result.draft).toBe(draft);
  });

  it('keeps an untouched draft off its stand-in model until the default model\'s details arrive', () => {
    // The Create tab opens on Image, and the catalog has the video draft's stand-in (Kling 3.0)
    // before the video default's details. Reconciling against the stand-in stamped a revision,
    // and the draft then kept Kling 3.0 at 70 credits once Seedance 2 Mini's details came
    // (2026-10-28, when Mini became the default).
    const miniAtItsRelease = {
      ...seedance2MiniModel,
      controls: seedance2MiniModel.controls.map((control) => (
        control.key === 'duration' && control.type === 'integer' ? { ...control, defaultValue: 5 } : control
      )),
    };
    const loading: GenerationModelCatalog = {
      ...catalog,
      defaults: { ...catalog.defaults, video: 'seedance-2-mini' },
    };
    const draft = createDefaultCreationDraft('video');

    const waiting = normalizeCreationDraftForCatalog(draft, loading, { modelSelectionTouched: false });
    expect(waiting).toEqual({ draft, warning: null, missingModel: false });

    const loaded: GenerationModelCatalog = { ...loading, models: [...loading.models, miniAtItsRelease] };
    const settled = normalizeCreationDraftForCatalog(waiting.draft, loaded, { modelSelectionTouched: false });
    expect(settled.draft).toMatchObject({
      model: 'seedance-2-mini',
      catalogRevision: loaded.revision,
      catalogSettings: { aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false },
    });

    // A default the catalog says it dropped is not waited for: the draft keeps its own model.
    const dropped = normalizeCreationDraftForCatalog(draft, loading, { modelSelectionTouched: false, missingIds: ['seedance-2-mini'] });
    expect(dropped.draft.model).toBe('kling-3.0-video');
    expect(dropped.draft.catalogRevision).toBe(loading.revision);
  });

  it('changes nothing when a draft is normalized a second time', () => {
    const defaults = [createDefaultCreationDraft('image'), createDefaultCreationDraft('video'), createDefaultCreationDraft('motion')];
    for (const draft of defaults) {
      const once = normalizeCreationDraftForCatalog(draft, catalog, { modelSelectionTouched: false }).draft;
      const twice = normalizeCreationDraftForCatalog(once, catalog, { modelSelectionTouched: false });

      expect(twice.draft).toEqual(once);
      expect(twice.warning).toBeNull();
    }
  });
});

describe('normalizeCreationDraftForCatalog with a guided starter', () => {
  // The starter mechanism on two starters, the list the app shipped until 2026-10-28: Seedance 1.5 Pro, then
  // Seedance 2 Mini. The list the app ships now is pinned at the end of this block.
  const STARTERS = [
    { modelId: 'seedance-1.5-pro', settings: { resolution: '720p', duration: '4', sound: false } },
    { modelId: 'seedance-2-mini', settings: { resolution: '480p', duration: 4, sound: false } },
  ];
  const [starter, fallbackStarter] = STARTERS;
  const withSeedance = (): GenerationModelCatalog => {
    const catalog = createRemixRestoreCatalog();
    return { ...catalog, models: [...catalog.models, seedance15ProModel] };
  };
  const guidedVideoDraft = () => ({ ...createDefaultCreationDraft('video'), model: starter.modelId });

  it('starts a guided draft on its starter\'s model and pinned settings, not on the catalog default', () => {
    const result = normalizeCreationDraftForCatalog(guidedVideoDraft(), withSeedance(), { modelSelectionTouched: false, starter });

    expect(result).toMatchObject({ warning: null, missingModel: false });
    expect(result.draft).toMatchObject({
      model: 'seedance-1.5-pro',
      resolution: '720p',
      duration: 4,
      sound: false,
      aspectRatio: '1:1',
      referenceMode: 'frames',
      catalogRevision: 'gpt-image-2-5-20260911',
      catalogSettings: { resolution: '720p', duration: '4', sound: false, aspectRatio: '1:1' },
    });
  });

  it('waits for the starter details instead of settling on the default, which would stick', () => {
    const draft = guidedVideoDraft();
    const result = normalizeCreationDraftForCatalog(draft, createRemixRestoreCatalog(), { modelSelectionTouched: false, starter });

    expect(result).toEqual({ draft, warning: null, missingModel: false });
    expect(result.draft).toBe(draft);
  });

  it('takes the catalog default when the starter is not a mobile model for the tool', () => {
    const catalog = withSeedance();
    const notOnMobile: GenerationModelCatalog = {
      ...catalog,
      schemaVersion: 3,
      models: catalog.models.map((model) => ({ ...model, availability: { web: true, mobile: model.id !== starter.modelId } })),
    };
    expect(normalizeCreationDraftForCatalog(guidedVideoDraft(), notOnMobile, { modelSelectionTouched: false, starter }).draft.model)
      .toBe('kling-3.0-video');

    const imageStarter = { modelId: 'nano-banana-2', settings: {} };
    expect(normalizeCreationDraftForCatalog(createDefaultCreationDraft('video'), catalog, { modelSelectionTouched: false, starter: imageStarter }).draft.model)
      .toBe('kling-3.0-video');
  });

  it('leaves a started, chosen or already-normalized draft where it is', () => {
    const catalog = withSeedance();
    const started = { ...createDefaultCreationDraft('video'), prompt: 'A lighthouse in a storm' };
    expect(normalizeCreationDraftForCatalog(started, catalog, { modelSelectionTouched: false, starter }).draft.model).toBe('kling-3.0-video');

    const chosen = normalizeCreationDraftForCatalog({ ...createDefaultCreationDraft('video'), model: 'seedance-2' }, catalog, { modelSelectionTouched: true, starter });
    expect(chosen.draft.model).toBe('seedance-2');

    const once = normalizeCreationDraftForCatalog(guidedVideoDraft(), catalog, { modelSelectionTouched: false, starter }).draft;
    expect(normalizeCreationDraftForCatalog(once, catalog, { modelSelectionTouched: false, starter }).draft).toEqual(once);
  });

  it('gives a seeded draft started before the starter details arrived the starter, keeping its words', () => {
    const started = { ...guidedVideoDraft(), prompt: 'A lighthouse in a storm' };
    const result = normalizeCreationDraftForCatalog(started, withSeedance(), { modelSelectionTouched: false, starter });

    expect(result).toMatchObject({ warning: null, missingModel: false });
    expect(result.draft).toMatchObject({
      model: 'seedance-1.5-pro',
      prompt: 'A lighthouse in a storm',
      resolution: '720p',
      duration: 4,
      aspectRatio: '1:1',
    });
  });

  it('gives a seeded draft the catalog default, keeping its words, once the catalog says the starter is gone', () => {
    const started = { ...guidedVideoDraft(), prompt: 'A lighthouse in a storm' };
    const gone = { modelSelectionTouched: false, starter, missingIds: [starter.modelId] };

    const result = normalizeCreationDraftForCatalog(started, createRemixRestoreCatalog(), gone);
    expect(result).toMatchObject({ warning: null, missingModel: false });
    expect(result.draft).toMatchObject({ model: 'kling-3.0-video', prompt: 'A lighthouse in a storm', duration: 5 });

    // The default's details not in yet either: it waits rather than read as a missing model.
    const noDetails: GenerationModelCatalog = { ...createRemixRestoreCatalog(), models: [] };
    expect(normalizeCreationDraftForCatalog(started, noDetails, gone)).toEqual({ draft: started, warning: null, missingModel: false });
  });

  it('starts the guided first video where the default video opens, inside the welcome credits', () => {
    // The owner's default video (2026-10-28): Seedance 2 Mini at 480p for 5 s without sound, 3.8 a second, so
    // 19 credits (src/__tests__/guided-first-video-starter-price.test.ts). Seedance 1.5 Pro, which Kie has taken
    // off its site, is no longer listed.
    expect(GUIDED_CREATION_STARTERS.video).toEqual([
      { modelId: 'seedance-2-mini', settings: { resolution: '480p', duration: 5, sound: false } },
    ]);
  });

  it('picks the first starter the catalog still carries, and only on the guided tool', () => {
    const screen = { guided: true, initialTool: 'video' as const };
    expect(guidedCreationStarter('video', screen)?.modelId).toBe('seedance-2-mini');
    // Every starter dropped: the last, which the reconcile reads as gone and replaces with the default.
    expect(guidedCreationStarter('video', screen, ['seedance-2-mini'])?.modelId).toBe('seedance-2-mini');
    expect(guidedCreationStarter('video', { guided: false, initialTool: 'video' })).toBeNull();
    expect(guidedCreationStarter('image', screen)).toBeNull();
  });

  it('moves a draft seeded with a dropped starter to the next one, keeping its words', () => {
    const seededIds = STARTERS.map((candidate) => candidate.modelId);
    const started = { ...guidedVideoDraft(), prompt: 'A lighthouse in a storm' };
    const catalog: GenerationModelCatalog = { ...createRemixRestoreCatalog(), models: [...createRemixRestoreCatalog().models, seedance2MiniModel] };
    const options = { modelSelectionTouched: false, starter: fallbackStarter, missingIds: ['seedance-1.5-pro'], seededModelIds: seededIds };

    const result = normalizeCreationDraftForCatalog(started, catalog, options);
    expect(result).toMatchObject({ warning: null, missingModel: false });
    expect(result.draft).toMatchObject({
      model: 'seedance-2-mini',
      prompt: 'A lighthouse in a storm',
      resolution: '480p',
      duration: 4,
      sound: false,
      catalogSettings: { resolution: '480p', duration: 4, sound: false },
    });
    expect(normalizeCreationDraftForCatalog(result.draft, catalog, options).draft).toEqual(result.draft);

    // The next starter's details not in yet: it waits rather than settle on the default, which would stick.
    expect(normalizeCreationDraftForCatalog(started, createRemixRestoreCatalog(), options))
      .toEqual({ draft: started, warning: null, missingModel: false });

    // Without the seeded ids the same draft reads as the creator's own, and its model as missing.
    expect(normalizeCreationDraftForCatalog(started, catalog, { ...options, seededModelIds: undefined }).missingModel).toBe(true);
  });

  it('gives a seeded draft the catalog default once the catalog has dropped every starter', () => {
    const seededIds = STARTERS.map((candidate) => candidate.modelId);
    const started = { ...guidedVideoDraft(), prompt: 'A lighthouse in a storm' };
    const result = normalizeCreationDraftForCatalog(started, createRemixRestoreCatalog(), {
      modelSelectionTouched: false,
      starter: fallbackStarter,
      missingIds: seededIds,
      seededModelIds: seededIds,
    });
    expect(result.draft).toMatchObject({ model: 'kling-3.0-video', prompt: 'A lighthouse in a storm' });
  });

  it('holds every pinned value against the model defaults, on the schema the live catalog uses', () => {
    const catalog = withSeedance();
    const moved: GenerationModelDescriptor = {
      ...seedance15ProModel,
      controls: seedance15ProModel.controls.map((control) => {
        if (control.key === 'duration' && control.type === 'choice') return { ...control, defaultValue: '8' };
        if (control.key === 'sound' && control.type === 'boolean') return { ...control, defaultValue: true };
        return control;
      }),
    };
    const live: GenerationModelCatalog = {
      ...catalog,
      schemaVersion: 3,
      models: [...catalog.models.filter((model) => model.id !== moved.id), moved]
        .map((model) => ({ ...model, availability: { web: true, mobile: true } })),
    };

    expect(normalizeCreationDraftForCatalog(guidedVideoDraft(), live, { modelSelectionTouched: false, starter }).draft)
      .toMatchObject({ model: 'seedance-1.5-pro', resolution: '720p', duration: 4, sound: false });
  });

  it('keeps the model default for a starter value the model does not take', () => {
    const result = normalizeCreationDraftForCatalog(guidedVideoDraft(), withSeedance(), {
      modelSelectionTouched: false,
      starter: { modelId: 'seedance-1.5-pro', settings: { resolution: '4k', duration: '4' } },
    });

    expect(result.draft).toMatchObject({ model: 'seedance-1.5-pro', resolution: '480p', duration: 4 });
  });
});
