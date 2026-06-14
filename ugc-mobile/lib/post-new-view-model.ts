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

export interface PostComposerCreationPackageDraft {
  attachGenerationReferences: boolean;
  attachPromptResource: boolean;
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
  creationPackage: PostComposerCreationPackageDraft;
}

export interface PostComposerValidationResult {
  valid: boolean;
  message?: string;
}

export type PostComposerReadinessState = 'ready' | 'warning' | 'neutral';

export interface PostComposerReadinessItem {
  id: 'public-post' | 'unlock' | 'preview' | 'publish';
  label: string;
  body: string;
  state: PostComposerReadinessState;
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
  { id: 'none', label: 'None' },
  { id: 'free', label: 'Free' },
  { id: 'paid', label: 'Paid' },
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

export function getDefaultCreationPackageDraft(): PostComposerCreationPackageDraft {
  return {
    attachGenerationReferences: false,
    attachPromptResource: false,
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
    creationPackage: getDefaultCreationPackageDraft(),
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
  const includeGenerationReferences = shouldIncludeGenerationReferences(item, draft);
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
    return 'Paid resource package will appear in post details.';
  }

  if (draft.resource.accessMode === 'free') {
    return 'Free resource package will appear in post details.';
  }

  if (willAttachGenerationReferences(selectedGeneration, draft)) {
    return 'Creation references will appear in post details.';
  }

  return 'No resource package configured.';
}

export function getPostComposerReadiness(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null,
  skipGenerationSelection = false
): PostComposerReadinessItem[] {
  const publicReady = isPublicPostReady(draft, selectedGeneration, skipGenerationSelection);
  const unlockBundle = buildPostResourceBundleInput(draft.resource);
  const unlockActive = draft.resource.accessMode !== 'none';
  const unlockReady = !unlockActive || Boolean(unlockBundle && draft.resource.previewText.trim());
  const validation = validatePostComposerDraft(draft);

  return [
    {
      id: 'public-post',
      label: publicReady ? 'Public post ready' : 'Public post needs content',
      body: publicReady
        ? 'Title, content, attribution, and visibility are set.'
        : publicPostMissingMessage(draft, selectedGeneration, skipGenerationSelection),
      state: publicReady ? 'ready' : 'warning',
    },
    {
      id: 'unlock',
      label: unlockActive ? unlockReady ? 'Resource package ready' : 'Resource package needs resources' : 'Resource package optional',
      body: unlockActive
        ? unlockReady
          ? getPostComposerPreviewStatusLabel(draft, selectedGeneration)
          : 'Add a buyer preview and at least one prompt, workflow, file, note, or remix resource.'
        : getPostComposerPreviewStatusLabel(draft, selectedGeneration),
      state: unlockActive ? unlockReady ? 'ready' : 'warning' : 'neutral',
    },
    {
      id: 'preview',
      label: 'Preview updates live',
      body: draft.title.trim() ? 'The preview reflects the public post and unlock cue.' : 'Add a title to make the preview meaningful.',
      state: draft.title.trim() ? 'ready' : 'neutral',
    },
    {
      id: 'publish',
      label: validation.valid ? 'Ready to publish' : 'Publish blocked',
      body: validation.valid ? 'The publish button will open the post in the viewer after success.' : validation.message ?? 'Complete the required fields.',
      state: validation.valid ? 'ready' : 'warning',
    },
  ];
}

export function applyCreationPromptResource(
  draft: PostComposerDraft,
  selectedGeneration: GenerationListItem | null | undefined,
  enabled: boolean
): PostComposerDraft {
  const creationPackage = getCreationPackageDraft(draft);
  if (!enabled) {
    return {
      ...draft,
      creationPackage: {
        ...creationPackage,
        attachPromptResource: false,
      },
    };
  }

  const prompt = selectedGeneration?.prompt?.trim() ?? '';

  return {
    ...draft,
    creationPackage: {
      ...creationPackage,
      attachPromptResource: true,
    },
    resource: {
      ...draft.resource,
      accessMode: draft.resource.accessMode === 'none' ? 'free' : draft.resource.accessMode,
      promptText: draft.resource.promptText.trim() ? draft.resource.promptText : prompt,
      previewText: draft.resource.previewText.trim() ? draft.resource.previewText : 'Includes the exact reusable prompt.',
    },
  };
}

export function getPostComposerSectionSummary(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null
) {
  return {
    publicPost: `${visibilityLabel(draft.visibility)} · ${contentModeSummary(draft, selectedGeneration)}`,
    postSettings: `${draft.sourceTool.trim() || 'Source'} · ${getGenerationCategoryLabel(draft.category)}`,
    resourcePackage: getResourcePackageSummary(draft, selectedGeneration),
  };
}

export function getPostComposerPackageStatus(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null
): PostComposerReadinessItem {
  const resourceBundle = buildPostResourceBundleInput(draft.resource);
  const resourceActive = draft.resource.accessMode !== 'none';
  const referencesAttached = willAttachGenerationReferences(selectedGeneration, draft);

  if (resourceActive) {
    const ready = Boolean(resourceBundle && draft.resource.previewText.trim());
    const promptResource = getCreationPackageDraft(draft).attachPromptResource && draft.resource.promptText.trim();
    return {
      id: 'unlock',
      label: ready
        ? promptResource
          ? 'Prompt resource ready'
          : draft.resource.accessMode === 'paid'
            ? 'Paid package ready'
            : 'Free package ready'
        : 'Resource package needs resources',
      body: ready
        ? promptResource
          ? draft.resource.previewText.trim()
          : getPostComposerPreviewStatusLabel(draft, selectedGeneration)
        : 'Add a buyer preview and at least one prompt, workflow, file, note, or remix resource.',
      state: ready ? 'ready' : 'warning',
    };
  }

  if (referencesAttached) {
    return {
      id: 'unlock',
      label: 'References attached',
      body: 'Creation input media will be available from the post details.',
      state: 'ready',
    };
  }

  return {
    id: 'unlock',
    label: 'Resource package optional',
    body: 'No resource package configured.',
    state: 'neutral',
  };
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

function isPublicPostReady(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null,
  skipGenerationSelection = false
) {
  if (!draft.title.trim()) return false;
  if (draft.mode === 'text') return Boolean(draft.contentText.trim() || draft.caption.trim());
  if (draft.mode === 'upload') return Boolean(draft.upload);
  if (draft.mode === 'creation') return skipGenerationSelection || Boolean(selectedGeneration ?? draft.selectedGenerationId);
  return false;
}

function publicPostMissingMessage(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null,
  skipGenerationSelection = false
) {
  if (!draft.title.trim()) return 'Add a title that people will understand in the feed.';
  if (draft.mode === 'text' && !draft.contentText.trim() && !draft.caption.trim()) {
    return 'Write the text post or add a caption.';
  }
  if (draft.mode === 'upload' && !draft.upload) {
    return 'Upload an image or video before publishing.';
  }
  if (draft.mode === 'creation' && !skipGenerationSelection && !selectedGeneration && !draft.selectedGenerationId) {
    return 'Choose a finished Magicbooklet creation.';
  }
  return 'Complete the required public post fields.';
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
  draft: PostComposerDraft
) {
  return draft.mode === 'creation'
    && getCreationPackageDraft(draft).attachGenerationReferences
    && hasGenerationReferences(item);
}

export function willAttachGenerationReferences(
  item: GenerationListItem | null | undefined,
  draft: PostComposerDraft
) {
  if (!item || draft.mode !== 'creation') {
    return false;
  }

  return shouldIncludeGenerationReferences(item, draft);
}

export const willAttachFreeGenerationReferenceBundle = willAttachGenerationReferences;

function normalizeGenerationCategory(category: string | null | undefined) {
  if (category === 'video' || category === 'motion' || category === 'ugc-ad' || category === 'text') {
    return category;
  }
  return 'image';
}

function getCreationPackageDraft(draft: PostComposerDraft): PostComposerCreationPackageDraft {
  return draft.creationPackage ?? getDefaultCreationPackageDraft();
}

function visibilityLabel(visibility: PostComposerVisibility) {
  if (visibility === 'unlisted') return 'Unlisted';
  if (visibility === 'private') return 'Private';
  return 'Public';
}

function contentModeSummary(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null
) {
  if (draft.mode === 'creation') return selectedGeneration || draft.selectedGenerationId ? 'Creation selected' : 'Choose creation';
  if (draft.mode === 'upload') return draft.upload ? 'Upload selected' : 'Add media';
  return draft.contentText.trim() || draft.caption.trim() ? 'Text ready' : 'Write text';
}

function getResourcePackageSummary(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null
) {
  if (draft.resource.accessMode === 'paid') return 'Paid package';
  if (draft.resource.accessMode === 'free') return 'Free package';
  if (willAttachGenerationReferences(selectedGeneration, draft)) return 'References attached';
  return 'No package';
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
