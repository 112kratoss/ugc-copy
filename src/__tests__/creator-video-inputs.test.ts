import { describe, expect, it } from 'vitest';

import {
  planVideoInputSwitch,
  shortFileName,
  videoInputSides,
  videoInputsHint,
  videoInputView,
  type HeldVideoInputs,
  type VideoInputNames,
  type VideoInputSides,
} from '@/lib/creator-video-inputs';
import { getVideoInputAffordances } from '@/lib/generation-model-affordances';
import { buildGenerationModelCatalog, type GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import { parseClientGenerationModelCatalog } from '@/lib/generation-model-client';
import type { VideoModelId } from '@/lib/models';
import productionVideo from './fixtures/production-video-descriptors-2026-10-29.json';

/**
 * The video creator's inputs as one choice, frames or references (the artboard Inputs, PR 4 of
 * the creator redesign; owner's answers of 2026-10-29: the switch wherever the catalog publishes
 * it, Wan 2.7 included; the mirror question when switching back to frames).
 */

const codeCatalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
// What the page reads in production: the published descriptors, parsed as the browser parses them.
const production = parseClientGenerationModelCatalog({
  schemaVersion: 3,
  revision: productionVideo.revision,
  defaults: { image: null, video: 'seedance-2-mini', motion: null },
  models: productionVideo.models,
});

function descriptorOf(models: { models: GenerationModelDescriptor[] }, id: string) {
  const descriptor = models.models.find((model) => model.id === id);
  if (!descriptor) throw new Error(`${id} is not in the catalog`);
  return descriptor;
}

function sidesOf(models: { models: GenerationModelDescriptor[] }, id: string, settings: { isMultiShot?: boolean; mode?: string } = {}) {
  return videoInputSides(getVideoInputAffordances(descriptorOf(models, id), id as VideoModelId, settings), { isMultiShot: Boolean(settings.isMultiShot) });
}

const NOTHING: HeldVideoInputs = { start: false, end: false, pictures: 0, clips: 0, tracks: 0, characters: 0 };
const names = (model: string, extra: Partial<VideoInputNames> = {}): VideoInputNames => ({
  model, start: null, end: null, pictures: [], promptHandles: [], ...extra,
});
const pictures = (...handles: string[]) => handles.map((handle, index) => ({ handle, name: `Picture ${index + 1}` }));

describe('the sides production publishes', () => {
  const switchable = productionVideo.models
    .map((model) => model.id)
    .filter((id) => {
      const sides = sidesOf(production, id);
      return Boolean(sides.frames && sides.references);
    });

  it('offers the switch on the 16 models whose release publishes the choice, Wan 2.7 included', () => {
    expect(switchable).toHaveLength(16);
    expect(switchable).toContain('wan-2.7');
    expect(switchable).not.toEqual(expect.arrayContaining(['kling-3.0-video', 'kling-3.0-turbo', 'hailuo-2.3', 'gemini-omni-video']));
    // Every one of them publishes the referenceMode control, and only they do.
    const publishing = productionVideo.models
      .filter((model) => model.controls.some((control) => control.key === 'referenceMode'))
      .map((model) => model.id);
    expect(switchable).toEqual(publishing);
  });

  it('names the options in the release’s words', () => {
    expect(sidesOf(production, 'seedance-2-5').labels).toEqual({ frames: 'Frames', references: 'References' });
  });

  it('shows frames alone on the frames-only models and references alone on Gemini Omni video', () => {
    for (const id of ['kling-3.0-video', 'kling-3.0-turbo', 'hailuo-2.3']) {
      const sides = sidesOf(production, id);
      expect(sides.frames, id).not.toBeNull();
      expect(sides.references, id).toBeNull();
    }
    const omni = sidesOf(production, 'gemini-omni-video');
    expect(omni.frames).toBeNull();
    expect(omni.references).toMatchObject({ pictures: 7 });
  });

  it('keeps the start image on the references side of Wan 2.7 alone', () => {
    const keeping = productionVideo.models.map((model) => model.id).filter((id) => sidesOf(production, id).references?.keepsStart);
    expect(keeping).toEqual(['wan-2.7']);
  });

  it('reads the start image beside the references off the flag the run reads', () => {
    // One source for the card and the run: a release that stopped combining Wan 2.7's frame
    // with its references would take the start image off both.
    const wan = descriptorOf(production, 'wan-2.7');
    const apart = { ...wan, inputs: { ...wan.inputs, combineFramesWithReferences: false } };
    expect(videoInputSides(getVideoInputAffordances(apart, 'wan-2.7', {}), { isMultiShot: false }).references?.keepsStart).toBe(false);
  });

  it('shares the count the release publishes across the references’ kinds', () => {
    expect(sidesOf(production, 'wan-2.7').references?.budget)
      .toEqual({ max: 5, weights: { pictures: 1, clips: 1, tracks: 1, characters: 0 } });
    expect(sidesOf(production, 'gemini-omni-video').references?.budget)
      .toEqual({ max: 7, weights: { pictures: 1, clips: 2, tracks: 0, characters: 1 } });
    expect(sidesOf(production, 'seedance-2-5').references?.budget).toBeNull();
  });

  it('agrees with the code catalog on every model they share', () => {
    for (const model of productionVideo.models) {
      if (!codeCatalog.models.some((entry) => entry.id === model.id)) continue;
      const fromCode = sidesOf(codeCatalog, model.id);
      const fromProduction = sidesOf(production, model.id);
      expect(Boolean(fromCode.frames && fromCode.references), model.id).toBe(Boolean(fromProduction.frames && fromProduction.references));
      expect(fromCode.references?.keepsStart ?? false, model.id).toBe(fromProduction.references?.keepsStart ?? false);
      expect(fromCode.references?.budget ?? null, model.id).toEqual(fromProduction.references?.budget ?? null);
    }
  });

  it('closes the references side in a multi-shot run, where the run sends none', () => {
    const sides = sidesOf(production, 'kling-o3', { isMultiShot: true });
    expect(sides.references).toBeNull();
    expect(sides.frames).toMatchObject({ start: true, end: false });
  });
});

describe('the side the card shows', () => {
  const seedance = sidesOf(production, 'seedance-2-5');
  const wan = sidesOf(production, 'wan-2.7');

  it('shows the side last picked while nothing is attached', () => {
    expect(videoInputView(seedance, NOTHING, 'frames')).toMatchObject({ side: 'frames', switchable: true, heldSide: null });
    expect(videoInputView(seedance, NOTHING, 'references')).toMatchObject({ side: 'references', heldSide: null });
  });

  it('is held by what is attached', () => {
    expect(videoInputView(seedance, { ...NOTHING, start: true }, 'references')).toMatchObject({ side: 'frames', heldSide: 'frames' });
    expect(videoInputView(seedance, { ...NOTHING, clips: 1 }, 'frames')).toMatchObject({ side: 'references', heldSide: 'references' });
  });

  it('shows references where a draft holds both, and names the frames the run leaves out', () => {
    expect(videoInputView(seedance, { ...NOTHING, start: true, end: true, pictures: 2 }, 'frames'))
      .toEqual({ side: 'references', switchable: true, heldSide: 'references', framesLeftOut: ['start', 'end'] });
  });

  it('lets Wan 2.7’s start image stand on either side', () => {
    expect(videoInputView(wan, { ...NOTHING, start: true }, 'references')).toMatchObject({ side: 'references', heldSide: null });
    expect(videoInputView(wan, { ...NOTHING, start: true, pictures: 1 }, 'frames')).toMatchObject({ side: 'references', framesLeftOut: [] });
    expect(videoInputView(wan, { ...NOTHING, end: true }, 'references')).toMatchObject({ side: 'frames', heldSide: 'frames' });
  });

  it('draws no switch on a model with one side', () => {
    expect(videoInputView(sidesOf(production, 'kling-3.0-video'), NOTHING, 'references')).toMatchObject({ side: 'frames', switchable: false });
    expect(videoInputView(sidesOf(production, 'gemini-omni-video'), NOTHING, 'frames')).toMatchObject({ side: 'references', switchable: false });
  });
});

describe('switching to references', () => {
  const seedance = sidesOf(production, 'seedance-2-5');

  it('asks first, in the artboard’s words, and brings the start image along', () => {
    const plan = planVideoInputSwitch(seedance, { ...NOTHING, start: true }, 'references', names('Seedance 2.5', { start: 'start.jpg' }));
    expect(plan.question).toEqual({
      title: 'Switch to references?',
      message: 'Seedance 2.5 takes frames or references, not both. Your start image can come with you as a reference.',
      keepLabel: 'Keep frames',
      confirmLabel: 'Move start.jpg to references',
    });
    expect(plan.framesToReferences).toEqual(['start']);
    expect(plan.framesCleared).toEqual([]);
  });

  it('switches without asking when nothing would be cleared', () => {
    expect(planVideoInputSwitch(seedance, NOTHING, 'references', names('Seedance 2.5')).question).toBeNull();
  });

  it('brings both frames along, and names an image without a file by its place', () => {
    const both = planVideoInputSwitch(seedance, { ...NOTHING, start: true, end: true }, 'references', names('Seedance 2.5'));
    expect(both.question?.message).toBe('Seedance 2.5 takes frames or references, not both. Your start and end images can come with you as references.');
    expect(both.question?.confirmLabel).toBe('Move both to references');
    expect(both.framesToReferences).toEqual(['start', 'end']);
    const remixed = planVideoInputSwitch(seedance, { ...NOTHING, start: true }, 'references', names('Seedance 2.5'));
    expect(remixed.question?.confirmLabel).toBe('Move the start image to references');
  });

  it('keeps a long file name short in the button', () => {
    const plan = planVideoInputSwitch(seedance, { ...NOTHING, start: true }, 'references', names('Seedance 2.5', { start: 'IMG_20261028_235959_HDR_portrait.jpg' }));
    expect(plan.question?.confirmLabel).toBe('Move IMG_20261028_235959….jpg to references');
  });

  it('clears what the references have no room for, and says so', () => {
    const onePicture: VideoInputSides = { ...seedance, references: { ...seedance.references!, pictures: 1 } };
    const plan = planVideoInputSwitch(onePicture, { ...NOTHING, start: true, end: true }, 'references', names('Seedance 2.5', { start: 'a.png' }));
    expect(plan.question?.message).toBe('Seedance 2.5 takes frames or references, not both. Your start image can come with you as a reference. Your end image is cleared.');
    expect(plan.question?.confirmLabel).toBe('Move a.png to references');
    expect(plan.framesToReferences).toEqual(['start']);
    expect(plan.framesCleared).toEqual(['end']);
  });

  it('asks on Wan 2.7 only for an end image, which its references side cannot keep', () => {
    const wan = sidesOf(production, 'wan-2.7');
    expect(planVideoInputSwitch(wan, { ...NOTHING, start: true }, 'references', names('Wan 2.7')).question).toBeNull();
    const plan = planVideoInputSwitch(wan, { ...NOTHING, start: true, end: true }, 'references', names('Wan 2.7', { end: 'end.jpg' }));
    expect(plan.question?.message).toBe('Wan 2.7 takes a start and end image, or references with a start image. Your end image can come with you as a reference.');
    expect(plan.question?.confirmLabel).toBe('Move end.jpg to references');
    expect(plan.framesToReferences).toEqual(['end']);
  });
});

describe('switching back to frames (the mirror question)', () => {
  const seedance = sidesOf(production, 'seedance-2-5');

  it('brings the first picture along as the start image', () => {
    const plan = planVideoInputSwitch(seedance, { ...NOTHING, pictures: 1 }, 'frames', names('Seedance 2.5', { pictures: pictures('@reference_1') }));
    expect(plan.question).toEqual({
      title: 'Switch to frames?',
      message: 'Seedance 2.5 takes frames or references, not both. @reference_1 can come with you as the start image.',
      keepLabel: 'Keep references',
      confirmLabel: 'Move @reference_1 to frames',
    });
    expect(plan.picturesToFrames).toEqual([{ index: 0, frame: 'start' }]);
    expect(plan.promptNames).toEqual([]);
  });

  it('brings the second picture as the end image, and clears the clips, tracks and other pictures', () => {
    const plan = planVideoInputSwitch(
      seedance,
      { ...NOTHING, pictures: 3, clips: 1, tracks: 1 },
      'frames',
      names('Seedance 2.5', { pictures: pictures('@lead', '@prop', '@extra') }),
    );
    expect(plan.question?.message).toBe('Seedance 2.5 takes frames or references, not both. @lead and @prop can come with you as the start and end images. The other 3 references are cleared.');
    expect(plan.question?.confirmLabel).toBe('Move both to frames');
    expect(plan.picturesToFrames).toEqual([{ index: 0, frame: 'start' }, { index: 1, frame: 'end' }]);
  });

  it('says the prompt’s mentions of the pictures become their names, and plans it', () => {
    // Every picture goes, as a frame or cleared, and the server refuses a prompt that mentions
    // a reference the run does not send: Generate stopped on "@lead" after the move.
    const held = { ...NOTHING, pictures: 3 };
    const carried = [{ handle: '@lead', name: 'Hero shot' }, { handle: '@prop', name: 'Umbrella' }, { handle: '@extra', name: 'Extra' }];
    const two = planVideoInputSwitch(seedance, held, 'frames', names('Seedance 2.5', { pictures: carried, promptHandles: ['@lead', '@prop', '@someone'] }));
    expect(two.question?.message).toBe('Seedance 2.5 takes frames or references, not both. @lead and @prop can come with you as the start and end images. The other reference is cleared. In your prompt, @lead and @prop become “Hero shot” and “Umbrella”.');
    expect(two.promptNames).toEqual([['@lead', 'Hero shot'], ['@prop', 'Umbrella']]);

    const one = planVideoInputSwitch(seedance, held, 'frames', names('Seedance 2.5', { pictures: carried, promptHandles: ['@extra'] }));
    expect(one.question?.message).toMatch(/ In your prompt, @extra becomes “Extra”\.$/);
    const all = planVideoInputSwitch(seedance, held, 'frames', names('Seedance 2.5', { pictures: carried, promptHandles: ['@lead', '@prop', '@extra'] }));
    expect(all.question?.message).toMatch(/ In your prompt, 3 handles become the names of their references\.$/);
    expect(all.promptNames).toHaveLength(3);
  });

  it('fills only the start image on a model with no end frame', () => {
    const plan = planVideoInputSwitch(sidesOf(production, 'kling-o3'), { ...NOTHING, pictures: 2 }, 'frames', names('Kling O3', { pictures: pictures('@a', '@b') }));
    expect(plan.question?.message).toBe('Kling O3 takes frames or references, not both. @a can come with you as the start image. The other reference is cleared.');
    expect(plan.picturesToFrames).toEqual([{ index: 0, frame: 'start' }]);
  });

  it('says what goes when no picture can come along', () => {
    const one = planVideoInputSwitch(seedance, { ...NOTHING, clips: 1 }, 'frames', names('Seedance 2.5'));
    expect(one.question?.message).toBe('Seedance 2.5 takes frames or references, not both. Your reference is cleared.');
    expect(one.question?.confirmLabel).toBe('Switch to frames');
    expect(planVideoInputSwitch(seedance, { ...NOTHING, clips: 1, tracks: 1 }, 'frames', names('Seedance 2.5')).question?.message)
      .toBe('Seedance 2.5 takes frames or references, not both. Your 2 references are cleared.');
  });

  it('fills Wan 2.7’s end image where its start image is already set', () => {
    const plan = planVideoInputSwitch(sidesOf(production, 'wan-2.7'), { ...NOTHING, start: true, pictures: 1 }, 'frames', names('Wan 2.7', { pictures: pictures('@hero') }));
    expect(plan.question?.message).toBe('Wan 2.7 takes a start and end image, or references with a start image. @hero can come with you as the end image.');
    expect(plan.picturesToFrames).toEqual([{ index: 0, frame: 'end' }]);
  });

  it('switches without asking when no reference is held', () => {
    expect(planVideoInputSwitch(seedance, NOTHING, 'frames', names('Seedance 2.5')).question).toBeNull();
  });
});

describe('the line under the switch', () => {
  const seedance = sidesOf(production, 'seedance-2-5');
  const hint = (sides: VideoInputSides, held: HeldVideoInputs, picked: 'frames' | 'references', model: string, extra: { remixPictures?: number; subjectsHeld?: boolean } = {}) => (
    videoInputsHint({ view: videoInputView(sides, held, picked), sides, model, held, remixPictures: extra.remixPictures ?? 0, subjectsHeld: extra.subjectsHeld ?? false })
  );

  it('invites on an empty frames side and explains a filled one (the artboards Main and Inputs)', () => {
    expect(hint(seedance, NOTHING, 'frames', 'Seedance 2.5'))
      .toBe('Optional. Set a first and last image, or switch to References to bring in people and products by name.');
    expect(hint(seedance, { ...NOTHING, start: true }, 'frames', 'Seedance 2.5'))
      .toBe('Seedance 2.5 starts from the first image and ends on the last one you set.');
    expect(hint(sidesOf(production, 'kling-o3'), { ...NOTHING, start: true }, 'frames', 'Kling O3')).toBe('Kling O3 starts from the image you set.');
  });

  it('counts only a frame the side holds', () => {
    // An end image kept from a model that takes one is not set on a model, or in a multi-shot
    // run, without an end frame.
    expect(hint(sidesOf(production, 'kling-o3'), { ...NOTHING, end: true }, 'frames', 'Kling O3'))
      .toBe('Optional. Set a first image, or switch to References to bring in people and products by name.');
    expect(hint(sidesOf(production, 'seedance-2-5', { isMultiShot: true }), { ...NOTHING, end: true }, 'frames', 'Seedance 2.5'))
      .toBe('Optional. Set a first image.');
  });

  it('offers no switch where there is none, and asks for Hailuo 2.3’s start image', () => {
    expect(hint(sidesOf(production, 'kling-3.0-video'), NOTHING, 'frames', 'Kling 3.0')).toBe('Optional. Set a first and last image.');
    expect(hint(sidesOf(production, 'hailuo-2.3'), NOTHING, 'frames', 'Hailuo 2.3')).toBe('Hailuo 2.3 needs a first image to start from.');
  });

  it('counts the pictures on the references side, and asks a remix to make them its own', () => {
    expect(hint(seedance, { ...NOTHING, pictures: 3 }, 'references', 'Seedance 2.5'))
      .toBe('Type @ in the prompt, or tap a handle, to use a reference. 3 of 30.');
    expect(hint(sidesOf(production, 'seedance-2-mini'), { ...NOTHING, pictures: 2 }, 'references', 'Seedance 2 Mini', { remixPictures: 2 }))
      .toBe('Replace the photos to make it yours. Each keeps its @handle, so the prompt still works. 2 of 5.');
  });

  it('counts against a count the kinds share, as the run is checked', () => {
    expect(hint(sidesOf(production, 'wan-2.7'), { ...NOTHING, pictures: 2, clips: 1 }, 'references', 'Wan 2.7'))
      .toBe('Type @ in the prompt, or tap a handle, to use a reference. 3 of 5 in all.');
    expect(hint(sidesOf(production, 'gemini-omni-video'), { ...NOTHING, pictures: 1, clips: 1, characters: 1 }, 'references', 'Gemini Omni'))
      .toBe('Type @ in the prompt, or tap a handle, to use a reference. 4 of 7 in all. A clip counts as two.');
  });

  it('says named subjects replace both sides for the run', () => {
    expect(hint(sidesOf(production, 'kling-o3'), { ...NOTHING, start: true }, 'frames', 'Kling O3', { subjectsHeld: true }))
      .toBe('Named subjects replace frames and references for this run.');
  });
});

describe('shortFileName', () => {
  it('keeps short names and the extension of long ones', () => {
    expect(shortFileName('start.jpg')).toBe('start.jpg');
    expect(shortFileName('a-very-long-name-without-any-extension-at-all')).toBe('a-very-long-name-withou…');
    expect(shortFileName('IMG_20261028_235959_HDR_portrait.jpeg', 20)).toBe('IMG_20261028_2….jpeg');
  });
});
