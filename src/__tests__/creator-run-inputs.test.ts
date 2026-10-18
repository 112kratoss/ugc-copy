import { describe, expect, it } from 'vitest';

import {
  planImageRunInputs,
  planVideoRunInputs,
  type VideoRunDraft,
} from '@/lib/creator-run-inputs';
import { catalogRunInputFacts } from '../../ugc-mobile/lib/model-catalog/protocol';

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
