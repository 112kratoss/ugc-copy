import { isValidElementHandle, normalizeSubmittedElementDescriptors } from '@/lib/image-elements';
import {
  getPostResourceKinds,
  type PostResourceItem,
  type PostResourceItemRole,
  type PostResourceItemType,
  type PostResourceRemixUse,
  type PostResourceKind,
} from '@/lib/post-resource-bundles';
import type { GenerationInputMediaItem, GenerationInputMediaType } from '@/lib/generation-input-media';
import {
  isMotionGeneration,
  klingSubjectDescriptors,
  motionInputDescriptors,
  normalizeRemixMediaAssetDescriptor,
} from '@/lib/remix-source';

/**
 * What a recipe made from a creation starts from, on the owner's library entry (`/api/generations`).
 * Until 2026-11-03 it carried `notesMarkdown` too, the creation's "Saved generation setup", which
 * every new recipe took in as a protected note; the settings are the post's now, for everyone
 * (`buildPublicGenerationSetup`, owner's decision), and the field is gone. No installed app reads
 * the prefill, and a page running older code takes an answer without it as one with no notes.
 */
export interface GenerationPaywallPrefill {
  resourceKinds: PostResourceKind[];
  promptText: string | null;
  allowRemix: boolean;
  referenceCount?: number;
  referenceKindCounts?: Partial<Record<GenerationInputMediaType, number>>;
  /**
   * Of those, the creator's own (`generationInputOrigin`): their uploads and creations, as
   * against the references a remix brought from its original. The web creators' recipe leaves
   * them out unless the creator adds them. Absent where it was not worked out: then every
   * reference counts as the creator's own.
   */
  ownReferenceCount?: number;
  ownReferenceKindCounts?: Partial<Record<GenerationInputMediaType, number>>;
}

export interface GenerationPaywallPrefillSource {
  category: string | null | undefined;
  /** The generation's creation_mode: how a catalog-path motion generation says it is one. */
  creationMode?: string | null;
  prompt: string | null | undefined;
  workflowSettings: Record<string, unknown> | null | undefined;
  inputMedia?: GenerationInputMediaItem[] | null;
  /** The ids of `inputMedia` that are the creator's own (`generationInputOrigin`). */
  ownInputIds?: ReadonlySet<string>;
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

// A clip or a sound is a reference like a picture, as the copy a recipe stores
// at publish types it (`post-resource-bundles-server.ts`): typed a source file,
// the app gave the reference video its own "Source assets" card.
function mapGenerationInputResourceType(item: GenerationInputMediaItem): PostResourceItemType {
  if (item.mediaType === 'image') return 'reference_image';
  if (item.mediaType === 'audio') return 'reference_audio';
  return 'reference_video';
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

function hasRecoverableDescriptor(value: unknown, expectedKind: 'image' | 'video'): boolean {
  const descriptor = normalizeRemixMediaAssetDescriptor(value, expectedKind);
  return Boolean(descriptor?.storagePath || descriptor?.sourceGenerationId);
}

function countRecoverableDescriptors(value: unknown): number {
  return normalizeSubmittedElementDescriptors(value).filter((element) => element.storagePath || element.sourceGenerationId).length;
}

/** The named subjects of a Kling O3 run that have a staged picture a remix could restore. */
function countRecoverableSubjects(workflowSettings: Record<string, unknown>): number {
  return klingSubjectDescriptors(workflowSettings)
    .filter((subject) => subject.images.some((image) => image.storagePath))
    .length;
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
  const isMotionWorkflow = isMotionGeneration({ category: source.category, creationMode: source.creationMode, workflowSettings });

  if (source.category === 'image') {
    return countRecoverableDescriptors(workflowSettings.elements) > 0;
  }

  if ((source.category === 'video' && !isMotionWorkflow) || source.category === 'ugc-ad') {
    return (
      countRecoverableDescriptors(workflowSettings.elements) > 0 ||
      countRecoverableDescriptors(workflowSettings.klingVideoElements) > 0 ||
      countRecoverableSubjects(workflowSettings) > 0 ||
      hasRecoverableDescriptor(workflowSettings.startFrame, 'image') ||
      hasRecoverableDescriptor(workflowSettings.endFrame, 'image')
    );
  }

  if (isMotionWorkflow) {
    const motionInputs = motionInputDescriptors(workflowSettings);
    return (
      hasRecoverableDescriptor(motionInputs.characterImage, 'image') &&
      hasRecoverableDescriptor(motionInputs.referenceVideo, 'video')
    );
  }

  return false;
}

/**
 * What a recipe made from the creation starts from: its prompt, its saved references and the
 * remix a buyer can restore. Not its settings: those are public on the post since 2026-11-03
 * (`buildPublicGenerationSetup` in public-generation-setup.ts, owner's decision), so the sell
 * link, Studio's Manage and Add recipe, the composer and the creators' publish form no longer
 * put a "Saved generation setup" item into a new recipe. Recipes that hold one keep it.
 */
export function buildGenerationPaywallPrefill(
  source: GenerationPaywallPrefillSource
): GenerationPaywallPrefill | null {
  const promptText = trimText(source.prompt);
  const allowRemix = hasRecoverableGenerationRemixInputs(source);
  const referenceKindCounts = getSavedReferenceKindCounts(source.inputMedia);
  const referenceCount = getSavedReferenceCount(referenceKindCounts);
  const resourceKinds = getPostResourceKinds({
    promptText,
    allowRemix,
  });
  const effectiveResourceKinds: PostResourceKind[] = referenceCount > 0 && !resourceKinds.includes('files')
    ? [...resourceKinds, 'files']
    : resourceKinds;

  if (!promptText && !allowRemix && referenceCount === 0) {
    return null;
  }

  const ownReferenceKindCounts = source.ownInputIds
    ? getSavedReferenceKindCounts(source.inputMedia?.filter((item) => source.ownInputIds!.has(item.id)))
    : null;

  return {
    resourceKinds: effectiveResourceKinds,
    promptText,
    allowRemix,
    referenceCount,
    referenceKindCounts,
    ...(ownReferenceKindCounts
      ? { ownReferenceCount: getSavedReferenceCount(ownReferenceKindCounts), ownReferenceKindCounts }
      : {}),
  };
}
