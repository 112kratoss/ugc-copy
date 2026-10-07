import {
  getVideoElementSupport,
  getVideoReferenceSupport,
  type VideoModelId,
} from '@/lib/client-generation-models';
import type {
  CatalogCondition,
  CatalogInputConstraint,
  CatalogInputSlot,
  GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
import {
  SUBJECT_IMAGES_PER_NAME,
  SUBJECT_IMAGES_SLOT_KEY,
  subjectsPerRun,
} from '../../ugc-mobile/lib/model-catalog/protocol';

/**
 * What a selected model can actually do, derived from its catalog descriptor.
 *
 * The create surfaces used to answer this with per-model-id conditionals
 * (`isSeedance2Family`, `isWanVideoModel`, limit ternaries, hardcoded end-frame lists).
 * That is how three models shipped advertising reference support the UI never rendered:
 * the descriptor said one thing and a switch statement said another. Reading the
 * descriptor makes the two impossible to disagree.
 *
 * Type-only imports from the catalog module keep this browser-safe — no server registry
 * or pricing data is pulled into the bundle.
 */

export type AffordanceSettings = {
  referenceMode?: string;
  mode?: string;
  isMultiShot?: boolean;
};

export type VideoInputAffordances = {
  /** Which reference mode the descriptor actually honours for these settings. */
  activeMode: 'frames' | 'elements';
  /**
   * True when the provider cannot take frames and references in the same request, so the
   * two groups must disable each other rather than both accept attachments.
   *
   * Kie splits three ways here. Seedance sends every field to one endpoint but documents
   * frames and references as mutually exclusive scenarios; minimax-h3 and kling-o3 pick a
   * different endpoint per shape, so their reference endpoints have no frame field at all;
   * wan-2.7's r2v endpoint genuinely takes `first_frame` alongside `reference_image` and
   * `reference_video`. Only the last of those may show both groups live at once.
   */
  framesExcludeReferences: boolean;
  elements: {
    enabled: boolean;
    /** Total reference images that may be attached. */
    maxTotal: number;
    /** How many of those may carry a name. Equals maxTotal unless the model caps it. */
    maxNamed: number;
    disabledReason: string | null;
  };
  referenceVideos: { max: number; maxDurationSeconds: number | null };
  referenceAudios: { max: number };
  frames: { start: boolean; end: boolean; startRequired: boolean };
  /** True when a start frame may be attached alongside reusable references. */
  combineFramesWithReferences: boolean;
  /** Named video elements (Kling), which are a distinct slot from reference clips. */
  namedVideoElements: { enabled: boolean; max: number };
  /**
   * Named subjects: several pictures of one person or thing that the provider fuses
   * into one identity, mentioned in the prompt as @handle. Read off the descriptor's
   * `subjects` mode, which is how the native creator finds them too, so the editor
   * appears on exactly the models the catalog publishes it for.
   */
  subjects: {
    enabled: boolean;
    /** Pictures across every subject. */
    maxImages: number;
    /** Subjects per run. */
    maxNamed: number;
    imagesPerSubject: { min: number; max: number };
  };
  preparedAssets: { voices: number; characters: number } | null;
  /** Condition-filtered constraints; their `message` is the copy the UI should show. */
  activeConstraints: CatalogInputConstraint[];
  /** True when these values came from the descriptor rather than the fallback tables. */
  descriptorDriven: boolean;
};

type ConditionValue = string | number | boolean;

function conditionActualValue(
  condition: CatalogCondition,
  settings: Record<string, ConditionValue>,
): ConditionValue | undefined {
  // Only setting-sourced conditions are resolvable here; input-count conditions depend
  // on live attachment counts the caller evaluates itself.
  return condition.source === 'setting' ? settings[condition.key] : undefined;
}

/** Mirrors generationModelConditionMatches so client and server agree on activation. */
function conditionMatches(
  condition: CatalogCondition,
  settings: Record<string, ConditionValue>,
): boolean {
  const actual = conditionActualValue(condition, settings);
  const expected = condition.value;
  switch (condition.operator) {
    case 'equals':
      return actual === expected;
    case 'notEquals':
      return actual !== expected;
    case 'in':
      return Array.isArray(expected) && expected.includes(actual as never);
    case 'notIn':
      return Array.isArray(expected) && !expected.includes(actual as never);
    case 'greaterThan':
      return typeof actual === 'number' && typeof expected === 'number' && actual > expected;
    case 'greaterThanOrEqual':
      return typeof actual === 'number' && typeof expected === 'number' && actual >= expected;
    default:
      return true;
  }
}

function conditionsMatch(
  conditions: CatalogCondition[] | undefined,
  settings: Record<string, ConditionValue>,
): boolean {
  return !conditions || conditions.every((condition) => conditionMatches(condition, settings));
}

/** Slots active for the given settings, keyed by slot key. */
function activeSlots(
  descriptor: GenerationModelDescriptor,
  settings: Record<string, ConditionValue>,
): Map<string, CatalogInputSlot> {
  const active = new Map<string, CatalogInputSlot>();
  for (const mode of descriptor.inputModes ?? []) {
    if (!conditionsMatch(mode.conditions, settings)) continue;
    for (const slot of mode.slots) {
      if (!conditionsMatch(slot.conditions, settings)) continue;
      active.set(slot.key, slot);
    }
  }
  return active;
}

/** Every slot the model declares, regardless of the current settings. */
function declaredSlots(descriptor: GenerationModelDescriptor): Map<string, CatalogInputSlot> {
  const declared = new Map<string, CatalogInputSlot>();
  for (const mode of descriptor.inputModes ?? []) {
    for (const slot of mode.slots) declared.set(slot.key, slot);
  }
  return declared;
}

/**
 * Pre-catalog behaviour, preserved verbatim so first paint and offline are unchanged.
 * These tables are the last remaining per-model hardcodes; once a descriptor is present
 * it wins.
 */
function legacyFallbackAffordances(
  modelId: VideoModelId,
  settings: AffordanceSettings,
): VideoInputAffordances {
  const support = getVideoElementSupport(modelId, {
    mode: settings.mode,
    isMultiShot: settings.isMultiShot,
  });
  const references = getVideoReferenceSupport(modelId);
  const isKling = modelId === 'kling-3.0-video';
  const activeMode: 'frames' | 'elements' = support.enabled
    ? (modelId === 'gemini-omni-video' ? 'elements' : (settings.referenceMode === 'elements' ? 'elements' : 'frames'))
    : 'frames';
  return {
    activeMode,
    framesExcludeReferences: support.enabled && modelId !== 'gemini-omni-video' && modelId !== 'wan-2.7',
    elements: {
      enabled: support.enabled,
      maxTotal: support.maxElements,
      maxNamed: support.maxNamed,
      disabledReason: support.reason,
    },
    referenceVideos: {
      max: isKling ? 0 : references.videos,
      maxDurationSeconds: modelId === 'seedance-2-5'
        ? 30
        : (modelId.startsWith('seedance-2') || modelId === 'minimax-h3' ? 15 : null),
    },
    referenceAudios: { max: references.audios },
    frames: {
      start: true,
      // kling-o3 takes a single start image and no end frame; it was missing from this
      // list, so the surface offered an end-frame slot the model cannot use.
      end: !['grok-imagine-video', 'kling-3.0-turbo', 'hailuo-2.3', 'happyhorse-1.1', 'gemini-omni-video', 'kling-o3'].includes(modelId),
      startRequired: modelId === 'hailuo-2.3',
    },
    combineFramesWithReferences: modelId === 'wan-2.7' && activeMode === 'elements',
    namedVideoElements: { enabled: isKling, max: isKling ? references.videos : 0 },
    subjects: modelId === 'kling-o3'
      ? { enabled: true, maxImages: 12, maxNamed: 3, imagesPerSubject: SUBJECT_IMAGES_PER_NAME }
      : NO_SUBJECTS,
    preparedAssets: modelId === 'gemini-omni-video' ? { voices: 3, characters: 3 } : null,
    activeConstraints: [],
    descriptorDriven: false,
  };
}

const NO_SUBJECTS: VideoInputAffordances['subjects'] = {
  enabled: false,
  maxImages: 0,
  maxNamed: 0,
  imagesPerSubject: SUBJECT_IMAGES_PER_NAME,
};

export function getVideoInputAffordances(
  descriptor: GenerationModelDescriptor | null | undefined,
  modelId: VideoModelId,
  settings: AffordanceSettings = {},
): VideoInputAffordances {
  if (!descriptor) return legacyFallbackAffordances(modelId, settings);

  const conditionSettings: Record<string, ConditionValue> = {
    ...Object.fromEntries(descriptor.controls.map((control) => [control.key, control.defaultValue])),
    ...(settings.mode !== undefined ? { mode: settings.mode } : {}),
    referenceMode: settings.referenceMode === 'elements' ? 'elements' : 'frames',
  };

  const declared = declaredSlots(descriptor);
  const frameSlotsDeclared = [...declared.values()].some((slot) => slot.role === 'startFrame' || slot.role === 'endFrame');
  const referenceSlotDeclared = declared.has('imageReferences')
    || declared.has('videoReferences')
    || declared.has('audioReferences');

  // Reference capacity is reported for the mode that can hold references, not the mode
  // currently showing. Reading it off `active` made the answer depend on the very toggle
  // it gated: the references mode could only be entered from a control that was hidden
  // until you were already in it, so every model with a frames/references split reported
  // zero reference capacity forever. Everything else here still keys off `active`, so
  // Veo's mode gating and the multi-shot block continue to apply.
  const reachable = activeSlots(descriptor, { ...conditionSettings, referenceMode: 'elements' });
  const imageSlot = reachable.get('imageReferences');
  const declaredImageSlot = declared.get('imageReferences');
  const videoSlot = reachable.get('videoReferences');
  const audioSlot = reachable.get('audioReferences');

  // Multi-shot suppresses reusable references everywhere except Kling O3, which carries
  // its named subjects across shots.
  const multiShotBlocks = Boolean(settings.isMultiShot) && modelId !== 'kling-o3';
  const elementsEnabled = Boolean(imageSlot) && imageSlot!.max > 0 && !multiShotBlocks;
  const maxTotal = elementsEnabled ? imageSlot!.max : 0;
  const takesReferences = !multiShotBlocks
    && [imageSlot, videoSlot, audioSlot].some((slot) => (slot?.max ?? 0) > 0);

  // A model with no frame slots is always in elements mode; the picker only makes sense
  // when both shapes exist. A model with frame slots is in elements mode only when that
  // is asked for and the run can hold a reference. The fallback table above has always
  // answered so. This path answered 'elements' to whoever asked, and the create-video
  // page asked whenever a reference was saved in the browser: Kling 3.0 and Hailuo 2.3,
  // which take none, became references runs that the price quote refused.
  const activeMode: 'frames' | 'elements' = !frameSlotsDeclared && referenceSlotDeclared
    ? 'elements'
    : (conditionSettings.referenceMode === 'elements' && takesReferences ? 'elements' : 'frames');
  conditionSettings.referenceMode = activeMode;

  const active = activeSlots(descriptor, conditionSettings);
  const videoElementSlot = active.get('videoElements');
  // Declared, like the frames: the editor is offered wherever the model takes subjects,
  // and the run enters the subjects mode once one is attached.
  const subjectSlot = declared.get(SUBJECT_IMAGES_SLOT_KEY);
  // Frame slots report DECLARED capability, not activation: callers combine them with
  // `activeMode`/`combineFramesWithReferences` themselves, and a model does not stop
  // supporting an end frame just because the user is currently on the references tab.
  const startSlot = declared.get('startFrame');
  const endSlot = declared.get('endFrame');

  const disabledReason = elementsEnabled
    ? null
    : multiShotBlocks
      ? 'Reusable references are available in single-shot only.'
      : declaredImageSlot && declaredImageSlot.max > 0
        // Declared but inactive: some other setting (Veo's mode, for one) gates it.
        ? getVideoElementSupport(modelId, { mode: settings.mode }).reason
          ?? 'Reusable references are unavailable with the selected settings.'
        : 'Reusable references are not available for this model yet.';

  const activeConstraints = (descriptor.inputConstraints ?? [])
    .filter((constraint) => conditionsMatch(constraint.conditions, conditionSettings));

  return {
    activeMode,
    framesExcludeReferences: frameSlotsDeclared
      && referenceSlotDeclared
      && descriptor.inputs.combineFramesWithReferences !== true,
    elements: {
      enabled: elementsEnabled,
      maxTotal,
      // Absent maxNamed means every attached reference may be named.
      maxNamed: elementsEnabled ? Math.min(imageSlot!.maxNamed ?? maxTotal, maxTotal) : 0,
      disabledReason,
    },
    referenceVideos: {
      max: multiShotBlocks ? 0 : (videoSlot?.max ?? 0),
      maxDurationSeconds: videoSlot?.maxDurationSeconds ?? null,
    },
    referenceAudios: { max: multiShotBlocks ? 0 : (audioSlot?.max ?? 0) },
    frames: {
      start: Boolean(startSlot),
      end: Boolean(endSlot),
      startRequired: (startSlot?.min ?? 0) > 0,
    },
    combineFramesWithReferences: descriptor.inputs.combineFramesWithReferences === true
      && activeMode === 'elements',
    namedVideoElements: {
      enabled: Boolean(videoElementSlot) && videoElementSlot!.max > 0,
      max: videoElementSlot?.max ?? 0,
    },
    subjects: subjectSlot && subjectSlot.max > 0
      ? {
          enabled: true,
          maxImages: subjectSlot.max,
          maxNamed: subjectsPerRun(subjectSlot),
          imagesPerSubject: SUBJECT_IMAGES_PER_NAME,
        }
      : NO_SUBJECTS,
    preparedAssets: active.has('preparedVoices') || active.has('characters')
      ? {
          voices: active.get('preparedVoices')?.max ?? 0,
          characters: active.get('characters')?.max ?? 0,
        }
      : null,
    activeConstraints,
    descriptorDriven: true,
  };
}

/** How many references of each kind a draft holds, attached here or saved on another model. */
export type HeldVideoReferences = {
  images: number;
  /** Reference clips. Kling's named video elements are a slot of their own and not counted. */
  videos: number;
  audios: number;
};

export type VideoRunAffordances = VideoInputAffordances & {
  /**
   * Which kinds of held reference the run carries. A kind the model has no slot for
   * with these settings is on standby: it stays in the draft and is no part of the run.
   */
  carries: { images: boolean; videos: boolean; audios: boolean };
};

/**
 * The affordances of the run a draft makes on a model, with the run's shape read off
 * what the draft holds.
 *
 * The browser keeps a creator's references when the model changes, so a draft can hold
 * an image, a clip or a track that the selected model cannot take. Only a reference the
 * model has a slot for makes the run a references run. The create-video page asked for
 * one whenever anything was held, so two images saved on Seedance 2 made Kling 3.0 a
 * references run of two images, and a clip saved there locked the frames of Seedance
 * 1.5 Pro, which takes no clip, behind a reference its page had no card for.
 */
export function getVideoRunAffordances(
  descriptor: GenerationModelDescriptor | null | undefined,
  modelId: VideoModelId,
  settings: Omit<AffordanceSettings, 'referenceMode'>,
  held: HeldVideoReferences,
): VideoRunAffordances {
  // What a model takes does not depend on the run's shape, so it is read off the
  // frames run first.
  const framesRun = getVideoInputAffordances(descriptor, modelId, { ...settings, referenceMode: 'frames' });
  const carries = {
    images: held.images > 0 && framesRun.elements.enabled,
    videos: held.videos > 0 && framesRun.referenceVideos.max > 0,
    audios: held.audios > 0 && framesRun.referenceAudios.max > 0,
  };
  const affordances = carries.images || carries.videos || carries.audios
    ? getVideoInputAffordances(descriptor, modelId, { ...settings, referenceMode: 'elements' })
    : framesRun;
  return { ...affordances, carries };
}

export type ImageInputAffordances = {
  references: { max: number; maxNamed: number; required: boolean };
  /** A single-option control is a fixed value, not a choice worth rendering. */
  showResolutionControl: boolean;
  qualityModeLabel: string | null;
};

export function getImageInputAffordances(
  descriptor: GenerationModelDescriptor | null | undefined,
): ImageInputAffordances | null {
  if (!descriptor) return null;
  const slot = declaredSlots(descriptor).get('imageReferences');
  const resolution = descriptor.controls.find((control) => control.key === 'resolution');
  const resolutionOptions = resolution && resolution.type === 'choice' ? resolution.options.length : 0;
  return {
    references: {
      max: slot?.max ?? descriptor.inputs.imageReferences?.max ?? 0,
      maxNamed: slot?.maxNamed ?? slot?.max ?? descriptor.inputs.imageReferences?.max ?? 0,
      required: (slot?.min ?? 0) > 0,
    },
    showResolutionControl: resolutionOptions > 1,
    qualityModeLabel: descriptor.controls.find((control) => control.key === 'qualityMode')?.label ?? null,
  };
}
