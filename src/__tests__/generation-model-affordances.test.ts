import { describe, expect, it } from 'vitest';

import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { videoInputSides } from '@/lib/creator-video-inputs';
import { getImageInputAffordances, getVideoInputAffordances, getVideoRunAffordances } from '@/lib/generation-model-affordances';
import { VIDEO_MODELS, type VideoModelId } from '@/lib/models';

/**
 * The create surfaces derive every capability gate from the catalog descriptor, falling
 * back to the old hardcoded tables only until the catalog loads. Both paths must answer
 * the same question the same way — otherwise the UI changes shape mid-session, and the
 * per-model tables the fallback still carries could rot unnoticed.
 */

const catalog = buildGenerationModelCatalog({ platform: 'web', schemaVersion: 2 });
const videoModelIds = Object.keys(VIDEO_MODELS) as VideoModelId[];

function descriptorFor(modelId: string) {
  return catalog.models.find((model) => model.id === modelId);
}

describe('descriptor-driven affordances', () => {
  it.each(videoModelIds)('%s: descriptor and fallback agree on reference capacity', (modelId) => {
    // Veo only permits references in its lite/fast modes; ask both paths the same way.
    const settings = { referenceMode: 'elements', mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };
    const fromDescriptor = getVideoInputAffordances(descriptorFor(modelId), modelId, settings);
    const fromFallback = getVideoInputAffordances(null, modelId, settings);

    expect(fromDescriptor.descriptorDriven).toBe(true);
    expect(fromFallback.descriptorDriven).toBe(false);
    expect(fromDescriptor.elements.enabled, `${modelId} elements.enabled`).toBe(fromFallback.elements.enabled);
    expect(fromDescriptor.elements.maxTotal, `${modelId} elements.maxTotal`).toBe(fromFallback.elements.maxTotal);
    expect(fromDescriptor.elements.maxNamed, `${modelId} elements.maxNamed`).toBe(fromFallback.elements.maxNamed);
    expect(fromDescriptor.referenceVideos.max, `${modelId} referenceVideos`).toBe(fromFallback.referenceVideos.max);
    expect(fromDescriptor.referenceAudios.max, `${modelId} referenceAudios`).toBe(fromFallback.referenceAudios.max);
    expect(fromDescriptor.frames.end, `${modelId} frames.end`).toBe(fromFallback.frames.end);
    expect(fromDescriptor.frames.startRequired, `${modelId} startRequired`).toBe(fromFallback.frames.startRequired);
    expect(fromDescriptor.namedVideoElements.enabled, `${modelId} namedVideoElements`).toBe(fromFallback.namedVideoElements.enabled);
  });

  it.each(videoModelIds)('%s: reference capacity is reachable from the default state', (modelId) => {
    // The create surfaces open in the frames shape with nothing attached. Reading capacity
    // off the slots active for *that* shape reported zero for every model whose references
    // sit behind a condition, and the control that satisfied the condition was itself gated
    // on the capacity — so the references were unreachable in a fresh session. Capacity must
    // answer "can this model take references at all", independent of what is attached now.
    const settings = { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };
    const fresh = getVideoInputAffordances(descriptorFor(modelId), modelId, { ...settings, referenceMode: 'frames' });
    const engaged = getVideoInputAffordances(descriptorFor(modelId), modelId, { ...settings, referenceMode: 'elements' });

    expect(fresh.elements.enabled, `${modelId} elements.enabled`).toBe(engaged.elements.enabled);
    expect(fresh.elements.maxTotal, `${modelId} elements.maxTotal`).toBe(engaged.elements.maxTotal);
    expect(fresh.referenceVideos.max, `${modelId} referenceVideos.max`).toBe(engaged.referenceVideos.max);
    expect(fresh.referenceAudios.max, `${modelId} referenceAudios.max`).toBe(engaged.referenceAudios.max);
  });

  it.each(videoModelIds)('%s: with a reference attached, a frames run means the model takes none', (modelId) => {
    // Asked for 'elements', the answer is 'frames' only for a model, a mode or a
    // multi-shot run that takes no reusable references. The page leans on that. A
    // prompt that mentions a saved reference the run cannot use gets one answer, which
    // names the mention, and none that tells the creator to change the run's shape:
    // there is nothing to change it with, since the shape is read off what is attached.
    const modes = [undefined, ...VIDEO_MODELS[modelId].modeOptions.map((option) => option.value)];
    for (const descriptor of [descriptorFor(modelId), null]) {
      for (const mode of modes) {
        for (const isMultiShot of [false, true]) {
          const affordances = getVideoInputAffordances(descriptor, modelId, { referenceMode: 'elements', mode, isMultiShot });
          if (affordances.activeMode === 'frames') {
            expect(
              affordances.elements.enabled,
              `${modelId} from the ${descriptor ? 'descriptor' : 'built-in table'}, mode ${mode ?? 'not set'}, ${isMultiShot ? 'multi-shot' : 'single-shot'}`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it.each(videoModelIds)('%s: asked for a references run, the descriptor and the built-in table give the same shape', (modelId) => {
    // The browser keeps a creator's references when the model changes, so the question
    // "a references run, please" reaches models that take no reference at all. The
    // built-in table has always answered 'frames' there. The descriptor path echoed the
    // question back (2026-10-03): Kling 3.0, Kling 3.0 Turbo and Hailuo 2.3 became
    // references runs with no slot for a reference, and the price quote refused them.
    // The capacity test above compared the two sources on everything but the shape.
    const settings = { referenceMode: 'elements', mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };

    expect(getVideoInputAffordances(descriptorFor(modelId), modelId, settings).activeMode)
      .toBe(getVideoInputAffordances(null, modelId, settings).activeMode);
  });

  it.each(videoModelIds)('%s: a references run is given only where the run has a slot for a reference', (modelId) => {
    // Each source against its own capacity, in every mode and every shot shape the
    // model has: a model with frame slots is in the references shape only while it
    // can hold an image, a clip or a track. A model with no frame slot has one shape.
    const modes = [undefined, ...VIDEO_MODELS[modelId].modeOptions.map((option) => option.value)];
    const shotShapes = VIDEO_MODELS[modelId].supportsMultiShot ? [false, true] : [false];
    for (const descriptor of [descriptorFor(modelId), null]) {
      for (const mode of modes) {
        for (const isMultiShot of shotShapes) {
          const affordances = getVideoInputAffordances(descriptor, modelId, { referenceMode: 'elements', mode, isMultiShot });
          const takesAReference = affordances.elements.enabled
            || affordances.referenceVideos.max > 0
            || affordances.referenceAudios.max > 0;
          const hasFrameSlots = affordances.frames.start || affordances.frames.end;

          expect(
            affordances.activeMode,
            `${modelId} from the ${descriptor ? 'descriptor' : 'built-in table'}, mode ${mode ?? 'not set'}, ${isMultiShot ? 'multi-shot' : 'single-shot'}`,
          ).toBe(takesAReference || !hasFrameSlots ? 'elements' : 'frames');
        }
      }
    }
  });

  describe('the run a draft makes on a model', () => {
    // What a draft can hold: the kinds of reference the video creator saves in the
    // browser, each alone and all three at once.
    const drafts = [
      { name: 'two images', held: { images: 2, videos: 0, audios: 0 } },
      { name: 'a clip', held: { images: 0, videos: 1, audios: 0 } },
      { name: 'a track', held: { images: 0, videos: 0, audios: 1 } },
      { name: 'images, a clip and a track', held: { images: 2, videos: 1, audios: 1 } },
    ];
    const sources = [
      { name: 'the descriptor', descriptorOf: descriptorFor },
      { name: 'the built-in table', descriptorOf: () => null },
    ];

    it.each(videoModelIds)('%s: carries only the references the model has a slot for', (modelId) => {
      const settings = { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined };
      // Whether the model has a frame slot is read from its descriptor for both sources:
      // the built-in table lists a start frame for every model, Gemini Omni included.
      const { frames } = getVideoInputAffordances(descriptorFor(modelId), modelId, settings);
      const hasFrameSlots = frames.start || frames.end;
      for (const source of sources) {
        const capacity = getVideoInputAffordances(source.descriptorOf(modelId), modelId, settings);
        for (const draft of drafts) {
          const run = getVideoRunAffordances(source.descriptorOf(modelId), modelId, settings, draft.held);
          const where = `${modelId} from ${source.name}, a draft with ${draft.name}`;

          expect(run.carries.images, `${where}: images`).toBe(draft.held.images > 0 && capacity.elements.enabled);
          expect(run.carries.videos, `${where}: clips`).toBe(draft.held.videos > 0 && capacity.referenceVideos.max > 0);
          expect(run.carries.audios, `${where}: tracks`).toBe(draft.held.audios > 0 && capacity.referenceAudios.max > 0);
          // The shape follows what is carried, never what is merely held.
          const carriesAReference = run.carries.images || run.carries.videos || run.carries.audios;
          expect(run.activeMode, `${where}: shape`).toBe(carriesAReference || !hasFrameSlots ? 'elements' : 'frames');
        }
      }
    });

    it('checks that rule against models of every kind', () => {
      // A model list with no model that takes nothing, or none that takes everything,
      // would let the test above pass without proving anything.
      const takes = (modelId: VideoModelId) => {
        const capacity = getVideoInputAffordances(descriptorFor(modelId), modelId, { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined });
        return `${capacity.elements.enabled ? 'images' : '-'} ${capacity.referenceVideos.max > 0 ? 'clips' : '-'} ${capacity.referenceAudios.max > 0 ? 'tracks' : '-'}`;
      };

      expect(videoModelIds.filter((modelId) => takes(modelId) === '- - -').sort())
        .toEqual(['hailuo-2.3', 'kling-3.0-turbo', 'kling-3.0-video']);
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images - -')).toEqual(expect.arrayContaining(['seedance-1.5-pro', 'kling-o3', 'veo-3.1']));
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images clips -')).toEqual(['gemini-omni-video', 'gemini-omni-1.1-flash']);
      expect(videoModelIds.filter((modelId) => takes(modelId) === 'images clips tracks')).toEqual(expect.arrayContaining(['seedance-2', 'wan-2.7', 'minimax-h3']));
    });

    it('makes a frames run of saved images on the models that take none', () => {
      // The reported case. Two images saved on Seedance 2, then a model with frame slots
      // and no slot for a reference: the run is the one the page makes with nothing saved.
      for (const modelId of ['kling-3.0-video', 'kling-3.0-turbo', 'hailuo-2.3'] as const) {
        const { carries, ...run } = getVideoRunAffordances(descriptorFor(modelId), modelId, {}, { images: 2, videos: 0, audios: 0 });

        expect(carries, modelId).toEqual({ images: false, videos: false, audios: false });
        expect(run, modelId).toEqual(getVideoInputAffordances(descriptorFor(modelId), modelId, { referenceMode: 'frames' }));
        expect(run.activeMode, modelId).toBe('frames');
      }
    });

    it('leaves a saved clip and track out of a run on a model that takes images only', () => {
      // Seedance 1.5 Pro takes two images and no clip. A clip saved on Seedance 2 made its
      // run a references run, greyed its frames out, and was counted by the quote.
      const clipOnly = getVideoRunAffordances(descriptorFor('seedance-1.5-pro'), 'seedance-1.5-pro', {}, { images: 0, videos: 1, audios: 1 });
      expect(clipOnly.carries).toEqual({ images: false, videos: false, audios: false });
      expect(clipOnly.activeMode).toBe('frames');

      const withImages = getVideoRunAffordances(descriptorFor('seedance-1.5-pro'), 'seedance-1.5-pro', {}, { images: 2, videos: 1, audios: 1 });
      expect(withImages.carries).toEqual({ images: true, videos: false, audios: false });
      expect(withImages.activeMode).toBe('elements');
    });

    it('leaves a saved track out of a Gemini Omni run, which takes images and a clip', () => {
      const run = getVideoRunAffordances(descriptorFor('gemini-omni-video'), 'gemini-omni-video', {}, { images: 1, videos: 1, audios: 1 });
      expect(run.carries).toEqual({ images: true, videos: true, audios: false });
      // No frame slot, so one shape whatever it holds.
      expect(run.activeMode).toBe('elements');
      expect(getVideoRunAffordances(descriptorFor('gemini-omni-video'), 'gemini-omni-video', {}, { images: 0, videos: 0, audios: 0 }).activeMode).toBe('elements');
    });

    it('carries everything on a model that takes everything, and combines a frame on Wan 2.7', () => {
      const seedance = getVideoRunAffordances(descriptorFor('seedance-2'), 'seedance-2', {}, { images: 2, videos: 1, audios: 1 });
      expect(seedance.carries).toEqual({ images: true, videos: true, audios: true });
      expect(seedance.activeMode).toBe('elements');

      const wan = getVideoRunAffordances(descriptorFor('wan-2.7'), 'wan-2.7', {}, { images: 0, videos: 1, audios: 0 });
      expect(wan.activeMode).toBe('elements');
      expect(wan.combineFramesWithReferences).toBe(true);
    });

    it('is a frames run while the draft holds nothing', () => {
      for (const modelId of ['seedance-2', 'kling-o3', 'wan-2.7', 'veo-3.1'] as const) {
        const run = getVideoRunAffordances(descriptorFor(modelId), modelId, { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined }, { images: 0, videos: 0, audios: 0 });
        expect(run.activeMode, modelId).toBe('frames');
        expect(run.combineFramesWithReferences, modelId).toBe(false);
      }
    });

    it('carries nothing into a multi-shot run on a model that takes references in single-shot only', () => {
      // Multi-shot takes no reusable reference on any model but Kling O3. The creator
      // page offers Seedance 2 no multi-shot run; asked for one here, it shows the rule.
      const run = getVideoRunAffordances(descriptorFor('seedance-2'), 'seedance-2', { isMultiShot: true }, { images: 2, videos: 1, audios: 1 });
      expect(run.carries).toEqual({ images: false, videos: false, audios: false });
      expect(run.activeMode).toBe('frames');
    });
  });

  it('reports Seedance 2.5 reference slots with nothing attached', () => {
    // The reported case: the model publishes its image, video and audio reference slots
    // and the page rendered none of them. The counts track Kie's schema for
    // bytedance/seedance-2-5 (reference_image_urls maxItems 30, video and audio 10).
    const fresh = getVideoInputAffordances(descriptorFor('seedance-2-5'), 'seedance-2-5', { referenceMode: 'frames' });
    expect(fresh.elements.enabled).toBe(true);
    expect(fresh.elements.maxTotal).toBe(30);
    expect(fresh.referenceVideos.max).toBe(10);
    expect(fresh.referenceAudios.max).toBe(10);
    // Ten slots, still thirty seconds of usable footage.
    expect(fresh.referenceVideos.maxDurationSeconds).toBe(30);
  });

  it('keeps a start image beside the references only where the provider takes both, by the flag the run reads', () => {
    // Verified against Kie's live model docs. Seedance sends every field to one endpoint but
    // documents the two as mutually exclusive scenarios; minimax-h3 and kling-o3 route
    // references to an endpoint carrying no frame field; wan-2.7's r2v takes `first_frame`
    // alongside `reference_image` and `reference_video`. The creator's switch keeps that start
    // image on its references side, read off `combineFramesWithReferences` as the run is.
    // `null` asks the built-in tables (an `undefined` here would take the default, the descriptor).
    const beside = (modelId: VideoModelId, descriptor: ReturnType<typeof descriptorFor> | null = descriptorFor(modelId)) => getVideoInputAffordances(
      descriptor,
      modelId,
      { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined },
    ).inputChoice.startBesideReferences;

    expect(videoModelIds.filter((modelId) => beside(modelId))).toEqual(['wan-2.7']);
    expect(videoModelIds.filter((modelId) => beside(modelId, null))).toEqual(['wan-2.7']);
    const wan = descriptorFor('wan-2.7')!;
    expect(beside('wan-2.7', { ...wan, inputs: { ...wan.inputs, combineFramesWithReferences: false } })).toBe(false);
  });

  it('reads the count the references share off the descriptor, as the fallback does', () => {
    // Wan 2.7 takes five references in all, of any kind; Gemini Omni seven slots, a clip
    // taking two. The creator counts against these, as the run is checked.
    const budget = (modelId: VideoModelId, descriptor: ReturnType<typeof descriptorFor> | null = descriptorFor(modelId)) => getVideoInputAffordances(
      descriptor,
      modelId,
      {},
    ).inputChoice.referencesBudget;

    expect(budget('wan-2.7')).toEqual({ max: 5, weights: { pictures: 1, clips: 1, tracks: 1, characters: 0 } });
    expect(budget('gemini-omni-video')).toEqual({ max: 7, weights: { pictures: 1, clips: 2, tracks: 0, characters: 1 } });
    expect(budget('gemini-omni-1.1-flash')).toEqual({ max: 7, weights: { pictures: 1, clips: 2, tracks: 0, characters: 0 } });
    expect(budget('seedance-2-5')).toBeNull();
    for (const modelId of videoModelIds) {
      expect(budget(modelId, null), modelId).toEqual(budget(modelId));
    }
  });

  it('answers for a model the built-in tables do not know, before the catalog arrives', () => {
    // A link can name any model (`/create-video?model=…`). Reading the switch off the tables
    // threw for one they lack, and the creator drew nothing.
    const affordances = getVideoInputAffordances(null, 'not-a-model' as VideoModelId, {});
    expect(affordances.inputChoice).toEqual({ labels: null, startBesideReferences: false, referencesBudget: null });
  });

  it('caps Kling O3 named subjects below its total reference capacity', () => {
    const affordances = getVideoInputAffordances(descriptorFor('kling-o3'), 'kling-o3', { referenceMode: 'elements' });
    expect(affordances.elements.maxTotal).toBe(7);
    expect(affordances.elements.maxNamed).toBe(3);
  });

  it('offers named subjects on exactly the models whose descriptor publishes a subjects mode', () => {
    // The native creator reads the same slot, so the two cannot disagree about which
    // models take subjects. The fallback table answers the same way before the catalog loads.
    for (const modelId of videoModelIds) {
      const publishesSubjects = (descriptorFor(modelId)?.inputModes ?? []).some((mode) => mode.key === 'subjects');
      const fromDescriptor = getVideoInputAffordances(descriptorFor(modelId), modelId, {});
      const fromFallback = getVideoInputAffordances(null, modelId, {});
      expect(fromDescriptor.subjects.enabled, `${modelId} subjects from the descriptor`).toBe(publishesSubjects);
      expect(fromFallback.subjects.enabled, `${modelId} subjects from the fallback`).toBe(publishesSubjects);
    }
    const o3 = getVideoInputAffordances(descriptorFor('kling-o3'), 'kling-o3', {}).subjects;
    expect(o3).toEqual({ enabled: true, maxImages: 12, maxNamed: 3, imagesPerSubject: { min: 2, max: 4 } });
    expect(getVideoInputAffordances(descriptorFor('seedance-2'), 'seedance-2', {}).subjects.enabled).toBe(false);
  });

  it('keeps Kling O3 references across multi-shot and drops them elsewhere', () => {
    const o3 = getVideoInputAffordances(descriptorFor('kling-o3'), 'kling-o3', { referenceMode: 'elements', isMultiShot: true });
    const seedance = getVideoInputAffordances(descriptorFor('seedance-2'), 'seedance-2', { referenceMode: 'elements', isMultiShot: true });
    expect(o3.elements.enabled).toBe(true);
    expect(seedance.elements.enabled).toBe(false);
    expect(seedance.elements.disabledReason).toContain('single-shot');
  });

  it('keeps Kling video elements available in frames mode', () => {
    // The slot has its own always-active mode, so attaching an element never depends on
    // a reference-mode toggle this surface does not show for Kling.
    const affordances = getVideoInputAffordances(descriptorFor('kling-3.0-video'), 'kling-3.0-video', { referenceMode: 'frames' });
    expect(affordances.namedVideoElements.enabled).toBe(true);
    expect(affordances.namedVideoElements.max).toBe(3);
  });

  it('surfaces wan-2.7 frame-and-reference combining from the descriptor', () => {
    const combined = getVideoInputAffordances(descriptorFor('wan-2.7'), 'wan-2.7', { referenceMode: 'elements' });
    const framesOnly = getVideoInputAffordances(descriptorFor('wan-2.7'), 'wan-2.7', { referenceMode: 'frames' });
    expect(combined.combineFramesWithReferences).toBe(true);
    expect(framesOnly.combineFramesWithReferences).toBe(false);
  });

  it('carries constraint copy from the descriptor rather than hardcoded strings', () => {
    const affordances = getVideoInputAffordances(descriptorFor('seedance-2-5'), 'seedance-2-5', { referenceMode: 'elements' });
    const combined = affordances.activeConstraints.find((constraint) => constraint.type === 'combined-duration');
    expect(combined?.max).toBe(30);
    expect(combined?.message).toContain('30 seconds');
  });

  it('hides a resolution control that offers only one value', () => {
    // A single-option control is a fixed value, not a choice worth rendering.
    const singleOption = getImageInputAffordances(descriptorFor('imagen-4'));
    const multiOption = getImageInputAffordances(descriptorFor('nano-banana-2'));
    expect(singleOption?.showResolutionControl).toBe(false);
    expect(multiOption?.showResolutionControl).toBe(true);
  });

  it.each(videoModelIds)('%s: descriptor and fallback draw the same inputs card in every mode', (modelId) => {
    // The creator draws the card from the fallback before the catalog arrives and from the
    // descriptor after, so the two must draw the same sides, or the card changes shape as the
    // catalog lands. Every mode is asked: Veo 3.1 takes reference pictures in Lite and Fast only.
    // (Production's release still offers them in Quality too, where the quote refuses them: a
    // catalog fix, `archive/creator-page-build-2026-10-28/pr4/kie-audit.md`.) The page always
    // asks with the mode chosen, so a model with modes is asked in each of them.
    const options = VIDEO_MODELS[modelId].modeOptions.map((option) => option.value);
    const modes = options.length > 0 ? options : [undefined];
    for (const mode of modes) {
      for (const isMultiShot of [false, true]) {
        const sides = (descriptor: ReturnType<typeof descriptorFor>) => videoInputSides(
          getVideoInputAffordances(descriptor, modelId, { mode, isMultiShot }),
          { isMultiShot },
        );
        const fromFallback = sides(undefined);
        const fromDescriptor = sides(descriptorFor(modelId));
        if (modelId === 'veo-3.1' && mode === 'veo3' && !isMultiShot) {
          // The one known gap, pinned so that its catalog fix shows here: the descriptor offers
          // Quality the pictures Kie's REFERENCE_2_VIDEO takes in Lite and Fast only, which the
          // quote refuses ("Reusable references require Veo Lite or Fast."). The tables do not.
          expect(fromFallback.references).toBeNull();
          expect(fromDescriptor.references?.pictures).toBe(3);
          continue;
        }
        expect(fromFallback, `${modelId} ${mode ?? 'default mode'}${isMultiShot ? ', multi-shot' : ''}`).toEqual(fromDescriptor);
      }
    }
  });

  it.each(videoModelIds)('%s: the switch is offered exactly where the catalog publishes its referenceMode control', (modelId) => {
    const descriptor = descriptorFor(modelId);
    const published = Boolean(descriptor?.controls.some((control) => control.key === 'referenceMode'));
    const affordances = getVideoInputAffordances(descriptor, modelId, { mode: modelId === 'veo-3.1' ? 'veo3_fast' : undefined });
    const bothSides = (affordances.frames.start || affordances.frames.end) && affordances.elements.enabled;
    expect(affordances.inputChoice.labels !== null, `${modelId} labels`).toBe(published);
    expect(bothSides, `${modelId} has both sides`).toBe(published);
  });

  it('names the switch’s options in the control’s own words', () => {
    expect(getVideoInputAffordances(descriptorFor('seedance-2-5'), 'seedance-2-5', {}).inputChoice.labels)
      .toEqual({ frames: 'Frames', references: 'References' });
    expect(getVideoInputAffordances(descriptorFor('kling-3.0-video'), 'kling-3.0-video', {}).inputChoice.labels).toBeNull();
  });

  it('reports the required character reference on ideogram-character', () => {
    const affordances = getImageInputAffordances(descriptorFor('ideogram-character'));
    // Kie's ideogram/character endpoint uses only the first reference image
    // ("rest will be ignored"), so the app stops collecting extras.
    expect(affordances?.references.max).toBe(1);
  });
});
