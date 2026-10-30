import { describe, expect, it } from 'vitest';

import { parseModelCatalogDetail } from '../lib/generation-model-catalog';
import {
  applyCatalogModelDefaults,
  buildUnifiedCatalogGenerationRequest,
  catalogDraftRunHandles,
  hydrateCatalogCreationDraftFromRemixSource,
  validateCatalogCreationDraft,
} from '../lib/generation-model-draft';
import {
  createDefaultCreationDraft,
  renameMediaDraft,
  type VideoCreationDraft,
} from '../lib/media-creation-view-model';
import type { RemixResolvedAsset, RemixResolvedImageElement, RemixSourceBundle } from '../lib/types';
import liveCatalog from './fixtures/live-catalog-descriptors.json';
import { catalogV2, klingVideoModel, remoteVideoModel } from './generation-model-catalog-v2-fixtures';

function namedReference(handle: string, index: number): RemixResolvedImageElement {
  const name = handle.slice(1);
  return {
    id: `imageReferences-${index}`,
    displayName: name,
    handle,
    storagePath: `generation_inputs/owner/source-generation/0${index}-reference_image.jpg`,
    sourceGenerationId: null,
    url: `https://cdn.example.com/${name}.jpg`,
  };
}

function namedReferenceRemix(elements: RemixResolvedImageElement[], prompt: string): RemixSourceBundle {
  return {
    generation: {
      id: 'source-generation',
      title: 'Referenced source',
      prompt,
      category: 'video',
      model: 'remote-video-v2',
    },
    result: null,
    inputs: {
      video: {
        referenceMode: 'elements',
        startFrame: null,
        endFrame: null,
        elements,
        referenceVideos: [],
        referenceAudios: [],
      },
    },
    workflowSettings: { model: 'remote-video-v2', referenceMode: 'elements', duration: 4 },
    restoreIssues: [],
  };
}

describe('catalog remix restore of reusable video references', () => {
  // The create screen passes a default video draft, whose model is kling-3.0-video. The
  // bundled registry gives that model no image references, so capping restored media
  // against it emptied every Seedance 2 remix before the catalog model was applied.
  it('keeps named references the catalog model accepts, whatever the draft model was', () => {
    const catalog = catalogV2();
    const model = catalog.models.find((entry) => entry.id === 'remote-video-v2')!;

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      namedReferenceRemix([namedReference('@girl', 1)], 'The girl from @girl is crying'),
      catalog,
    );

    expect(restored.warning).toBeNull();
    expect(restored.draft).toMatchObject({
      model: 'remote-video-v2',
      referenceMode: 'elements',
      duration: 4,
      references: [expect.objectContaining({ handle: '@girl', url: 'https://cdn.example.com/girl.jpg' })],
    });
    expect(validateCatalogCreationDraft(restored.draft, model).errors)
      .not.toContainEqual(expect.stringContaining('Unknown element mention'));
  });

  // A restore used to cut references to the catalog model's limit and warn that some could
  // not be restored, which was the cut itself. They are all kept now, as a model change
  // keeps them: the run sends what the model takes and waits until the rest are removed.
  it('restores every reference, sending what the catalog model takes and blocking the run until the rest are removed', () => {
    const base = remoteVideoModel();
    const narrow = remoteVideoModel('remote-video-v2', {
      inputs: { ...base.inputs, imageReferences: { max: 1, supportsNaming: true } },
      inputModes: base.inputModes?.map((mode) => ({
        ...mode,
        slots: mode.slots.map((slot) => (slot.key === 'imageReferences' ? { ...slot, max: 1 } : slot)),
      })),
    });
    const catalog = catalogV2([remoteVideoModel('fallback-video-v2'), narrow]);

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      namedReferenceRemix([namedReference('@ref1', 1), namedReference('@ref2', 2)], 'Blend @ref1 and @ref2'),
      catalog,
    );

    expect(restored.warning).toBeNull();
    expect((restored.draft as VideoCreationDraft).references.map((reference) => reference.handle)).toEqual(['@ref1', '@ref2']);
    expect(validateCatalogCreationDraft(restored.draft, narrow).errors).toEqual(['Reference images supports up to 1 input.']);
    expect(buildUnifiedCatalogGenerationRequest(restored.draft, narrow, catalog.revision).inputs.map((input) => input.handle))
      .toEqual(['@ref1']);
  });

  // Reported from a live Seedance 2 post: its remix showed the three reference images
  // and no clip. The server had never kept the clip, so the source arrived without it.
  // This is the app's half of the fix: a source that carries the clip restores it, and
  // the next run sends the kept copy on so that run keeps it too.
  it('restores a reference clip beside the named images and sends it with the next run', () => {
    const catalog = catalogV2();
    const model = catalog.models.find((entry) => entry.id === 'remote-video-v2')!;
    const keptClip = 'generation_inputs/owner/source-generation/01-reference_video.mp4';
    const bundle = namedReferenceRemix(
      [namedReference('@ali', 1)],
      'Change the first person in the reference video to @ali',
    );
    bundle.inputs.video!.referenceVideos = [{
      kind: 'video',
      label: 'Dance clip',
      storagePath: keptClip,
      sourceGenerationId: null,
      url: 'https://cdn.example.com/dance.mp4',
      durationSeconds: 9,
    }];

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      bundle,
      catalog,
    );

    expect(restored.warning).toBeNull();
    expect((restored.draft as VideoCreationDraft).references.map((reference) => reference.handle)).toEqual(['@ali']);
    expect((restored.draft as VideoCreationDraft).referenceVideos).toEqual([
      expect.objectContaining({
        kind: 'video',
        displayName: 'Dance clip',
        url: 'https://cdn.example.com/dance.mp4',
        storagePath: keptClip,
        durationSeconds: 9,
      }),
    ]);
    expect(buildUnifiedCatalogGenerationRequest(restored.draft, model, catalog.revision).inputs).toContainEqual(
      expect.objectContaining({
        slot: 'videoReferences',
        kind: 'video',
        url: 'https://cdn.example.com/dance.mp4',
        storagePath: keptClip,
        label: 'Dance clip',
        durationSeconds: 9,
      }),
    );
  });

  // A model that prices or caps a run by its reference seconds will not quote a clip
  // whose length it does not know. A restored clip arrived without one, so the remix
  // showed the clip and then refused to generate until it was removed and added again,
  // which someone remixing another creator's post has no file to do with.
  it('restores a clip with its length, so the run it joins can be quoted', () => {
    const catalog = catalogV2();
    const model = catalog.models.find((entry) => entry.id === 'remote-video-v2')!;
    const clip = {
      kind: 'video' as const,
      label: 'Dance clip',
      storagePath: 'generation_inputs/owner/source-generation/01-reference_video.mp4',
      sourceGenerationId: null,
      url: 'https://cdn.example.com/dance.mp4',
    };
    const restore = (referenceVideos: NonNullable<RemixSourceBundle['inputs']['video']>['referenceVideos']) => {
      const bundle = namedReferenceRemix([namedReference('@ali', 1)], 'Change the first person to @ali');
      bundle.inputs.video!.referenceVideos = referenceVideos;
      return hydrateCatalogCreationDraftFromRemixSource(createDefaultCreationDraft('video'), bundle, catalog).draft;
    };

    expect(validateCatalogCreationDraft(restore([{ ...clip, durationSeconds: 9 }]), model).errors).toEqual([]);
    // A source that kept the clip before lengths were recorded still says so.
    expect(validateCatalogCreationDraft(restore([clip]), model).errors)
      .toEqual(['Reference videos requires duration metadata.']);
  });
});

/** A clip a Kling 3.0 run kept, as the server hands it: its handle, and no length. The app names every clip it uploads "Reference Video". */
function keptKlingClip(place: number, handle?: string): RemixResolvedAsset {
  return {
    kind: 'video',
    label: 'Reference Video',
    storagePath: `generation_inputs/owner/source-generation/0${place}-reference_video.mp4`,
    sourceGenerationId: null,
    url: `https://cdn.example.com/clip-${place}.mp4`,
    handle,
  };
}

function klingClipsRemix(referenceVideos: RemixResolvedAsset[], prompt: string): RemixSourceBundle {
  return {
    generation: { id: 'source-generation', title: 'Two moves', prompt, category: 'video', model: 'kling-3.0-video' },
    result: null,
    inputs: {
      video: { referenceMode: 'frames', startFrame: null, endFrame: null, elements: [], referenceVideos, referenceAudios: [] },
    },
    workflowSettings: { model: 'kling-3.0-video', referenceMode: 'frames', duration: 5 },
    restoreIssues: [],
  };
}

describe('catalog remix restore of Kling 3.0 clips', () => {
  const twoKeptClips = () => klingClipsRemix(
    [keptKlingClip(2, '@reference_video_2'), keptKlingClip(3, '@reference_video_3')],
    'Open on @reference_video_2, then cut to @reference_video_3',
  );

  // Uploaded as @reference_video, @reference_video_2 and @reference_video_3, the first taken away
  // before the run: the run kept two clips, both named "Reference Video", under the handles its
  // prompt mentions. Restored without them, the app held the run ("Unknown element mentions:
  // @reference_video_2, @reference_video_3") and would have sent both clips with no handle.
  it('restores each clip under the handle its run kept, so the prompt still names them', () => {
    const catalog = catalogV2([klingVideoModel()]);
    const model = catalog.models[0];

    const restored = hydrateCatalogCreationDraftFromRemixSource(createDefaultCreationDraft('video'), twoKeptClips(), catalog);
    const draft = restored.draft as VideoCreationDraft;

    expect(restored.warning).toBeNull();
    expect(draft.referenceVideos.map((clip) => clip.handle)).toEqual(['@reference_video_2', '@reference_video_3']);
    expect(validateCatalogCreationDraft(draft, model).errors).toEqual([]);
    expect(buildUnifiedCatalogGenerationRequest(draft, model, catalog.revision).inputs).toEqual([
      expect.objectContaining({ slot: 'videoElements', handle: '@reference_video_2', url: 'https://cdn.example.com/clip-2.mp4' }),
      expect.objectContaining({ slot: 'videoElements', handle: '@reference_video_3', url: 'https://cdn.example.com/clip-3.mp4' }),
    ]);
    // Renamed later, a restored clip answers to its new name, as one the creator uploaded does.
    expect(renameMediaDraft(draft.referenceVideos[1], 'Jump').handle).toBe('@jump');
  });

  // The server hands a clip's handle only when it is one a prompt can mention (toRemixAssetDescriptor),
  // so none of these arrives today: this holds the app to its own check of what it is handed. A clip
  // handed none, as a row kept before handles were, is named as an upload is: Kling 3.0 takes no clip
  // without a handle, and those clips were quoted and then left out of the remix's run.
  it('keeps no handed handle a prompt could not mention, and names those clips as an upload is named', () => {
    const catalog = catalogV2([klingVideoModel()]);
    const model = catalog.models[0];

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      klingClipsRemix([keptKlingClip(1, '@Reference Video'), keptKlingClip(2, ''), keptKlingClip(3)], 'Three moves'),
      catalog,
    );
    const draft = restored.draft as VideoCreationDraft;

    expect(draft.referenceVideos.map((clip) => clip.handle)).toEqual(['@reference_video', '@reference_video_2', '@reference_video_3']);
    expect(buildUnifiedCatalogGenerationRequest(draft, model, catalog.revision).inputs.map((input) => [input.slot, input.handle])).toEqual([
      ['videoElements', '@reference_video'],
      ['videoElements', '@reference_video_2'],
      ['videoElements', '@reference_video_3'],
    ]);
  });

  // A run kept before clip handles were still mentions its clips by theirs. Its clips come back under
  // handles no words mention, so the run is held on those mentions, rather than sending
  // @reference_video_2 to the clip after the one the source meant.
  it('names a clip handed no handle past every handle its prompt mentions', () => {
    const catalog = catalogV2([klingVideoModel()]);
    const model = catalog.models[0];
    const prompt = 'Open on @reference_video_2, then cut to @reference_video_3';

    const restored = hydrateCatalogCreationDraftFromRemixSource(
      createDefaultCreationDraft('video'),
      klingClipsRemix([keptKlingClip(2), keptKlingClip(3)], prompt),
      catalog,
    );
    const draft = restored.draft as VideoCreationDraft;

    expect(draft.referenceVideos.map((clip) => clip.handle)).toEqual(['@reference_video', '@reference_video_4']);
    expect(draft.prompt).toBe(prompt);
    expect(validateCatalogCreationDraft(draft, model).errors).toEqual(['Unknown element mentions: @reference_video_2, @reference_video_3']);
  });

  // Only Kling 3.0 takes a clip under a handle (the server's videoElementInputs); Wan 2.7's slot names
  // none. A remix moved there kept its clips' handles, and the app took the prompt's mentions of them
  // for ones the run could send, which the server then refused.
  it('reads a mention of a clip as naming nothing on a model whose clips take no handle', () => {
    const catalog = catalogV2([klingVideoModel()]);
    const wan27 = parseModelCatalogDetail(liveCatalog.models.find((entry) => entry.id === 'wan-2.7'));
    const restored = hydrateCatalogCreationDraftFromRemixSource(createDefaultCreationDraft('video'), twoKeptClips(), catalog).draft;

    const onWan = applyCatalogModelDefaults(restored, wan27) as VideoCreationDraft;

    expect(onWan.referenceVideos.map((clip) => clip.handle)).toEqual(['@reference_video_2', '@reference_video_3']);
    expect(catalogDraftRunHandles(onWan, wan27)).toEqual([]);
    expect(validateCatalogCreationDraft(onWan, wan27).errors)
      .toContain('Unknown element mentions: @reference_video_2, @reference_video_3');
  });
});
