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
    return {
      ...draft,
      ...values,
      model: model.id as VideoCreationDraft['model'],
      isMultiShot: model.capabilities.multiShot ? Boolean(values.isMultiShot ?? draft.isMultiShot) : false,
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
      startFrame: model.inputs.startFrame ? draft.startFrame : null,
      endFrame: model.inputs.endFrame ? draft.endFrame : null,
      referenceMode: !model.inputs.startFrame && model.inputs.imageReferences ? 'elements' : draft.referenceMode,
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
    const count = draft.references.length + draft.referenceVideos.length + draft.referenceAudios.length + (draft.startFrame ? 1 : 0) + (draft.endFrame ? 1 : 0);
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
  if (draft.tool === 'image' && model.inputs.imageReferences && draft.references.length > model.inputs.imageReferences.max) {
    errors.push(`${model.displayName} supports up to ${model.inputs.imageReferences.max} total reference images.`);
  }
  if (draft.tool === 'video') {
    if (!model.capabilities.multiShot && draft.isMultiShot) errors.push(`${model.displayName} does not support multi-shot video generation.`);
    if (!model.inputs.startFrame && draft.startFrame) errors.push(`${model.displayName} does not support a start frame.`);
    if (!model.inputs.endFrame && draft.endFrame) errors.push(`${model.displayName} does not support an end frame.`);
    if (model.inputs.imageReferences && draft.references.length > model.inputs.imageReferences.max) errors.push(`${model.displayName} supports up to ${model.inputs.imageReferences.max} image references.`);
    if (model.inputs.videoReferences && draft.referenceVideos.length > model.inputs.videoReferences.max) errors.push(`${model.displayName} supports up to ${model.inputs.videoReferences.max} video references.`);
    if (model.inputs.audioReferences && draft.referenceAudios.length > model.inputs.audioReferences.max) errors.push(`${model.displayName} supports up to ${model.inputs.audioReferences.max} audio references.`);
  }

  const references = draft.tool === 'image' ? draft.references : draft.tool === 'video' ? draft.references : [];
  const knownHandles = references.map((reference) => reference.handle).filter((handle): handle is string => Boolean(handle));
  const unknownHandles = extractHandles(draft.prompt).filter((handle) => !knownHandles.includes(handle));
  if (unknownHandles.length > 0) errors.push(`Unknown element mention${unknownHandles.length === 1 ? '' : 's'}: ${unknownHandles.join(', ')}`);

  const cost = options.quotedCost ?? 0;
  if (typeof options.credits === 'number' && options.quotedCost !== null && options.quotedCost !== undefined && options.credits < cost) {
    errors.push(`Insufficient credits. This generation costs ${cost} credits.`);
  }
  return { errors, warnings: [], cost, canGenerate: errors.length === 0 && options.quotedCost !== null };
}

export function buildCatalogQuoteRequest(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string
): GenerationModelQuoteRequest {
  const settings = Object.fromEntries(model.controls.map((control) => [control.key, currentControlValue(draft, control) ?? control.defaultValue]));
  if (draft.tool === 'image') {
    return { kind: 'image', modelId: model.id, settings, inputCounts: { images: draft.references.length, videos: 0, audios: 0 }, catalogRevision };
  }
  if (draft.tool === 'video') {
    return {
      kind: 'video',
      modelId: model.id,
      settings,
      inputCounts: {
        images: draft.references.length + (draft.startFrame ? 1 : 0) + (draft.endFrame ? 1 : 0),
        videos: draft.referenceVideos.length,
        audios: draft.referenceAudios.length,
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

export function buildCatalogGenerationPayload(draft: ImageCreationDraft, model: GenerationModelDescriptor, catalogRevision: string): ImageGenerationRequest;
export function buildCatalogGenerationPayload(draft: VideoCreationDraft, model: GenerationModelDescriptor, catalogRevision: string): VideoGenerationRequest;
export function buildCatalogGenerationPayload(draft: MotionCreationDraft, model: GenerationModelDescriptor, catalogRevision: string): MotionGenerationRequest;
export function buildCatalogGenerationPayload(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string
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
    };
  }
  if (draft.tool === 'video') {
    const imageUrls = draft.references.map((reference) => reference.url);
    return {
      model: model.id,
      isMultiShot: model.capabilities.multiShot ? draft.isMultiShot : false,
      prompt: draft.prompt.trim(),
      multiPrompts: draft.isMultiShot ? draft.multiPrompts.map((shot, index) => ({
        id: shot.id || `shot-${index + 1}`,
        prompt: shot.prompt.trim(),
        duration: Math.max(1, Math.round(shot.duration || 5)),
      })) : undefined,
      elements: elementDescriptors(draft),
      elementImageUrls: imageUrls,
      imageUrls,
      referenceVideoUrls: draft.referenceVideos.map((media) => media.url),
      referenceAudioUrls: draft.referenceAudios.map((media) => media.url),
      startImageUrl: draft.startFrame?.url ?? null,
      endImageUrl: draft.endFrame?.url ?? null,
      startFrame: mediaDescriptor(draft.startFrame),
      endFrame: mediaDescriptor(draft.endFrame),
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
  };
}
