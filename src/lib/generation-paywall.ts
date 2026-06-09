import { isValidElementHandle, normalizeSubmittedElementDescriptors } from '@/lib/image-elements';
import {
  IMAGE_MODELS,
  MOTION_MODELS,
  VIDEO_MODELS,
  type ImageModelId,
  type MotionModelId,
  type VideoModelId,
} from '@/lib/models';
import {
  getPostResourceKinds,
  type PostResourceItem,
  type PostResourceItemRole,
  type PostResourceItemType,
  type PostResourceRemixUse,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import type { GenerationInputMediaItem, GenerationInputMediaType } from '@/lib/generation-input-media';
import { normalizeRemixMediaAssetDescriptor } from '@/lib/remix-source';

export interface GenerationPaywallPrefill {
  resourceKinds: PostResourceKind[];
  promptText: string | null;
  notesMarkdown: string | null;
  allowRemix: boolean;
  referenceCount?: number;
  referenceKindCounts?: Partial<Record<GenerationInputMediaType, number>>;
}

export interface GenerationPaywallPrefillSource {
  category: string | null | undefined;
  model: string | null | undefined;
  prompt: string | null | undefined;
  workflowSettings: Record<string, unknown> | null | undefined;
  inputMedia?: GenerationInputMediaItem[] | null;
}

function trimText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function inferReferenceExtension(storagePath: string | null | undefined, mediaType: GenerationInputMediaType): string {
  const candidate = storagePath?.split('?')[0]?.split('.').pop()?.toLowerCase();
  if (candidate && /^[a-z0-9]{2,5}$/.test(candidate)) {
    return candidate;
  }

  if (mediaType === 'image') return 'jpg';
  if (mediaType === 'audio') return 'mp3';
  return 'mp4';
}

function inferReferenceContentType(storagePath: string | null | undefined, mediaType: GenerationInputMediaType): string {
  const extension = inferReferenceExtension(storagePath, mediaType);
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'webm') return 'video/webm';
  if (extension === 'wav') return 'audio/wav';
  if (extension === 'ogg') return 'audio/ogg';
  if (extension === 'flac') return 'audio/flac';
  if (extension === 'mp3') return 'audio/mpeg';
  if (mediaType === 'image') return 'image/jpeg';
  if (mediaType === 'audio') return 'audio/mpeg';
  return 'video/mp4';
}

function mapGenerationInputResourceType(item: GenerationInputMediaItem): PostResourceItemType {
  return item.mediaType === 'image' ? 'reference_image' : 'source_file';
}

function mapGenerationInputResourceRole(role: string): PostResourceItemRole {
  if (role === 'character_image') return 'character_reference';
  if (role === 'start_frame' || role === 'end_frame') return 'before_input';
  if (role === 'reference_video' || role === 'reference_audio' || role === 'motion_reference_video') {
    return 'supporting_workflow';
  }
  return 'style_reference';
}

function mapGenerationInputRemixUse(item: GenerationInputMediaItem): PostResourceRemixUse {
  return item.mediaType === 'image' ? 'reference_only' : 'none';
}

function getGenerationInputRecipeTitle(item: GenerationInputMediaItem, index: number): string {
  const metadata = item.metadata ?? {};
  const handle = typeof metadata.handle === 'string' ? metadata.handle.trim() : '';
  if (isValidElementHandle(handle)) {
    return handle;
  }

  return trimText(item.label) ?? `Reference ${index + 1}`;
}

export function buildGenerationRecipeResourceItems(source: {
  promptText: string | null | undefined;
  notesMarkdown: string | null | undefined;
  allowRemix: boolean;
  inputMedia?: GenerationInputMediaItem[] | null;
}): PostResourceItem[] {
  const items: PostResourceItem[] = [];
  const promptText = trimText(source.promptText);
  const notesMarkdown = trimText(source.notesMarkdown);

  if (promptText) {
    items.push({
      type: 'prompt',
      role: 'primary',
      sectionId: null,
      title: 'Prompt',
      description: null,
      textContent: promptText,
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: items.length,
      isPrimary: true,
      remixUse: 'none',
    });
  }

  for (const [index, item] of (source.inputMedia ?? []).entries()) {
    if (!item.storagePath) {
      continue;
    }

    items.push({
      type: mapGenerationInputResourceType(item),
      role: mapGenerationInputResourceRole(item.role),
      sectionId: null,
      title: getGenerationInputRecipeTitle(item, index),
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: item.storagePath,
      contentType: inferReferenceContentType(item.storagePath, item.mediaType),
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: items.length,
      isPrimary: items.length === 0,
      remixUse: mapGenerationInputRemixUse(item),
    });
  }

  if (notesMarkdown) {
    items.push({
      type: 'note',
      role: 'other',
      sectionId: null,
      title: 'Notes',
      description: null,
      textContent: notesMarkdown,
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: items.length,
      isPrimary: items.length === 0,
      remixUse: 'none',
    });
  }

  if (source.allowRemix) {
    items.push({
      type: 'remix_access',
      role: 'other',
      sectionId: null,
      title: 'Remix access',
      description: null,
      textContent: null,
      externalUrl: null,
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      sortOrder: items.length,
      isPrimary: items.length === 0,
      remixUse: 'direct_remix',
    });
  }

  return items;
}

function formatBooleanLabel(value: boolean): string {
  return value ? 'On' : 'Off';
}

function formatListCount(value: number, singular: string, plural: string): string | null {
  if (value <= 0) {
    return null;
  }

  return `${value} ${value === 1 ? singular : plural}`;
}

function formatModeLabel(modelId: string | null, mode: string | null): string | null {
  if (!modelId || !mode || !(modelId in VIDEO_MODELS)) {
    return mode;
  }

  const option = VIDEO_MODELS[modelId as VideoModelId].modeOptions.find((candidate) => candidate.value === mode);
  return option?.label ?? mode;
}

function getModelDisplayName(category: string | null | undefined, workflowSettings: Record<string, unknown>, model: string | null | undefined): string | null {
  const workflowModel = typeof workflowSettings.model === 'string' ? workflowSettings.model : null;

  if (workflowModel) {
    if (workflowModel in IMAGE_MODELS) {
      return IMAGE_MODELS[workflowModel as ImageModelId].displayName;
    }
    if (workflowModel in VIDEO_MODELS) {
      return VIDEO_MODELS[workflowModel as VideoModelId].displayName;
    }
    if (workflowModel in MOTION_MODELS) {
      return MOTION_MODELS[workflowModel as MotionModelId].displayName;
    }
    return workflowModel;
  }

  if (!model) {
    return null;
  }

  if (category === 'image') {
    const imageModel = Object.values(IMAGE_MODELS).find((candidate) => candidate.id === model);
    if (imageModel) {
      return imageModel.displayName;
    }
  }

  if (category === 'video' || category === 'ugc-ad') {
    const videoModel = Object.values(VIDEO_MODELS).find(
      (candidate) => candidate.id === model || candidate.apiModelId === model
    );
    if (videoModel) {
      return videoModel.displayName;
    }
  }

  if (category === 'motion') {
    const motionModel = Object.values(MOTION_MODELS).find(
      (candidate) => candidate.id === model || candidate.apiModelId === model
    );
    if (motionModel) {
      return motionModel.displayName;
    }
  }

  return model;
}

function hasRecoverableDescriptor(value: unknown, expectedKind: 'image' | 'video'): boolean {
  const descriptor = normalizeRemixMediaAssetDescriptor(value, expectedKind);
  return Boolean(descriptor?.storagePath || descriptor?.sourceGenerationId);
}

function countRecoverableDescriptors(value: unknown): number {
  return normalizeSubmittedElementDescriptors(value).filter((element) => element.storagePath || element.sourceGenerationId).length;
}

function getSavedReferenceKindCounts(
  inputMedia: GenerationInputMediaItem[] | null | undefined
): Partial<Record<GenerationInputMediaType, number>> {
  const counts: Partial<Record<GenerationInputMediaType, number>> = {};

  for (const item of inputMedia ?? []) {
    if (!item.storagePath) {
      continue;
    }

    counts[item.mediaType] = (counts[item.mediaType] ?? 0) + 1;
  }

  return counts;
}

function getSavedReferenceCount(kindCounts: Partial<Record<GenerationInputMediaType, number>>): number {
  return Object.values(kindCounts).reduce((total, count) => total + (count ?? 0), 0);
}

export function hasRecoverableGenerationRemixInputs(source: GenerationPaywallPrefillSource): boolean {
  const workflowSettings =
    source.workflowSettings && typeof source.workflowSettings === 'object' ? source.workflowSettings : {};

  if (source.category === 'image') {
    return countRecoverableDescriptors(workflowSettings.elements) > 0;
  }

  if (source.category === 'video' || source.category === 'ugc-ad') {
    return (
      countRecoverableDescriptors(workflowSettings.elements) > 0 ||
      countRecoverableDescriptors(workflowSettings.klingVideoElements) > 0 ||
      hasRecoverableDescriptor(workflowSettings.startFrame, 'image') ||
      hasRecoverableDescriptor(workflowSettings.endFrame, 'image')
    );
  }

  if (source.category === 'motion') {
    return (
      hasRecoverableDescriptor(workflowSettings.characterImage, 'image') &&
      hasRecoverableDescriptor(workflowSettings.referenceVideo, 'video')
    );
  }

  return false;
}

function buildImageNotes(modelLabel: string | null, workflowSettings: Record<string, unknown>): string[] {
  const details: string[] = [];
  const referenceCount = countRecoverableDescriptors(workflowSettings.elements);

  if (modelLabel) {
    details.push(`Model: ${modelLabel}`);
  }

  if (typeof workflowSettings.aspectRatio === 'string') {
    details.push(`Aspect ratio: ${workflowSettings.aspectRatio}`);
  }

  if (typeof workflowSettings.resolution === 'string') {
    details.push(`Resolution: ${workflowSettings.resolution}`);
  }

  if (typeof workflowSettings.outputFormat === 'string') {
    details.push(`Output format: ${workflowSettings.outputFormat.toUpperCase()}`);
  }

  if (typeof workflowSettings.googleSearch === 'boolean') {
    details.push(`Google Search grounding: ${formatBooleanLabel(workflowSettings.googleSearch)}`);
  }

  const referencesLabel = formatListCount(referenceCount, 'saved reference', 'saved references');
  if (referencesLabel) {
    details.push(`Inputs: ${referencesLabel}`);
  }

  return details;
}

function buildVideoNotes(modelLabel: string | null, workflowSettings: Record<string, unknown>): string[] {
  const details: string[] = [];
  const frameCount = Number(hasRecoverableDescriptor(workflowSettings.startFrame, 'image')) +
    Number(hasRecoverableDescriptor(workflowSettings.endFrame, 'image'));
  const namedReferenceCount = countRecoverableDescriptors(workflowSettings.elements);
  const referenceVideoCount = Array.isArray(workflowSettings.referenceVideoUrls)
    ? workflowSettings.referenceVideoUrls.filter((value) => typeof value === 'string' && value.trim().length > 0).length
    : 0;
  const klingVideoElementCount = countRecoverableDescriptors(workflowSettings.klingVideoElements);
  const referenceAudioCount = Array.isArray(workflowSettings.referenceAudioUrls)
    ? workflowSettings.referenceAudioUrls.filter((value) => typeof value === 'string' && value.trim().length > 0).length
    : 0;

  if (modelLabel) {
    details.push(`Model: ${modelLabel}`);
  }

  if (typeof workflowSettings.aspectRatio === 'string') {
    details.push(`Aspect ratio: ${workflowSettings.aspectRatio}`);
  }

  if (typeof workflowSettings.duration === 'number' && Number.isFinite(workflowSettings.duration)) {
    details.push(`Duration: ${workflowSettings.duration}s`);
  }

  if (typeof workflowSettings.resolution === 'string') {
    details.push(`Resolution: ${workflowSettings.resolution}`);
  } else if (typeof workflowSettings.mode === 'string') {
    const workflowModel = typeof workflowSettings.model === 'string' ? workflowSettings.model : null;
    const modeLabel = formatModeLabel(workflowModel, workflowSettings.mode);
    if (modeLabel) {
      details.push(`Mode: ${modeLabel}`);
    }
  }

  if (typeof workflowSettings.referenceMode === 'string') {
    details.push(
      `Reference mode: ${
        workflowSettings.referenceMode === 'elements' ? 'Named references' : 'Frames'
      }`
    );
  }

  if (typeof workflowSettings.sound === 'boolean') {
    details.push(`Sound: ${formatBooleanLabel(workflowSettings.sound)}`);
  }

  if (typeof workflowSettings.fixedLens === 'boolean' && workflowSettings.fixedLens) {
    details.push('Camera: Fixed lens');
  }

  if (Array.isArray(workflowSettings.multiPrompts) && workflowSettings.multiPrompts.length > 0) {
    details.push(`Shot prompts: ${workflowSettings.multiPrompts.length}`);
  }

  const inputLabels = [
    formatListCount(frameCount, 'saved frame', 'saved frames'),
    formatListCount(namedReferenceCount, 'named reference', 'named references'),
    formatListCount(referenceVideoCount + klingVideoElementCount, 'video reference', 'video references'),
    formatListCount(referenceAudioCount, 'audio reference', 'audio references'),
  ].filter((value): value is string => Boolean(value));

  if (inputLabels.length > 0) {
    details.push(`Inputs: ${inputLabels.join(', ')}`);
  }

  return details;
}

function buildMotionNotes(modelLabel: string | null, workflowSettings: Record<string, unknown>): string[] {
  const details: string[] = [];
  const hasCharacterImage = hasRecoverableDescriptor(workflowSettings.characterImage, 'image');
  const hasReferenceVideo = hasRecoverableDescriptor(workflowSettings.referenceVideo, 'video');
  const inputs: string[] = [];

  if (modelLabel) {
    details.push(`Model: ${modelLabel}`);
  }

  if (typeof workflowSettings.duration === 'number' && Number.isFinite(workflowSettings.duration)) {
    details.push(`Duration: ${workflowSettings.duration}s`);
  }

  if (typeof workflowSettings.mode === 'string') {
    details.push(`Render mode: ${workflowSettings.mode}`);
  }

  if (typeof workflowSettings.characterOrientation === 'string') {
    details.push(`Character orientation: ${workflowSettings.characterOrientation}`);
  }

  if (hasCharacterImage) {
    inputs.push('character image');
  }

  if (hasReferenceVideo) {
    inputs.push('reference video');
  }

  if (inputs.length > 0) {
    details.push(`Inputs: ${inputs.join(' + ')}`);
  }

  return details;
}

export function buildGenerationPaywallNotes(source: GenerationPaywallPrefillSource): string | null {
  const workflowSettings =
    source.workflowSettings && typeof source.workflowSettings === 'object' ? source.workflowSettings : {};
  const modelLabel = getModelDisplayName(source.category, workflowSettings, source.model);

  const details =
    source.category === 'image'
      ? buildImageNotes(modelLabel, workflowSettings)
      : source.category === 'video' || source.category === 'ugc-ad'
        ? buildVideoNotes(modelLabel, workflowSettings)
        : source.category === 'motion'
          ? buildMotionNotes(modelLabel, workflowSettings)
          : [];

  if (details.length === 0) {
    return null;
  }

  return ['Saved generation setup', ...details].join('\n');
}

export function buildGenerationPaywallPrefill(
  source: GenerationPaywallPrefillSource
): GenerationPaywallPrefill | null {
  const promptText = trimText(source.prompt);
  const notesMarkdown = buildGenerationPaywallNotes(source);
  const allowRemix = hasRecoverableGenerationRemixInputs(source);
  const referenceKindCounts = getSavedReferenceKindCounts(source.inputMedia);
  const referenceCount = getSavedReferenceCount(referenceKindCounts);
  const resourceKinds = getPostResourceKinds({
    promptText,
    notesMarkdown,
    allowRemix,
  });
  const effectiveResourceKinds: PostResourceKind[] = referenceCount > 0 && !resourceKinds.includes('files')
    ? [...resourceKinds, 'files']
    : resourceKinds;

  if (!promptText && !notesMarkdown && !allowRemix && referenceCount === 0) {
    return null;
  }

  return {
    resourceKinds: effectiveResourceKinds,
    promptText,
    notesMarkdown,
    allowRemix,
    referenceCount,
    referenceKindCounts,
  };
}
