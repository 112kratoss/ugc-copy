import type {
  CatalogGenerationInputAsset,
  CatalogGenerationRequest,
  CatalogControl,
  CatalogInputConstraint,
  CatalogInputSlot,
  CatalogPrimitive,
  GenerationModelCatalog,
  GenerationModelDescriptor,
  GenerationModelQuoteRequest,
} from './generation-model-catalog';
import {
  catalogConditionsMatch,
  getActiveCatalogInputSlots,
  getCatalogDefaultModel,
  getCatalogModel,
  normalizeCatalogSettings,
} from './generation-model-catalog';
import {
  hydrateCreationDraftFromRemixSource,
  type CatalogDraftInputAsset,
  type CatalogDraftInputSlots,
  type CreationDraft,
  type CreationSectionSummary,
  type CreationValidationResult,
  type ImageCreationDraft,
  type MediaDraft,
  type MotionCreationDraft,
  type VideoCreationDraft,
} from './media-creation-view-model';
import type {
  GenerationElementDescriptor,
  ImageGenerationRequest,
  MotionGenerationRequest,
  RemixMediaAssetDescriptor,
  RemixSourceBundle,
  VideoGenerationRequest,
} from './types';

function draftKey(draft: CreationDraft, controlKey: string) {
  return draft.tool === 'motion' && controlKey === 'resolution' ? 'mode' : controlKey;
}

function currentControlValue(draft: CreationDraft, control: CatalogControl): CatalogPrimitive | undefined {
  const value = (draft as unknown as Record<string, unknown>)[draftKey(draft, control.key)];
  if (control.type === 'choice') {
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') return value;
    const catalogValue = draft.catalogSettings?.[control.key];
    return typeof catalogValue === 'string' ? catalogValue : undefined;
  }
  if (control.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    const catalogValue = draft.catalogSettings?.[control.key];
    return typeof catalogValue === 'boolean' ? catalogValue : undefined;
  }
  if (typeof value === 'number') return value;
  const catalogValue = draft.catalogSettings?.[control.key];
  return typeof catalogValue === 'number' ? catalogValue : undefined;
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
  return typeof current === 'number'
    && Number.isInteger(current)
    && current >= control.min
    && current <= control.max
    && (current - control.min) % control.step === 0
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

export function getCatalogDraftSettings(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
): Record<string, CatalogPrimitive> {
  const current = { ...(draft.catalogSettings ?? {}) };
  for (const control of model.controls) {
    const value = currentControlValue(draft, control);
    if (value !== undefined) current[control.key] = value;
  }
  return normalizeCatalogSettings(model, current);
}

function mediaDraftAsset(media: MediaDraft): CatalogDraftInputAsset {
  return {
    id: media.id,
    kind: media.kind,
    url: media.url,
    storagePath: media.storagePath ?? null,
    fileName: media.fileName,
    displayName: media.displayName,
    handle: media.handle ?? null,
    durationSeconds: media.durationSeconds ?? null,
    sourceGenerationId: media.sourceGenerationId ?? null,
  };
}

function idOnlyAsset(id: string, kind: 'character' | 'prepared-voice'): CatalogDraftInputAsset {
  return { id, kind };
}

function legacyAssetsForSlot(
  draft: CreationDraft,
  slot: CatalogInputSlot,
): CatalogDraftInputAsset[] {
  if (slot.role === 'startFrame') {
    return draft.tool === 'video' && draft.startFrame ? [mediaDraftAsset(draft.startFrame)] : [];
  }
  if (slot.role === 'endFrame') {
    return draft.tool === 'video' && draft.endFrame ? [mediaDraftAsset(draft.endFrame)] : [];
  }
  if (slot.kind === 'image') {
    if (draft.tool === 'image' || draft.tool === 'video') return draft.references.map(mediaDraftAsset);
    return draft.characterImage ? [mediaDraftAsset(draft.characterImage)] : [];
  }
  if (slot.kind === 'video') {
    if (draft.tool === 'video') return draft.referenceVideos.map(mediaDraftAsset);
    if (draft.tool === 'motion' && draft.referenceVideo) return [mediaDraftAsset(draft.referenceVideo)];
    return [];
  }
  if (slot.kind === 'audio') {
    return draft.tool === 'video' ? draft.referenceAudios.map(mediaDraftAsset) : [];
  }
  if (slot.kind === 'preparedVoice') {
    return draft.tool === 'video'
      ? preparedAudioIds(draft).map((id) => idOnlyAsset(id, 'prepared-voice'))
      : [];
  }
  return draft.tool === 'video'
    ? characterIds(draft).map((id) => idOnlyAsset(id, 'character'))
    : [];
}

export function buildCatalogDraftInputSlots(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  settings: Record<string, CatalogPrimitive> = getCatalogDraftSettings(draft, model),
): CatalogDraftInputSlots {
  const knownCounts = Object.fromEntries((model.inputModes ?? [])
    .flatMap((mode) => mode.slots)
    .map((slot) => {
      const assets = draft.catalogInputSlots?.[slot.key] ?? legacyAssetsForSlot(draft, slot);
      return [slot.key, assets.length];
    }));
  const slots = getActiveCatalogInputSlots(model, settings, knownCounts);
  return Object.fromEntries(slots.map((slot) => {
    const existing = draft.catalogInputSlots?.[slot.key];
    const assets = existing ?? legacyAssetsForSlot(draft, slot);
    return [slot.key, assets];
  }));
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

export function applyCatalogModelDefaults(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string | null = draft.catalogRevision ?? null,
): CreationDraft {
  const values = writeControlValues(draft, model);
  const catalogSettings = getCatalogDraftSettings(draft, model);
  const allInputSlots = new Map((model.inputModes ?? [])
    .flatMap((mode) => mode.slots)
    .map((slot) => [slot.key, slot]));
  const catalogInputSlots = draft.catalogInputSlots === undefined
    ? undefined
    : Object.fromEntries(Object.entries(draft.catalogInputSlots)
      .flatMap(([slotKey, assets]) => {
        const slot = allInputSlots.get(slotKey);
        return slot ? [[slotKey, assets.slice(0, slot.max)] as const] : [];
      }));
  if (draft.tool === 'image') {
    return {
      ...draft,
      ...values,
      model: model.id,
      catalogRevision,
      catalogSettings,
      ...(catalogInputSlots ? { catalogInputSlots } : {}),
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
      model: model.id,
      catalogRevision,
      catalogSettings,
      ...(catalogInputSlots ? { catalogInputSlots } : {}),
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
    model: model.id,
    catalogRevision,
    catalogSettings,
    ...(catalogInputSlots ? { catalogInputSlots } : {}),
  } as MotionCreationDraft;
}

export function applyCatalogModelInitialDefaults(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
): CreationDraft {
  const descriptorDefaults = Object.fromEntries(model.controls.map((control) => [
    draftKey(draft, control.key),
    control.key === 'duration' && control.type === 'choice'
      ? Number(control.defaultValue)
      : control.defaultValue,
  ]));
  return applyCatalogModelDefaults({
    ...draft,
    ...descriptorDefaults,
    model: model.id,
    catalogSettings: {},
  } as CreationDraft, model, catalogRevision);
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
    if (control.type === 'boolean' && typeof value !== 'boolean') {
      errors.push(`${control.label} must be on or off.`);
    }
    if (
      control.type === 'integer'
      && (
        typeof value !== 'number'
        || !Number.isInteger(value)
        || value < control.min
        || value > control.max
        || (value - control.min) % control.step !== 0
      )
    ) {
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

function catalogInputConstraintValue(
  constraint: CatalogInputConstraint,
  slots: CatalogDraftInputSlots,
) {
  if (constraint.type === 'combined-duration') {
    return constraint.slotKeys.reduce((total, slotKey) => (
      total + (slots[slotKey] ?? []).reduce((slotTotal, asset) => (
        slotTotal + Math.max(0, asset.durationSeconds ?? 0)
      ), 0)
    ), 0);
  }
  return constraint.slotKeys.reduce((total, slotKey) => {
    const count = slots[slotKey]?.length ?? 0;
    const weight = constraint.type === 'weighted-count'
      ? constraint.weights?.[slotKey] ?? 1
      : 1;
    return total + count * weight;
  }, 0);
}

function validateCatalogV2Inputs(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  errors: string[],
) {
  const settings = getCatalogDraftSettings(draft, model);
  if (draft.tool === 'video') settings.referenceMode = draft.referenceMode;
  const slots = buildCatalogDraftInputSlots(draft, model, settings);
  const inputCounts = Object.fromEntries(
    Object.entries(slots).map(([key, assets]) => [key, assets.length]),
  );
  for (const slot of getActiveCatalogInputSlots(model, settings, inputCounts)) {
    const assets = slots[slot.key] ?? [];
    if (assets.length < slot.min) {
      errors.push(`${slot.label} requires at least ${slot.min} input${slot.min === 1 ? '' : 's'}.`);
    }
    if (assets.length > slot.max) {
      errors.push(`${slot.label} supports up to ${slot.max} input${slot.max === 1 ? '' : 's'}.`);
    }
    for (const asset of assets) {
      if (slot.durationMetadata === 'required' && !(typeof asset.durationSeconds === 'number' && asset.durationSeconds >= 0)) {
        errors.push(`${slot.label} requires duration metadata.`);
      }
      if (
        typeof slot.maxDurationSeconds === 'number'
        && typeof asset.durationSeconds === 'number'
        && asset.durationSeconds > slot.maxDurationSeconds
      ) {
        errors.push(`${slot.label} inputs must be ${slot.maxDurationSeconds} seconds or shorter.`);
      }
    }
  }
  for (const constraint of model.inputConstraints ?? []) {
    if (!catalogConditionsMatch(constraint.conditions, settings, inputCounts)) continue;
    if (catalogInputConstraintValue(constraint, slots) > constraint.max) {
      errors.push(constraint.message);
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
  if (model.inputModes) {
    validateCatalogV2Inputs(draft, model, errors);
  } else if (draft.tool === 'image') {
    validateCatalogInputLimit(
      draft.references.length,
      model.inputs.imageReferences,
      `${model.displayName} does not support image references.`,
      (max) => `${model.displayName} supports up to ${max} total reference images.`,
      errors
    );
  }
  if (!model.inputModes && draft.tool === 'video') {
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
  const settings = getCatalogDraftSettings(draft, model);
  if (draft.tool === 'video') settings.referenceMode = draft.referenceMode;
  const inputSlots = buildCatalogDraftInputSlots(draft, model, settings);
  const inputMetadataSlots = Object.fromEntries(Object.entries(inputSlots).map(([slotKey, assets]) => {
    const durationsSeconds = assets
      .map((asset) => asset.durationSeconds)
      .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
    return [slotKey, {
      count: assets.length,
      ...(durationsSeconds.length > 0 ? { durationsSeconds } : {}),
    }];
  }));
  const v2ReferenceVideoDurations = getActiveCatalogInputSlots(model, settings)
    .filter((slot) => slot.kind === 'video' && slot.role === 'reference')
    .flatMap((slot) => inputSlots[slot.key] ?? [])
    .map((asset) => asset.durationSeconds)
    .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration));
  const legacyReferenceVideoDurations = draft.tool === 'video'
    ? draft.referenceVideos
      .map((asset) => asset.durationSeconds)
      .filter((duration): duration is number => typeof duration === 'number' && Number.isFinite(duration))
    : draft.tool === 'motion' && typeof draft.referenceVideo?.durationSeconds === 'number'
      ? [draft.referenceVideo.durationSeconds]
      : [];
  const referenceVideoDurationsSeconds = v2ReferenceVideoDurations.length > 0
    ? v2ReferenceVideoDurations
    : legacyReferenceVideoDurations;
  const inputMetadata = {
    slots: inputMetadataSlots,
    ...(referenceVideoDurationsSeconds.length > 0 ? { referenceVideoDurationsSeconds } : {}),
  };
  const schemaVersion = model.inputModes ? 2 as const : 1 as const;
  if (draft.tool === 'image') {
    return {
      schemaVersion,
      kind: 'image',
      modelId: model.id,
      settings,
      inputCounts: { images: draft.references.length, videos: 0, audios: 0 },
      inputMetadata,
      catalogRevision,
    };
  }
  if (draft.tool === 'video') {
    const usesReusableReferences = draft.referenceMode === 'elements';
    return {
      schemaVersion,
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
      inputMetadata,
      catalogRevision,
    };
  }
  return {
    schemaVersion,
    kind: 'motion',
    modelId: model.id,
    settings,
    inputCounts: { images: draft.characterImage ? 1 : 0, videos: draft.referenceVideo ? 1 : 0, audios: 0 },
    inputMetadata,
    catalogRevision,
  };
}

function generationInputKind(
  slot: CatalogInputSlot,
): CatalogGenerationInputAsset['kind'] {
  return slot.kind;
}

export function buildUnifiedCatalogGenerationRequest(
  draft: CreationDraft,
  model: GenerationModelDescriptor,
  catalogRevision: string,
  normalizedSettings?: Record<string, CatalogPrimitive>,
): CatalogGenerationRequest {
  const settings = normalizedSettings
    ? normalizeCatalogSettings(model, normalizedSettings)
    : getCatalogDraftSettings(draft, model);
  if (draft.tool === 'video' && !('referenceMode' in settings)) {
    settings.referenceMode = draft.referenceMode;
  }
  const inputSlots = buildCatalogDraftInputSlots(draft, model, settings);
  const slotDescriptors = new Map(
    getActiveCatalogInputSlots(model, settings).map((slot) => [slot.key, slot]),
  );
  const inputs = Object.entries(inputSlots).flatMap(([slotKey, assets]) => {
    const slot = slotDescriptors.get(slotKey);
    if (!slot) return [];
    return assets.map((asset): CatalogGenerationInputAsset => ({
      slot: slotKey,
      kind: generationInputKind(slot),
      url: asset.url ?? null,
      ...(slot.kind === 'character' || slot.kind === 'preparedVoice'
        ? { assetId: asset.id }
        : {}),
      storagePath: asset.storagePath ?? null,
      label: asset.displayName ?? asset.fileName ?? null,
      handle: asset.handle ?? null,
      durationSeconds: asset.durationSeconds ?? null,
      sourceGenerationId: asset.sourceGenerationId ?? null,
    }));
  });
  return {
    kind: draft.tool,
    modelId: model.id,
    catalogRevision,
    settings,
    prompt: draft.prompt.trim(),
    ...(draft.tool === 'video' && draft.isMultiShot
      ? {
          shots: draft.multiPrompts.map((shot) => ({
            prompt: shot.prompt.trim(),
            duration: Math.max(1, Math.round(shot.duration || 0)),
          })),
        }
      : {}),
    inputs,
    sourceGenerationId: draft.sourceGenerationId ?? null,
  };
}

export interface CatalogDraftReconciliation {
  draft: CreationDraft;
  model: GenerationModelDescriptor | null;
  switchedModel: boolean;
  previousModelId: string;
  discardedSettingKeys: string[];
  warning: string | null;
}

export function reconcileCreationDraftWithCatalog(
  draft: CreationDraft,
  catalog: GenerationModelCatalog,
): CatalogDraftReconciliation {
  const previousModelId = draft.model;
  const existing = getCatalogModel(catalog, previousModelId);
  const selected = existing?.kind === draft.tool
    && existing.minClientSchemaVersion <= catalog.schemaVersion
    && (catalog.schemaVersion === 1 || existing.availability?.mobile)
    ? existing
    : getCatalogDefaultModel(catalog, draft.tool);
  if (!selected) {
    return {
      draft,
      model: null,
      switchedModel: false,
      previousModelId,
      discardedSettingKeys: [],
      warning: `No ${draft.tool} generation model is currently available.`,
    };
  }

  const sourceSettings = { ...(draft.catalogSettings ?? {}) };
  for (const control of selected.controls) {
    const current = currentControlValue(draft, control);
    if (current !== undefined) sourceSettings[control.key] = current;
  }
  const normalizedSettings = normalizeCatalogSettings(selected, sourceSettings);
  const discardedSettingKeys = Object.keys(sourceSettings).filter((key) => !(key in normalizedSettings));
  const reconciled = applyCatalogModelDefaults({
    ...draft,
    model: selected.id,
    catalogRevision: catalog.revision,
    catalogSettings: normalizedSettings,
    ...(draft.catalogInputSlots === undefined
      ? {}
      : { catalogInputSlots: draft.catalogInputSlots }),
  } as CreationDraft, selected, catalog.revision);
  const switchedModel = selected.id !== previousModelId;
  const retiredModelWarning = switchedModel
    ? `Your previous ${draft.tool} model is no longer available. Switched to ${selected.displayName}.`
    : null;
  const discardedSettingsWarning = discardedSettingKeys.length > 0
    ? `Some saved settings are no longer supported and were reset: ${discardedSettingKeys.join(', ')}.`
    : null;
  return {
    draft: reconciled,
    model: selected,
    switchedModel,
    previousModelId,
    discardedSettingKeys,
    warning: [retiredModelWarning, discardedSettingsWarning].filter(Boolean).join(' ') || null,
  };
}

function remixCatalogSettings(
  bundle: RemixSourceBundle,
  model: GenerationModelDescriptor,
): Record<string, CatalogPrimitive> {
  const nested = bundle.workflowSettings.settings;
  const nestedRecord = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : {};
  const settings: Record<string, CatalogPrimitive> = {};
  for (const control of model.controls) {
    const value = nestedRecord[control.key] ?? bundle.workflowSettings[control.key];
    if (
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    ) {
      settings[control.key] = value;
    }
  }
  return normalizeCatalogSettings(model, settings);
}

export function hydrateCatalogCreationDraftFromRemixSource(
  baseDraft: CreationDraft,
  bundle: RemixSourceBundle,
  catalog: GenerationModelCatalog,
): {
  draft: CreationDraft;
  model: GenerationModelDescriptor | null;
  warning: string | null;
  switchedModel: boolean;
} {
  const requestedModelId = typeof bundle.workflowSettings.model === 'string'
    ? bundle.workflowSettings.model
    : bundle.generation.model;
  const requestedModel = getCatalogModel(catalog, requestedModelId);
  const model = requestedModel?.kind === baseDraft.tool
    && requestedModel.minClientSchemaVersion <= catalog.schemaVersion
    && (catalog.schemaVersion === 1 || requestedModel.availability?.mobile)
    ? requestedModel
    : getCatalogDefaultModel(catalog, baseDraft.tool);
  if (!model) {
    return {
      draft: baseDraft,
      model: null,
      warning: `No ${baseDraft.tool} generation model is currently available.`,
      switchedModel: false,
    };
  }

  // The legacy hydrator restores signed media descriptors. Catalog model
  // selection and settings are deliberately reapplied afterwards so a remote
  // id never has to exist in the bundled registry.
  const legacyBundle = {
    ...bundle,
    workflowSettings: {
      ...bundle.workflowSettings,
      model: baseDraft.model,
    },
  } as RemixSourceBundle;
  const restored: { draft: CreationDraft; warning: string | null } = baseDraft.tool === 'image'
    ? hydrateCreationDraftFromRemixSource(baseDraft, legacyBundle)
    : baseDraft.tool === 'video'
      ? hydrateCreationDraftFromRemixSource(baseDraft, legacyBundle)
      : hydrateCreationDraftFromRemixSource(baseDraft, legacyBundle);
  const restoredCatalogSettings = remixCatalogSettings(bundle, model);
  const projectedControlValues = Object.fromEntries(model.controls.map((control) => {
    const value = restoredCatalogSettings[control.key] ?? control.defaultValue;
    return [
      draftKey(restored.draft, control.key),
      control.key === 'duration' && control.type === 'choice' ? Number(value) : value,
    ];
  }));
  const draft = applyCatalogModelDefaults({
    ...restored.draft,
    ...projectedControlValues,
    model: model.id,
    catalogRevision: catalog.revision,
    catalogSettings: restoredCatalogSettings,
  } as CreationDraft, model, catalog.revision);
  const switchedModel = model.id !== requestedModelId;
  const retirementWarning = switchedModel
    ? `${requestedModelId} is no longer available. Switched to ${model.displayName}.`
    : null;
  return {
    draft,
    model,
    warning: [retirementWarning, restored.warning].filter(Boolean).join(' ') || null,
    switchedModel,
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
