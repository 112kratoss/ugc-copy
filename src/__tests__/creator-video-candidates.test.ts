import { describe, expect, it } from 'vitest';

import {
  fitVideoFormToModel,
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
 * The video run moved to another model: what the model list prices and what picking a
 * model sets. The registry here holds the code catalog's descriptors, as a page holds the
 * published ones once their details are in.
 */
applyGenerationModelCatalogToRegistries(buildGenerationModelCatalog({ platform: 'web', schemaVersion: 3 }));

type Media = VideoRunMedia & { imageReference: { id: string }; reference: { id: string } };

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

  // A model's row prices a multi-shot run at its shots' whole length, not the single shot's.
  it('prices a multi-shot run on another model at its shots together', () => {
    const shots = videoRunOnModel<Media>({
      modelId: 'kling-3.0-video',
      catalogRevision: 'rev-1',
      settings: fitVideoFormToModel('kling-3.0-video', { ...miniForm, isMultiShot: true }),
      held: held({ multiShotSeconds: 9 }),
    });
    expect(shots?.quoteInput.settings).toMatchObject({ duration: 9, isMultiShot: true });
  });
});
