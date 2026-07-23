import type {
  CatalogControl,
  CatalogPrimitive,
  GenerationModelDescriptor,
  GenerationModelQuoteRequest,
} from './generation-model-catalog';
import type {
  CreationDraft,
  CreationSectionSummary,
  CreationValidationResult,
  ImageCreationDraft,
  MotionCreationDraft,
  VideoCreationDraft,
} from './media-creation-view-model';
import type {
  GenerationElementDescriptor,
  ImageGenerationRequest,
  MotionGenerationRequest,
  RemixMediaAssetDescriptor,
  VideoGenerationRequest,
} from './types';

function draftKey(draft: CreationDraft, controlKey: string) {
  return draft.tool === 'motion' && controlKey === 'resolution' ? 'mode' : controlKey;
}

function currentControlValue(draft: CreationDraft, control: CatalogControl): CatalogPrimitive | undefined {
  const value = (draft as unknown as Record<string, unknown>)[draftKey(draft, control.key)];
  if (control.type === 'choice') {
    if (typeof value === 'number') return String(value);
    return typeof value === 'string' ? value : undefined;
  }
  if (control.type === 'boolean') return typeof value === 'boolean' ? value : undefined;
  return typeof value === 'number' ? value : undefined;
}

function preparedAudioIds(draft: VideoCreationDraft): string[] {
  return Array.isArray(draft.preparedAudioIds) ? draft.preparedAudioIds : [];
}

function characterIds(draft: VideoCreationDraft): string[] {
  return Array.isArray(draft.characterIds) ? draft.characterIds : [];
}

function normalizedControlValue(draft: CreationDraft, control: CatalogControl): CatalogPrimitive {
  const current = currentControlValue(draft, control);
  if (control.type === 'choice') {
    return typeof current === 'string' && control.options.some((option) => option.value === current)
      ? current
      : control.defaultValue;
  }
  if (control.type === 'boolean') return typeof current === 'boolean' ? current : control.defaultValue;
  return typeof current === 'number' && current >= control.min && current <= control.max
    ? current
    : control.defaultValue;
}

function writeControlValues(draft: CreationDraft, model: GenerationModelDescriptor) {
  const values: Record<string, CatalogPrimitive> = {};
  for (const control of model.controls) {
    const value = normalizedControlValue(draft, control);
    const key = draftKey(draft, control.key);
    values[key] = control.key === 'duration' && control.type === 'choice' ? Number(value) : value;
  }
  return values;
}

function hasReusableVideoInputs(model: GenerationModelDescriptor) {
  const reusableInputs = [
    model.inputs.imageReferences,
    model.inputs.videoReferences,
    model.inputs.audioReferences,
    model.inputs.preparedAudioReferences,
    model.inputs.characterReferences,
  ];
  return reusableInputs.some((input) => Boolean(input && input.max > 0));
}

function normalizedVideoReferenceMode(
  draft: VideoCreationDraft,
  model: GenerationModelDescriptor,
  isMultiShot: boolean
): VideoCreationDraft['referenceMode'] {
  if (isMultiShot) return 'frames';

  const supportsFrames = model.inputs.startFrame || model.inputs.endFrame;
  const supportsReusableReferences = hasReusableVideoInputs(model);
  if (draft.referenceMode === 'elements' && supportsReusableReferences) return 'elements';
  if (draft.referenceMode === 'frames' && supportsFrames) return 'frames';
  return supportsReusableReferences ? 'elements' : 'frames';
}

export function applyCatalogModelDefaults(draft: CreationDraft, model: GenerationModelDescriptor): CreationDraft {
  const values = writeControlValues(draft, model);
  if (draft.tool === 'image') {
    return {
      ...draft,
      ...values,
      model: model.id as ImageCreationDraft['model'],
      references: model.inputs.imageReferences
        ? draft.references.slice(0, model.inputs.imageReferences.max)
        : [],
    } as ImageCreationDraft;
  }
  if (draft.tool === 'video') {
    const isMultiShot = model.capabilities.multiShot ? Boolean(values.isMultiShot ?? draft.isMultiShot) : false;
    return {
      ...draft,
      ...values,
      model: model.id as VideoCreationDraft['model'],
      isMultiShot,
      sound: model.capabilities.sound ? Boolean(values.sound ?? draft.sound) : false,
      fixedLens: model.capabilities.fixedLens ? Boolean(values.fixedLens ?? draft.fixedLens) : false,
      references: model.inputs.imageReferences
        ? draft.references.slice(0, model.inputs.imageReferences.max)
        : [],
      referenceVideos: model.inputs.videoReferences
        ? draft.referenceVideos.slice(0, model.inputs.videoReferences.max)
        : [],
      referenceAudios: model.inputs.audioReferences
        ? draft.referenceAudios.slice(0, model.inputs.audioReferences.max)
        : [],
      preparedAudioIds: model.inputs.preparedAudioReferences
        ? preparedAudioIds(draft).slice(0, model.inputs.preparedAudioReferences.max)
        : [],
      characterIds: model.inputs.characterReferences
        ? characterIds(draft).slice(0, model.inputs.characterReferences.max)
        : [],
      startFrame: model.inputs.startFrame ? draft.startFrame : null,
      endFrame: model.inputs.endFrame && !isMultiShot ? draft.endFrame : null,
      referenceMode: normalizedVideoReferenceMode(draft, model, isMultiShot),
    } as VideoCreationDraft;
  }
  return {
    ...draft,
    ...values,
    model: model.id as MotionCreationDraft['model'],
  } as MotionCreationDraft;
}

function referenceSummary(draft: CreationDraft) {
  if (draft.tool === 'image') return draft.references.length === 0 ? 'No references' : `${draft.references.length} image reference${draft.references.length === 1 ? '' : 's'}`;
  if (draft.tool === 'video') {
    const count = draft.references.length + draft.referenceVideos.length + draft.referenceAudios.length + preparedAudioIds(draft).length + characterIds(draft).length + (draft.startFrame ? 1 : 0) + (draft.endFrame ? 1 : 0);
    return count === 0 ? 'No references' : `${count} reference asset${count === 1 ? '' : 's'}`;
  }
  return `${draft.characterImage ? 'Character ready' : 'Character missing'} · ${draft.referenceVideo ? 'motion ready' : 'motion missing'}`;
}

export function getCatalogCreationSectionSummary(draft: CreationDraft, model: GenerationModelDescriptor): CreationSectionSummary {
  if (draft.tool === 'image') {
    return {
      essentials: `${model.displayName} · ${draft.aspectRatio} · ${draft.resolution}`,
      references: referenceSummary(draft),
      advanced: `${draft.outputFormat.toUpperCase()} · Search ${draft.googleSearch ? 'on' : 'off'}`,
    };
  }
  if (draft.tool === 'video') {
    const duration = draft.isMultiShot
      ? draft.multiPrompts.reduce((total, shot) => total + Math.max(1, Math.round(shot.duration || 0)), 0)
      : draft.duration;
    return {
      essentials: `${model.displayName} · ${draft.aspectRatio} · ${duration}s`,
      references: referenceSummary(draft),
      advanced: [draft.mode, draft.resolution, model.capabilities.sound ? `Sound ${draft.sound ? 'on' : 'off'}` : null].filter(Boolean).join(' · ') || 'Default settings',
    };
  }
  return {
    essentials: `${model.displayName} · ${draft.mode} · ${Math.max(1, Math.ceil(draft.referenceVideo?.durationSeconds ?? draft.duration))}s`,
    references: referenceSummary(draft),
    advanced: `${draft.characterOrientation === 'video' ? 'Video' : 'Image'} orientation`,
  };
}

function extractHandles(prompt: string) {
  return Array.from(new Set(prompt.match(/@[a-z0-9_]+/gi) ?? []));
}

function validateControls(draft: CreationDraft, model: GenerationModelDescriptor, errors: string[]) {
  for (const control of model.controls) {
    const value = currentControlValue(draft, control);
    if (control.type === 'choice' && (typeof value !== 'string' || !control.options.some((option) => option.value === value))) {
      errors.push(`${model.displayName} does not support ${control.label.toLowerCase()} ${String(value ?? '')}.`);
    }
    if (control.type === 'integer' && (typeof value !== 'number' || value < control.min || value > control.max)) {
      errors.push(`${control.label} must be between ${control.min} and ${control.max}.`);
    }
  }
}

function validateCatalogInputLimit(
  count: number,
  limit: { max: number } | null,
  unsupportedMessage: string,
  limitMessage: (max: number) => string,
  errors: string[]
) {
  if (count <= 0) return;
  if (!limit) {
    errors.push(unsupportedMessage);
    return;
  }
  if (count > limit.max) errors.push(limitMessage(limit.max));
}

export function validateCatalogCreationDraft(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  options: { credits?: number | null; quotedCost?: number | null } = {}
): CreationValidationResult {
  const errors: string[] = [];
  if (draft.tool === 'image' && !draft.prompt.trim()) errors.push('Prompt is required.');
  if (draft.tool === 'video' && !draft.isMultiShot && !draft.prompt.trim()) errors.push('Prompt is required.');
  if (draft.tool === 'video' && draft.isMultiShot && !draft.multiPrompts.every((shot) => shot.prompt.trim())) errors.push('All multi-shot entries need a text prompt.');
  if (draft.tool === 'motion') {
    if (!draft.characterImage) errors.push('Character image is required.');
    if (!draft.referenceVideo) errors.push('Reference video is required.');
  }

  validateControls(draft, model, errors);
  if (draft.tool === 'image') {
    validateCatalogInputLimit(
      draft.references.length,
      model.inputs.imageReferences,
      `${model.displayName} does not support image references.`,
      (max) => `${model.displayName} supports up to ${max} total reference images.`,
      errors
    );
  }
  if (draft.tool === 'video') {
    if (!model.capabilities.multiShot && draft.isMultiShot) errors.push(`${model.displayName} does not support multi-shot video generation.`);
    if (!model.inputs.startFrame && draft.startFrame) errors.push(`${model.displayName} does not support a start frame.`);
    if (!model.inputs.endFrame && draft.endFrame) errors.push(`${model.displayName} does not support an end frame.`);
    validateCatalogInputLimit(
      draft.references.length,
      model.inputs.imageReferences,
      `${model.displayName} does not support image references.`,
      (max) => `${model.displayName} supports up to ${max} image references.`,
      errors
    );
    validateCatalogInputLimit(
      draft.referenceVideos.length,
      model.inputs.videoReferences,
      `${model.displayName} does not support reference videos.`,
      (max) => `${model.displayName} supports up to ${max} video references.`,
      errors
    );
    validateCatalogInputLimit(
      draft.referenceAudios.length,
      model.inputs.audioReferences,
      `${model.displayName} does not support reference audio.`,
      (max) => `${model.displayName} supports up to ${max} audio references.`,
      errors
    );
    validateCatalogInputLimit(
      preparedAudioIds(draft).length,
      model.inputs.preparedAudioReferences ?? null,
      `${model.displayName} does not support prepared voice references.`,
      (max) => `${model.displayName} supports up to ${max} prepared voice references.`,
      errors
    );
    validateCatalogInputLimit(
      characterIds(draft).length,
      model.inputs.characterReferences ?? null,
      `${model.displayName} does not support prepared character references.`,
      (max) => `${model.displayName} supports up to ${max} prepared character references.`,
      errors
    );
  }

  const references = draft.tool === 'image'
    ? draft.references
    : draft.tool === 'video'
      ? [
          ...draft.references,
          ...(model.id === 'kling-3.0-video' && draft.referenceMode === 'elements' ? draft.referenceVideos : []),
        ]
      : [];
  const knownHandles = references.map((reference) => reference.handle).filter((handle): handle is string => Boolean(handle));
  const unknownHandles = extractHandles(draft.prompt).filter((handle) => !knownHandles.includes(handle));
  if (unknownHandles.length > 0) errors.push(`Unknown element mention${unknownHandles.length === 1 ? '' : 's'}: ${unknownHandles.join(', ')}`);

  const hasServerQuote = typeof options.quotedCost === 'number' && Number.isFinite(options.quotedCost);
  const cost = hasServerQuote ? options.quotedCost as number : 0;
  if (typeof options.credits === 'number' && hasServerQuote && options.credits < cost) {
    errors.push(`Insufficient credits. This generation costs ${cost} credits.`);
  }
  return { errors, warnings: [], cost, canGenerate: errors.length === 0 && hasServerQuote };
}

export function buildCatalogQuoteRequest(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string
): GenerationModelQuoteRequest {
  const settings = Object.fromEntries(model.controls.map((control) => [control.key, currentControlValue(draft, control) ?? control.defaultValue]));
  if (draft.tool === 'video') settings.referenceMode = draft.referenceMode;
  if (draft.tool === 'image') {
    return { kind: 'image', modelId: model.id, settings, inputCounts: { images: draft.references.length, videos: 0, audios: 0 }, catalogRevision };
  }
  if (draft.tool === 'video') {
    const usesReusableReferences = draft.referenceMode === 'elements';
    return {
      kind: 'video',
      modelId: model.id,
      settings,
      inputCounts: {
        images: usesReusableReferences
          ? draft.references.length
          : (draft.startFrame ? 1 : 0) + (!draft.isMultiShot && draft.endFrame ? 1 : 0),
        videos: usesReusableReferences ? draft.referenceVideos.length : 0,
        audios: usesReusableReferences ? draft.referenceAudios.length : 0,
        preparedAudios: usesReusableReferences ? preparedAudioIds(draft).length : 0,
        characters: usesReusableReferences ? characterIds(draft).length : 0,
      },
      catalogRevision,
    };
  }
  return {
    kind: 'motion',
    modelId: model.id,
    settings,
    inputCounts: { images: draft.characterImage ? 1 : 0, videos: draft.referenceVideo ? 1 : 0, audios: 0 },
    catalogRevision,
  };
}

function elementDescriptors(draft: ImageCreationDraft | VideoCreationDraft): GenerationElementDescriptor[] {
  return draft.references
    .filter((reference): reference is typeof reference & { handle: string } => typeof reference.handle === 'string' && reference.handle.length > 0)
    .map((reference) => ({
      id: reference.id,
      displayName: reference.displayName,
      handle: reference.handle,
      storagePath: reference.storagePath ?? null,
      sourceGenerationId: reference.sourceGenerationId ?? null,
    }));
}

function mediaDescriptor(media: ImageCreationDraft['references'][number] | null): RemixMediaAssetDescriptor | null {
  return media ? {
    url: media.url,
    storagePath: media.storagePath ?? null,
    mediaType: media.kind,
    fileName: media.fileName,
  } : null;
}

export function buildCatalogGenerationPayload(draft: ImageCreationDraft, model: GenerationModelDescriptor, catalogRevision: string, normalizedSettings?: Record<string, CatalogPrimitive>): ImageGenerationRequest;
export function buildCatalogGenerationPayload(draft: VideoCreationDraft, model: GenerationModelDescriptor, catalogRevision: string, normalizedSettings?: Record<string, CatalogPrimitive>): VideoGenerationRequest;
export function buildCatalogGenerationPayload(draft: MotionCreationDraft, model: GenerationModelDescriptor, catalogRevision: string, normalizedSettings?: Record<string, CatalogPrimitive>): MotionGenerationRequest;
export function buildCatalogGenerationPayload(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
  normalizedSettings: Record<string, CatalogPrimitive> = {},
): ImageGenerationRequest | VideoGenerationRequest | MotionGenerationRequest {
  if (draft.tool === 'image') {
    const hasQualityControl = model.controls.some((control) => control.key === 'qualityMode');
    return {
      model: model.id,
      prompt: draft.prompt.trim(),
      imageUrls: draft.references.map((reference) => reference.url),
      elements: elementDescriptors(draft),
      aspectRatio: draft.aspectRatio,
      resolution: draft.resolution,
      qualityMode: hasQualityControl ? draft.qualityMode : undefined,
      outputFormat: model.capabilities.outputFormat ? draft.outputFormat : 'jpg',
      googleSearch: model.capabilities.googleSearch ? draft.googleSearch : false,
      sourceGenerationId: draft.sourceGenerationId ?? null,
      catalogRevision,
      settings: normalizedSettings,
    };
  }
  if (draft.tool === 'video') {
    const usesReusableReferences = draft.referenceMode === 'elements';
    const usesKlingVideoElements = usesReusableReferences && model.id === 'kling-3.0-video';
    const activeReferences = usesReusableReferences ? draft.references : [];
    const imageUrls = activeReferences.map((reference) => reference.url);
    return {
      model: model.id,
      isMultiShot: model.capabilities.multiShot ? draft.isMultiShot : false,
      prompt: draft.prompt.trim(),
      multiPrompts: draft.isMultiShot ? draft.multiPrompts.map((shot, index) => ({
        id: shot.id || `shot-${index + 1}`,
        prompt: shot.prompt.trim(),
        duration: Math.max(1, Math.round(shot.duration || 5)),
      })) : undefined,
      elements: usesReusableReferences ? elementDescriptors(draft) : [],
      elementImageUrls: imageUrls,
      imageUrls,
      referenceVideoUrls: usesReusableReferences && !usesKlingVideoElements ? draft.referenceVideos.map((media) => media.url) : [],
      klingVideoElements: usesKlingVideoElements ? draft.referenceVideos.map((media) => ({
        id: media.id,
        url: media.url,
        handle: media.handle ?? null,
        displayName: media.displayName,
        storagePath: media.storagePath ?? null,
        sourceGenerationId: media.sourceGenerationId ?? null,
      })) : [],
      referenceAudioUrls: usesReusableReferences ? draft.referenceAudios.map((media) => media.url) : [],
      preparedAudioIds: usesReusableReferences ? preparedAudioIds(draft) : [],
      characterIds: usesReusableReferences ? characterIds(draft) : [],
      startImageUrl: usesReusableReferences && !model.inputs.combineFramesWithReferences ? null : draft.startFrame?.url ?? null,
      endImageUrl: usesReusableReferences || draft.isMultiShot ? null : draft.endFrame?.url ?? null,
      startFrame: usesReusableReferences && !model.inputs.combineFramesWithReferences ? null : mediaDescriptor(draft.startFrame),
      endFrame: usesReusableReferences || draft.isMultiShot ? null : mediaDescriptor(draft.endFrame),
      mode: draft.mode,
      aspectRatio: draft.aspectRatio,
      sound: model.capabilities.sound ? draft.sound : false,
      duration: draft.duration,
      resolution: draft.resolution,
      fixedLens: model.capabilities.fixedLens ? draft.fixedLens : false,
      referenceMode: draft.referenceMode,
      seedanceAssets: null,
      sourceGenerationId: draft.sourceGenerationId ?? null,
      catalogRevision,
      settings: normalizedSettings,
    };
  }
  return {
    model: model.id,
    prompt: draft.prompt.trim(),
    referenceVideoUrl: draft.referenceVideo?.url ?? '',
    characterImageUrl: draft.characterImage?.url ?? '',
    duration: Math.max(1, Math.ceil(draft.referenceVideo?.durationSeconds ?? draft.duration)),
    characterOrientation: draft.characterOrientation,
    mode: draft.mode,
    characterImage: mediaDescriptor(draft.characterImage),
    referenceVideo: mediaDescriptor(draft.referenceVideo),
    sourceGenerationId: draft.sourceGenerationId ?? null,
    catalogRevision,
    settings: normalizedSettings,
  };
}
