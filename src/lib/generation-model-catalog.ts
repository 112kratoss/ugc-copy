import { createHash } from 'node:crypto';

import {
  IMAGE_MODELS,
  MOTION_MODELS,
  VIDEO_MODELS,
  getImageQualityModes,
  getVideoDurationRange,
  type VideoModelId,
} from '@/lib/models';
import {
  buildCodeGenerationModelOperations,
  calculateGenerationModelRuntimeCost,
  generationModelConditionMatches,
  type GenerationModelOperationalConfig,
  type GenerationModelRuntimeInputs,
  type GenerationModelValidationRuleType,
} from '@/lib/generation-model-runtime';

export const GENERATION_MODEL_CATALOG_SCHEMA_VERSION = 3;
// Stored releases still use schema-v2 descriptors. Schema v3 is a compact
// wire projection, so changing transport shape must not churn release hashes.
export const GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION = 2;
export const GENERATION_MODEL_CATALOG_V1_SCHEMA_VERSION = 1;

export type GenerationModelKind = 'image' | 'video' | 'motion';
export type CatalogPlatform = 'web' | 'mobile';
export type CatalogPrimitive = string | number | boolean;

export interface CatalogCondition {
  source: 'setting' | 'inputCount';
  key: string;
  operator: 'equals' | 'notEquals' | 'in' | 'notIn' | 'greaterThan' | 'greaterThanOrEqual';
  value: CatalogPrimitive | CatalogPrimitive[];
}

interface CatalogControlCompatibility {
  minClientSchemaVersion?: number;
  conditions?: CatalogCondition[];
}

export interface CatalogChoiceOption {
  value: string;
  label: string;
}

export interface CatalogChoiceControl extends CatalogControlCompatibility {
  key: string;
  label: string;
  type: 'choice';
  presentation: 'chips' | 'select';
  defaultValue: string;
  options: CatalogChoiceOption[];
  normalizedValueType?: 'string' | 'number';
}

export interface CatalogBooleanControl extends CatalogControlCompatibility {
  key: string;
  label: string;
  type: 'boolean';
  presentation: 'toggle';
  defaultValue: boolean;
}

export interface CatalogIntegerControl extends CatalogControlCompatibility {
  key: string;
  label: string;
  type: 'integer';
  presentation: 'stepper';
  defaultValue: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
}

export type CatalogControl = CatalogChoiceControl | CatalogBooleanControl | CatalogIntegerControl;

export type CatalogInputSlot = {
  key: string;
  kind: 'image' | 'video' | 'audio' | 'character' | 'preparedVoice';
  role: 'reference' | 'startFrame' | 'endFrame';
  label: string;
  min: number;
  max: number;
  supportsNaming?: boolean;
  /**
   * Upper bound on how many assets in this slot may carry a name, when that is lower
   * than `max`. Kling O3 takes 7 reference images but names at most 3 as subjects.
   * Absent means every asset may be named. Optional by design: mobile's slot parser
   * rebuilds from known keys, so unknown extras are ignored and no release is needed.
   */
  maxNamed?: number;
  durationMetadata?: 'optional' | 'required';
  maxDurationSeconds?: number;
  conditions?: CatalogCondition[];
};

export type CatalogInputMode = {
  key: string;
  label: string;
  default: boolean;
  conditions?: CatalogCondition[];
  slots: CatalogInputSlot[];
};

export type CatalogInputConstraint = {
  type: 'total-count' | 'weighted-count' | 'combined-duration';
  slotKeys: string[];
  max: number;
  weights?: Record<string, number>;
  conditions?: CatalogCondition[];
  message: string;
};

export interface GenerationModelDescriptor {
  id: string;
  kind: GenerationModelKind;
  displayName: string;
  description: string;
  badge: string | null;
  recommended: boolean;
  sortOrder: number;
  minClientSchemaVersion: number;
  controls: CatalogControl[];
  capabilities: {
    multiShot: boolean;
    sound: boolean;
    fixedLens: boolean;
    googleSearch: boolean;
    outputFormat: boolean;
  };
  // Kept for the schema-v1 projection and installed clients.
  inputs: {
    imageReferences: { max: number; supportsNaming: boolean } | null;
    videoReferences: { max: number } | null;
    audioReferences: { max: number } | null;
    preparedAudioReferences?: { max: number } | null;
    characterReferences?: { max: number } | null;
    startFrame: boolean;
    endFrame: boolean;
    combineFramesWithReferences?: boolean;
  };
  // Schema-v2-only public fields. Provider routing and pricing never appear here.
  availability?: Record<CatalogPlatform, boolean>;
  inputModes?: CatalogInputMode[];
  inputConstraints?: CatalogInputConstraint[];
}

export interface GenerationModelCatalog {
  schemaVersion: number;
  revision: string;
  defaults: Record<GenerationModelKind, string | null>;
  models: GenerationModelDescriptor[];
}

export type GenerationModelInputSlotMetadata = {
  count?: number;
  durationsSeconds?: number[];
};

export type GenerationModelQuoteInputMetadata = {
  slots?: Record<string, GenerationModelInputSlotMetadata>;
  referenceVideoDurationsSeconds?: number[];
};

export interface GenerationModelQuoteInput {
  kind: GenerationModelKind;
  modelId: string;
  schemaVersion?: number;
  settings?: Record<string, unknown>;
  inputCounts?: {
    images?: number;
    videos?: number;
    audios?: number;
    preparedAudios?: number;
    characters?: number;
  };
  inputMetadata?: GenerationModelQuoteInputMetadata;
  catalogRevision?: string | null;
}

export interface GenerationModelQuote {
  modelId: string;
  catalogRevision: string;
  normalizedSettings: Record<string, CatalogPrimitive>;
  costCredits: number;
}

type ModelStatus = 'active' | 'retired';

const MODEL_STATUS: Record<string, ModelStatus> = Object.fromEntries([
  ...Object.keys(IMAGE_MODELS),
  ...Object.keys(VIDEO_MODELS),
  ...Object.keys(MOTION_MODELS),
].map((id) => [id, 'active'])) as Record<string, ModelStatus>;

const DEFAULT_MODEL_IDS: Record<GenerationModelKind, string> = {
  image: 'nano-banana-2',
  video: 'kling-3.0-video',
  motion: 'kling-2.6',
};

export class CatalogError extends Error {
  constructor(
    message: string,
    public readonly code: 'INVALID_MODEL_SETTINGS' | 'MODEL_UNAVAILABLE' | 'CATALOG_CHANGED',
    public readonly status: 409 | 422,
    public readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

function labelForValue(value: string | number): string {
  return String(value);
}

function choiceControl(
  key: string,
  label: string,
  values: readonly (string | number)[],
  defaultValue: string | number = values[0],
  presentation: CatalogChoiceControl['presentation'] = values.length > 8 ? 'select' : 'chips',
  options: Pick<CatalogChoiceControl, 'normalizedValueType' | 'minClientSchemaVersion'> = {},
): CatalogChoiceControl {
  return {
    key,
    label,
    type: 'choice',
    presentation,
    defaultValue: String(defaultValue),
    options: values.map((value) => ({ value: String(value), label: labelForValue(value) })),
    ...options,
  };
}

function booleanControl(key: string, label: string, defaultValue = false): CatalogBooleanControl {
  return { key, label, type: 'boolean', presentation: 'toggle', defaultValue };
}

function imageInputModes(maxImages: number): CatalogInputMode[] {
  if (maxImages <= 0) {
    return [{
      key: 'prompt-only',
      label: 'Prompt only',
      default: true,
      slots: [],
    }];
  }
  return [{
    key: 'references',
    label: 'Reference images',
    default: true,
    slots: [{
      key: 'imageReferences',
      kind: 'image',
      role: 'reference',
      label: 'Reference images',
      min: 0,
      max: maxImages,
      supportsNaming: true,
    }],
  }];
}

function imageDescriptors(): GenerationModelDescriptor[] {
  return Object.values(IMAGE_MODELS).map((model, index) => {
    const controls: CatalogControl[] = [
      choiceControl('aspectRatio', 'Aspect ratio', model.aspectRatios),
      choiceControl('resolution', 'Resolution', model.resolutions),
    ];
    if (model.supportsOutputFormat) {
      controls.push(choiceControl('outputFormat', 'Output format', model.outputFormats));
    }
    if (model.supportsGoogleSearch) controls.push(booleanControl('googleSearch', 'Google Search'));
    const qualityModes = getImageQualityModes(model.id);
    if (qualityModes.length > 0) {
      controls.push(choiceControl(
        'qualityMode',
        model.id === 'ideogram-v3' || model.id === 'ideogram-character' ? 'Speed' : 'Quality',
        qualityModes,
      ));
    }
    return {
      id: model.id,
      kind: 'image',
      displayName: model.displayName,
      description: model.description,
      badge: model.badge,
      recommended: model.id === DEFAULT_MODEL_IDS.image,
      sortOrder: index * 10,
      minClientSchemaVersion: 1,
      controls,
      capabilities: {
        multiShot: false,
        sound: false,
        fixedLens: false,
        googleSearch: model.supportsGoogleSearch,
        outputFormat: model.supportsOutputFormat,
      },
      inputs: {
        imageReferences: model.maxImages > 0
          ? { max: model.maxImages, supportsNaming: true }
          : null,
        videoReferences: null,
        audioReferences: null,
        preparedAudioReferences: null,
        characterReferences: null,
        startFrame: false,
        endFrame: false,
        combineFramesWithReferences: false,
      },
      availability: { web: true, mobile: true },
      inputModes: imageInputModes(model.maxImages),
      inputConstraints: [],
    };
  });
}

interface VideoInputLimits {
  images: number;
  videos: number;
  audios: number;
  startFrame: boolean;
  endFrame: boolean;
}

/**
 * Total record on purpose: TypeScript forces an explicit entry for every video
 * model. This used to end in a silent `{images: 3, startFrame: true, endFrame:
 * true}` default that granted new models slots they never declared.
 */
const VIDEO_INPUT_LIMITS: Record<VideoModelId, VideoInputLimits> = {
  'seedance-2': { images: 5, videos: 3, audios: 3, startFrame: true, endFrame: true },
  'seedance-2-fast': { images: 5, videos: 3, audios: 3, startFrame: true, endFrame: true },
  'seedance-2-mini': { images: 5, videos: 3, audios: 3, startFrame: true, endFrame: true },
  // Kie's seedance-2-5 spec caps the reference arrays far above the rest of the family:
  // 30 images, 10 videos, 10 audios. The 30s combined-duration ceiling on reference
  // videos is unchanged, so the extra video slots buy more clips, not more footage.
  'seedance-2-5': { images: 30, videos: 10, audios: 10, startFrame: true, endFrame: true },
  // Kling O3 has no discrete frame slots — image-to-video and reference-to-video both
  // take `image_urls`, so the start frame stands in for the single-image variant.
  'kling-o3': { images: 7, videos: 0, audios: 0, startFrame: true, endFrame: false },
  // MiniMax bills for input images past the first five, so we cap references there.
  // minimax-h3/reference-to-video: 9 images, 3 videos (15s combined), 3 audios.
  'minimax-h3': { images: 9, videos: 3, audios: 3, startFrame: true, endFrame: true },
  'seedance-1.5-pro': { images: 2, videos: 0, audios: 0, startFrame: true, endFrame: true },
  'grok-imagine-video': { images: 1, videos: 0, audios: 0, startFrame: true, endFrame: false },
  'kling-3.0-video': { images: 0, videos: 3, audios: 0, startFrame: true, endFrame: true },
  'kling-3.0-turbo': { images: 0, videos: 0, audios: 0, startFrame: true, endFrame: false },
  'wan-2.7': { images: 5, videos: 5, audios: 1, startFrame: true, endFrame: true },
  'happyhorse-1.1': { images: 9, videos: 0, audios: 0, startFrame: true, endFrame: false },
  'gemini-omni-video': { images: 7, videos: 1, audios: 0, startFrame: false, endFrame: false },
  'hailuo-2.3': { images: 0, videos: 0, audios: 0, startFrame: true, endFrame: false },
  // Veo previously received the silent default; these are its live effective values.
  'veo-3.1': { images: 3, videos: 0, audios: 0, startFrame: true, endFrame: true },
};

/**
 * Exported so the start service reads the same clip/audio caps the descriptor
 * publishes. A hand-written "3" in generation-services is how Seedance 2.5 shipped
 * advertising ten clip slots its own start path refused.
 */
export function getVideoInputLimits(modelId: VideoModelId): VideoInputLimits {
  return VIDEO_INPUT_LIMITS[modelId];
}

/** Longest reference clip a Seedance model accepts, which tracks its own output ceiling. */
/**
 * Per-asset ceiling for reference video and audio, in seconds. Every model here caps a
 * single asset at the same figure Kie caps the combined total at, so one number serves
 * both the slot's `maxDurationSeconds` and its `combined-duration` constraint.
 * Seedance 2.5 reaches 30s where the rest of the Seedance 2 family stops at 15, and
 * minimax-h3 caps both its reference arrays at 15s total.
 */
function referenceAssetCapSeconds(modelId: VideoModelId): number | undefined {
  if (modelId === 'seedance-2-5') return 30;
  if (modelId.startsWith('seedance-2')) return 15;
  if (modelId === 'minimax-h3') return 15;
  return undefined;
}

function videoInputModes(
  modelId: VideoModelId,
  limits: ReturnType<typeof getVideoInputLimits>,
): CatalogInputMode[] {
  const videoCapSeconds = referenceAssetCapSeconds(modelId);
  const modes: CatalogInputMode[] = [];
  const frameSlots: CatalogInputSlot[] = [];
  if (limits.startFrame) {
    frameSlots.push({
      key: 'startFrame',
      kind: 'image',
      role: 'startFrame',
      label: 'Start frame',
      min: modelId === 'hailuo-2.3' ? 1 : 0,
      max: 1,
    });
  }
  if (limits.endFrame) {
    frameSlots.push({
      key: 'endFrame',
      kind: 'image',
      role: 'endFrame',
      label: 'End frame',
      min: 0,
      max: 1,
    });
  }
  if (frameSlots.length > 0) {
    modes.push({
      key: 'frames',
      label: 'Frames',
      default: true,
      conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'frames' }],
      slots: frameSlots,
    });
  }
  const referenceSlots: CatalogInputSlot[] = [];
  // Kling's video elements are named subjects the provider combines WITH start frames
  // (see the kling branch in generation-services), so they cannot live in the
  // frames-vs-references either/or. They get their own always-active mode below;
  // keeping them inside the elements-conditioned mode made every run that attached one
  // unquotable, because this model never enters elements mode.
  const videoElementSlots: CatalogInputSlot[] = [];
  if (limits.images > 0) {
    referenceSlots.push({
      key: 'imageReferences',
      kind: 'image',
      role: 'reference',
      label: 'Reference images',
      min: 0,
      max: limits.images,
      supportsNaming: true,
      // Kling O3 accepts 7 reference images but names at most 3 of them as subjects.
      ...(modelId === 'kling-o3' ? { maxNamed: 3 } : {}),
    });
  }
  if (limits.videos > 0) {
    const isNamedVideoElementSlot = modelId === 'kling-3.0-video';
    const videoSlot: CatalogInputSlot = {
      key: isNamedVideoElementSlot ? 'videoElements' : 'videoReferences',
      kind: 'video',
      role: 'reference',
      label: isNamedVideoElementSlot ? 'Video elements' : 'Reference videos',
      min: 0,
      max: limits.videos,
      ...(isNamedVideoElementSlot ? { supportsNaming: true } : {}),
      // A combined-duration ceiling is only enforceable when every asset reports its
      // length — a client that stays silent would otherwise sum to zero and sail past
      // it. So the models that carry one demand the metadata, and the manifest
      // validator refuses to ship the constraint without it. Seedance additionally
      // prices on reference-video seconds and could not quote without them.
      durationMetadata: videoCapSeconds !== undefined ? 'required' : 'optional',
      ...(videoCapSeconds !== undefined ? { maxDurationSeconds: videoCapSeconds } : {}),
    };
    if (isNamedVideoElementSlot) {
      videoElementSlots.push(videoSlot);
    } else {
      referenceSlots.push(videoSlot);
    }
  }
  if (limits.audios > 0) {
    referenceSlots.push({
      key: 'audioReferences',
      kind: 'audio',
      role: 'reference',
      label: 'Reference audio',
      min: 0,
      max: limits.audios,
      durationMetadata: 'optional',
      ...(videoCapSeconds !== undefined ? { maxDurationSeconds: videoCapSeconds } : {}),
    });
  }
  if (modelId === 'wan-2.7') {
    referenceSlots.push({
      key: 'startFrame',
      kind: 'image',
      role: 'startFrame',
      label: 'Start frame',
      min: 0,
      max: 1,
    });
  }
  if (referenceSlots.length > 0) {
    modes.push({
      key: 'references',
      label: 'Reusable references',
      default: frameSlots.length === 0,
      conditions: frameSlots.length > 0
        ? [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' }]
        : undefined,
      slots: referenceSlots,
    });
  }
  if (videoElementSlots.length > 0) {
    // Unconditioned on purpose: named video elements coexist with either reference mode.
    modes.push({
      key: 'video-elements',
      label: 'Video elements',
      default: frameSlots.length === 0 && referenceSlots.length === 0,
      slots: videoElementSlots,
    });
  }
  if (modelId === 'kling-o3') {
    // Multi-image named subjects: 2–4 images per @subject, up to 3 subjects,
    // grouped by a shared handle (grouping cardinality is enforced in
    // generation-services, like the video-element semantics above). Gated on
    // its own referenceMode value so catalog-driven UIs that cannot group
    // images never surface the slot.
    modes.push({
      key: 'subjects',
      label: 'Named subjects',
      default: false,
      conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'subjects' }],
      slots: [{
        key: 'subjectImages',
        kind: 'image',
        role: 'reference',
        label: 'Subject images',
        min: 0,
        max: 12,
        supportsNaming: true,
        maxNamed: 3,
      }],
    });
  }
  if (modelId === 'gemini-omni-video') {
    modes.push({
      key: 'prepared-assets',
      label: 'Prepared assets',
      default: false,
      slots: [
        {
          key: 'preparedVoices',
          kind: 'preparedVoice',
          role: 'reference',
          label: 'Prepared voices',
          min: 0,
          max: 3,
        },
        {
          key: 'characters',
          kind: 'character',
          role: 'reference',
          label: 'Characters',
          min: 0,
          max: 3,
        },
      ],
    });
  }
  return modes;
}

function videoInputConstraints(modelId: VideoModelId): CatalogInputConstraint[] {
  if (modelId === 'wan-2.7') {
    return [{
      type: 'total-count',
      slotKeys: ['imageReferences', 'videoReferences', 'audioReferences'],
      max: 5,
      conditions: [{ source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' }],
      message: 'Wan 2.7 supports up to 5 reusable references in total.',
    }];
  }
  if (modelId === 'gemini-omni-video') {
    return [{
      type: 'weighted-count',
      slotKeys: ['imageReferences', 'videoReferences', 'characters'],
      weights: { imageReferences: 1, videoReferences: 2, characters: 1 },
      max: 7,
      message: 'Gemini Omni supports seven reference slots; videos use two and characters use one.',
    }];
  }
  // Kie caps the *combined* duration of reference videos independently of how many
  // files it accepts, so raising a file cap never buys more usable footage.
  const max = referenceAssetCapSeconds(modelId);
  if (max !== undefined) {
    return [
      {
        type: 'combined-duration',
        slotKeys: ['videoReferences'],
        max,
        message: `Reference videos may be at most ${max} seconds in total.`,
      },
    ];
  }
  return [];
}

function videoDescriptors(): GenerationModelDescriptor[] {
  return Object.values(VIDEO_MODELS).map((model, index) => {
    const durationRange = getVideoDurationRange(model.id);
    const controls: CatalogControl[] = [choiceControl('aspectRatio', 'Aspect ratio', model.aspectRatios)];
    if (model.modeOptions.length > 0) {
      // The label travels with the model so surfaces don't each keep their own
      // per-id ternary deciding what to call this control.
      const modeLabel = model.id === 'veo-3.1'
        ? 'Model variant'
        : model.id === 'grok-imagine-video'
          ? 'Grok mode'
          : 'Quality mode';
      controls.push({
        ...choiceControl('mode', modeLabel, model.modeOptions.map((option) => option.value)),
        options: model.modeOptions.map((option) => ({ value: option.value, label: option.label })),
      });
    }
    if (model.resolutions.length > 0) controls.push(choiceControl('resolution', 'Resolution', model.resolutions));
    if (durationRange) {
      controls.push({
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        presentation: 'stepper',
        defaultValue: durationRange.default,
        min: durationRange.min,
        max: durationRange.max,
        step: 1,
        unit: 'seconds',
      });
    } else {
      controls.push(choiceControl(
        'duration',
        'Duration',
        model.durations,
        model.durations[0],
        'chips',
        { normalizedValueType: 'number' },
      ));
    }
    if (model.supportsSound) controls.push(booleanControl('sound', 'Sound'));
    if (model.supportsFixedLens) controls.push(booleanControl('fixedLens', 'Fixed lens'));
    if (model.supportsMultiShot) controls.push(booleanControl('isMultiShot', 'Multi-shot'));
    const limits = getVideoInputLimits(model.id);
    if (limits.images > 0 && (limits.startFrame || limits.endFrame)) {
      controls.push({
        ...choiceControl(
          'referenceMode',
          'Input mode',
          ['frames', 'elements'],
          'frames',
          'chips',
          { minClientSchemaVersion: 2 },
        ),
        options: [
          { value: 'frames', label: 'Frames' },
          { value: 'elements', label: 'References' },
        ],
      });
    }
    return {
      id: model.id,
      kind: 'video',
      displayName: model.displayName,
      description: model.description,
      badge: ['grok-imagine-video', 'kling-3.0-turbo', 'seedance-2-mini', 'wan-2.7', 'hailuo-2.3'].includes(model.id) ? 'New' : null,
      recommended: model.id === DEFAULT_MODEL_IDS.video,
      sortOrder: index * 10,
      minClientSchemaVersion: 1,
      controls,
      capabilities: {
        multiShot: model.supportsMultiShot,
        sound: model.supportsSound,
        fixedLens: model.supportsFixedLens,
        googleSearch: false,
        outputFormat: false,
      },
      inputs: {
        imageReferences: limits.images > 0 ? { max: limits.images, supportsNaming: true } : null,
        videoReferences: limits.videos > 0 ? { max: limits.videos } : null,
        audioReferences: limits.audios > 0 ? { max: limits.audios } : null,
        preparedAudioReferences: model.id === 'gemini-omni-video' ? { max: 3 } : null,
        characterReferences: model.id === 'gemini-omni-video' ? { max: 3 } : null,
        startFrame: limits.startFrame,
        endFrame: limits.endFrame,
        combineFramesWithReferences: model.id === 'wan-2.7',
      },
      availability: { web: true, mobile: true },
      inputModes: videoInputModes(model.id, limits),
      inputConstraints: videoInputConstraints(model.id),
    };
  });
}

function motionDescriptors(): GenerationModelDescriptor[] {
  return Object.values(MOTION_MODELS).map((model, index) => ({
    id: model.id,
    kind: 'motion',
    displayName: model.displayName,
    description: model.description,
    badge: model.badge,
    recommended: model.id === DEFAULT_MODEL_IDS.motion,
    sortOrder: index * 10,
    minClientSchemaVersion: 1,
    controls: [
      choiceControl('resolution', 'Resolution', model.resolutions),
      choiceControl('characterOrientation', 'Character orientation', model.characterOrientations),
      {
        key: 'duration',
        label: 'Duration',
        type: 'integer',
        presentation: 'stepper',
        defaultValue: 10,
        min: 1,
        max: model.maxDuration,
        step: 1,
        unit: 'seconds',
      },
    ],
    capabilities: {
      multiShot: false,
      sound: false,
      fixedLens: false,
      googleSearch: false,
      outputFormat: false,
    },
    inputs: {
      imageReferences: { max: 1, supportsNaming: false },
      videoReferences: { max: 1 },
      audioReferences: null,
      preparedAudioReferences: null,
      characterReferences: null,
      startFrame: false,
      endFrame: false,
      combineFramesWithReferences: false,
    },
    availability: { web: true, mobile: true },
    inputModes: [{
      key: 'motion-inputs',
      label: 'Motion inputs',
      default: true,
      slots: [
        {
          key: 'characterImage',
          kind: 'image',
          role: 'reference',
          label: 'Character image',
          min: 1,
          max: 1,
        },
        {
          key: 'referenceVideo',
          kind: 'video',
          role: 'reference',
          label: 'Reference video',
          min: 1,
          max: 1,
          durationMetadata: 'optional',
          maxDurationSeconds: model.maxDuration,
        },
      ],
    }],
    inputConstraints: [],
  }));
}

const ALL_PUBLIC_MODELS: GenerationModelDescriptor[] = [
  ...imageDescriptors(),
  ...videoDescriptors(),
  ...motionDescriptors(),
];

const PRIVATE_GENERATION_MODEL_ALIASES = [
  ...Object.values(IMAGE_MODELS),
  ...Object.values(VIDEO_MODELS),
  ...Object.values(MOTION_MODELS),
] as Array<{ id: string; displayName: string; apiModelId?: string }>;

function buildRevision(models: GenerationModelDescriptor[]): string {
  return createHash('sha256')
    .update(JSON.stringify({
      schemaVersion: GENERATION_MODEL_CATALOG_DESCRIPTOR_SCHEMA_VERSION,
      models,
      status: MODEL_STATUS,
      operations: buildCodeGenerationModelOperations(),
    }))
    .digest('hex')
    .slice(0, 16);
}

function projectControl(control: CatalogControl, schemaVersion: number): CatalogControl | null {
  if ((control.minClientSchemaVersion ?? 1) > schemaVersion) return null;
  if (schemaVersion >= 2) return control;
  const projected = { ...control };
  delete projected.minClientSchemaVersion;
  delete projected.conditions;
  return projected;
}

export function projectGenerationModelDescriptor(
  descriptor: GenerationModelDescriptor,
  schemaVersion: number,
): GenerationModelDescriptor {
  const controls = descriptor.controls
    .map((control) => projectControl(control, schemaVersion))
    .filter((control): control is CatalogControl => Boolean(control));
  if (schemaVersion >= 2) return { ...descriptor, controls };
  const v1 = { ...descriptor };
  delete v1.availability;
  delete v1.inputModes;
  delete v1.inputConstraints;
  return { ...v1, controls };
}

export function buildGenerationModelCatalog({
  platform,
  schemaVersion,
}: {
  platform: CatalogPlatform;
  schemaVersion: number;
}): GenerationModelCatalog {
  const projectedSchemaVersion = schemaVersion >= 3 ? 3 : schemaVersion >= 2 ? 2 : 1;
  const models = ALL_PUBLIC_MODELS
    .filter((model) => (
      MODEL_STATUS[model.id] === 'active'
      && model.minClientSchemaVersion <= schemaVersion
      && (model.availability?.[platform] ?? true)
    ))
    .map((model) => projectGenerationModelDescriptor(model, projectedSchemaVersion))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
  const modelIds = new Set(models.map((model) => model.id));
  return {
    schemaVersion: projectedSchemaVersion,
    revision: buildRevision(ALL_PUBLIC_MODELS),
    defaults: {
      image: modelIds.has(DEFAULT_MODEL_IDS.image) ? DEFAULT_MODEL_IDS.image : models.find((model) => model.kind === 'image')?.id ?? null,
      video: modelIds.has(DEFAULT_MODEL_IDS.video) ? DEFAULT_MODEL_IDS.video : models.find((model) => model.kind === 'video')?.id ?? null,
      motion: modelIds.has(DEFAULT_MODEL_IDS.motion) ? DEFAULT_MODEL_IDS.motion : models.find((model) => model.kind === 'motion')?.id ?? null,
    },
    models,
  };
}

function normalizedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function normalizedDurations(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0)
    : [];
}

export function normalizeGenerationModelInputFacts(
  input: Pick<GenerationModelQuoteInput, 'inputCounts' | 'inputMetadata'>,
): GenerationModelRuntimeInputs {
  const counts = {
    images: normalizedCount(input.inputCounts?.images),
    videos: normalizedCount(input.inputCounts?.videos),
    audios: normalizedCount(input.inputCounts?.audios),
    preparedAudios: normalizedCount(input.inputCounts?.preparedAudios),
    characters: normalizedCount(input.inputCounts?.characters),
  };
  const slotCounts: Record<string, number> = {
    imageReferences: counts.images,
    videoReferences: counts.videos,
    audioReferences: counts.audios,
    preparedVoices: counts.preparedAudios,
    characters: counts.characters,
  };
  const slotDurationsSeconds: Record<string, number[]> = {};
  for (const [slotKey, metadata] of Object.entries(input.inputMetadata?.slots ?? {})) {
    if (metadata && typeof metadata === 'object') {
      if (metadata.count !== undefined) slotCounts[slotKey] = normalizedCount(metadata.count);
      if (metadata.durationsSeconds !== undefined) {
        slotDurationsSeconds[slotKey] = normalizedDurations(metadata.durationsSeconds);
      }
    }
  }
  const explicitReferenceDurations = normalizedDurations(
    input.inputMetadata?.referenceVideoDurationsSeconds,
  );
  const referenceVideoDurationsSeconds = explicitReferenceDurations.length > 0
    ? explicitReferenceDurations
    : slotDurationsSeconds.videoReferences ?? [];
  return {
    counts,
    slotCounts,
    slotDurationsSeconds,
    referenceVideoDurationsSeconds,
  };
}

function conditionsMatch(
  conditions: CatalogCondition[] | undefined,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
): boolean {
  return !conditions || conditions.every((condition) => (
    generationModelConditionMatches(condition, settings, inputs)
  ));
}

function normalizeControlCandidate(
  control: CatalogControl,
  rawSettings: Record<string, unknown>,
): CatalogPrimitive {
  const rawValue = rawSettings[control.key];
  if (control.type === 'boolean') {
    return typeof rawValue === 'boolean' ? rawValue : control.defaultValue;
  }
  if (control.type === 'integer') {
    return typeof rawValue === 'number' && Number.isFinite(rawValue)
      ? rawValue
      : control.defaultValue;
  }
  const value = rawValue === undefined ? control.defaultValue : rawValue;
  const stringValue = typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : control.defaultValue;
  return control.normalizedValueType === 'number'
    ? Number(stringValue)
    : stringValue;
}

function normalizeDescriptorSettings(
  descriptor: GenerationModelDescriptor,
  rawSettings: Record<string, unknown>,
  runtimeConfig: GenerationModelOperationalConfig,
  inputs: GenerationModelRuntimeInputs,
): {
  normalizedSettings: Record<string, CatalogPrimitive>;
  fieldErrors: Record<string, string>;
} {
  const normalizedSettings: Record<string, CatalogPrimitive> = {};
  const fieldErrors: Record<string, string> = {};
  const conditionSettings = Object.fromEntries(
    descriptor.controls.map((control) => [
      control.key,
      normalizeControlCandidate(control, rawSettings),
    ]),
  );
  for (const control of descriptor.controls) {
    if (!conditionsMatch(control.conditions, conditionSettings, inputs)) continue;
    const rawValue = rawSettings[control.key];
    if (control.type === 'boolean') {
      if (rawValue !== undefined && typeof rawValue !== 'boolean') {
        fieldErrors[control.key] = `${control.label} must be on or off.`;
      }
      normalizedSettings[control.key] = typeof rawValue === 'boolean' ? rawValue : control.defaultValue;
      continue;
    }
    if (control.type === 'integer') {
      const value = rawValue === undefined ? control.defaultValue : rawValue;
      if (typeof value !== 'number'
        || !Number.isFinite(value)
        || value < control.min
        || value > control.max
        || Math.abs((value - control.min) / control.step - Math.round((value - control.min) / control.step)) > 1e-9) {
        fieldErrors[control.key] = `${control.label} must be between ${control.min} and ${control.max}.`;
      } else {
        normalizedSettings[control.key] = value;
      }
      continue;
    }
    const value = rawValue === undefined ? control.defaultValue : rawValue;
    const stringValue = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    if (!control.options.some((option) => option.value === stringValue)) {
      fieldErrors[control.key] = `${descriptor.displayName} does not support ${control.key} ${String(value)}.`;
    } else {
      normalizedSettings[control.key] = control.normalizedValueType === 'number'
        ? Number(stringValue)
        : stringValue;
    }
  }
  const validationConfig = runtimeConfig.validationConfig;
  const hasReusableReferenceInputs = (
    inputs.counts.videos > 0
    || inputs.counts.audios > 0
    || inputs.counts.preparedAudios > 0
    || inputs.counts.characters > 0
    || Object.entries(inputs.slotCounts).some(([slotKey, count]) => (
      count > 0
      && !['startFrame', 'endFrame', 'characterImage', 'referenceVideo'].includes(slotKey)
    ))
  );
  if (
    rawSettings.referenceMode === undefined
    && hasReusableReferenceInputs
    && (descriptor.inputModes ?? []).some((mode) => (
      mode.conditions?.some((condition) => (
        condition.source === 'setting'
        && condition.key === 'referenceMode'
        && condition.operator === 'equals'
        && condition.value === 'elements'
      ))
    ))
  ) {
    // V1 clients predate the generic input-mode control. Preserve their
    // reference uploads by selecting the reusable-reference mode from the
    // supplied input facts instead of silently treating them as frame inputs.
    normalizedSettings.referenceMode = 'elements';
  }
  const defaults = validationConfig.normalizedDefaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    for (const [key, value] of Object.entries(defaults)) {
      if (!(key in normalizedSettings)
        && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        normalizedSettings[key] = value;
      }
    }
  }
  const passthrough = Array.isArray(validationConfig.passthroughSettingKeys)
    ? validationConfig.passthroughSettingKeys
    : [];
  const descriptorControlKeys = new Set(descriptor.controls.map((control) => control.key));
  for (const key of passthrough) {
    if (typeof key !== 'string' || descriptorControlKeys.has(key)) continue;
    const value = rawSettings[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalizedSettings[key] = value;
    } else if (!(key in normalizedSettings) && key === 'referenceMode') {
      normalizedSettings[key] = 'frames';
    }
  }
  return { normalizedSettings, fieldErrors };
}

function slotCount(inputs: GenerationModelRuntimeInputs, key: string): number {
  if (key in inputs.slotCounts) return inputs.slotCounts[key] ?? 0;
  return inputs.counts[key as keyof GenerationModelRuntimeInputs['counts']] ?? 0;
}

function descriptorSlotCount(
  inputs: GenerationModelRuntimeInputs,
  key: string,
  settings: Record<string, CatalogPrimitive>,
): number {
  if (key in inputs.slotCounts) return inputs.slotCounts[key] ?? 0;
  if (key === 'startFrame' && settings.referenceMode !== 'elements') {
    return Math.min(1, inputs.counts.images);
  }
  if (key === 'endFrame' && settings.referenceMode !== 'elements') {
    return Math.min(1, Math.max(0, inputs.counts.images - 1));
  }
  if (key === 'characterImage') return inputs.counts.images;
  if (key === 'referenceVideo') return inputs.counts.videos;
  return slotCount(inputs, key);
}

function validateInputMetadata(
  input: GenerationModelQuoteInput,
  fieldErrors: Record<string, string>,
): void {
  for (const [slotKey, metadata] of Object.entries(input.inputMetadata?.slots ?? {})) {
    if (metadata.count !== undefined
      && (typeof metadata.count !== 'number' || !Number.isInteger(metadata.count) || metadata.count < 0)) {
      fieldErrors[slotKey] = `${slotKey} count must be a non-negative integer.`;
    }
    if (metadata.durationsSeconds !== undefined
      && (!Array.isArray(metadata.durationsSeconds)
        || metadata.durationsSeconds.some((duration) => (
          typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0
        )))) {
      fieldErrors[slotKey] = `${slotKey} durations must be non-negative seconds.`;
    }
  }
  const referenceDurations = input.inputMetadata?.referenceVideoDurationsSeconds;
  if (referenceDurations !== undefined
    && (!Array.isArray(referenceDurations)
      || referenceDurations.some((duration) => (
        typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0
      )))) {
    fieldErrors.videos = 'Reference video durations must be non-negative seconds.';
  }
}

function validateDescriptorInputs(
  descriptor: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
  input: GenerationModelQuoteInput,
  fieldErrors: Record<string, string>,
): void {
  if (descriptor.kind === 'image') {
    const maxImages = descriptor.inputs.imageReferences?.max ?? 0;
    if (inputs.counts.images > maxImages) {
      fieldErrors.references = maxImages > 0
        ? `${descriptor.displayName} supports up to ${maxImages} image references.`
        : `${descriptor.displayName} does not support image references.`;
    }
  }
  const maxVideos = descriptor.inputs.videoReferences?.max ?? 0;
  if (inputs.counts.videos > maxVideos) {
    fieldErrors.videos = maxVideos > 0
      ? `${descriptor.displayName} supports up to ${maxVideos} video references.`
      : `${descriptor.displayName} does not support video references.`;
  }
  const maxAudios = descriptor.inputs.audioReferences?.max ?? 0;
  if (inputs.counts.audios > maxAudios) {
    fieldErrors.audios = maxAudios > 0
      ? `${descriptor.displayName} supports up to ${maxAudios} audio references.`
      : `${descriptor.displayName} does not support audio references.`;
  }
  const maxPreparedAudios = descriptor.inputs.preparedAudioReferences?.max ?? 0;
  if (inputs.counts.preparedAudios > maxPreparedAudios) {
    fieldErrors.preparedAudios = maxPreparedAudios > 0
      ? `${descriptor.displayName} supports up to ${maxPreparedAudios} prepared voice references.`
      : `${descriptor.displayName} does not support prepared voice references.`;
  }
  const maxCharacters = descriptor.inputs.characterReferences?.max ?? 0;
  if (inputs.counts.characters > maxCharacters) {
    fieldErrors.characters = maxCharacters > 0
      ? `${descriptor.displayName} supports up to ${maxCharacters} character references.`
      : `${descriptor.displayName} does not support character references.`;
  }

  const declaredSlots = new Map<string, CatalogInputSlot>();
  const activeSlotKeys = new Set<string>();
  for (const mode of descriptor.inputModes ?? []) {
    for (const slot of mode.slots) declaredSlots.set(slot.key, slot);
    if (!conditionsMatch(mode.conditions, settings, inputs)) continue;
    for (const slot of mode.slots) {
      if (!conditionsMatch(slot.conditions, settings, inputs)) continue;
      activeSlotKeys.add(slot.key);
      const count = descriptorSlotCount(inputs, slot.key, settings);
      if (count < slot.min) fieldErrors[slot.key] = `${slot.label} requires at least ${slot.min}.`;
      if (count > slot.max) fieldErrors[slot.key] = `${slot.label} supports up to ${slot.max}.`;
      const durations = inputs.slotDurationsSeconds[slot.key]
        ?? (slot.key === 'videoReferences' ? inputs.referenceVideoDurationsSeconds : []);
      if (slot.durationMetadata === 'required' && count > 0 && durations.length !== count) {
        fieldErrors[slot.key] = `${slot.label} requires duration metadata for every asset.`;
      }
      if (slot.maxDurationSeconds !== undefined
        && durations.some((duration) => duration > slot.maxDurationSeconds!)) {
        fieldErrors[slot.key] = `${slot.label} assets must be at most ${slot.maxDurationSeconds} seconds each.`;
      }
    }
  }

  for (const [slotKey, metadata] of Object.entries(input.inputMetadata?.slots ?? {})) {
    const suppliedCount = Math.max(
      normalizedCount(metadata.count),
      normalizedDurations(metadata.durationsSeconds).length,
    );
    if (suppliedCount === 0) continue;
    const declaredSlot = declaredSlots.get(slotKey);
    if (!declaredSlot) {
      fieldErrors[slotKey] = `${descriptor.displayName} does not support the ${slotKey} input.`;
    } else if (!activeSlotKeys.has(slotKey)) {
      fieldErrors[slotKey] = `${declaredSlot.label} is unavailable with the selected settings.`;
    }
  }

  for (const constraint of descriptor.inputConstraints ?? []) {
    if (!conditionsMatch(constraint.conditions, settings, inputs)) continue;
    const field = constraint.slotKeys[0] ?? 'inputs';
    if (constraint.type === 'combined-duration') {
      let totalDuration = 0;
      let missingDurationMetadata = false;
      for (const slotKey of constraint.slotKeys) {
        const count = descriptorSlotCount(inputs, slotKey, settings);
        const durations = inputs.slotDurationsSeconds[slotKey]
          ?? (slotKey === 'videoReferences' ? inputs.referenceVideoDurationsSeconds : []);
        if (count > durations.length) missingDurationMetadata = true;
        totalDuration += durations.reduce((sum, duration) => sum + duration, 0);
      }
      if (missingDurationMetadata) {
        fieldErrors[field] = `${declaredSlots.get(field)?.label ?? field} requires duration metadata for every asset.`;
      } else if (totalDuration > constraint.max) {
        fieldErrors[field] = constraint.message;
      }
      continue;
    }
    const total = constraint.type === 'weighted-count'
      ? constraint.slotKeys.reduce((sum, slotKey) => (
          sum + descriptorSlotCount(inputs, slotKey, settings) * (constraint.weights?.[slotKey] ?? 0)
        ), 0)
      : constraint.slotKeys.reduce((sum, slotKey) => (
          sum + descriptorSlotCount(inputs, slotKey, settings)
        ), 0);
    if (total > constraint.max) fieldErrors[field] = constraint.message;
  }
}

function ruleConditions(value: unknown): CatalogCondition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid validation rule conditions.');
  return value as CatalogCondition[];
}

function validationMessage(
  rule: Record<string, unknown>,
  fallback: string,
): string {
  return typeof rule.message === 'string' && rule.message ? rule.message : fallback;
}

function applyValidationRule(
  rule: Record<string, unknown>,
  descriptor: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive>,
  inputs: GenerationModelRuntimeInputs,
  fieldErrors: Record<string, string>,
): void {
  if (typeof rule.type !== 'string') throw new Error(`Invalid validation rule for ${descriptor.id}.`);
  const allowed: GenerationModelValidationRuleType[] = [
    'control-options',
    'control-range',
    'max-slot-count',
    'min-slot-count',
    'combined-duration',
    'mutually-exclusive-slots',
    'weighted-slot-count',
    'forbidden-combination',
  ];
  if (!allowed.includes(rule.type as GenerationModelValidationRuleType)) {
    throw new Error(`Unsupported validation rule ${rule.type} for ${descriptor.id}.`);
  }
  const conditions = ruleConditions(rule.conditions);
  if (!conditionsMatch(conditions, settings, inputs)) return;
  const field = typeof rule.field === 'string' ? rule.field : null;
  if (rule.type === 'forbidden-combination') {
    fieldErrors[field ?? 'settings'] = validationMessage(rule, 'This combination of settings is unavailable.');
    return;
  }
  if (rule.type === 'control-options') {
    if (typeof rule.key !== 'string' || !Array.isArray(rule.options)) throw new Error('Invalid control-options rule.');
    if (!rule.options.includes(settings[rule.key])) {
      fieldErrors[field ?? rule.key] = validationMessage(rule, `${rule.key} is unavailable.`);
    }
    return;
  }
  if (rule.type === 'control-range') {
    if (typeof rule.key !== 'string' || typeof rule.min !== 'number' || typeof rule.max !== 'number') {
      throw new Error('Invalid control-range rule.');
    }
    const value = settings[rule.key];
    if (typeof value !== 'number' || value < rule.min || value > rule.max) {
      fieldErrors[field ?? rule.key] = validationMessage(rule, `${rule.key} is outside the supported range.`);
    }
    return;
  }
  if (rule.type === 'max-slot-count' || rule.type === 'min-slot-count') {
    if (typeof rule.slotKey !== 'string') throw new Error(`Invalid ${rule.type} rule.`);
    const limitKey = rule.type === 'max-slot-count' ? 'max' : 'min';
    const limit = rule[limitKey];
    if (typeof limit !== 'number') throw new Error(`Invalid ${rule.type} rule.`);
    const count = slotCount(inputs, rule.slotKey);
    const invalid = rule.type === 'max-slot-count' ? count > limit : count < limit;
    if (invalid) {
      fieldErrors[field ?? rule.slotKey] = validationMessage(
        rule,
        `${descriptor.displayName} requires ${rule.type === 'max-slot-count' ? 'at most' : 'at least'} ${limit} ${rule.slotKey}.`,
      );
    }
    return;
  }
  if (rule.type === 'combined-duration') {
    if (!Array.isArray(rule.slotKeys) || typeof rule.max !== 'number') throw new Error('Invalid combined-duration rule.');
    const slotKeys = rule.slotKeys.filter((key): key is string => typeof key === 'string');
    const total = slotKeys.reduce((sum, key) => (
      sum + (inputs.slotDurationsSeconds[key]
        ?? (key === 'videoReferences' ? inputs.referenceVideoDurationsSeconds : []))
        .reduce((slotSum, duration) => slotSum + duration, 0)
    ), 0);
    if (total > rule.max) {
      fieldErrors[field ?? slotKeys[0] ?? 'inputs'] = validationMessage(rule, `Combined duration may be at most ${rule.max} seconds.`);
    }
    return;
  }
  if (rule.type === 'mutually-exclusive-slots') {
    if (!Array.isArray(rule.slotKeys)) throw new Error('Invalid mutually-exclusive-slots rule.');
    const used = rule.slotKeys.filter((key) => typeof key === 'string' && slotCount(inputs, key) > 0);
    if (used.length > 1) {
      fieldErrors[field ?? 'inputs'] = validationMessage(rule, 'These inputs cannot be combined.');
    }
    return;
  }
  if (rule.type === 'weighted-slot-count') {
    if (!isRecord(rule.weights) || typeof rule.max !== 'number') throw new Error('Invalid weighted-slot-count rule.');
    const total = Object.entries(rule.weights).reduce((sum, [key, weight]) => (
      sum + (typeof weight === 'number' ? slotCount(inputs, key) * weight : 0)
    ), 0);
    if (total > rule.max) {
      fieldErrors[field ?? 'references'] = validationMessage(rule, `Combined inputs may use at most ${rule.max} slots.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertValid(fieldErrors: Record<string, string>): void {
  if (Object.keys(fieldErrors).length > 0) {
    throw new CatalogError(
      'Some model settings are no longer available.',
      'INVALID_MODEL_SETTINGS',
      422,
      fieldErrors,
    );
  }
}

export function quoteGenerationModel(
  input: GenerationModelQuoteInput,
  options: {
    catalog?: GenerationModelCatalog;
    operations?: Map<string, GenerationModelOperationalConfig>;
  } = {},
): GenerationModelQuote {
  // The quote engine is an internal server boundary and should validate
  // against the richest descriptor the backend understands. Public v1
  // projection remains a response concern handled by the catalog store.
  const catalog = options.catalog ?? buildGenerationModelCatalog({
    platform: 'web',
    schemaVersion: GENERATION_MODEL_CATALOG_SCHEMA_VERSION,
  });
  if (input.catalogRevision && input.catalogRevision !== catalog.revision) {
    throw new CatalogError(
      'The model catalog has changed. Refresh settings before generating.',
      'CATALOG_CHANGED',
      409,
    );
  }
  const descriptor = catalog.models.find((model) => model.id === input.modelId && model.kind === input.kind);
  if (!descriptor) {
    throw new CatalogError('This model is no longer available.', 'MODEL_UNAVAILABLE', 409);
  }
  const operations = options.operations
    ?? new Map(buildCodeGenerationModelOperations().map((entry) => [entry.modelId, entry]));
  const runtimeConfig = operations.get(input.modelId);
  if (!runtimeConfig || runtimeConfig.kind !== input.kind) {
    throw new Error(`The published operational configuration for ${input.modelId} is unavailable.`);
  }
  const inputs = normalizeGenerationModelInputFacts(input);
  const {
    normalizedSettings,
    fieldErrors,
  } = normalizeDescriptorSettings(descriptor, input.settings ?? {}, runtimeConfig, inputs);
  validateInputMetadata(input, fieldErrors);
  validateDescriptorInputs(descriptor, normalizedSettings, inputs, input, fieldErrors);
  const rules = runtimeConfig.validationConfig.rules;
  if (rules !== undefined && !Array.isArray(rules)) {
    throw new Error(`Invalid validation rules for ${input.modelId}.`);
  }
  for (const rule of rules ?? []) {
    if (!isRecord(rule)) throw new Error(`Invalid validation rule for ${input.modelId}.`);
    applyValidationRule(rule, descriptor, normalizedSettings, inputs, fieldErrors);
  }
  assertValid(fieldErrors);
  return {
    modelId: input.modelId,
    catalogRevision: catalog.revision,
    normalizedSettings,
    costCredits: calculateGenerationModelRuntimeCost(runtimeConfig, normalizedSettings, inputs),
  };
}

export function getGenerationModelDisplayName(modelId: string): string | null {
  return ALL_PUBLIC_MODELS.find((model) => model.id === modelId)?.displayName
    ?? PRIVATE_GENERATION_MODEL_ALIASES.find((model) => model.apiModelId === modelId)?.displayName
    ?? null;
}

export function getGenerationModelChoiceOptionLabel(
  modelId: string,
  controlKey: string,
  value: string,
): string | null {
  const model = ALL_PUBLIC_MODELS.find((candidate) => candidate.id === modelId);
  const control = model?.controls.find((candidate): candidate is CatalogChoiceControl => (
    candidate.type === 'choice' && candidate.key === controlKey
  ));
  return control?.options.find((option) => option.value === value)?.label ?? null;
}
