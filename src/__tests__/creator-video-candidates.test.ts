import { describe, expect, it } from 'vitest';

import {
  fitVideoFormToModel,
  takesSameVideoInputs,
  videoFitControls,
  videoRunInputTally,
  videoRunOnModel,
  type VideoFormHeld,
  type VideoFormSettings,
} from '@/lib/creator-video-candidates';
import { VIDEO_MODELS } from '@/lib/client-generation-models';
import type { VideoRunMedia } from '@/lib/creator-run-inputs';
import { buildGenerationModelCatalog } from '@/lib/generation-model-catalog';
import { applyGenerationModelCatalogToRegistries } from '@/lib/generation-model-client';

/**
 * The video run moved to another model: what the model list prices, what a fitted remix
 * opens on and what picking a model sets. The registry here holds the code catalog's
 * descriptors, as a page holds the published ones once their details are in.
 */
applyGenerationModelCatalogToRegistries(buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 }));

type Media = VideoRunMedia & { imageReference: { id: string }; reference: { id: string; durationSeconds: number | null } };

const miniForm: VideoFormSettings = {
  mode: '', aspectRatio: '9:16', resolution: '480p', duration: 5, sound: false, fixedLens: false, isMultiShot: false,
};
const held = (overrides: Partial<VideoFormHeld<Media>> = {}): VideoFormHeld<Media> => ({
  imageReferences: [],
  videoReferences: [],
  audioReferences: [],
  videoElements: [],
  subjects: [],
  hasStartFrame: false,
  hasEndFrame: false,
  preparedVoiceIds: [],
  characterIds: [],
  multiShotSeconds: 0,
  ...overrides,
});
const twoPictures = held({ imageReferences: [{ id: 'ref-1' }, { id: 'ref-2' }] });

describe('the video run moved to another model', () => {
  it('reads a model\'s settings off its descriptor once its details are in', () => {
    expect(videoFitControls('seedance-2-mini').find((control) => control.key === 'duration'))
      .toMatchObject({ type: 'integer', min: 4, max: 15 });
    expect(videoFitControls('not-a-model')).toEqual([]);
  });

  // A model the catalog lists before its details are in has a placeholder entry with no
  // ratios or resolutions (`seedCatalogSummaryRegistry`): picked then, it keeps the form's.
  it('keeps the form\'s ratio on a placeholder model that lists none yet', () => {
    const registry = VIDEO_MODELS as unknown as Record<string, unknown>;
    registry['placeholder-video'] = {
      ...VIDEO_MODELS['seedance-2-mini'], catalogDescriptor: undefined, aspectRatios: [], resolutions: [], durations: [5], modeOptions: [],
    };
    try {
      expect(fitVideoFormToModel('placeholder-video', miniForm)).toMatchObject({ aspectRatio: miniForm.aspectRatio, resolution: '', duration: 5 });
    } finally {
      delete registry['placeholder-video'];
    }
  });

  it('keeps the settings the model offers and moves the length to the nearest it makes', () => {
    expect(fitVideoFormToModel('seedance-1.5-pro', { ...miniForm, sound: true }))
      .toEqual({ ...miniForm, duration: 4, sound: true });
    expect(fitVideoFormToModel('kling-3.0-video', { ...miniForm, aspectRatio: '4:3', duration: 20 }))
      .toMatchObject({ aspectRatio: '16:9', duration: 15, resolution: '', mode: 'std' });
  });

  it('prices the run as the page asks for it: its settings, its references, and what the price is for', () => {
    const run = videoRunOnModel<Media>({ modelId: 'seedance-2-mini', catalogRevision: 'rev-1', settings: fitVideoFormToModel('seedance-2-mini', miniForm), held: twoPictures });
    expect(run?.quoteInput).toEqual({
      schemaVersion: 2,
      kind: 'video',
      modelId: 'seedance-2-mini',
      settings: {
        duration: 5, mode: '', aspectRatio: '9:16', sound: false, resolution: '480p', fixedLens: false, isMultiShot: false, referenceMode: 'elements',
      },
      inputCounts: { images: 2, videos: 0, audios: 0, preparedAudios: 0, characters: 0 },
      inputMetadata: { slots: { imageReferences: { count: 2 } }, referenceVideoDurationsSeconds: [] },
      catalogRevision: 'rev-1',
    });
    expect(run?.summary).toBe('480P · 5s');
    expect(videoRunInputTally(run?.inputs ?? [])).toEqual({ references: 2, frames: 0 });
  });

  it('cuts references to what a model takes, and leaves out a kind it has no place for', () => {
    const three = held({ imageReferences: [{ id: 'ref-1' }, { id: 'ref-2' }, { id: 'ref-3' }] });
    const onPro = videoRunOnModel<Media>({ modelId: 'seedance-1.5-pro', catalogRevision: 'rev-1', settings: fitVideoFormToModel('seedance-1.5-pro', miniForm), held: three });
    expect(videoRunInputTally(onPro?.inputs ?? []).references).toBe(2);
    expect(onPro?.summary).toBe('480P · 4s');

    const onKling = videoRunOnModel<Media>({ modelId: 'kling-3.0-video', catalogRevision: 'rev-1', settings: fitVideoFormToModel('kling-3.0-video', miniForm), held: three });
    expect(videoRunInputTally(onKling?.inputs ?? []).references).toBe(0);
    expect(onKling?.quoteInput.settings).toMatchObject({ referenceMode: 'frames', mode: 'std' });
    expect(onKling?.summary).toBe('720P · 5s');
  });

  it('tells a model that takes everything the original sends from one that does not', () => {
    const run = (modelId: string, form = miniForm, from = twoPictures) => {
      const moved = videoRunOnModel<Media>({ modelId, catalogRevision: 'rev-1', settings: fitVideoFormToModel(modelId, form), held: from });
      if (!moved) throw new Error(`no run on ${modelId}`);
      return moved;
    };
    const original = run('seedance-2-5');
    expect(takesSameVideoInputs(original, run('seedance-2-mini'))).toBe(true);
    expect(takesSameVideoInputs(original, run('seedance-1.5-pro'))).toBe(true);
    expect(takesSameVideoInputs(original, run('kling-3.0-video'))).toBe(false);

    const withSound = run('seedance-2-5', { ...miniForm, sound: true });
    expect(takesSameVideoInputs(withSound, run('seedance-2-mini', { ...miniForm, sound: true }))).toBe(true);
    expect(takesSameVideoInputs(withSound, run('wan-2.7', { ...miniForm, sound: true }))).toBe(false);

    // A clip the original's model takes but another's published minimum holds (Wan 3.0 takes 1 s and up,
    // Seedance 2 Mini 2 s): fitted there, the run would be held as soon as the page moved.
    const shortClip = held({ videoReferences: [{ id: 'clip-1', durationSeconds: 1.4 }] });
    const onWan = run('wan-3.0', miniForm, shortClip);
    expect(takesSameVideoInputs(onWan, run('wan-3.0-prime', miniForm, shortClip))).toBe(true);
    expect(takesSameVideoInputs(onWan, run('seedance-2-mini', miniForm, shortClip))).toBe(false);
    expect(takesSameVideoInputs(onWan, run('seedance-2-mini', miniForm, held({ videoReferences: [{ id: 'clip-1', durationSeconds: 2.4 }] })))).toBe(true);

    const shots = run('kling-3.0-video', { ...miniForm, isMultiShot: true }, held({ multiShotSeconds: 9 }));
    expect(shots.durationSeconds).toBe(9);
    expect(takesSameVideoInputs(shots, run('kling-o3', { ...miniForm, isMultiShot: true }, held({ multiShotSeconds: 9 })))).toBe(true);
    expect(takesSameVideoInputs(shots, run('seedance-2-mini', { ...miniForm, isMultiShot: true }, held({ multiShotSeconds: 9 })))).toBe(false);
  });
});
