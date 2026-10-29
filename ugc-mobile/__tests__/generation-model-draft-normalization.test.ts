import { describe, expect, it } from 'vitest';

import type { GenerationModelCatalog, GenerationModelDescriptor } from '../lib/generation-model-catalog';
import { createOpeningCreationDraft, normalizeCreationDraftForCatalog } from '../lib/generation-model-draft';
import { GUIDED_CREATION_STARTERS, guidedCreationStarter } from '../lib/guided-creation-starter';
import { createDefaultCreationDraft, type CreationDraft, type MediaDraft, type VideoCreationDraft } from '../lib/media-creation-view-model';
import { createRemixRestoreCatalog, seedance15ProModel, seedance2MiniAtRelease, seedance2MiniModel } from './fixtures/generation-model-catalog';

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
    const loading: GenerationModelCatalog = {
      ...catalog,
      defaults: { ...catalog.defaults, video: 'seedance-2-mini' },
    };
    const draft = createDefaultCreationDraft('video');

    const waiting = normalizeCreationDraftForCatalog(draft, loading, { modelSelectionTouched: false });
    expect(waiting).toEqual({ draft, warning: null, missingModel: false });

    const loaded: GenerationModelCatalog = { ...loading, models: [...loading.models, seedance2MiniAtRelease] };
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

/**
 * The app's creators open on APP_CREATOR_OPENINGS from the first frame, before the catalog arrives;
 * src/__tests__/app-creator-opening.test.ts holds it to the code catalog's defaults.
 */
describe('the opening draft', () => {
  // Each tool's default at its published settings, as production publishes them (kie-catalog-inputs-20261029).
  const published: GenerationModelCatalog = {
    ...createRemixRestoreCatalog(),
    revision: 'kie-catalog-inputs-20261029',
    defaults: { image: 'nano-banana-2', video: 'seedance-2-mini', motion: 'kling-2.6' },
    models: [...createRemixRestoreCatalog().models, seedance2MiniAtRelease],
  };

  it('writes the opening\'s settings where the draft keeps them', () => {
    expect(createOpeningCreationDraft('video')).toMatchObject({
      model: 'seedance-2-mini', resolution: '480p', aspectRatio: '16:9', duration: 5, sound: false, referenceMode: 'frames', catalogRevision: null,
    });
    // A motion run's resolution is the draft's `mode`.
    expect(createOpeningCreationDraft('motion')).toMatchObject({ model: 'kling-2.6', mode: '720p', characterOrientation: 'video', duration: 10 });
    expect(createOpeningCreationDraft('image')).toMatchObject({ model: 'nano-banana-2', resolution: '1K', aspectRatio: 'auto', outputFormat: 'jpg' });
  });

  it.each(['image', 'video', 'motion'] as const)('settles on the %s default with nothing changed but its revision', (tool) => {
    const opening = createOpeningCreationDraft(tool);
    const { draft, warning } = normalizeCreationDraftForCatalog(opening, published, { modelSelectionTouched: false });

    expect(warning).toBeNull();
    expect(draft.catalogRevision).toBe('kie-catalog-inputs-20261029');
    expect({ ...draft, catalogRevision: null, catalogSettings: {} }).toEqual(opening);
  });

  it('keeps words typed before the catalog arrives on the default, where the stand-in kept Kling 3.0', () => {
    const typed = { ...createOpeningCreationDraft('video'), prompt: 'A lighthouse in a storm' };

    expect(normalizeCreationDraftForCatalog(typed, published, { modelSelectionTouched: false }).draft).toMatchObject({
      model: 'seedance-2-mini', prompt: 'A lighthouse in a storm', resolution: '480p', catalogRevision: 'kie-catalog-inputs-20261029',
    });
    const stoodIn = { ...createDefaultCreationDraft('video'), prompt: 'A lighthouse in a storm' };
    expect(normalizeCreationDraftForCatalog(stoodIn, published, { modelSelectionTouched: false }).draft.model).toBe('kling-3.0-video');
  });
});

/**
 * A saved draft the creator never touched follows the catalog default, as a new draft does.
 *
 * On 2026-10-28 Seedance 2 Mini at 480p for 5 s without sound (19 credits) became the default video.
 * Every app build since the catalog arrived saved an untouched draft with the default it settled on
 * and a revision, and a draft with a revision kept its model: anyone who had once opened the video
 * creator still opened on Kling 3.0, 70 credits, against 25 welcome credits. So did a phone whose
 * stored catalog predated the release, for a new identity: its first draft settled on the stored
 * default before the network brought the new one.
 */
describe('normalizeCreationDraftForCatalog with a saved draft the creator never touched', () => {
  // What the phone held before the release, with Kling 3.0 the default video, and the release.
  const before: GenerationModelCatalog = { ...createRemixRestoreCatalog(), revision: 'kie-checkup-20261020' };
  const release: GenerationModelCatalog = {
    ...createRemixRestoreCatalog(),
    revision: 'mini-default-video-20261028',
    defaults: { ...createRemixRestoreCatalog().defaults, video: 'seedance-2-mini' },
    models: [...createRemixRestoreCatalog().models, seedance2MiniAtRelease],
  };
  const untouched = { modelSelectionTouched: false };
  /** An untouched video draft as the app saved it before the release: Kling 3.0 at its published defaults, with a revision. */
  const savedOnKling = () => normalizeCreationDraftForCatalog(createDefaultCreationDraft('video'), before, untouched).draft as VideoCreationDraft;
  const picture: MediaDraft = { id: 'picture-1', kind: 'image', url: 'https://storage.example.com/picture-1.png', fileName: 'picture-1.png', displayName: 'Picture 1' };

  it('moves a saved untouched draft to the current default, on the default\'s published settings', () => {
    const saved = savedOnKling();
    expect(saved).toMatchObject({ model: 'kling-3.0-video', catalogRevision: 'kie-checkup-20261020', aspectRatio: '16:9', mode: 'std' });

    const result = normalizeCreationDraftForCatalog(saved, release, untouched);
    expect(result).toMatchObject({ warning: null, missingModel: false });
    expect(result.draft).toMatchObject({
      model: 'seedance-2-mini',
      catalogRevision: 'mini-default-video-20261028',
      aspectRatio: '16:9',
      resolution: '480p',
      duration: 5,
      sound: false,
      catalogSettings: { aspectRatio: '16:9', resolution: '480p', duration: 5, sound: false },
    });
    // Settled on the default, it stays as it is.
    expect(normalizeCreationDraftForCatalog(result.draft, release, untouched)).toEqual(result);
  });

  it('moves a draft that settled on a stored catalog\'s default once the network brings the release', () => {
    // A new identity on a phone whose stored catalog predates the release: its first draft settles on the
    // stored default and gets that revision. The network's revision comes a moment later.
    const settledOnStored = normalizeCreationDraftForCatalog(createDefaultCreationDraft('video'), before, untouched).draft;
    expect(settledOnStored.model).toBe('kling-3.0-video');

    // The network's revision before any detail of it is in: nothing to read the draft against yet.
    const noDetails: GenerationModelCatalog = { ...release, models: [] };
    expect(normalizeCreationDraftForCatalog(settledOnStored, noDetails, untouched).draft).toBe(settledOnStored);
    // Its own model's details in, the default's not yet: it waits for them rather than settle again.
    const withoutDefault: GenerationModelCatalog = { ...release, models: release.models.filter((model) => model.id !== 'seedance-2-mini') };
    expect(normalizeCreationDraftForCatalog(settledOnStored, withoutDefault, untouched))
      .toEqual({ draft: settledOnStored, warning: null, missingModel: false });

    expect(normalizeCreationDraftForCatalog(settledOnStored, release, untouched).draft)
      .toMatchObject({ model: 'seedance-2-mini', catalogRevision: release.revision, resolution: '480p', duration: 5 });
  });

  it('keeps the model of a draft that holds anything, or a setting away from its model\'s defaults', () => {
    const saved = savedOnKling();
    // As saved, the draft moves: each change below is what keeps it.
    expect(normalizeCreationDraftForCatalog(saved, release, untouched).draft.model).toBe('seedance-2-mini');

    const kept: Array<[string, VideoCreationDraft]> = [
      ['a prompt', { ...saved, prompt: 'A lighthouse in a storm' }],
      ['a shot\'s words', { ...saved, multiPrompts: [{ id: 'shot-1', prompt: 'Waves break', duration: 5 }, saved.multiPrompts[1]] }],
      ['a start frame', { ...saved, startFrame: picture }],
      ['an end frame', { ...saved, endFrame: picture }],
      ['a reference picture', { ...saved, references: [picture] }],
      ['a reference clip', { ...saved, referenceVideos: [{ ...picture, kind: 'video' }] }],
      ['a reference track', { ...saved, referenceAudios: [{ ...picture, kind: 'audio' }] }],
      ['a named subject', { ...saved, subjects: [{ id: 'subject-1', displayName: 'Ava', handle: '@ava', images: [picture] }] }],
      ['a prepared voice', { ...saved, preparedAudioIds: ['voice-1'] }],
      ['a character', { ...saved, characterIds: ['character-1'] }],
      ['an input in a slot', { ...saved, catalogInputSlots: { imageReferences: [{ id: 'asset-1', kind: 'image', url: picture.url }] } }],
      ['another ratio', { ...saved, aspectRatio: '9:16' }],
      // Chosen when the model offered it: a release that drops a value does not make it the default.
      ['a ratio the model no longer offers', { ...saved, aspectRatio: '4:3' }],
      ['another quality', { ...saved, mode: 'pro' }],
      ['another length', { ...saved, duration: 10 }],
      ['sound', { ...saved, sound: true }],
      ['multi-shot', { ...saved, isMultiShot: true }],
      ['a remix\'s source', { ...saved, sourceGenerationId: 'generation-1' }],
    ];
    for (const [change, draft] of kept) {
      expect(normalizeCreationDraftForCatalog(draft, release, untouched).draft.model, change).toBe('kling-3.0-video');
    }
    // A model picked in this session is the creator's, however empty the draft.
    expect(normalizeCreationDraftForCatalog(saved, release, { modelSelectionTouched: true }).draft.model).toBe('kling-3.0-video');
  });

  it('does not count the words an entry link put in the draft as the creator\'s', () => {
    // A prompt-only Recreate opens the creator with the post's words in its tool's draft.
    const words = 'A lighthouse in a storm';
    const linked = { modelSelectionTouched: false, seededPrompt: words };

    // A new identity's draft, until now settled on the stand-in Kling 3.0 because the words read as started.
    expect(normalizeCreationDraftForCatalog({ ...createDefaultCreationDraft('video'), prompt: words }, release, linked).draft)
      .toMatchObject({ model: 'seedance-2-mini', prompt: words, resolution: '480p', duration: 5 });
    // A saved untouched draft with the link's words put in it.
    expect(normalizeCreationDraftForCatalog({ ...savedOnKling(), prompt: words }, release, linked).draft)
      .toMatchObject({ model: 'seedance-2-mini', prompt: words });
    // Words of the creator's own still keep the model.
    expect(normalizeCreationDraftForCatalog({ ...savedOnKling(), prompt: `${words}, at night` }, release, linked).draft.model)
      .toBe('kling-3.0-video');
    expect(normalizeCreationDraftForCatalog({ ...savedOnKling(), prompt: words }, release, untouched).draft.model)
      .toBe('kling-3.0-video');
  });

  it('moves untouched image and motion drafts to their defaults too', () => {
    // An image draft that settled on an earlier default.
    const imageBefore: GenerationModelCatalog = { ...before, defaults: { ...before.defaults, image: 'gpt-image-2' } };
    const imageDraft = normalizeCreationDraftForCatalog(createDefaultCreationDraft('image'), imageBefore, untouched).draft;
    expect(imageDraft).toMatchObject({ model: 'gpt-image-2', aspectRatio: 'auto', catalogRevision: before.revision });
    expect(normalizeCreationDraftForCatalog(imageDraft, release, untouched).draft)
      .toMatchObject({ model: 'nano-banana-2', aspectRatio: 'auto', resolution: '1K', outputFormat: 'jpg', googleSearch: false });

    // The motion draft older builds settled on the app's stand-in model (kling-3.0) when the default's
    // details (kling-2.6) were not there to wait for.
    const klingMotion: GenerationModelDescriptor = {
      ...createRemixRestoreCatalog().models.find((model) => model.id === 'kling-2.6')!,
      id: 'kling-3.0',
      displayName: 'Kling 3.0',
    };
    const withoutDefault: GenerationModelCatalog = { ...before, models: [...before.models.filter((model) => model.id !== 'kling-2.6'), klingMotion] };
    const motionDraft = normalizeCreationDraftForCatalog(createDefaultCreationDraft('motion'), withoutDefault, { ...untouched, missingIds: ['kling-2.6'] }).draft;
    expect(motionDraft).toMatchObject({ model: 'kling-3.0', catalogRevision: before.revision });
    const motionRelease: GenerationModelCatalog = { ...release, models: [...release.models, klingMotion] };
    expect(normalizeCreationDraftForCatalog(motionDraft, motionRelease, untouched).draft)
      .toMatchObject({ model: 'kling-2.6', mode: '720p', characterOrientation: 'video', duration: 10 });

    // With a character picture in it, the motion draft keeps its model.
    expect(normalizeCreationDraftForCatalog({ ...motionDraft, characterImage: picture } as CreationDraft, motionRelease, untouched).draft.model)
      .toBe('kling-3.0');
  });

  it('gives a saved untouched draft on a guided screen the starter, not the model it settled on', () => {
    const starter = { modelId: 'seedance-1.5-pro', settings: { resolution: '720p', duration: '4', sound: false } };
    const withSeedance: GenerationModelCatalog = { ...release, models: [...release.models, seedance15ProModel] };

    const result = normalizeCreationDraftForCatalog(savedOnKling(), withSeedance, { modelSelectionTouched: false, starter });
    expect(result.draft).toMatchObject({ model: 'seedance-1.5-pro', resolution: '720p', duration: 4, sound: false });
    // The starter's pins are not its model's defaults, and the draft settles there.
    expect(normalizeCreationDraftForCatalog(result.draft, withSeedance, { modelSelectionTouched: false, starter }).draft).toEqual(result.draft);
    expect(normalizeCreationDraftForCatalog(result.draft, withSeedance, untouched).draft.model).toBe('seedance-1.5-pro');

    // The screen asks for a starter's details only for a draft with no revision, so a saved one does not wait
    // for them: it takes the default.
    expect(normalizeCreationDraftForCatalog(savedOnKling(), release, { modelSelectionTouched: false, starter }).draft)
      .toMatchObject({ model: 'seedance-2-mini', resolution: '480p', duration: 5 });
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
