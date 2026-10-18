import { describe, expect, it } from 'vitest';

import type { GenerationModelCatalog } from '../lib/generation-model-catalog';
import { normalizeCreationDraftForCatalog } from '../lib/generation-model-draft';
import { GUIDED_CREATION_STARTERS } from '../lib/guided-creation-starter';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';
import { createRemixRestoreCatalog, seedance15ProModel } from './fixtures/generation-model-catalog';

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
  const starter = GUIDED_CREATION_STARTERS.video!;
  const withSeedance = (): GenerationModelCatalog => {
    const catalog = createRemixRestoreCatalog();
    return { ...catalog, models: [...catalog.models, seedance15ProModel] };
  };
  const guidedVideoDraft = () => ({ ...createDefaultCreationDraft('video'), model: starter.modelId });

  it('starts a guided first video inside the 25 welcome credits, not on the 70-credit default', () => {
    // Production prices (pixverse-mobile-20261008): Kling 3.0 std, no sound, 14 a second; Seedance 1.5 Pro
    // 480p/720p/1080p for 4 s without sound, 7/14/30.
    expect(starter).toEqual({ modelId: 'seedance-1.5-pro', settings: { resolution: '720p', duration: '4', sound: false } });

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

  it('keeps the model default for a starter value the model does not take', () => {
    const result = normalizeCreationDraftForCatalog(guidedVideoDraft(), withSeedance(), {
      modelSelectionTouched: false,
      starter: { modelId: 'seedance-1.5-pro', settings: { resolution: '4k', duration: '4' } },
    });

    expect(result.draft).toMatchObject({ model: 'seedance-1.5-pro', resolution: '480p', duration: 4 });
  });
});
