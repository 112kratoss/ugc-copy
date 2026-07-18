import type {
  GenerationListItem,
  OwnerPostListItem,
  OwnerPostsResponse,
  PostResourceAttachment,
  PostResourceBundleAccessMode,
  PostResourceBundleInput,
  PostResourceItem,
  PostResourceItemRole,
  PostResourceItemType,
  PostResourceKind,
  PostResourceRemixUse,
  PostResourceSection,
  PostResourceSectionKind,
  SourceToolCapability,
  SourceToolModel,
  SourceToolOption,
  ShowcaseFeedItem,
} from '@/lib/types';

export type PostComposerMode = 'text' | 'upload' | 'creation';
export type PostComposerProofMode = 'media' | 'text';
export type PostComposerVisibility = 'public' | 'unlisted' | 'private';
export type PostComposerCategory = ShowcaseFeedItem['category'];

export interface PostComposerSourceToolSelection {
  toolLabel: string;
  toolSlug: string | null;
  modelLabel?: string | null;
  modelSlug?: string | null;
  createTool?: boolean;
  createModel?: boolean;
}

export interface PostComposerUpload {
  uri: string;
  name: string;
  type: string;
}

export interface PostComposerMediaItem {
  id: string;
  uri: string;
  name: string;
  type: string;
  mediaKind: 'image' | 'video';
  storagePath?: string | null;
  existingId?: string | null;
  previewUrl?: string | null;
}

export interface PostComposerMediaItemPayload {
  storagePath?: string;
  existingId?: string;
  contentType?: string;
  originalName?: string;
}

export interface PostComposerMadeWithRow {
  id: string;
  toolLabel: string;
  toolSlug: string;
  modelLabel: string;
  modelSlug: string;
  createTool: boolean;
  createModel: boolean;
}

export type PostComposerResourceSelections = Record<PostResourceKind, boolean>;

export interface PostComposerResourceAttachmentDraft {
  id: string;
  kind: 'link' | 'file';
  label: string;
  url?: string;
  storagePath?: string;
  contentType?: string | null;
  sizeBytes?: number | null;
  resourceType?: PostResourceItemType;
  role?: PostResourceItemRole;
  remixUse?: PostResourceRemixUse;
}

export interface PostComposerResourceSectionDraft {
  id: string;
  title: string;
  kind: PostResourceSectionKind;
  description: string;
  promptText: string;
  workflowShareUrl: string;
  notesMarkdown: string;
  attachments: PostComposerResourceAttachmentDraft[];
  allowRemix: boolean;
}

export interface PostComposerResourceDraft {
  accessMode: PostResourceBundleAccessMode;
  selectedKinds: PostComposerResourceSelections;
  promptText: string;
  notesMarkdown: string;
  workflowShareUrl: string;
  attachmentUrl: string;
  attachmentLabel: string;
  attachments: PostComposerResourceAttachmentDraft[];
  organizeSections: boolean;
  sections: PostComposerResourceSectionDraft[];
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
  proofMode: PostComposerProofMode;
  title: string;
  description: string;
  contentText: string;
  caption: string;
  sourceTool: string;
  sourceToolSlug: string;
  madeWithRows: PostComposerMadeWithRow[];
  category: PostComposerCategory;
  visibility: PostComposerVisibility;
  selectedGenerationId: string | null;
  upload: PostComposerUpload | null;
  mediaItems: PostComposerMediaItem[];
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

export interface PostComposerPublishAction {
  id: PostComposerVisibility;
  label: string;
  visibility: PostComposerVisibility;
  variant: 'primary' | 'secondary';
  disabled: boolean;
  loading: boolean;
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
];

type FallbackSourceToolInput = Omit<SourceToolOption, 'models' | 'supportedMediaKinds'> & {
  media: Array<'image' | 'video'>;
  models?: SourceToolModel[];
};

function catalogModel(
  slug: string,
  label: string,
  capabilities: SourceToolCapability[],
  providerSlug: string,
  aliases: string[] = [],
): SourceToolModel {
  return { slug, label, capabilities, providerSlug, aliases, status: 'current' };
}

function fallbackSourceTool({ media, models = [], ...tool }: FallbackSourceToolInput): SourceToolOption {
  return {
    ...tool,
    models,
    supportedMediaKinds: media,
    status: tool.status ?? 'current',
    providerSlug: tool.providerSlug === undefined ? tool.slug : tool.providerSlug,
    aliases: tool.aliases ?? [],
  };
}

const IMAGE: SourceToolCapability[] = ['image'];
const VIDEO: SourceToolCapability[] = ['video'];
const IMAGE_VIDEO: SourceToolCapability[] = ['image', 'video'];

export const POST_COMPOSER_SOURCE_OPTIONS: SourceToolOption[] = [
  fallbackSourceTool({
    slug: 'manual', label: 'Manual', media: ['image', 'video'], toolType: 'workflow',
    capabilities: IMAGE_VIDEO, catalogTier: 'featured', aliases: ['camera', 'handmade', 'traditional'],
  }),
  fallbackSourceTool({
    slug: 'magicbooklet', label: 'Magicbooklet', media: ['image', 'video'], toolType: 'platform',
    capabilities: IMAGE_VIDEO, catalogTier: 'featured', aliases: ['magic booklet', 'creator studio'],
    models: [
      catalogModel('nano-banana-2-lite', 'Nano Banana 2 Lite', IMAGE, 'google', ['gemini image']),
      catalogModel('nano-banana-2', 'Nano Banana 2.0', IMAGE, 'google', ['gemini image']),
      catalogModel('nano-banana-pro', 'Nano Banana Pro', IMAGE, 'google', ['gemini image']),
      catalogModel('gpt-image-2', 'GPT Image 2', IMAGE, 'openai'),
      catalogModel('seedream-5-pro', 'Seedream 5 Pro', IMAGE, 'bytedance'),
      catalogModel('flux-2-pro', 'FLUX.2 Pro', IMAGE, 'black-forest-labs', ['bfl']),
      catalogModel('z-image', 'Z-Image', IMAGE, 'tongyi'),
      catalogModel('grok-imagine-image', 'Grok Imagine', IMAGE, 'xai'),
      catalogModel('kling-2.6', 'Kling 2.6 Motion', VIDEO, 'kling-ai'),
      catalogModel('kling-3.0', 'Kling 3.0 Motion', VIDEO, 'kling-ai'),
      catalogModel('kling-3.0-video', 'Kling 3.0 Cinematic', VIDEO, 'kling-ai'),
      catalogModel('seedance-1.5-pro', 'Seedance 1.5 Pro', VIDEO, 'bytedance'),
      catalogModel('seedance-2', 'Seedance 2', VIDEO, 'bytedance'),
      catalogModel('seedance-2-fast', 'Seedance 2 Fast', VIDEO, 'bytedance'),
      catalogModel('veo-3.1', 'Veo 3.1', VIDEO, 'google'),
      catalogModel('grok-imagine-video', 'Grok Imagine Video', VIDEO, 'xai'),
    ],
  }),
  fallbackSourceTool({
    slug: 'adobe-firefly', label: 'Adobe Firefly', media: ['image', 'video'], toolType: 'platform',
    capabilities: ['image', 'video', 'design'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['firefly'],
    models: [
      catalogModel('firefly-image-5', 'Firefly Image 5', IMAGE, 'adobe'),
      catalogModel('firefly-image-4-ultra', 'Firefly Image 4 Ultra', IMAGE, 'adobe'),
      catalogModel('firefly-video', 'Firefly Video', VIDEO, 'adobe'),
    ],
  }),
  fallbackSourceTool({
    slug: 'midjourney', label: 'Midjourney', media: ['image', 'video'], toolType: 'platform',
    capabilities: IMAGE_VIDEO, catalogTier: 'featured', aliases: ['mj', 'niji'],
    models: [
      catalogModel('v8.1', 'V8.1', IMAGE, 'midjourney', ['midjourney v8.1']),
      catalogModel('v7', 'V7', IMAGE, 'midjourney', ['midjourney v7']),
      catalogModel('niji-7', 'Niji 7', IMAGE, 'midjourney'),
      catalogModel('midjourney-video', 'Midjourney Video', VIDEO, 'midjourney'),
    ],
  }),
  fallbackSourceTool({
    slug: 'runway', label: 'Runway', media: ['image', 'video'], toolType: 'platform',
    capabilities: ['image', 'video', 'vfx'], catalogTier: 'featured', aliases: ['runwayml'],
    models: [
      catalogModel('gen-4.5', 'Gen-4.5', VIDEO, 'runway'),
      catalogModel('gen-4', 'Gen-4', VIDEO, 'runway'),
      catalogModel('gen-4-turbo', 'Gen-4 Turbo', VIDEO, 'runway'),
      { ...catalogModel('gen-3', 'Gen-3', VIDEO, 'runway'), status: 'legacy' },
      catalogModel('aleph-2', 'Aleph 2', ['video', 'vfx'], 'runway'),
      catalogModel('act-two', 'Act-Two', ['video', 'avatar'], 'runway'),
    ],
  }),
  fallbackSourceTool({
    slug: 'google-gemini-flow', label: 'Google Gemini / Flow', media: ['image', 'video'], toolType: 'platform',
    capabilities: IMAGE_VIDEO, catalogTier: 'featured', providerSlug: 'google', aliases: ['gemini', 'flow', 'veo', 'nano banana'],
    models: [
      catalogModel('nano-banana-2', 'Nano Banana 2', IMAGE, 'google', ['gemini image']),
      catalogModel('nano-banana-pro', 'Nano Banana Pro', IMAGE, 'google'),
      catalogModel('veo-3.1', 'Veo 3.1', VIDEO, 'google'),
      catalogModel('veo-3.1-fast', 'Veo 3.1 Fast', VIDEO, 'google'),
    ],
  }),
  fallbackSourceTool({
    slug: 'openai-chatgpt', label: 'ChatGPT', media: ['image'], toolType: 'platform', capabilities: IMAGE,
    catalogTier: 'featured', providerSlug: 'openai', aliases: ['openai', 'gpt image', 'dall-e', 'dalle'],
    models: [
      catalogModel('gpt-image-2', 'GPT Image 2', IMAGE, 'openai'),
      catalogModel('gpt-image-1.5', 'GPT Image 1.5', IMAGE, 'openai'),
      catalogModel('gpt-image-1', 'GPT Image 1', IMAGE, 'openai'),
    ],
  }),
  fallbackSourceTool({
    slug: 'kling', label: 'Kling AI', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'featured', providerSlug: 'kuaishou', aliases: ['kling', 'kolors'],
    models: [
      catalogModel('kling-3.0', 'Kling 3.0', VIDEO, 'kuaishou'),
      catalogModel('kling-o3', 'Kling O3', VIDEO, 'kuaishou'),
      catalogModel('kling-2.6', 'Kling 2.6', VIDEO, 'kuaishou'),
      catalogModel('motion-control', 'Motion Control', VIDEO, 'kuaishou'),
    ],
  }),
  fallbackSourceTool({
    slug: 'higgsfield', label: 'Higgsfield', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'featured', aliases: ['higgs field'], models: [
      catalogModel('soul', 'Soul', IMAGE, 'higgsfield'),
      catalogModel('k2', 'K2', VIDEO, 'higgsfield'),
    ],
  }),
  fallbackSourceTool({
    slug: 'freepik', label: 'Freepik', media: ['image', 'video'], toolType: 'platform',
    capabilities: ['image', 'video', 'design'], catalogTier: 'featured', aliases: ['freepik ai suite'], models: [
      catalogModel('mystic', 'Mystic', IMAGE, 'freepik'),
      catalogModel('classic', 'Classic', IMAGE, 'freepik'),
    ],
  }),
  fallbackSourceTool({
    slug: 'leonardo-ai', label: 'Leonardo.Ai', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'featured', aliases: ['leonardo'], models: [
      catalogModel('lucid-origin', 'Lucid Origin', IMAGE, 'leonardo-ai'),
      catalogModel('lucid-realism', 'Lucid Realism', IMAGE, 'leonardo-ai'),
      catalogModel('phoenix-1.0', 'Phoenix 1.0', IMAGE, 'leonardo-ai'),
    ],
  }),
  fallbackSourceTool({
    slug: 'black-forest-labs', label: 'Black Forest Labs', media: ['image'], toolType: 'platform', capabilities: IMAGE,
    catalogTier: 'featured', providerSlug: 'black-forest-labs', aliases: ['flux', 'bfl'], models: [
      catalogModel('flux.2-max', 'FLUX.2 Max', IMAGE, 'black-forest-labs'),
      catalogModel('flux.2-pro', 'FLUX.2 Pro', IMAGE, 'black-forest-labs'),
      catalogModel('flux.2-flex', 'FLUX.2 Flex', IMAGE, 'black-forest-labs'),
      catalogModel('flux.1-kontext-max', 'FLUX.1 Kontext Max', IMAGE, 'black-forest-labs'),
    ],
  }),
  fallbackSourceTool({
    slug: 'stability-ai', label: 'Stability AI', media: ['image'], toolType: 'platform', capabilities: IMAGE,
    catalogTier: 'featured', aliases: ['stable diffusion', 'stable image', 'sdxl'], models: [
      catalogModel('stable-image-ultra', 'Stable Image Ultra', IMAGE, 'stability-ai'),
      catalogModel('stable-image-core', 'Stable Image Core', IMAGE, 'stability-ai'),
      catalogModel('stable-diffusion-3.5-large', 'Stable Diffusion 3.5 Large', IMAGE, 'stability-ai', ['sd 3.5']),
    ],
  }),
  fallbackSourceTool({
    slug: 'ideogram', label: 'Ideogram', media: ['image'], toolType: 'platform', capabilities: IMAGE,
    catalogTier: 'featured', aliases: ['ideogram ai', 'text rendering'], models: [
      catalogModel('ideogram-3.0', 'Ideogram 3.0', IMAGE, 'ideogram'),
      catalogModel('ideogram-2a', 'Ideogram 2a', IMAGE, 'ideogram'),
    ],
  }),
  fallbackSourceTool({
    slug: 'recraft', label: 'Recraft', media: ['image'], toolType: 'platform', capabilities: ['image', 'design'],
    catalogTier: 'featured', aliases: ['recraft ai', 'vector'], models: [catalogModel('recraft-v3', 'Recraft V3', ['image', 'design'], 'recraft')],
  }),
  fallbackSourceTool({
    slug: 'krea', label: 'Krea', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'featured', aliases: ['krea ai', 'realtime generation'],
  }),
  fallbackSourceTool({
    slug: 'luma-dream-machine', label: 'Luma Dream Machine', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'featured', providerSlug: 'luma-ai', aliases: ['luma', 'dream machine', 'ray'], models: [
      catalogModel('ray-2', 'Ray 2', VIDEO, 'luma-ai'),
      catalogModel('ray-2-flash', 'Ray 2 Flash', VIDEO, 'luma-ai'),
    ],
  }),
  fallbackSourceTool({
    slug: 'pika', label: 'Pika', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'featured', aliases: ['pika labs', 'pikaframes'], models: [
      catalogModel('pika-2.2', 'Pika 2.2', VIDEO, 'pika'),
      catalogModel('pika-2.1', 'Pika 2.1', VIDEO, 'pika'),
      catalogModel('pika-turbo', 'Pika Turbo', VIDEO, 'pika'),
    ],
  }),
  fallbackSourceTool({
    slug: 'capcut', label: 'CapCut', media: ['image', 'video'], toolType: 'editor',
    capabilities: ['image', 'video', 'audio'], catalogTier: 'featured', providerSlug: 'bytedance', aliases: ['cap cut', 'video editor'],
  }),
  fallbackSourceTool({
    slug: 'canva', label: 'Canva', media: ['image', 'video'], toolType: 'editor',
    capabilities: ['image', 'video', 'design'], catalogTier: 'featured', aliases: ['magic media', 'design editor'],
  }),
  fallbackSourceTool({
    slug: 'adobe-photoshop', label: 'Adobe Photoshop', media: ['image'], toolType: 'editor',
    capabilities: ['image', 'design'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['photoshop', 'ps', 'photo editor'],
  }),
  fallbackSourceTool({
    slug: 'adobe-premiere-pro', label: 'Adobe Premiere Pro', media: ['video'], toolType: 'editor',
    capabilities: ['video', 'audio'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['premiere', 'pr', 'video editor'],
  }),
  fallbackSourceTool({
    slug: 'adobe-after-effects', label: 'Adobe After Effects', media: ['video'], toolType: 'editor',
    capabilities: ['video', 'vfx'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['after effects', 'ae', 'motion graphics'],
  }),
  fallbackSourceTool({
    slug: 'davinci-resolve', label: 'DaVinci Resolve', media: ['video'], toolType: 'editor',
    capabilities: ['video', 'audio', 'vfx'], catalogTier: 'featured', providerSlug: 'blackmagic-design', aliases: ['resolve', 'fusion', 'color grading'],
  }),
  fallbackSourceTool({
    slug: 'final-cut-pro', label: 'Final Cut Pro', media: ['video'], toolType: 'editor',
    capabilities: ['video', 'audio'], catalogTier: 'featured', providerSlug: 'apple', aliases: ['final cut', 'fcp', 'fcp x'],
  }),
  fallbackSourceTool({
    slug: 'blender', label: 'Blender', media: ['image', 'video'], toolType: 'editor',
    capabilities: ['image', 'video', '3d', 'vfx'], catalogTier: 'featured', aliases: ['3d', 'cycles', 'eevee'],
  }),
  fallbackSourceTool({
    slug: 'figma', label: 'Figma', media: ['image', 'video'], toolType: 'editor',
    capabilities: ['image', 'design'], catalogTier: 'featured', aliases: ['figma design', 'prototype', 'ui design'],
  }),
  fallbackSourceTool({
    slug: 'comfyui', label: 'ComfyUI', media: ['image', 'video'], toolType: 'workflow',
    capabilities: IMAGE_VIDEO, catalogTier: 'featured', providerSlug: null, aliases: ['comfy ui', 'node workflow', 'stable diffusion workflow'],
  }),
  fallbackSourceTool({
    slug: 'heygen', label: 'HeyGen', media: ['video'], toolType: 'platform',
    capabilities: ['video', 'audio', 'avatar'], catalogTier: 'featured', aliases: ['hey gen', 'ai avatar', 'digital twin'], models: [
      catalogModel('avatar-iv', 'Avatar IV', ['video', 'avatar'], 'heygen'),
      catalogModel('digital-twin', 'Digital Twin', ['video', 'avatar'], 'heygen'),
    ],
  }),
  fallbackSourceTool({
    slug: 'elevenlabs', label: 'ElevenLabs', media: ['video'], toolType: 'platform',
    capabilities: ['audio'], catalogTier: 'featured', aliases: ['eleven labs', 'voice ai', 'text to speech', 'tts'], models: [
      catalogModel('eleven-v3', 'Eleven v3', ['audio'], 'elevenlabs'),
      catalogModel('multilingual-v2', 'Multilingual v2', ['audio'], 'elevenlabs'),
      catalogModel('flash-v2-5', 'Flash v2.5', ['audio'], 'elevenlabs'),
    ],
  }),
  fallbackSourceTool({
    slug: 'sora', label: 'Sora', media: ['video'], toolType: 'platform', capabilities: VIDEO,
    catalogTier: 'historical', status: 'sunset', providerSlug: 'openai', aliases: ['sora 2', 'openai video'], models: [
      { ...catalogModel('sora-2', 'Sora 2', VIDEO, 'openai'), status: 'sunset' },
      { ...catalogModel('sora-2-pro', 'Sora 2 Pro', VIDEO, 'openai'), status: 'sunset' },
    ],
  }),
  fallbackSourceTool({
    slug: 'other', label: 'Other', media: ['image', 'video'], toolType: 'platform', capabilities: IMAGE_VIDEO,
    catalogTier: 'extended', providerSlug: null, aliases: ['another tool', 'custom'],
  }),
];

export const POST_COMPOSER_VISIBILITY_OPTIONS: Array<{ id: PostComposerVisibility; label: string; body: string }> = [
  { id: 'public', label: 'Public', body: 'Visible in Showcase.' },
  { id: 'unlisted', label: 'Unlisted', body: 'Shareable by link only.' },
  { id: 'private', label: 'Private', body: 'Saved privately in Studio.' },
];

export const POST_COMPOSER_UNLOCK_OPTIONS: Array<{ id: PostResourceBundleAccessMode; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'free', label: 'Free' },
  { id: 'paid', label: 'Paid' },
];

export const POST_COMPOSER_RESOURCE_KIND_OPTIONS: Array<{ id: PostResourceKind; label: string }> = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'workflow', label: 'Workflow / setup' },
  { id: 'files', label: 'Files / links' },
  { id: 'notes', label: 'Notes' },
  { id: 'remix', label: 'Remix access' },
];

const DEFAULT_RESOURCE_SELECTIONS: PostComposerResourceSelections = {
  prompt: true,
  workflow: false,
  files: false,
  notes: false,
  remix: false,
};

const BODY_MAX_LENGTH = 2000;
const MAX_MEDIA_ITEMS = 5;
const MAX_MADE_WITH_ROWS = 5;

export function getDefaultResourceDraft(): PostComposerResourceDraft {
  return {
    accessMode: 'none',
    selectedKinds: { ...DEFAULT_RESOURCE_SELECTIONS },
    promptText: '',
    notesMarkdown: '',
    workflowShareUrl: '',
    attachmentUrl: '',
    attachmentLabel: '',
    attachments: [],
    organizeSections: false,
    sections: [],
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
    proofMode: 'text',
    title: '',
    description: '',
    contentText: '',
    caption: '',
    sourceTool: 'Manual',
    sourceToolSlug: 'manual',
    madeWithRows: [createMadeWithRow({
      toolLabel: 'Manual',
      toolSlug: 'manual',
    })],
    category: 'text',
    visibility: 'public',
    selectedGenerationId: null,
    upload: null,
    mediaItems: [],
    resource: getDefaultResourceDraft(),
    creationPackage: getDefaultCreationPackageDraft(),
  };
}

export function getPublishableGenerations(items: GenerationListItem[] | null | undefined) {
  return (items ?? []).filter((item) => {
    const hasOutput = Boolean(item.output_url || item.output_urls?.length);
    const previewReady = item.media?.gridReady
      ?? Boolean(item.previewUrl ?? item.preview_url);
    return item.status === 'succeeded' && hasOutput && previewReady && !item.linked_post_id;
  });
}

export function isTemplateGeneration(item: GenerationListItem | null | undefined) {
  return item?.origin === 'template'
    && Boolean(item.template?.runId && item.template?.templateId);
}

/** Explicit template handoffs can arrive before their derived grid preview.
 * The owner API only marks the canonical, successful, non-test result as a
 * template result, so this narrow bypass does not affect the normal picker. */
export function getExplicitPublishGeneration(
  items: GenerationListItem[] | null | undefined,
  generationId: string | null | undefined,
) {
  if (!generationId) return null;
  const item = (items ?? []).find((candidate) => candidate.id === generationId);
  if (!item || item.status !== 'succeeded' || item.linked_post_id) return null;
  if (!item.output_url && !item.output_urls?.length) return null;
  if (isTemplateGeneration(item)) return item;
  return getPublishableGenerations([item])[0] ?? null;
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
  const templateResult = isTemplateGeneration(item);
  const resourceBundle = templateResult ? null : buildPostResourceBundleInput(draft.resource);
  const includeGenerationReferences = templateResult ? false : shouldIncludeGenerationReferences(item, draft);
  const sourceTools = buildSourceToolsPayload(draft, item);
  const primarySourceTool = sourceTools[0];

  return {
    generationId: item.id,
    visibility: draft.visibility,
    title: trimOrUndefined(draft.title) ?? getPublishGenerationTitle(item),
    description: trimOrUndefined(draft.description),
    body: trimOrUndefined(draft.caption),
    category: draft.category === 'text' ? getPublishGenerationMediaKind(item) ?? 'image' : draft.category,
    sourceTool: trimOrUndefined(primarySourceTool?.toolLabel) ?? trimOrUndefined(draft.sourceTool),
    sourceToolSlug: trimOrUndefined(primarySourceTool?.toolSlug) ?? trimOrUndefined(draft.sourceToolSlug),
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
    const sourceTools = !isTextProof(draft) || draft.mode === 'upload' ? buildSourceToolsPayload(draft) : [];
    const primarySourceTool = sourceTools[0];
    const mediaItems = buildPostComposerMediaItemsPayload(draft);

    return {
      title: draft.title.trim(),
      description: (draft.description || draft.caption).trim(),
      body,
      visibility: draft.visibility,
      category: draft.category,
      sourceTool: (primarySourceTool?.toolLabel ?? draft.sourceTool).trim(),
      sourceToolSlug: (primarySourceTool?.toolSlug ?? draft.sourceToolSlug).trim(),
      ...(sourceTools.length > 0 ? { sourceTools } : {}),
      ...(mediaItems.length > 0 ? { mediaItems } : {}),
      resourceBundle: buildPostResourceBundleInput(draft.resource) ?? { accessMode: 'none' },
    };
  }
}

export function validatePostComposerDraft(draft: PostComposerDraft): PostComposerValidationResult {
  if (isTextProof(draft) && !draft.contentText.trim() && !draft.caption.trim()) {
    return { valid: false, message: 'Write the text post or add a caption.' };
  }

  if (!isTextProof(draft) && draft.mode === 'upload' && draft.mediaItems.length === 0 && !draft.upload) {
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
  formData.append('description', (draft.description || draft.caption).trim());
  formData.append('body', getCreatePostBody(draft));
  const sourceTools = !isTextProof(draft) || draft.mode === 'upload' || draft.mode === 'creation'
    ? buildSourceToolsPayload(draft)
    : [];
  const primarySourceTool = sourceTools[0];
  formData.append('sourceTool', (primarySourceTool?.toolLabel ?? draft.sourceTool).trim());
  const primarySourceToolSlug = primarySourceTool?.toolSlug ?? draft.sourceToolSlug;
  if (primarySourceToolSlug.trim()) {
    formData.append('sourceToolSlug', primarySourceToolSlug.trim());
  }
  if (sourceTools.length > 0) {
    formData.append('sourceTools', JSON.stringify(sourceTools));
  }
  formData.append('visibility', draft.visibility);
  formData.append('postFormat', getCreatePostFormat(draft));
  formData.append('resourceBundle', JSON.stringify(buildPostResourceBundleInput(draft.resource) ?? { accessMode: 'none' }));

  if (draft.mode === 'upload') {
    formData.append('category', draft.category);
    const mediaItems = buildPostComposerMediaItemsPayload(draft);
    if (mediaItems.length > 0) {
      formData.append('mediaItems', JSON.stringify(mediaItems));
    } else if (draft.upload) {
      formData.append('media', {
        uri: draft.upload.uri,
        name: draft.upload.name,
        type: draft.upload.type,
      } as unknown as Blob);
    }
  }

  return formData;
}

export function buildPostComposerMediaItemsPayload(draft: PostComposerDraft): PostComposerMediaItemPayload[] {
  return draft.mediaItems
    .slice(0, MAX_MEDIA_ITEMS)
    .map((item): PostComposerMediaItemPayload | null => {
      if (item.existingId) {
        return { existingId: item.existingId };
      }

      if (!item.storagePath) {
        return null;
      }

      return {
        storagePath: item.storagePath,
        contentType: item.type,
        originalName: item.name,
      };
    })
    .filter((item): item is PostComposerMediaItemPayload => item !== null);
}

export function buildOptimisticOwnerPostListItem(
  postId: string | null | undefined,
  draft: PostComposerDraft,
  createdAt = new Date().toISOString()
): OwnerPostListItem | null {
  if (!postId || draft.mode === 'creation') return null;

  const mediaItems = buildOptimisticProfileMediaItems(draft);
  if (draft.mode === 'upload' && mediaItems.length === 0) return null;

  const coverMedia = mediaItems[0] ?? null;
  const isTextPost = isTextProof(draft);
  const sourceTools = !isTextPost || draft.mode === 'upload'
    ? buildSourceToolsPayload(draft)
    : [];
  const primarySourceTool = sourceTools[0];
  const title = trimOrUndefined(draft.title)
    ?? trimOrUndefined(draft.contentText)
    ?? trimOrUndefined(draft.caption)
    ?? 'Untitled post';

  return {
    id: postId,
    title,
    createdAt,
    visibility: draft.visibility,
    mediaUrl: coverMedia?.url ?? null,
    mediaKind: isTextPost ? null : coverMedia?.mediaKind ?? inferMediaKindFromDraft(draft),
    ...(mediaItems.length > 0 ? { mediaItems } : {}),
    description: trimOrUndefined(draft.description) ?? trimOrUndefined(draft.caption),
    prompt: isTextPost ? trimOrUndefined(draft.contentText) : undefined,
    body: getCreatePostBody(draft),
    category: draft.category,
    postFormat: getCreatePostFormat(draft),
    sourceLabel: primarySourceTool?.modelLabel
      ? `${primarySourceTool.toolLabel} · ${primarySourceTool.modelLabel}`
      : primarySourceTool?.toolLabel ?? trimOrUndefined(draft.sourceTool),
    publicPath: draft.visibility === 'private' ? null : `/showcase/${postId}`,
    ownerPath: `/showcase/${postId}`,
    bundle: null,
    archivedAt: null,
    generationId: null,
    sourceTool: primarySourceTool?.toolLabel ?? trimOrUndefined(draft.sourceTool) ?? null,
    sourceToolSlug: primarySourceTool?.toolSlug ?? trimOrUndefined(draft.sourceToolSlug) ?? null,
    sourceTools,
  };
}

export function upsertOptimisticOwnerPostResponse(
  current: OwnerPostsResponse | undefined,
  post: OwnerPostListItem
): OwnerPostsResponse {
  return {
    success: current?.success ?? true,
    ...current,
    posts: [
      post,
      ...(current?.posts ?? []).filter((item) => item.id !== post.id),
    ],
  };
}

function buildOptimisticProfileMediaItems(draft: PostComposerDraft): NonNullable<OwnerPostListItem['mediaItems']> {
  const items = draft.mediaItems.length
    ? draft.mediaItems
    : draft.upload
      ? [{
          id: 'optimistic-upload',
          uri: draft.upload.uri,
          previewUrl: draft.upload.uri,
          name: draft.upload.name,
          type: draft.upload.type,
          mediaKind: inferMediaKindFromContentType(draft.upload.type, draft),
          storagePath: null,
          existingId: null,
        }]
      : [];

  return items.map((item, index) => {
    const url = item.previewUrl || item.uri;

    return {
      id: item.existingId ?? item.id,
      url,
      previewUrl: item.mediaKind === 'image' ? url : null,
      mediaKind: item.mediaKind,
      contentType: item.type || null,
      originalName: item.name || null,
      width: null,
      height: null,
      durationSeconds: null,
      sortOrder: index,
    };
  });
}

function inferMediaKindFromContentType(
  contentType: string | null | undefined,
  draft: PostComposerDraft
): 'image' | 'video' {
  if (contentType?.startsWith('video/')) return 'video';
  if (contentType?.startsWith('image/')) return 'image';
  return inferMediaKindFromDraft(draft) === 'video' ? 'video' : 'image';
}

function inferMediaKindFromDraft(draft: PostComposerDraft): 'image' | 'video' | null {
  if (draft.category === 'video') return 'video';
  if (draft.category === 'image') return 'image';
  return null;
}

export function buildPostResourceBundleInput(resource: PostComposerResourceDraft): PostResourceBundleInput | null {
  if (resource.accessMode === 'none') {
    return null;
  }

  const selectedKinds = getResourceSelections(resource);
  const attachments = buildResourceAttachments(resource);
  const sectionItems = resource.organizeSections ? buildSectionResourceItems(resource.sections ?? [], 0) : [];
  const globalItems = buildResourceItems({
    selectedKinds,
    promptText: resource.promptText,
    notesMarkdown: resource.notesMarkdown,
    workflowShareUrl: resource.workflowShareUrl,
    attachments,
    allowRemix: Boolean(resource.allowRemix || selectedKinds.remix),
    startingSortOrder: sectionItems.length,
  });
  const sections = resource.organizeSections ? serializeResourceSections(resource.sections ?? []) : [];
  const items = [...sectionItems, ...globalItems];
  const resources = {
    promptText: selectedKinds.prompt ? trimOrNull(resource.promptText) : null,
    notesMarkdown: selectedKinds.notes ? trimOrNull(resource.notesMarkdown) : null,
    workflowShareUrl: selectedKinds.workflow ? trimOrNull(resource.workflowShareUrl) : null,
    attachments: selectedKinds.files ? attachments : [],
    allowRemix: Boolean(resource.allowRemix || selectedKinds.remix),
    ...(sections.length > 0 ? { sections } : {}),
    ...(items.length > 0 ? { items } : {}),
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

export function getPostComposerPublishActions(params: {
  selectedVisibility: PostComposerVisibility;
  isEditMode: boolean;
  isPending: boolean;
  pendingVisibility?: PostComposerVisibility | null;
}): PostComposerPublishAction[] {
  const createAction = (
    visibility: PostComposerVisibility,
    label: string,
    variant: 'primary' | 'secondary'
  ): PostComposerPublishAction => {
    const loading = params.isPending
      && (params.pendingVisibility ? params.pendingVisibility === visibility : params.selectedVisibility === visibility);
    const pendingLabel = params.isEditMode ? 'Saving' : visibility === 'public' ? 'Publishing' : 'Saving';

    return {
      id: visibility,
      label: loading ? pendingLabel : label,
      visibility,
      variant,
      disabled: params.isPending,
      loading,
    };
  };

  const actions: PostComposerPublishAction[] = [
    createAction('private', 'Save private', 'secondary'),
  ];

  if (params.selectedVisibility === 'unlisted') {
    actions.push(createAction('unlisted', 'Save unlisted', 'secondary'));
  }

  actions.push(createAction('public', 'Publish public', 'primary'));

  return actions;
}

function isPublicPostReady(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null,
  skipGenerationSelection = false
) {
  if (isTextProof(draft)) return Boolean(draft.contentText.trim() || draft.caption.trim());
  if (draft.mode === 'upload') return draft.mediaItems.length > 0 || Boolean(draft.upload);
  if (draft.mode === 'creation') return skipGenerationSelection || Boolean(selectedGeneration ?? draft.selectedGenerationId);
  return false;
}

function publicPostMissingMessage(
  draft: PostComposerDraft,
  selectedGeneration?: GenerationListItem | null,
  skipGenerationSelection = false
) {
  if (isTextProof(draft) && !draft.contentText.trim() && !draft.caption.trim()) {
    return 'Write the text post or add a caption.';
  }
  if (draft.mode === 'upload' && draft.mediaItems.length === 0 && !draft.upload) {
    return 'Upload an image or video before publishing.';
  }
  if (draft.mode === 'creation' && !skipGenerationSelection && !selectedGeneration && !draft.selectedGenerationId) {
    return 'Choose a finished Magicbooklet creation.';
  }
  return 'Complete the required public post fields.';
}

export function getCreatePostBody(draft: PostComposerDraft) {
  const parts = isTextProof(draft)
    ? [draft.contentText.trim(), draft.caption.trim()]
    : [draft.caption.trim()];
  return parts.filter(Boolean).join('\n\n');
}

export function getCreatePostFormat(draft: PostComposerDraft): 'text' | 'media' | 'mixed' {
  if (isTextProof(draft)) return 'text';
  return draft.caption.trim() ? 'mixed' : 'media';
}

export function getPublishGenerationTitle(item: GenerationListItem) {
  return item.title || item.template?.templateTitle || item.prompt || 'Untitled creation';
}

export function getPublishGenerationSubtitle(item: GenerationListItem) {
  const category = item.creationMode === 'motion' ? 'Motion' : getGenerationCategoryLabel(item.category);
  return `${category} · ${item.model || 'Magicbooklet'}`;
}

export function getPublishGenerationMediaKind(item: GenerationListItem): 'image' | 'video' | null {
  const category = normalizeGenerationCategory(item.category);
  if (category === 'video') return 'video';
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
  if (category === 'motion' || category === 'ugc-ad') return 'video';
  if (category === 'video' || category === 'text') {
    return category;
  }
  return 'image';
}

function isTextProof(draft: PostComposerDraft) {
  return draft.mode === 'text' && draft.proofMode === 'text';
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

export function createMadeWithRow(partial: Partial<PostComposerMadeWithRow> = {}): PostComposerMadeWithRow {
  const toolLabel = partial.toolLabel ?? '';
  const modelLabel = partial.modelLabel ?? '';

  return {
    id: partial.id ?? `mw-${Math.random().toString(36).slice(2, 10)}`,
    toolLabel,
    toolSlug: partial.toolSlug ?? slugifySourceValue(toolLabel) ?? '',
    modelLabel,
    modelSlug: partial.modelSlug ?? slugifySourceValue(modelLabel) ?? '',
    createTool: partial.createTool ?? false,
    createModel: partial.createModel ?? false,
  };
}

function buildSourceToolsPayload(
  draft: PostComposerDraft,
  item?: GenerationListItem
): PostComposerSourceToolSelection[] {
  const madeWithRows = getSourceRowsForSubmit(draft);
  if (madeWithRows.length > 0) {
    return madeWithRows
      .slice(0, MAX_MADE_WITH_ROWS)
      .map((row) => ({
        toolLabel: row.toolLabel.trim(),
        toolSlug: slugifySourceValue(row.toolSlug) ?? slugifySourceValue(row.toolLabel),
        ...(row.modelLabel.trim()
          ? {
              modelLabel: row.modelLabel.trim(),
              modelSlug: slugifySourceValue(row.modelSlug) ?? slugifySourceValue(row.modelLabel),
            }
          : {}),
        ...(row.createTool ? { createTool: true } : {}),
        ...(row.createModel ? { createModel: true } : {}),
      }))
      .filter((row) => row.toolLabel);
  }

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

function getSourceRowsForSubmit(draft: PostComposerDraft): PostComposerMadeWithRow[] {
  const rows = draft.madeWithRows ?? [];
  const nonEmptyRows = rows.filter((row) => row.toolLabel.trim());
  const hasExplicitRows = nonEmptyRows.some((row) => {
    const isDefaultManual = row.toolLabel.trim() === 'Manual'
      && (row.toolSlug.trim() === 'manual' || !row.toolSlug.trim())
      && !row.modelLabel.trim()
      && !row.createTool
      && !row.createModel;
    return !isDefaultManual;
  });

  if (hasExplicitRows || draft.sourceTool.trim() === 'Manual') {
    return nonEmptyRows;
  }

  return [];
}

function getPriceUsdCents(value: string) {
  const parsed = Number.parseFloat(value.trim() || '0');
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed * 100));
}

function buildResourceAttachments(resource: PostComposerResourceDraft): PostResourceAttachment[] {
  const rows = resource.attachments?.length
    ? resource.attachments
    : resource.attachmentUrl?.trim()
      ? [{
          id: 'legacy-attachment',
          kind: 'link' as const,
          label: resource.attachmentLabel,
          url: resource.attachmentUrl,
        }]
      : [];

  return rows
    .map((row): PostResourceAttachment | null => {
      if (row.kind === 'file') {
        const storagePath = row.storagePath?.trim();
        if (!storagePath) return null;
        return {
          kind: 'file',
          label: row.label.trim() || storagePath.split('/').pop() || 'File',
          storagePath,
          contentType: row.contentType ?? null,
          sizeBytes: row.sizeBytes ?? null,
          ...(row.resourceType ? { resourceType: row.resourceType } : {}),
          ...(row.role ? { role: row.role } : {}),
          ...(row.remixUse ? { remixUse: row.remixUse } : {}),
        };
      }

      const url = row.url?.trim();
      if (!url) return null;
      return {
        kind: 'link',
        label: row.label.trim() || url,
        url,
        ...(row.resourceType ? { resourceType: row.resourceType } : {}),
        ...(row.role ? { role: row.role } : {}),
        ...(row.remixUse ? { remixUse: row.remixUse } : {}),
      };
    })
    .filter((row): row is PostResourceAttachment => row !== null);
}

function getSelectedResourceKinds(resources: {
  promptText: string | null;
  notesMarkdown: string | null;
  workflowShareUrl: string | null;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
  sections?: PostResourceSection[];
  items?: PostResourceItem[];
}) {
  const kinds: PostResourceKind[] = [];
  const items = resources.items ?? [];
  if (resources.promptText || items.some((item) => item.type === 'prompt')) kinds.push('prompt');
  if (resources.workflowShareUrl || items.some((item) => item.type === 'workflow')) kinds.push('workflow');
  if (resources.attachments.length > 0 || items.some((item) => item.storagePath || item.externalUrl)) kinds.push('files');
  if (resources.notesMarkdown || items.some((item) => item.type === 'note' || item.type === 'settings')) kinds.push('notes');
  if (resources.allowRemix || items.some((item) => item.type === 'remix_access')) kinds.push('remix');
  return kinds;
}

function getResourceSelections(resource: PostComposerResourceDraft): PostComposerResourceSelections {
  return {
    prompt: Boolean(resource.selectedKinds?.prompt || resource.promptText?.trim()),
    workflow: Boolean(resource.selectedKinds?.workflow || resource.workflowShareUrl?.trim()),
    files: Boolean(resource.selectedKinds?.files || resource.attachmentUrl?.trim() || resource.attachments?.length),
    notes: Boolean(resource.selectedKinds?.notes || resource.notesMarkdown?.trim()),
    remix: Boolean(resource.selectedKinds?.remix || resource.allowRemix),
  };
}

function serializeResourceSections(rows: PostComposerResourceSectionDraft[]): PostResourceSection[] {
  return rows
    .filter(sectionHasContent)
    .map((section, index) => ({
      id: section.id,
      title: section.title.trim() || `Section ${index + 1}`,
      kind: section.kind,
      description: section.description.trim() || null,
      sortOrder: index,
    }));
}

function sectionHasContent(section: PostComposerResourceSectionDraft) {
  return Boolean(
    section.title.trim()
    || section.description.trim()
    || section.promptText.trim()
    || section.workflowShareUrl.trim()
    || section.notesMarkdown.trim()
    || section.attachments.length > 0
    || section.allowRemix
  );
}

function pushResourceItem(
  items: PostResourceItem[],
  item: Omit<PostResourceItem, 'sortOrder' | 'isPrimary'>,
  startingSortOrder: number
) {
  items.push({
    ...item,
    sortOrder: startingSortOrder + items.length,
    isPrimary: startingSortOrder + items.length === 0,
  });
}

function buildResourceItems(params: {
  selectedKinds: PostComposerResourceSelections;
  promptText: string;
  notesMarkdown: string;
  workflowShareUrl: string;
  attachments: PostResourceAttachment[];
  allowRemix: boolean;
  startingSortOrder: number;
}): PostResourceItem[] {
  const items: PostResourceItem[] = [];

  if (params.selectedKinds.prompt && params.promptText.trim()) {
    pushResourceItem(items, createTextResourceItem({
      type: 'prompt',
      title: 'Prompt',
      textContent: params.promptText.trim(),
    }), params.startingSortOrder);
  }

  if (params.selectedKinds.workflow && params.workflowShareUrl.trim()) {
    pushResourceItem(items, {
      type: 'workflow',
      role: 'primary',
      sectionId: null,
      title: 'Workflow',
      description: null,
      textContent: null,
      externalUrl: params.workflowShareUrl.trim(),
      storagePath: null,
      contentType: null,
      sizeBytes: null,
      workflowSnapshot: null,
      remixUse: 'import_source',
    }, params.startingSortOrder);
  }

  if (params.selectedKinds.files) {
    for (const attachment of params.attachments) {
      pushResourceItem(items, createAttachmentResourceItem(attachment, null), params.startingSortOrder);
    }
  }

  if (params.selectedKinds.notes && params.notesMarkdown.trim()) {
    pushResourceItem(items, createTextResourceItem({
      type: 'note',
      title: 'Notes',
      textContent: params.notesMarkdown.trim(),
    }), params.startingSortOrder);
  }

  if (params.allowRemix) {
    pushResourceItem(items, createRemixResourceItem('Remix access', null), params.startingSortOrder);
  }

  return items;
}

function buildSectionResourceItems(sections: PostComposerResourceSectionDraft[], startingSortOrder: number): PostResourceItem[] {
  const items: PostResourceItem[] = [];

  for (const section of sections.filter(sectionHasContent)) {
    const title = section.title.trim() || 'Section';
    if (section.promptText.trim()) {
      pushResourceItem(items, createTextResourceItem({
        type: 'prompt',
        title: `${title} prompt`,
        textContent: section.promptText.trim(),
        sectionId: section.id,
      }), startingSortOrder);
    }

    if (section.workflowShareUrl.trim()) {
      pushResourceItem(items, {
        type: 'workflow',
        role: 'primary',
        sectionId: section.id,
        title: `${title} workflow`,
        description: null,
        textContent: null,
        externalUrl: section.workflowShareUrl.trim(),
        storagePath: null,
        contentType: null,
        sizeBytes: null,
        workflowSnapshot: null,
        remixUse: 'import_source',
      }, startingSortOrder);
    }

    for (const attachment of section.attachments) {
      for (const serialized of buildResourceAttachments({
        ...getDefaultResourceDraft(),
        accessMode: 'free',
        selectedKinds: { ...DEFAULT_RESOURCE_SELECTIONS, files: true },
        attachments: [attachment],
      })) {
        pushResourceItem(items, createAttachmentResourceItem(serialized, section.id), startingSortOrder);
      }
    }

    if (section.notesMarkdown.trim()) {
      pushResourceItem(items, createTextResourceItem({
        type: 'note',
        title: `${title} notes`,
        textContent: section.notesMarkdown.trim(),
        sectionId: section.id,
      }), startingSortOrder);
    }

    if (section.allowRemix) {
      pushResourceItem(items, createRemixResourceItem(`${title} remix access`, section.id), startingSortOrder);
    }
  }

  return items;
}

function createTextResourceItem(params: {
  type: 'prompt' | 'note';
  title: string;
  textContent: string;
  sectionId?: string | null;
}): Omit<PostResourceItem, 'sortOrder' | 'isPrimary'> {
  return {
    type: params.type,
    role: 'primary',
    sectionId: params.sectionId ?? null,
    title: params.title,
    description: null,
    textContent: params.textContent,
    externalUrl: null,
    storagePath: null,
    contentType: null,
    sizeBytes: null,
    workflowSnapshot: null,
    remixUse: 'none',
  };
}

function createAttachmentResourceItem(
  attachment: PostResourceAttachment,
  sectionId: string | null
): Omit<PostResourceItem, 'sortOrder' | 'isPrimary'> {
  const type = attachment.resourceType ?? (attachment.kind === 'file' ? 'source_file' : 'external_link');

  return {
    type,
    role: attachment.role ?? (type === 'reference_image' ? 'style_reference' : 'primary'),
    sectionId,
    title: attachment.label,
    description: null,
    textContent: null,
    externalUrl: attachment.kind === 'file' ? null : attachment.url ?? null,
    storagePath: attachment.kind === 'file' ? attachment.storagePath ?? null : null,
    contentType: attachment.contentType ?? null,
    sizeBytes: attachment.sizeBytes ?? null,
    workflowSnapshot: null,
    remixUse: attachment.remixUse ?? (type === 'reference_image' ? 'reference_only' : type === 'workflow' ? 'import_source' : 'none'),
  };
}

function createRemixResourceItem(
  title: string,
  sectionId: string | null
): Omit<PostResourceItem, 'sortOrder' | 'isPrimary'> {
  return {
    type: 'remix_access',
    role: 'primary',
    sectionId,
    title,
    description: null,
    textContent: null,
    externalUrl: null,
    storagePath: null,
    contentType: null,
    sizeBytes: null,
    workflowSnapshot: null,
    remixUse: 'direct_remix',
  };
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
  if (normalized === 'video') return 'Video';
  if (normalized === 'text') return 'Text';
  return 'Image';
}
