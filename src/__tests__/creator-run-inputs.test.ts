import { describe, expect, it } from 'vitest';

import {
  lengthReading,
  motionRunClipSlot,
  planImageRunInputs,
  planMotionRunInputs,
  planVideoRunInputs,
  type MotionRunDescriptor,
  type VideoRunDraft,
} from '@/lib/creator-run-inputs';
import { buildGenerationModelCatalog, quoteGenerationModel } from '@/lib/generation-model-catalog';
import { catalogRunInputFacts, catalogRunQuoteInput } from '../../ugc-mobile/lib/model-catalog/protocol';
import { PRODUCTION_KLING_3_MOTION_MODES, ROLLBACK_KLING_3_MOTION_MODES } from './fixtures/production-motion-descriptors';

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

const motionSettings = { duration: 8, characterOrientation: 'video', resolution: '720p' };
const slotsOf = (descriptor: MotionRunDescriptor | null | undefined, settings: Record<string, string | number> = motionSettings) => (
  planMotionRunInputs(descriptor, settings).map((input) => `${input.slot}:${input.kind}`)
);

describe('planMotionRunInputs', () => {
  it('sends the picture and the clip in the slots each code motion model declares, whatever their names', () => {
    const motionModels = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 }).models.filter((model) => model.kind === 'motion');
    expect(motionModels.map((model) => model.id).sort()).toEqual(['kling-2.6', 'kling-3.0']);
    for (const model of motionModels) {
      expect(slotsOf(model)).toEqual(['characterImage:image', 'referenceVideo:video']);
      // The same model with its slots renamed: the plan follows the descriptor, not the names it knows.
      const renamed = {
        ...model,
        inputModes: model.inputModes?.map((mode) => ({ ...mode, slots: mode.slots.map((slot) => ({ ...slot, key: `${slot.key}Renamed` })) })),
      };
      expect(slotsOf(renamed)).toEqual(['characterImageRenamed:image', 'referenceVideoRenamed:video']);
    }
  });

  it("sends Kling 3.0's in the motion-inputs slots production publishes", () => {
    expect(planMotionRunInputs({ inputModes: PRODUCTION_KLING_3_MOTION_MODES }, motionSettings))
      .toEqual([{ slot: 'characterImage', kind: 'image' }, { slot: 'referenceVideo', kind: 'video' }]);
  });

  it("sends Kling 3.0's in the reference slots production serves on a rollback, counted as the run sends them", () => {
    const planned = planMotionRunInputs({ inputModes: ROLLBACK_KLING_3_MOTION_MODES }, motionSettings);
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

  it('skips a slot that takes nothing, and prefers one the run must fill', () => {
    expect(slotsOf({
      inputModes: [{
        slots: [
          { key: 'closed', kind: 'image', role: 'reference', min: 0, max: 0 },
          { key: 'optional', kind: 'image', role: 'reference', min: 0, max: 1 },
          { key: 'required', kind: 'image', role: 'reference', min: 1, max: 1 },
          { key: 'clip', kind: 'video', role: 'reference', min: 0, max: 1 },
        ],
      }],
    })).toEqual(['required:image', 'clip:video']);
    expect(slotsOf({
      inputModes: [{ slots: [{ key: 'closed', kind: 'image', role: 'reference', max: 0 }, { key: 'optional', kind: 'image', role: 'reference', max: 1 }] }],
    })).toEqual(['optional:image', 'referenceVideo:video']);
  });

  it('reads a frame slot as empty in a mode’s conditions, as the server and the app do', () => {
    expect(slotsOf({
      inputModes: [
        {
          conditions: [{ source: 'inputCount', key: 'startFrame', operator: 'equals', value: 0 }],
          slots: [{ key: 'imageReferences', kind: 'image', role: 'reference' }, { key: 'videoReferences', kind: 'video', role: 'reference' }],
        },
        { slots: [{ key: 'startFrame', kind: 'image', role: 'startFrame' }] },
      ],
    })).toEqual(['imageReferences:image', 'videoReferences:video']);
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

  it('is a run the server prices for every code motion model and for Kling 3.0’s rollback shape, where the fixed slots were refused', () => {
    const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
    const quote = (models: typeof catalog.models, modelId: string, inputs: readonly { slot: string; kind: 'image' | 'video' }[]) => quoteGenerationModel(
      catalogRunQuoteInput({ kind: 'motion' as const, modelId, catalogRevision: catalog.revision, settings: motionSettings, inputs }),
      { catalog: { ...catalog, models } },
    );
    for (const model of catalog.models.filter((candidate) => candidate.kind === 'motion')) {
      expect(quote(catalog.models, model.id, planMotionRunInputs(model, motionSettings)).costCredits).toEqual(expect.any(Number));
    }

    // Production served Kling 3.0 in the compatibility release's plain reference slots until release
    // kling-3-motion-inputs-20261101, and serves them again on a rollback of it.
    const asRollback = catalog.models.map((model) => (
      model.id === 'kling-3.0' && model.kind === 'motion' ? { ...model, inputModes: ROLLBACK_KLING_3_MOTION_MODES } : model
    ));
    const kling3 = asRollback.find((model) => model.id === 'kling-3.0' && model.kind === 'motion');
    expect(quote(asRollback, 'kling-3.0', planMotionRunInputs(kling3, motionSettings)).costCredits).toEqual(expect.any(Number));
    expect(() => quote(asRollback, 'kling-3.0', [{ slot: 'characterImage', kind: 'image' }, { slot: 'referenceVideo', kind: 'video' }]))
      .toThrow(expect.objectContaining({ fieldErrors: expect.objectContaining({ characterImage: 'Kling 3.0 does not support the characterImage input.' }) }));
  });
});

/**
 * The slot whose shortest clip the motion page holds a run to is the one the run sends its clip in: a
 * slot of a mode the run's settings open, that takes something. A key repeated in a closed mode, a slot
 * that takes nothing, or no open clip slot at all must not lend its minimum (or its words) to the run.
 */
describe('motionRunClipSlot', () => {
  const clip = (minDurationSeconds?: number, extra: Record<string, unknown> = {}) => ({
    key: 'referenceVideo', kind: 'video' as const, role: 'reference' as const, label: 'Reference video', min: 1, max: 1,
    ...(minDurationSeconds === undefined ? {} : { minDurationSeconds }), ...extra,
  });
  const imageOnly = { conditions: [{ source: 'setting' as const, key: 'characterOrientation', operator: 'equals' as const, value: 'image' }] };

  it('reads the open mode’s slot where a closed mode declares the same key first', () => {
    const descriptor = { inputModes: [{ ...imageOnly, slots: [clip(3)] }, { slots: [clip()] }] };
    expect(motionRunClipSlot(descriptor, motionSettings)).toEqual(clip());
    expect(motionRunClipSlot(descriptor, { ...motionSettings, characterOrientation: 'image' })).toEqual(clip(3));
  });

  it('reads no slot where no open slot takes a clip, though the run falls back to the motion-inputs key', () => {
    expect(slotsOf({ inputModes: [{ ...imageOnly, slots: [clip(3)] }] })).toEqual(['characterImage:image', 'referenceVideo:video']);
    expect(motionRunClipSlot({ inputModes: [{ ...imageOnly, slots: [clip(3)] }] }, motionSettings)).toBeNull();
    expect(motionRunClipSlot({ inputModes: [{ slots: [clip(3, { max: 0 })] }] }, motionSettings)).toBeNull();
    expect(motionRunClipSlot({ inputModes: [{ slots: [clip(3, { conditions: imageOnly.conditions })] }] }, motionSettings)).toBeNull();
  });
});

/**
 * A clip's or track's length as the creators show it: rounded down under its slot's shortest, as the
 * start's refusal gives it (a 1.97 s clip under 2 s is refused as running 1.9 seconds), rounded up over
 * its longest (a 15.04 s clip over 15 s must not read 15.0), and to the nearest tenth between.
 */
describe('lengthReading', () => {
  it('reads a length toward the limit it is past, and to the nearest tenth otherwise', () => {
    expect(lengthReading(1.97, { minDurationSeconds: 2 })).toBe('1.9');
    expect(lengthReading(1.86, { minDurationSeconds: 2, maxDurationSeconds: 15 })).toBe('1.8');
    expect(lengthReading(2, { minDurationSeconds: 2 })).toBe('2.0');
    expect(lengthReading(2.16, { minDurationSeconds: 2 })).toBe('2.2');
    expect(lengthReading(15.04, { minDurationSeconds: 2, maxDurationSeconds: 15 })).toBe('15.1');
    expect(lengthReading(15, { maxDurationSeconds: 15 })).toBe('15.0');
    expect(lengthReading(14.96, { maxDurationSeconds: 15 })).toBe('15.0');
    expect(lengthReading(1.97, {})).toBe('2.0');
    expect(lengthReading(1.97, null)).toBe('2.0');
  });
});
