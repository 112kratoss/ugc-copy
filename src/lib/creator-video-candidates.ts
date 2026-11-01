import {
  fitSettingsToControls,
  type FitControl,
} from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import { videoRunShortSummary } from '../../ugc-mobile/lib/creator-settings-summary/creator-settings-summary';
import { catalogRunQuoteInput, SUBJECT_IMAGES_SLOT_KEY } from '../../ugc-mobile/lib/model-catalog/protocol';
import { VIDEO_MODELS, type VideoModelId } from '@/lib/client-generation-models';
import { planVideoRunInputs, type VideoRunInput, type VideoRunMedia, type VideoRunSubject } from '@/lib/creator-run-inputs';
import { getVideoRunAffordances } from '@/lib/generation-model-affordances';
import type { GenerationModelDescriptor, GenerationModelQuoteInput } from '@/lib/generation-model-catalog';

/**
 * The video creator's run moved to another model: what the model list prices each model
 * at, and what picking a model sets. One reading of the form for both, the page's own:
 * the settings carried over by the shared fitting rule (`fitSettingsToControls`), then
 * the inputs the model takes read off its descriptor (`getVideoRunAffordances`,
 * `planVideoRunInputs`) as the page reads them for the run it sends, so the price on a
 * model's row is the price Generate shows once the creator is on it.
 */

export type VideoRegistryEntry = (typeof VIDEO_MODELS)[VideoModelId] & { catalogDescriptor?: GenerationModelDescriptor };

/**
 * Where a run reads its models: the page's registry, or on the server entries built from
 * the published catalog (`catalogVideoEntryFields`), which price a shelf post's remix on
 * each model as the page will once it opens.
 */
export type VideoModelLookup = (modelId: string) => VideoRegistryEntry | undefined;

/** The settings the video form sets, as the page holds them. */
export type VideoFormSettings = {
  mode: string;
  aspectRatio: string;
  resolution: string;
  /** A single shot's length. */
  duration: number;
  sound: boolean;
  fixedLens: boolean;
  isMultiShot: boolean;
};

/** What the form holds to send, whichever model it goes to. */
export type VideoFormHeld<M extends VideoRunMedia> = {
  imageReferences: readonly M['imageReference'][];
  videoReferences: readonly M['reference'][];
  audioReferences: readonly M['reference'][];
  /** Kling 3.0's named video elements. */
  videoElements: readonly M['videoElement'][];
  subjects: readonly VideoRunSubject<M>[];
  hasStartFrame: boolean;
  hasEndFrame: boolean;
  preparedVoiceIds: readonly string[];
  characterIds: readonly string[];
  /** A multi-shot run's length: its shots' together. */
  multiShotSeconds: number;
};

const REFERENCE_SLOTS = new Set(['imageReferences', 'videoReferences', 'audioReferences', 'videoElements', SUBJECT_IMAGES_SLOT_KEY]);

const pageModels: VideoModelLookup = (modelId) => (VIDEO_MODELS as unknown as Record<string, VideoRegistryEntry | undefined>)[modelId];

// As `getVideoDurationRange`, `getDefaultVideoDuration` and `isValidVideoDuration` read the page's registry.
export function durationRangeOf(entry: VideoRegistryEntry | undefined): { min: number; max: number; default: number } | null {
  return entry && 'singleShotDurationRange' in entry ? entry.singleShotDurationRange : null;
}

function defaultDurationOf(entry: VideoRegistryEntry | undefined): number {
  return durationRangeOf(entry)?.default ?? (entry?.durations[0] ?? 5);
}

/** Whether a model makes a single shot of this length: in its range, or among the lengths it lists. */
export function makesVideoLength(entry: VideoRegistryEntry, durationSeconds: number): boolean {
  const range = durationRangeOf(entry);
  return range
    ? durationSeconds >= range.min && durationSeconds <= range.max
    : (entry.durations as readonly number[]).includes(durationSeconds);
}

/** A model's settings as the fitting rule reads them: its descriptor's, or before that its options as the page draws them. */
export function videoFitControls(modelId: string, models: VideoModelLookup = pageModels): FitControl[] {
  const entry = models(modelId);
  if (!entry) return [];
  if (entry.catalogDescriptor) {
    return entry.catalogDescriptor.controls.map((control): FitControl => (
      control.type === 'choice'
        ? { key: control.key, type: 'choice', defaultValue: control.defaultValue, options: control.options }
        : control.type === 'integer'
          ? { key: control.key, type: 'integer', defaultValue: control.defaultValue, min: control.min, max: control.max, step: control.step }
          : { key: control.key, type: 'boolean', defaultValue: control.defaultValue }
    ));
  }
  // A setting a placeholder lists no options for (its details not in) is left to the
  // model's defaults, not given the value "undefined".
  const choice = (key: string, values: readonly (string | number)[], defaultValue = String(values[0])): FitControl[] => (
    values.length > 0 ? [{ key, type: 'choice', defaultValue, options: values.map((value) => ({ value: String(value) })) }] : []
  );
  const range = durationRangeOf(entry);
  return [
    ...choice('mode', entry.modeOptions.map((option) => option.value)),
    ...choice('aspectRatio', entry.aspectRatios),
    ...choice('resolution', entry.resolutions),
    ...(range
      ? [{ key: 'duration', type: 'integer', defaultValue: range.default, min: range.min, max: range.max, step: 1 } as const]
      : choice('duration', entry.durations, String(defaultDurationOf(entry)))),
    ...(entry.supportsSound ? [{ key: 'sound', type: 'boolean', defaultValue: false } as const] : []),
    ...(entry.supportsFixedLens ? [{ key: 'fixedLens', type: 'boolean', defaultValue: false } as const] : []),
    ...(entry.supportsMultiShot ? [{ key: 'isMultiShot', type: 'boolean', defaultValue: false } as const] : []),
  ];
}

/** The form's settings moved to a model (`fitSettingsToControls`), in the shape the page holds them. */
export function fitVideoFormToModel(modelId: string, form: VideoFormSettings, models: VideoModelLookup = pageModels): VideoFormSettings {
  const entry = models(modelId);
  const fitted = fitSettingsToControls(videoFitControls(modelId, models), form);
  const duration = Number(fitted.duration);
  return {
    mode: typeof fitted.mode === 'string' ? fitted.mode : '',
    aspectRatio: typeof fitted.aspectRatio === 'string' ? fitted.aspectRatio : String(entry?.aspectRatios[0] ?? form.aspectRatio),
    resolution: typeof fitted.resolution === 'string' ? fitted.resolution : '',
    duration: Number.isFinite(duration) ? duration : defaultDurationOf(entry),
    sound: fitted.sound === true,
    fixedLens: fitted.fixedLens === true,
    isMultiShot: fitted.isMultiShot === true,
  };
}

/** How many references and frames a run sends. */
export function videoRunInputTally(inputs: ReadonlyArray<{ slot: string }>): { references: number; frames: number } {
  return {
    references: inputs.filter((input) => REFERENCE_SLOTS.has(input.slot)).length,
    frames: inputs.filter((input) => input.slot === 'startFrame' || input.slot === 'endFrame').length,
  };
}

export type VideoRunOnModel<M extends VideoRunMedia> = {
  modelId: string;
  /** The settings the model opens on (what picking it sets). */
  settings: VideoFormSettings;
  /** The run's whole length: a multi-shot run's shots together. */
  durationSeconds: number;
  inputs: VideoRunInput<M>[];
  quoteInput: GenerationModelQuoteInput;
  /** What the price on the model's row is for: "480P · 5s". */
  summary: string;
};

/**
 * The run the form would send on `modelId` at `settings` (the form's moved to the model,
 * `fitVideoFormToModel`): the inputs the model takes (a kind it has no place for stays in
 * the draft, and a kind past the model's limit is cut to it, as the creator would have
 * to), and the quote request that prices it.
 */
export function videoRunOnModel<M extends VideoRunMedia>({
  modelId,
  catalogRevision,
  settings,
  held,
  models = pageModels,
}: {
  modelId: string;
  catalogRevision: string;
  settings: VideoFormSettings;
  held: VideoFormHeld<M>;
  models?: VideoModelLookup;
}): VideoRunOnModel<M> | null {
  const entry = models(modelId);
  if (!entry) return null;
  const { isMultiShot } = settings;
  const affordances = getVideoRunAffordances(
    entry.catalogDescriptor,
    modelId as VideoModelId,
    { mode: settings.mode, isMultiShot },
    {
      images: isMultiShot ? 0 : held.imageReferences.length,
      videos: held.videoReferences.length,
      audios: held.audioReferences.length,
    },
  );
  const subjectsActive = affordances.subjects.enabled && held.subjects.length > 0;
  const durationSeconds = isMultiShot
    ? held.multiShotSeconds
    : (modelId === 'veo-3.1' ? Number(entry.durations[0]) : settings.duration);
  const takesPreparedMedia = modelId === 'gemini-omni-video';
  const inputs = planVideoRunInputs<M>({
    activeReferenceMode: affordances.activeMode,
    combinesFrameWithReferences: affordances.combineFramesWithReferences,
    takesEndFrame: affordances.frames.end && !affordances.combineFramesWithReferences,
    isMultiShot,
    imageReferences: affordances.carries.images ? held.imageReferences.slice(0, affordances.elements.maxTotal) : [],
    videoReferences: affordances.carries.videos ? held.videoReferences.slice(0, affordances.referenceVideos.max) : [],
    audioReferences: affordances.carries.audios ? held.audioReferences.slice(0, affordances.referenceAudios.max) : [],
    videoElements: modelId === 'kling-3.0-video' ? held.videoElements : [],
    subjects: subjectsActive ? held.subjects : [],
    hasStartFrame: held.hasStartFrame,
    hasEndFrame: held.hasEndFrame,
    preparedVoiceIds: takesPreparedMedia ? held.preparedVoiceIds : [],
    characterIds: takesPreparedMedia ? held.characterIds : [],
  });
  // In the page's own order, so a run on the model in use asks the page's own question.
  const runSettings = {
    duration: durationSeconds,
    mode: settings.mode,
    aspectRatio: settings.aspectRatio,
    sound: entry.supportsSound ? settings.sound : false,
    resolution: settings.resolution,
    fixedLens: entry.supportsFixedLens ? settings.fixedLens : false,
    isMultiShot,
    referenceMode: subjectsActive ? 'subjects' : affordances.activeMode,
  };
  return {
    modelId,
    settings,
    durationSeconds,
    inputs,
    quoteInput: catalogRunQuoteInput({ kind: 'video' as const, modelId, catalogRevision, settings: runSettings, inputs }),
    summary: videoRunShortSummary({
      modeLabel: entry.modeOptions.find((option) => option.value === settings.mode)?.label ?? settings.mode,
      resolution: settings.resolution,
      durationSeconds,
    }),
  };
}
