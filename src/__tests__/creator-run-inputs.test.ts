import { describe, expect, it } from 'vitest';

import {
  planImageRunInputs,
  planMotionRunInputs,
  planVideoRunInputs,
  type MotionRunDescriptor,
  type VideoRunDraft,
} from '@/lib/creator-run-inputs';
import { buildGenerationModelCatalog, quoteGenerationModel, type CatalogInputMode } from '@/lib/generation-model-catalog';
import { buildCodeGenerationModelOperations } from '@/lib/generation-model-runtime';
import { catalogRunInputFacts, catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';

type Media = {
  imageReference: string;
  reference: { id: string; durationSeconds?: number | null };
  videoElement: string;
  subjectImage: string;
};

const nothing: VideoRunDraft<Media> = {
  activeReferenceMode: 'frames',
  combinesFrameWithReferences: false,
  takesEndFrame: true,
  isMultiShot: false,
  imageReferences: [],
  videoReferences: [],
  audioReferences: [],
  videoElements: [],
  subjects: [],
  hasStartFrame: false,
  hasEndFrame: false,
  preparedVoiceIds: [],
  characterIds: [],
};

const pictures = (count: number) => Array.from({ length: count }, (_, index) => `picture-${index + 1}`);
const clips = (count: number, durationSeconds: number | null = 4) => Array.from({ length: count }, (_, index) => ({
  id: `clip-${index + 1}`,
  durationSeconds,
}));

/** Each planned input as `slot:kind`, in the order the run sends them. */
function sent(draft: Partial<VideoRunDraft<Media>>) {
  return planVideoRunInputs<Media>({ ...nothing, ...draft }).map((input) => `${input.slot}:${input.kind}`);
}

describe('planVideoRunInputs', () => {
  it("sends Wan 2.7's start frame beside five reference pictures, and the quote counts six images", () => {
    const plan = planVideoRunInputs<Media>({
      ...nothing,
      activeReferenceMode: 'elements',
      combinesFrameWithReferences: true,
      takesEndFrame: false,
      imageReferences: pictures(5),
      hasStartFrame: true,
    });

    expect(plan.map((input) => input.slot)).toEqual([
      'imageReferences', 'imageReferences', 'imageReferences', 'imageReferences', 'imageReferences', 'startFrame',
    ]);
    expect(catalogRunInputFacts(plan).inputCounts).toMatchObject({ images: 6, videos: 0 });
  });

  it("sends Wan 2.7's start frame beside five clips, and the quote counts it as an image", () => {
    const plan = planVideoRunInputs<Media>({
      ...nothing,
      activeReferenceMode: 'elements',
      combinesFrameWithReferences: true,
      videoReferences: clips(5),
      hasStartFrame: true,
    });

    expect(catalogRunInputFacts(plan)).toEqual({
      inputCounts: { images: 1, videos: 5, audios: 0, preparedAudios: 0, characters: 0 },
      inputMetadata: {
        slots: { videoReferences: { count: 5, durationsSeconds: [4, 4, 4, 4, 4] }, startFrame: { count: 1 } },
        referenceVideoDurationsSeconds: [4, 4, 4, 4, 4],
      },
    });
  });

  it('leaves the frames out of a references run on a model that cannot combine them', () => {
    // The page says so: "as it stands the run will use your references and ignore the frames".
    expect(sent({
      activeReferenceMode: 'elements',
      imageReferences: pictures(2),
      hasStartFrame: true,
      hasEndFrame: true,
    })).toEqual(['imageReferences:image', 'imageReferences:image']);
  });

  it('sends both frames in a frames run, and no reference', () => {
    expect(sent({ hasStartFrame: true, hasEndFrame: true })).toEqual(['startFrame:image', 'endFrame:image']);
    // A kind the run does not carry is passed empty; a frames run sends none of any kind.
    expect(sent({ hasStartFrame: true, imageReferences: pictures(1), videoReferences: clips(1) })).toEqual(['startFrame:image']);
  });

  it('sends no end frame where the model takes none, nor beside references', () => {
    expect(sent({ hasStartFrame: true, hasEndFrame: true, takesEndFrame: false })).toEqual(['startFrame:image']);
    expect(sent({
      activeReferenceMode: 'elements',
      combinesFrameWithReferences: true,
      imageReferences: pictures(1),
      hasStartFrame: true,
      hasEndFrame: true,
    })).toEqual(['imageReferences:image', 'startFrame:image']);
  });

  it('sends a multi-shot run its start frame, and no end frame or image reference, which its page does not show', () => {
    expect(sent({ isMultiShot: true, hasStartFrame: true, hasEndFrame: true })).toEqual(['startFrame:image']);
    expect(sent({
      isMultiShot: true,
      activeReferenceMode: 'elements',
      imageReferences: pictures(2),
      videoReferences: clips(1),
    })).toEqual(['videoReferences:video']);
  });

  it('sends named subjects in place of frames and references, under each subject’s name and handle', () => {
    const plan = planVideoRunInputs<Media>({
      ...nothing,
      activeReferenceMode: 'elements',
      imageReferences: pictures(1),
      hasStartFrame: true,
      subjects: [
        { displayName: 'Hero', handle: '@hero', images: ['front', 'side'] },
        { displayName: 'Prop', handle: '@prop', images: ['top', 'bottom', 'detail'] },
      ],
    });

    expect(plan.map((input) => (input.slot === 'subjectImages' ? `${input.subject.handle}/${input.image}` : input.slot))).toEqual([
      '@hero/front', '@hero/side', '@prop/top', '@prop/bottom', '@prop/detail',
    ]);
    expect(catalogRunInputFacts(plan).inputCounts.images).toBe(5);
  });

  it('carries the subjects across the shots of a multi-shot run', () => {
    expect(sent({ isMultiShot: true, subjects: [{ displayName: 'Hero', handle: '@hero', images: ['front', 'side'] }] }))
      .toEqual(['subjectImages:image', 'subjectImages:image']);
  });

  it("sends Kling 3.0's video elements beside either shape, with no length, as the run sends them", () => {
    expect(sent({ hasStartFrame: true, videoElements: ['walk'] })).toEqual(['videoElements:video', 'startFrame:image']);
    expect(sent({ isMultiShot: true, videoElements: ['walk', 'turn'] })).toEqual(['videoElements:video', 'videoElements:video']);
    const facts = catalogRunInputFacts(planVideoRunInputs<Media>({ ...nothing, videoElements: ['walk'] }));
    expect(facts.inputCounts.videos).toBe(1);
    expect(facts.inputMetadata.referenceVideoDurationsSeconds).toEqual([]);
  });

  it("sends Gemini Omni's prepared voices and characters beside either shape, last", () => {
    expect(sent({
      activeReferenceMode: 'elements',
      imageReferences: pictures(1),
      videoReferences: clips(1),
      preparedVoiceIds: ['voice-1'],
      characterIds: ['character-1', 'character-2'],
    })).toEqual([
      'imageReferences:image',
      'videoReferences:video',
      'preparedVoices:preparedVoice',
      'characters:character',
      'characters:character',
    ]);
  });

  it('sends every kind in one order: references, video elements, subjects, frames, prepared assets', () => {
    expect(sent({
      activeReferenceMode: 'elements',
      combinesFrameWithReferences: true,
      imageReferences: pictures(1),
      videoReferences: clips(1),
      audioReferences: clips(1),
      videoElements: ['walk'],
      hasStartFrame: true,
      preparedVoiceIds: ['voice-1'],
      characterIds: ['character-1'],
    })).toEqual([
      'imageReferences:image',
      'videoReferences:video',
      'audioReferences:audio',
      'videoElements:video',
      'startFrame:image',
      'preparedVoices:preparedVoice',
      'characters:character',
    ]);
  });

  it('reports each clip and track with its length, and an unknown length as none', () => {
    const plan = planVideoRunInputs<Media>({
      ...nothing,
      activeReferenceMode: 'elements',
      videoReferences: [{ id: 'clip', durationSeconds: 4.2 }, { id: 'unmeasured' }],
      audioReferences: [{ id: 'track', durationSeconds: 6.5 }],
    });

    expect(plan.map((input) => ('durationSeconds' in input ? input.durationSeconds : undefined))).toEqual([4.2, null, 6.5]);
    expect(catalogRunInputFacts(plan).inputMetadata).toEqual({
      slots: { videoReferences: { count: 2, durationsSeconds: [4.2] }, audioReferences: { count: 1, durationsSeconds: [6.5] } },
      referenceVideoDurationsSeconds: [4.2],
    });
  });

  it('sends nothing for an empty draft', () => {
    expect(sent({})).toEqual([]);
    expect(sent({ activeReferenceMode: 'elements' })).toEqual([]);
  });
});

describe('planImageRunInputs', () => {
  it('sends as many pictures as the model takes, in grid order', () => {
    expect(planImageRunInputs(pictures(15), 14).map((input) => input.element)).toEqual(pictures(14));
    expect(catalogRunInputFacts(planImageRunInputs(pictures(15), 14)).inputCounts.images).toBe(14);
  });

  it('sends every picture within the limit, and none to a prompt-only model', () => {
    expect(planImageRunInputs(pictures(2), 14)).toEqual([
      { slot: 'imageReferences', kind: 'image', element: 'picture-1' },
      { slot: 'imageReferences', kind: 'image', element: 'picture-2' },
    ]);
    expect(planImageRunInputs(pictures(2), 0)).toEqual([]);
    expect(planImageRunInputs(pictures(2), -1)).toEqual([]);
  });
});

/** Kling 3.0 motion as production publishes it (release `wan-start-frame-apart-20261019`, read 2026-10-19). */
const productionKling3Motion: CatalogInputMode[] = [{
  key: 'default',
  label: 'Default',
  default: true,
  slots: [
    { key: 'imageReferences', label: 'Reference images', kind: 'image', role: 'reference', min: 0, max: 1 },
    { key: 'videoReferences', label: 'Reference videos', kind: 'video', role: 'reference', min: 0, max: 1 },
  ],
}];

const motionSettings = { duration: 8, characterOrientation: 'video', resolution: '720p' };
const slotsOf = (descriptor: MotionRunDescriptor | null | undefined, settings: Record<string, string | number> = motionSettings) => (
  planMotionRunInputs(descriptor, settings).map((input) => `${input.slot}:${input.kind}`)
);

describe('planMotionRunInputs', () => {
  it('sends the picture and the clip in the slots each code motion model declares', () => {
    const motionModels = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 }).models.filter((model) => model.kind === 'motion');
    expect(motionModels.map((model) => model.id).sort()).toEqual(['kling-2.6', 'kling-3.0']);
    for (const model of motionModels) {
      expect(slotsOf(model)).toEqual(['characterImage:image', 'referenceVideo:video']);
    }
  });

  it("sends Kling 3.0's in the reference slots production publishes, counted as the run sends them", () => {
    const planned = planMotionRunInputs({ inputModes: productionKling3Motion }, motionSettings);
    expect(planned).toEqual([{ slot: 'imageReferences', kind: 'image' }, { slot: 'videoReferences', kind: 'video' }]);
    expect(catalogRunInputFacts(planned)).toEqual({
      inputCounts: { images: 1, videos: 1, audios: 0, preparedAudios: 0, characters: 0 },
      inputMetadata: { slots: { imageReferences: { count: 1 }, videoReferences: { count: 1 } }, referenceVideoDurationsSeconds: [] },
    });
  });

  it('keeps the motion-inputs slots for a descriptor that publishes no mode, or none for a kind', () => {
    expect(slotsOf(undefined)).toEqual(['characterImage:image', 'referenceVideo:video']);
    expect(slotsOf({})).toEqual(['characterImage:image', 'referenceVideo:video']);
    expect(slotsOf({ inputModes: [{ slots: [{ key: 'imageReferences', kind: 'image', role: 'reference' }] }] }))
      .toEqual(['imageReferences:image', 'referenceVideo:video']);
  });

  it('reads the slots of the mode the run’s settings open, and of the slots they open in it', () => {
    const gated: MotionRunDescriptor = {
      inputModes: [
        {
          conditions: [{ source: 'setting', key: 'characterOrientation', operator: 'equals', value: 'image' }],
          slots: [
            { key: 'portrait', kind: 'image', role: 'reference' },
            { key: 'performance', kind: 'video', role: 'reference', conditions: [{ source: 'setting', key: 'resolution', operator: 'equals', value: '1080p' }] },
            { key: 'take', kind: 'video', role: 'reference' },
          ],
        },
        { slots: [{ key: 'character', kind: 'image', role: 'reference' }, { key: 'clip', kind: 'video', role: 'reference' }] },
      ],
    };
    expect(slotsOf(gated, { ...motionSettings, characterOrientation: 'video' })).toEqual(['character:image', 'clip:video']);
    expect(slotsOf(gated, { ...motionSettings, characterOrientation: 'image' })).toEqual(['portrait:image', 'take:video']);
    expect(slotsOf(gated, { ...motionSettings, characterOrientation: 'image', resolution: '1080p' })).toEqual(['portrait:image', 'performance:video']);
  });

  it('never puts the character in a frame slot', () => {
    expect(slotsOf({
      inputModes: [{
        slots: [
          { key: 'startFrame', kind: 'image', role: 'startFrame' },
          { key: 'character', kind: 'image', role: 'reference' },
          { key: 'clip', kind: 'video', role: 'reference' },
        ],
      }],
    })).toEqual(['character:image', 'clip:video']);
  });

  it('is a run the server prices for every code motion model and for production’s Kling 3.0, where the fixed slots were refused', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
    const operations = new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry]));
    const quote = (models: typeof catalog.models, modelId: string, inputs: readonly { slot: string; kind: 'image' | 'video' }[]) => quoteGenerationModel(
      catalogRunQuoteInput({ kind: 'motion' as const, modelId, catalogRevision: catalog.revision, settings: motionSettings, inputs }),
      { catalog: { ...catalog, models }, operations },
    );
    for (const model of catalog.models.filter((candidate) => candidate.kind === 'motion')) {
      expect(quote(catalog.models, model.id, planMotionRunInputs(model, motionSettings)).costCredits).toEqual(expect.any(Number));
    }

    const asProduction = catalog.models.map((model) => (
      model.id === 'kling-3.0' && model.kind === 'motion' ? { ...model, inputModes: productionKling3Motion } : model
    ));
    const kling3 = asProduction.find((model) => model.id === 'kling-3.0' && model.kind === 'motion');
    expect(quote(asProduction, 'kling-3.0', planMotionRunInputs(kling3, motionSettings)).costCredits).toEqual(expect.any(Number));
    expect(() => quote(asProduction, 'kling-3.0', [{ slot: 'characterImage', kind: 'image' }, { slot: 'referenceVideo', kind: 'video' }]))
      .toThrow(expect.objectContaining({ fieldErrors: expect.objectContaining({ characterImage: 'Kling 3.0 does not support the characterImage input.' }) }));
  });
});
