import { describe, expect, it } from 'vitest';

import { normalizeCreationDraftForCatalog } from '../lib/generation-model-draft';
import { createDefaultCreationDraft } from '../lib/media-creation-view-model';
import { createRemixRestoreCatalog } from './fixtures/generation-model-catalog';

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
