import type {
  GenerationListItem,
  PostResourceAttachment,
  PostResourceBundleAccessMode,
  PostResourceBundleInput,
  PostResourceKind,
  ShowcaseFeedItem,
} from '@/lib/types';

export type PostComposerMode = 'text' | 'upload' | 'creation';
export type PostComposerVisibility = 'public' | 'unlisted' | 'private';
export type PostComposerCategory = ShowcaseFeedItem['category'];

interface PostComposerSourceToolSelection {
  toolLabel: string;
  toolSlug: string | null;
  modelLabel?: string | null;
  modelSlug?: string | null;
}

export interface PostComposerUpload {
  uri: string;
  name: string;
  type: string;
}

export interface PostComposerResourceDraft {
  accessMode: PostResourceBundleAccessMode;
  promptText: string;
  notesMarkdown: string;
  workflowShareUrl: string;
  attachmentUrl: string;
  attachmentLabel: string;
  allowRemix: boolean;
  summary: string;
  previewText: string;
  priceUsd: string;
}

export interface PostComposerDraft {
  mode: PostComposerMode;
  title: string;
  contentText: string;
  caption: string;
  sourceTool: string;
  sourceToolSlug: string;
  category: PostComposerCategory;
  visibility: PostComposerVisibility;
  selectedGenerationId: string | null;
  upload: PostComposerUpload | null;
  resource: PostComposerResourceDraft;
}

export interface PostComposerValidationResult {
  valid: boolean;
  message?: string;
}

export const POST_COMPOSER_MODES: Array<{ id: PostComposerMode; label: string; body: string }> = [
  { id: 'text', label: 'Text', body: 'Write a post, prompt, idea, or breakdown.' },
  { id: 'upload', label: 'Upload', body: 'Post media made in any tool.' },
  { id: 'creation', label: 'Creation', body: 'Publish a Magicbooklet result.' },
];

export const POST_COMPOSER_CATEGORY_OPTIONS: Array<{ id: PostComposerCategory; label: string }> = [
  { id: 'text', label: 'Text' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
  { id: 'motion', label: 'Motion' },
  { id: 'ugc-ad', label: 'UGC ad' },
];

export const POST_COMPOSER_SOURCE_OPTIONS = [
  { label: 'Manual', slug: 'manual' },
  { label: 'Magicbooklet', slug: 'magicbooklet' },
  { label: 'Runway', slug: 'runway' },
  { label: 'Midjourney', slug: 'midjourney' },
  { label: 'Sora', slug: 'sora' },
  { label: 'Kling', slug: 'kling' },
  { label: 'CapCut', slug: 'capcut' },
  { label: 'Other', slug: 'other' },
];

export const POST_COMPOSER_VISIBILITY_OPTIONS: Array<{ id: PostComposerVisibility; label: string; body: string }> = [
  { id: 'public', label: 'Public', body: 'Visible in Feed.' },
  { id: 'unlisted', label: 'Unlisted', body: 'Shareable by link only.' },
  { id: 'private', label: 'Private', body: 'Saved privately in Studio.' },
];

export const POST_COMPOSER_UNLOCK_OPTIONS: Array<{ id: PostResourceBundleAccessMode; label: string }> = [
  { id: 'none', label: 'No unlock' },
  { id: 'free', label: 'Free unlock' },
  { id: 'paid', label: 'Paid unlock' },
];

const BODY_MAX_LENGTH = 2000;

export function getDefaultResourceDraft(): PostComposerResourceDraft {
  return {
    accessMode: 'none',
    promptText: '',
    notesMarkdown: '',
    workflowShareUrl: '',
    attachmentUrl: '',
    attachmentLabel: '',
    allowRemix: false,
    summary: '',
    previewText: '',
    priceUsd: '9',
  };
}

export function getDefaultPostComposerDraft(): PostComposerDraft {
  return {
    mode: 'text',
    title: '',
    contentText: '',
    caption: '',
    sourceTool: 'Manual',
    sourceToolSlug: 'manual',
    category: 'text',
    visibility: 'public',
    selectedGenerationId: null,
    upload: null,
    resource: getDefaultResourceDraft(),
  };
}

export function getPublishableGenerations(items: GenerationListItem[] | null | undefined) {
  return (items ?? []).filter((item) => {
    const hasOutput = Boolean(item.output_url || item.output_urls?.length);
    return item.status === 'succeeded' && hasOutput && !item.linked_post_id;
  });
}

export function buildPublishGenerationPayload(item: GenerationListItem) {
  const includeGenerationReferences = hasGenerationReferences(item) || undefined;

  return {
    generationId: item.id,
    visibility: 'public',
    title: item.title || item.prompt || 'Untitled creation',
    description: item.description || undefined,
    prompt: item.prompt || undefined,
    category: normalizeGenerationCategory(item.category),
    ...(includeGenerationReferences ? { includeGenerationReferences } : {}),
  };
}

export function buildPublishGenerationPostPayload(item: GenerationListItem, draft: PostComposerDraft) {
  const resourceBundle = buildPostResourceBundleInput(draft.resource);
  const includeGenerationReferences = shouldIncludeGenerationReferences(item, draft.visibility, resourceBundle);
  const sourceTools = buildSourceToolsPayload(draft, item);

  return {
    generationId: item.id,
    visibility: draft.visibility,
    title: trimOrUndefined(draft.title) ?? getPublishGenerationTitle(item),
    description: undefined,
    body: trimOrUndefined(draft.caption),
    category: draft.category === 'text' ? getPublishGenerationMediaKind(item) ?? 'image' : draft.category,
    sourceTool: trimOrUndefined(draft.sourceTool),
    sourceToolSlug: trimOrUndefined(draft.sourceToolSlug),
    ...(sourceTools.length > 0 ? { sourceTools } : {}),
    ...(includeGenerationReferences ? { includeGenerationReferences: true } : {}),
    resourceBundle: resourceBundle ?? { accessMode: 'none' },
  };
}

export function buildUpdatePostPayload(isGenerationBacked: boolean, draft: PostComposerDraft) {
  if (isGenerationBacked) {
    return {
      visibility: draft.visibility,
      resourceBundle: buildPostResourceBundleInput(draft.resource) ?? { accessMode: 'none' },
    };
  } else {
    const body = draft.mode === 'text' ? draft.contentText.trim() : getCreatePostBody(draft);
    const sourceTools = draft.mode === 'upload' ? buildSourceToolsPayload(draft) : [];

    return {
      title: draft.title.trim(),
      description: draft.caption.trim(),
      body,
      visibility: draft.visibility,
      category: draft.category,
      sourceTool: draft.sourceTool.trim(),
      sourceToolSlug: draft.sourceToolSlug.trim(),
      ...(sourceTools.length > 0 ? { sourceTools } : {}),
      resourceBundle: buildPostResourceBundleInput(draft.resource) ?? { accessMode: 'none' },
    };
  }
}

export function validatePostComposerDraft(draft: PostComposerDraft): PostComposerValidationResult {
  if (!draft.title.trim()) {
    return { valid: false, message: 'Add a title before publishing.' };
  }

  if (draft.mode === 'text' && !draft.contentText.trim() && !draft.caption.trim()) {
    return { valid: false, message: 'Write the text post or add a caption.' };
  }

  if (draft.mode === 'upload' && !draft.upload) {
    return { valid: false, message: 'Upload an image or video before publishing.' };
  }

  if (draft.mode === 'creation' && !draft.selectedGenerationId) {
    return { valid: false, message: 'Choose a finished creation before publishing.' };
  }

  const body = getCreatePostBody(draft);
  if (body.length > BODY_MAX_LENGTH) {
    return { valid: false, message: `Posts are limited to ${BODY_MAX_LENGTH} characters.` };
  }

  if (draft.resource.accessMode !== 'none') {
    const resourceBundle = buildPostResourceBundleInput(draft.resource);
    if (!resourceBundle) {
      return { valid: false, message: 'Add at least one unlockable resource.' };
    }

    if (!draft.resource.previewText.trim()) {
      return { valid: false, message: 'Add a buyer preview for the unlock.' };
    }

    if (draft.resource.accessMode === 'paid' && getPriceUsdCents(draft.resource.priceUsd) < 100) {
      return { valid: false, message: 'Paid unlocks must be at least $1.00.' };
    }
  }

  return { valid: true };
}

export function buildCreatePostFormData(draft: PostComposerDraft) {
  const formData = new FormData();
  formData.append('title', draft.title.trim());
  formData.append('description', draft.caption.trim());
  formData.append('body', getCreatePostBody(draft));
  formData.append('sourceTool', draft.sourceTool.trim());
  if (draft.sourceToolSlug.trim()) {
    formData.append('sourceToolSlug', draft.sourceToolSlug.trim());
  }
  const sourceTools = draft.mode === 'upload' ? buildSourceToolsPayload(draft) : [];
  if (sourceTools.length > 0) {
    formData.append('sourceTools', JSON.stringify(sourceTools));
  }
  formData.append('visibility', draft.visibility);
  formData.append('postFormat', getCreatePostFormat(draft));
  formData.append('resourceBundle', JSON.stringify(buildPostResourceBundleInput(draft.resource) ?? { accessMode: 'none' }));

  if (draft.mode === 'upload') {
    formData.append('category', draft.category);
    if (draft.upload) {
      formData.append('media', {
        uri: draft.upload.uri,
        name: draft.upload.name,
        type: draft.upload.type,
      } as unknown as Blob);
    }
  }

  return formData;
}

export function buildPostResourceBundleInput(resource: PostComposerResourceDraft): PostResourceBundleInput | null {
  if (resource.accessMode === 'none') {
    return null;
  }

  const attachments = buildResourceAttachments(resource);
  const resources = {
    promptText: trimOrNull(resource.promptText),
    notesMarkdown: trimOrNull(resource.notesMarkdown),
    workflowShareUrl: trimOrNull(resource.workflowShareUrl),
    attachments,
    allowRemix: resource.allowRemix,
  };
  const kinds = getSelectedResourceKinds(resources);
  if (kinds.length === 0) {
    return null;
  }

  return {
    accessMode: resource.accessMode,
    summary: trimOrUndefined(resource.summary) ?? getDefaultResourceSummary(kinds),
    previewText: trimOrUndefined(resource.previewText) ?? getDefaultResourcePreview(kinds),
    priceUsdCents: resource.accessMode === 'paid' ? getPriceUsdCents(resource.priceUsd) : 0,
    resources,
  };
}

export function getPostComposerPreviewStatusLabel(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null
) {
  if (draft.resource.accessMode === 'paid') {
    return 'Paid unlock will appear in post details.';
  }

  if (draft.resource.accessMode === 'free') {
    return 'Free unlock will appear in post details.';
  }

  if (willAttachFreeGenerationReferenceBundle(selectedGeneration, draft)) {
    return 'Free reference package will appear in post details.';
  }

  return 'No unlock attached.';
}

export function getPostComposerSubmitLabel(params: {
  visibility: PostComposerVisibility;
  isEditMode: boolean;
  isPending: boolean;
}) {
  if (params.isPending) {
    return params.isEditMode ? 'Saving' : 'Publishing';
  }

  if (params.isEditMode) {
    return 'Save changes';
  }

  if (params.visibility === 'private') {
    return 'Save private';
  }

  if (params.visibility === 'unlisted') {
    return 'Save unlisted';
  }

  return 'Publish public';
}

export function getCreatePostBody(draft: PostComposerDraft) {
  const parts = draft.mode === 'text'
    ? [draft.contentText.trim(), draft.caption.trim()]
    : [draft.caption.trim()];
  return parts.filter(Boolean).join('\n\n');
}

export function getCreatePostFormat(draft: PostComposerDraft): 'text' | 'media' | 'mixed' {
  if (draft.mode === 'text') return 'text';
  return draft.caption.trim() ? 'mixed' : 'media';
}

export function getPublishGenerationTitle(item: GenerationListItem) {
  return item.title || item.prompt || 'Untitled creation';
}

export function getPublishGenerationSubtitle(item: GenerationListItem) {
  const category = getGenerationCategoryLabel(item.category);
  return `${category} · ${item.model || 'Magicbooklet'}`;
}

export function getPublishGenerationMediaKind(item: GenerationListItem): 'image' | 'video' | null {
  const category = normalizeGenerationCategory(item.category);
  if (category === 'video' || category === 'motion' || category === 'ugc-ad') return 'video';
  if (category === 'text') return null;
  return 'image';
}

export function hasGenerationReferences(item: GenerationListItem | null | undefined) {
  return Boolean(item?.input_media?.some((media) => media.url || media.kind));
}

export function shouldIncludeGenerationReferences(
  item: GenerationListItem,
  visibility: PostComposerVisibility,
  resourceBundle: PostResourceBundleInput | null
) {
  if (!hasGenerationReferences(item)) {
    return false;
  }

  return visibility === 'public' || Boolean(resourceBundle && resourceBundle.accessMode !== 'none');
}

export function willAttachFreeGenerationReferenceBundle(
  item: GenerationListItem | null | undefined,
  draft: PostComposerDraft
) {
  if (!item || draft.mode !== 'creation') {
    return false;
  }

  return !buildPostResourceBundleInput(draft.resource)
    && shouldIncludeGenerationReferences(item, draft.visibility, null);
}

function normalizeGenerationCategory(category: string | null | undefined) {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad' || category === 'text') {
    return category;
  }
  return 'image';
}

function trimOrUndefined(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimOrNull(value: string | null | undefined) {
  return trimOrUndefined(value) ?? null;
}

function slugifySourceValue(value: string | null | undefined) {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || null;
}

function buildSourceToolsPayload(
  draft: PostComposerDraft,
  item?: GenerationListItem
): PostComposerSourceToolSelection[] {
  const toolLabel = draft.sourceTool.trim();
  if (!toolLabel) {
    return [];
  }

  const toolSlug = slugifySourceValue(draft.sourceToolSlug) ?? slugifySourceValue(toolLabel);
  const modelLabel = item?.model?.trim() || null;

  return [{
    toolLabel,
    toolSlug,
    ...(modelLabel
      ? {
          modelLabel,
          modelSlug: slugifySourceValue(modelLabel),
        }
      : {}),
  }];
}

function getPriceUsdCents(value: string) {
  const parsed = Number.parseFloat(value.trim() || '0');
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100));
}

function buildResourceAttachments(resource: PostComposerResourceDraft): PostResourceAttachment[] {
  const url = resource.attachmentUrl.trim();
  if (!url) return [];
  return [{
    kind: 'link',
    label: resource.attachmentLabel.trim() || url,
    url,
  }];
}

function getSelectedResourceKinds(resources: {
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
}) {
  const kinds: PostResourceKind[] = [];
  if (resources.promptText) kinds.push('prompt');
  if (resources.workflowShareUrl) kinds.push('workflow');
  if (resources.attachments.length > 0) kinds.push('files');
  if (resources.notesMarkdown) kinds.push('notes');
  if (resources.allowRemix) kinds.push('remix');
  return kinds;
}

function getDefaultResourceSummary(kinds: PostResourceKind[]) {
  const summary = kinds.map((kind) => {
    if (kind === 'workflow') return 'workflow';
    if (kind === 'files') return 'files';
    if (kind === 'notes') return 'notes';
    if (kind === 'remix') return 'remix access';
    return 'prompt';
  }).join(', ').replace(/, ([^,]*)$/, ', and $1');
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

function getDefaultResourcePreview(kinds: PostResourceKind[]) {
  if (kinds.length === 1 && kinds[0] === 'prompt') {
    return 'Includes the exact reusable prompt.';
  }
  return `Includes ${getDefaultResourceSummary(kinds)}.`;
}

function getGenerationCategoryLabel(category: string | null | undefined) {
  const normalized = normalizeGenerationCategory(category);
  if (normalized === 'ugc-ad') return 'UGC ad';
  if (normalized === 'motion') return 'Motion';
  if (normalized === 'video') return 'Video';
  if (normalized === 'text') return 'Text';
  return 'Image';
}
