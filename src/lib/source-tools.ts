export type SourceToolType = 'platform' | 'editor' | 'workflow' | 'api-marketplace';
export type SourceToolCapability = 'image' | 'video' | 'audio' | 'avatar' | 'design' | '3d' | 'vfx';
export type SourceToolCatalogTier = 'featured' | 'extended' | 'historical';
export type SourceToolStatus = 'current' | 'legacy' | 'deprecated' | 'sunset';

export interface SourceToolModel {
  slug: string;
  label: string;
  capabilities?: SourceToolCapability[];
  status?: SourceToolStatus;
  providerSlug?: string | null;
  aliases?: string[];
}

export interface SourceToolOption {
  slug: string;
  label: string;
  models: SourceToolModel[];
  supportedMediaKinds: Array<'image' | 'video'>;
  toolType?: SourceToolType;
  capabilities?: SourceToolCapability[];
  catalogTier?: SourceToolCatalogTier;
  status?: SourceToolStatus;
  providerSlug?: string | null;
  aliases?: string[];
}

export interface SourceToolSelection {
  toolLabel: string;
  toolSlug: string | null;
  modelLabel?: string | null;
  modelSlug?: string | null;
  createTool?: boolean;
  createModel?: boolean;
}

const MAX_SOURCE_TOOL_SELECTIONS = 5;
const MAX_SOURCE_TOOL_LABEL_LENGTH = 80;
const MAX_SOURCE_MODEL_LABEL_LENGTH = 80;
const RESERVED_SOURCE_CATALOG_SLUGS = new Set(['all', 'custom', 'unknown']);

function sourceTool(
  input: Omit<SourceToolOption, 'models' | 'toolType' | 'capabilities' | 'catalogTier' | 'status' | 'aliases'>
    & Partial<Pick<SourceToolOption, 'models' | 'toolType' | 'capabilities' | 'catalogTier' | 'status' | 'aliases'>>
): SourceToolOption {
  return {
    models: [],
    toolType: 'platform',
    capabilities: input.supportedMediaKinds,
    catalogTier: 'extended',
    status: 'current',
    aliases: [],
    ...input,
  };
}

const APP_SOURCE_TOOL: SourceToolOption = sourceTool({
  slug: 'magicbooklet',
  label: 'magicbooklet',
  models: [
    { slug: 'nano-banana-2-lite', label: 'Nano Banana 2 Lite' },
    { slug: 'nano-banana-2', label: 'Nano Banana 2.0' },
    { slug: 'nano-banana-pro', label: 'Nano Banana Pro' },
    { slug: 'gpt-image-2', label: 'GPT Image 2' },
    { slug: 'seedream-5-pro', label: 'Seedream 5 Pro' },
    { slug: 'flux-2-pro', label: 'FLUX.2 Pro' },
    { slug: 'z-image', label: 'Z-Image' },
    { slug: 'grok-imagine-image', label: 'Grok Imagine' },
    { slug: 'kling-2.6', label: 'Kling 2.6 Motion' },
    { slug: 'kling-3.0', label: 'Kling 3.0 Motion' },
    { slug: 'kling-3.0-video', label: 'Kling 3.0 Cinematic' },
    { slug: 'seedance-1.5-pro', label: 'Seedance 1.5 Pro' },
    { slug: 'seedance-2', label: 'Seedance 2' },
    { slug: 'seedance-2-fast', label: 'Seedance 2 Fast' },
    { slug: 'veo-3.1', label: 'Veo 3.1' },
    { slug: 'grok-imagine-video', label: 'Grok Imagine Video' },
    { slug: 'grok-imagine-image-2', label: 'Grok Imagine 2.0' },
    { slug: 'qwen3', label: 'Qwen Image 3.0' },
    { slug: 'qwen3-pro', label: 'Qwen Image 3.0 Pro' },
    { slug: 'ideogram-character', label: 'Ideogram Character' },
    { slug: 'seedance-2-5', label: 'Seedance 2.5' },
    { slug: 'kling-o3', label: 'Kling O3' },
    { slug: 'minimax-h3', label: 'MiniMax H3' },
    // Registration audit 2026-08-16: first-party attribution catalog had drifted
    // to 16 of 29 models; these were the missing shipped models.
    { slug: 'seedream-5-lite', label: 'Seedream 5 Lite' },
    { slug: 'wan-2.7-image', label: 'Wan 2.7 Image' },
    { slug: 'wan-2.7-image-pro', label: 'Wan 2.7 Image Pro' },
    { slug: 'imagen-4-fast', label: 'Imagen 4 Fast' },
    { slug: 'imagen-4', label: 'Imagen 4' },
    { slug: 'imagen-4-ultra', label: 'Imagen 4 Ultra' },
    { slug: 'ideogram-v3', label: 'Ideogram V3' },
    { slug: 'kling-3.0-turbo', label: 'Kling 3 Turbo' },
    { slug: 'seedance-2-mini', label: 'Seedance 2 Mini' },
    { slug: 'wan-2.7', label: 'Wan 2.7' },
    { slug: 'happyhorse-1.1', label: 'HappyHorse 1.1' },
    { slug: 'gemini-omni-video', label: 'Gemini Omni Video' },
    { slug: 'hailuo-2.3', label: 'Hailuo 2.3' },
  ],
  supportedMediaKinds: ['image', 'video'],
  catalogTier: 'featured',
  aliases: ['Magic Booklet', 'Emptybooklet'],
});

export const FALLBACK_SOURCE_TOOLS: SourceToolOption[] = [
  APP_SOURCE_TOOL,
  sourceTool({
    slug: 'adobe-firefly',
    label: 'Adobe Firefly',
    models: [
      { slug: 'firefly-image-5', label: 'Firefly Image 5', capabilities: ['image'] },
      { slug: 'firefly-image-4-ultra', label: 'Firefly Image 4 Ultra', capabilities: ['image'] },
      { slug: 'firefly-video', label: 'Firefly Video', capabilities: ['video'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    providerSlug: 'adobe',
    aliases: ['Firefly'],
  }),
  sourceTool({
    slug: 'midjourney',
    label: 'Midjourney',
    models: [
      { slug: 'v8.1', label: 'V8.1', capabilities: ['image'] },
      { slug: 'v7', label: 'V7', capabilities: ['image'] },
      { slug: 'niji-7', label: 'Niji 7', capabilities: ['image'] },
      { slug: 'midjourney-video', label: 'Midjourney Video', capabilities: ['video'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'runway',
    label: 'Runway',
    models: [
      { slug: 'gen-4.5', label: 'Gen-4.5', capabilities: ['video'] },
      { slug: 'aleph-2', label: 'Aleph 2', capabilities: ['video', 'vfx'] },
      { slug: 'gen-4-turbo', label: 'Gen-4 Turbo', capabilities: ['video'] },
      { slug: 'act-two', label: 'Act-Two', capabilities: ['video', 'avatar'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'google-gemini-flow',
    label: 'Google Gemini / Flow',
    models: [
      { slug: 'nano-banana-2', label: 'Nano Banana 2', capabilities: ['image'] },
      { slug: 'nano-banana-pro', label: 'Nano Banana Pro', capabilities: ['image'] },
      { slug: 'veo-3.1', label: 'Veo 3.1', capabilities: ['video'] },
      { slug: 'veo-3.1-fast', label: 'Veo 3.1 Fast', capabilities: ['video'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    providerSlug: 'google',
    aliases: ['Gemini', 'Flow', 'Google AI Studio', 'Nano Banana', 'Veo'],
  }),
  sourceTool({
    slug: 'openai-chatgpt',
    label: 'ChatGPT',
    models: [
      { slug: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['image'] },
      { slug: 'gpt-image-1.5', label: 'GPT Image 1.5', capabilities: ['image'] },
      { slug: 'gpt-image-1', label: 'GPT Image 1', capabilities: ['image'] },
    ],
    supportedMediaKinds: ['image'],
    catalogTier: 'featured',
    providerSlug: 'openai',
    aliases: ['OpenAI', 'GPT Image'],
  }),
  sourceTool({
    slug: 'kling',
    label: 'Kling AI',
    models: [
      { slug: 'kling-3.0', label: 'Kling 3.0', capabilities: ['image', 'video'] },
      { slug: 'kling-o3', label: 'Kling O3', capabilities: ['video'] },
      { slug: 'kling-2.6', label: 'Kling 2.6', capabilities: ['video'] },
      { slug: 'motion-control', label: 'Motion Control', capabilities: ['video'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    providerSlug: 'kuaishou',
    aliases: ['Kling'],
  }),
  sourceTool({
    slug: 'higgsfield',
    label: 'Higgsfield',
    models: [
      { slug: 'soul', label: 'Soul' },
      { slug: 'k2', label: 'K2' },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'freepik',
    label: 'Freepik',
    models: [
      { slug: 'mystic', label: 'Mystic' },
      { slug: 'classic', label: 'Classic' },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    aliases: ['Freepik AI Suite'],
  }),
  sourceTool({
    slug: 'leonardo-ai',
    label: 'Leonardo.Ai',
    models: [
      { slug: 'lucid-origin', label: 'Lucid Origin', capabilities: ['image'] },
      { slug: 'lucid-realism', label: 'Lucid Realism', capabilities: ['image'] },
      { slug: 'phoenix-1.0', label: 'Phoenix 1.0', capabilities: ['image'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    aliases: ['Leonardo'],
  }),
  sourceTool({
    slug: 'black-forest-labs',
    label: 'Black Forest Labs',
    models: [
      { slug: 'flux.2-max', label: 'FLUX.2 Max', capabilities: ['image'] },
      { slug: 'flux.2-pro', label: 'FLUX.2 Pro', capabilities: ['image'] },
      { slug: 'flux.2-flex', label: 'FLUX.2 Flex', capabilities: ['image'] },
      { slug: 'flux.1-kontext-max', label: 'FLUX.1 Kontext Max', capabilities: ['image'] },
    ],
    supportedMediaKinds: ['image'],
    catalogTier: 'featured',
    aliases: ['BFL', 'FLUX', 'Flux AI'],
  }),
  sourceTool({
    slug: 'stability-ai',
    label: 'Stability AI',
    models: [
      { slug: 'stable-image-ultra', label: 'Stable Image Ultra', capabilities: ['image'] },
      { slug: 'stable-image-core', label: 'Stable Image Core', capabilities: ['image'] },
      { slug: 'stable-diffusion-3.5-large', label: 'Stable Diffusion 3.5 Large', capabilities: ['image'] },
    ],
    supportedMediaKinds: ['image'],
    catalogTier: 'featured',
    aliases: ['Stable Diffusion', 'SDXL'],
  }),
  sourceTool({
    slug: 'ideogram',
    label: 'Ideogram',
    models: [
      { slug: 'ideogram-3.0', label: 'Ideogram 3.0', capabilities: ['image'] },
      { slug: 'ideogram-2a', label: 'Ideogram 2a', capabilities: ['image'] },
    ],
    supportedMediaKinds: ['image'],
    catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'recraft',
    label: 'Recraft',
    models: [{ slug: 'recraft-v3', label: 'Recraft V3', capabilities: ['image', 'design'] }],
    supportedMediaKinds: ['image'],
    capabilities: ['image', 'design'],
    catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'krea',
    label: 'Krea',
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'luma-dream-machine',
    label: 'Luma Dream Machine',
    models: [
      { slug: 'ray-2', label: 'Ray 2', capabilities: ['video'] },
      { slug: 'ray-2-flash', label: 'Ray 2 Flash', capabilities: ['video'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    aliases: ['Luma AI', 'Dream Machine'],
  }),
  sourceTool({
    slug: 'pika',
    label: 'Pika',
    models: [
      { slug: 'pika-2.2', label: 'Pika 2.2', capabilities: ['video'] },
      { slug: 'pika-2.1', label: 'Pika 2.1', capabilities: ['video'] },
      { slug: 'pika-turbo', label: 'Pika Turbo', capabilities: ['video'] },
    ],
    supportedMediaKinds: ['image', 'video'],
    catalogTier: 'featured',
    aliases: ['Pika Labs'],
  }),
  sourceTool({
    slug: 'capcut', label: 'CapCut', supportedMediaKinds: ['image', 'video'],
    toolType: 'editor', capabilities: ['image', 'video', 'audio', 'design'], catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'canva', label: 'Canva', supportedMediaKinds: ['image', 'video'],
    toolType: 'editor', capabilities: ['image', 'video', 'design'], catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'adobe-photoshop', label: 'Adobe Photoshop', supportedMediaKinds: ['image'],
    toolType: 'editor', capabilities: ['image', 'design'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['Photoshop'],
  }),
  sourceTool({
    slug: 'adobe-premiere-pro', label: 'Adobe Premiere Pro', supportedMediaKinds: ['video'],
    toolType: 'editor', capabilities: ['video', 'audio'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['Premiere Pro'],
  }),
  sourceTool({
    slug: 'adobe-after-effects', label: 'Adobe After Effects', supportedMediaKinds: ['video'],
    toolType: 'editor', capabilities: ['video', 'vfx'], catalogTier: 'featured', providerSlug: 'adobe', aliases: ['After Effects', 'AE'],
  }),
  sourceTool({
    slug: 'davinci-resolve', label: 'DaVinci Resolve', supportedMediaKinds: ['video'],
    toolType: 'editor', capabilities: ['video', 'audio', 'vfx'], catalogTier: 'featured', providerSlug: 'blackmagic-design', aliases: ['Resolve'],
  }),
  sourceTool({
    slug: 'final-cut-pro', label: 'Final Cut Pro', supportedMediaKinds: ['video'],
    toolType: 'editor', capabilities: ['video', 'audio'], catalogTier: 'featured', providerSlug: 'apple', aliases: ['FCP'],
  }),
  sourceTool({
    slug: 'figma', label: 'Figma', supportedMediaKinds: ['image'],
    toolType: 'editor', capabilities: ['image', 'design'], catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'blender', label: 'Blender', supportedMediaKinds: ['image', 'video'],
    toolType: 'editor', capabilities: ['image', 'video', '3d', 'vfx'], catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'comfyui', label: 'ComfyUI', supportedMediaKinds: ['image', 'video'],
    toolType: 'workflow', capabilities: ['image', 'video'], catalogTier: 'featured', aliases: ['Comfy UI'],
  }),
  sourceTool({
    slug: 'heygen', label: 'HeyGen', supportedMediaKinds: ['video'],
    models: [
      { slug: 'avatar-iv', label: 'Avatar IV', capabilities: ['video', 'avatar'] },
      { slug: 'digital-twin', label: 'Digital Twin', capabilities: ['video', 'avatar'] },
    ],
    capabilities: ['video', 'audio', 'avatar'], catalogTier: 'featured',
  }),
  sourceTool({
    slug: 'elevenlabs', label: 'ElevenLabs', supportedMediaKinds: ['video'],
    models: [
      { slug: 'eleven-v3', label: 'Eleven v3', capabilities: ['audio'] },
      { slug: 'multilingual-v2', label: 'Multilingual v2', capabilities: ['audio'] },
      { slug: 'sound-effects-v2', label: 'Sound Effects v2', capabilities: ['audio'] },
    ],
    capabilities: ['audio'], catalogTier: 'featured', aliases: ['11Labs'],
  }),
  sourceTool({ slug: 'minimax-hailuo', label: 'MiniMax Hailuo', supportedMediaKinds: ['video'], models: [
    { slug: 'hailuo-2.3', label: 'Hailuo 2.3', capabilities: ['video'] },
    { slug: 'hailuo-2.3-fast', label: 'Hailuo 2.3 Fast', capabilities: ['video'] },
  ], aliases: ['Hailuo AI'] }),
  sourceTool({ slug: 'dreamina', label: 'Dreamina', supportedMediaKinds: ['image', 'video'], models: [
    { slug: 'seedream', label: 'Seedream', capabilities: ['image'] },
    { slug: 'seedance', label: 'Seedance', capabilities: ['video'] },
  ], providerSlug: 'bytedance', aliases: ['Seedream', 'Seedance'] }),
  sourceTool({ slug: 'wan-ai', label: 'Wan AI', supportedMediaKinds: ['image', 'video'], models: [
    { slug: 'wan-2.6', label: 'Wan 2.6', capabilities: ['video'] },
    { slug: 'wan-2.5', label: 'Wan 2.5', capabilities: ['video'] },
  ], aliases: ['Wan Video'] }),
  sourceTool({ slug: 'vidu', label: 'Vidu', supportedMediaKinds: ['video'], models: [
    { slug: 'q3', label: 'Q3', capabilities: ['video'] },
    { slug: 'q3-turbo', label: 'Q3 Turbo', capabilities: ['video'] },
  ] }),
  sourceTool({ slug: 'pixverse', label: 'PixVerse', supportedMediaKinds: ['video'], models: [{ slug: 'v6', label: 'V6', capabilities: ['video'] }] }),
  sourceTool({ slug: 'ltx-studio', label: 'LTX Studio', supportedMediaKinds: ['video'], models: [
    { slug: 'ltx-2.3-fast', label: 'LTX 2.3 Fast', capabilities: ['video'] },
    { slug: 'ltx-2.3-pro', label: 'LTX 2.3 Pro', capabilities: ['video'] },
  ], aliases: ['LTX Video'] }),
  sourceTool({ slug: 'xai-grok', label: 'Grok', supportedMediaKinds: ['image', 'video'], models: [
    { slug: 'grok-imagine-image', label: 'Grok Imagine Image', capabilities: ['image'] },
    { slug: 'grok-imagine-video', label: 'Grok Imagine Video', capabilities: ['video'] },
  ], providerSlug: 'xai', aliases: ['xAI', 'Grok Imagine'] }),
  sourceTool({ slug: 'adobe-lightroom', label: 'Adobe Lightroom', supportedMediaKinds: ['image'], toolType: 'editor', capabilities: ['image'], providerSlug: 'adobe', aliases: ['Lightroom'] }),
  sourceTool({ slug: 'adobe-illustrator', label: 'Adobe Illustrator', supportedMediaKinds: ['image'], toolType: 'editor', capabilities: ['image', 'design'], providerSlug: 'adobe', aliases: ['Illustrator'] }),
  sourceTool({ slug: 'adobe-express', label: 'Adobe Express', supportedMediaKinds: ['image', 'video'], toolType: 'editor', capabilities: ['image', 'video', 'design'], providerSlug: 'adobe' }),
  sourceTool({ slug: 'adobe-audition', label: 'Adobe Audition', supportedMediaKinds: ['video'], toolType: 'editor', capabilities: ['audio'], providerSlug: 'adobe', aliases: ['Audition'] }),
  sourceTool({ slug: 'cinema-4d', label: 'Cinema 4D', supportedMediaKinds: ['image', 'video'], toolType: 'editor', capabilities: ['image', 'video', '3d', 'vfx'], aliases: ['C4D'] }),
  sourceTool({ slug: 'zbrush', label: 'ZBrush', supportedMediaKinds: ['image'], toolType: 'editor', capabilities: ['image', '3d'] }),
  sourceTool({ slug: 'unreal-engine', label: 'Unreal Engine', supportedMediaKinds: ['image', 'video'], toolType: 'editor', capabilities: ['image', 'video', '3d', 'vfx'], aliases: ['UE5'] }),
  sourceTool({ slug: 'procreate', label: 'Procreate', supportedMediaKinds: ['image'], toolType: 'editor', capabilities: ['image', 'design'] }),
  sourceTool({ slug: 'procreate-dreams', label: 'Procreate Dreams', supportedMediaKinds: ['video'], toolType: 'editor', capabilities: ['video', 'design'] }),
  sourceTool({ slug: 'affinity', label: 'Affinity', supportedMediaKinds: ['image'], toolType: 'editor', capabilities: ['image', 'design'], aliases: ['Affinity Photo', 'Affinity Designer'] }),
  sourceTool({ slug: 'descript', label: 'Descript', supportedMediaKinds: ['video'], toolType: 'editor', capabilities: ['video', 'audio'] }),
  sourceTool({ slug: 'veed', label: 'VEED', supportedMediaKinds: ['video'], toolType: 'editor', capabilities: ['video', 'audio'] }),
  sourceTool({ slug: 'invideo', label: 'InVideo', supportedMediaKinds: ['video'], toolType: 'editor', capabilities: ['video', 'audio'] }),
  sourceTool({ slug: 'synthesia', label: 'Synthesia', supportedMediaKinds: ['video'], capabilities: ['video', 'audio', 'avatar'] }),
  sourceTool({ slug: 'd-id', label: 'D-ID', supportedMediaKinds: ['video'], capabilities: ['video', 'audio', 'avatar'] }),
  sourceTool({ slug: 'suno', label: 'Suno', supportedMediaKinds: ['video'], capabilities: ['audio'] }),
  sourceTool({ slug: 'udio', label: 'Udio', supportedMediaKinds: ['video'], capabilities: ['audio'] }),
  sourceTool({ slug: 'automatic1111', label: 'AUTOMATIC1111', supportedMediaKinds: ['image'], toolType: 'workflow', capabilities: ['image'], aliases: ['A1111', 'Stable Diffusion WebUI'] }),
  sourceTool({ slug: 'invokeai', label: 'InvokeAI', supportedMediaKinds: ['image'], toolType: 'workflow', capabilities: ['image'] }),
  sourceTool({ slug: 'replicate', label: 'Replicate', supportedMediaKinds: ['image', 'video'], toolType: 'api-marketplace', capabilities: ['image', 'video', 'audio'] }),
  sourceTool({ slug: 'fal', label: 'fal', supportedMediaKinds: ['image', 'video'], toolType: 'api-marketplace', capabilities: ['image', 'video', 'audio'], aliases: ['fal.ai'] }),
  sourceTool({ slug: 'kie-ai', label: 'Kie.ai', supportedMediaKinds: ['image', 'video'], toolType: 'api-marketplace', capabilities: ['image', 'video', 'audio'], aliases: ['Kie AI'] }),
  sourceTool({ slug: 'hugging-face', label: 'Hugging Face', supportedMediaKinds: ['image', 'video'], toolType: 'api-marketplace', capabilities: ['image', 'video', 'audio'], aliases: ['HF'] }),
  sourceTool({
    slug: 'sora',
    label: 'Sora',
    models: [
      { slug: 'sora-2', label: 'Sora 2', capabilities: ['video'], status: 'sunset' },
      { slug: 'sora-2-pro', label: 'Sora 2 Pro', capabilities: ['video'], status: 'sunset' },
    ],
    supportedMediaKinds: ['video'],
    catalogTier: 'historical',
    status: 'sunset',
    providerSlug: 'openai',
  }),
  sourceTool({
    slug: 'veo',
    label: 'Google Veo',
    models: [
      { slug: 'veo-3.1', label: 'Veo 3.1' },
    ],
    supportedMediaKinds: ['video'],
    catalogTier: 'historical',
    status: 'legacy',
    providerSlug: 'google',
    aliases: ['Veo'],
  }),
];

export function slugifySourceTool(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || null;
}

function getSourceToolBySlug(
  catalog: SourceToolOption[],
  slug: string | null | undefined
): SourceToolOption | null {
  if (!slug) {
    return null;
  }

  const normalizedSlug = slugifySourceTool(slug);
  if (!normalizedSlug) {
    return null;
  }

  if (normalizedSlug === 'emptybooklet') {
    return catalog.find((tool) => tool.slug === APP_SOURCE_TOOL.slug) ?? APP_SOURCE_TOOL;
  }

  return catalog.find((tool) => tool.slug === normalizedSlug) ?? null;
}

function getSourceToolByLabel(
  catalog: SourceToolOption[],
  label: string | null | undefined
): SourceToolOption | null {
  const normalizedLabel = label?.trim().toLowerCase();
  if (!normalizedLabel) {
    return null;
  }

  if (normalizedLabel === 'emptybooklet') {
    return catalog.find((tool) => tool.slug === APP_SOURCE_TOOL.slug) ?? APP_SOURCE_TOOL;
  }

  return catalog.find((tool) => tool.label.toLowerCase() === normalizedLabel) ?? null;
}

export function getSourceToolLabelFromCatalog(
  catalog: SourceToolOption[],
  slug: string | null | undefined
): string | null {
  return getSourceToolBySlug(catalog, slug)?.label ?? null;
}

export function getSourceToolOptionFromCatalog(
  catalog: SourceToolOption[],
  slug: string | null | undefined
): SourceToolOption | null {
  return getSourceToolBySlug(catalog, slug);
}

export function getSourceToolLabel(slug: string | null | undefined): string | null {
  return getSourceToolLabelFromCatalog(FALLBACK_SOURCE_TOOLS, slug);
}

export function getSourceToolOption(slug: string | null | undefined): SourceToolOption | null {
  return getSourceToolOptionFromCatalog(FALLBACK_SOURCE_TOOLS, slug);
}

export function normalizeSourceToolInputWithCatalog(
  catalog: SourceToolOption[],
  params: {
    label?: string | null;
    slug?: string | null;
  }
): { label: string | null; slug: string | null } {
  const requestedSlug = slugifySourceTool(params.slug);
  if (requestedSlug) {
    const tool = getSourceToolBySlug(catalog, requestedSlug);
    if (tool) {
      return {
        label: tool.label,
        slug: tool.slug,
      };
    }
  }

  const label = params.label?.trim() || null;
  if (!label) {
    return {
      label: null,
      slug: null,
    };
  }

  const catalogTool = getSourceToolByLabel(catalog, label);
  if (catalogTool) {
    return {
      label: catalogTool.label,
      slug: catalogTool.slug,
    };
  }

  return {
    label,
    slug: slugifySourceTool(label),
  };
}

export function normalizeSourceToolInput(params: {
  label?: string | null;
  slug?: string | null;
}): { label: string | null; slug: string | null } {
  return normalizeSourceToolInputWithCatalog(FALLBACK_SOURCE_TOOLS, params);
}

function normalizeOptionalLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.slice(0, maxLength);
}

function normalizeSourceModelInputWithCatalog(
  catalog: SourceToolOption[],
  params: {
    toolSlug?: string | null;
    label?: unknown;
    slug?: unknown;
  }
): { label: string | null; slug: string | null } {
  const rawLabel = normalizeOptionalLabel(params.label, MAX_SOURCE_MODEL_LABEL_LENGTH);
  const rawSlug = slugifySourceTool(normalizeOptionalLabel(params.slug, MAX_SOURCE_MODEL_LABEL_LENGTH));
  const tool = getSourceToolOptionFromCatalog(catalog, params.toolSlug);

  if (tool && rawSlug) {
    const model = tool.models.find((candidate) => candidate.slug === rawSlug);
    if (model) {
      return {
        label: model.label,
        slug: model.slug,
      };
    }
  }

  if (tool && rawLabel) {
    const model = tool.models.find((candidate) => candidate.label.toLowerCase() === rawLabel.toLowerCase());
    if (model) {
      return {
        label: model.label,
        slug: model.slug,
      };
    }
  }

  return {
    label: rawLabel ?? rawSlug,
    slug: rawSlug,
  };
}

export function normalizeSourceToolSelectionsWithCatalog(
  catalog: SourceToolOption[],
  value: unknown
): SourceToolSelection[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .slice(0, MAX_SOURCE_TOOL_SELECTIONS)
    .map((entry): SourceToolSelection | null => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const row = entry as Record<string, unknown>;
      const normalizedTool = normalizeSourceToolInputWithCatalog(catalog, {
        label: normalizeOptionalLabel(row.toolLabel, MAX_SOURCE_TOOL_LABEL_LENGTH),
        slug: normalizeOptionalLabel(row.toolSlug, MAX_SOURCE_TOOL_LABEL_LENGTH),
      });

      if (!normalizedTool.label) {
        return null;
      }

      const normalizedModel = normalizeSourceModelInputWithCatalog(catalog, {
        toolSlug: normalizedTool.slug,
        label: row.modelLabel,
        slug: row.modelSlug,
      });

      return {
        toolLabel: normalizedTool.label,
        toolSlug: normalizedTool.slug,
        modelLabel: normalizedModel.label,
        modelSlug: normalizedModel.slug,
        createTool: row.createTool === true,
        createModel: row.createModel === true,
      };
    })
    .filter((entry): entry is SourceToolSelection => entry !== null);
}

export function normalizeSourceToolSelections(value: unknown): SourceToolSelection[] {
  return normalizeSourceToolSelectionsWithCatalog(FALLBACK_SOURCE_TOOLS, value);
}

export function validateSourceToolSelections(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'Source tool metadata must be an array.';
  }

  if (value.length > MAX_SOURCE_TOOL_SELECTIONS) {
    return `A post can include at most ${MAX_SOURCE_TOOL_SELECTIONS} source tools.`;
  }

  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return 'Source tool metadata is invalid.';
    }

    const row = entry as Record<string, unknown>;
    const toolLabel = typeof row.toolLabel === 'string' ? row.toolLabel.trim() : '';
    const modelLabel = typeof row.modelLabel === 'string' ? row.modelLabel.trim() : '';

    if (!toolLabel) {
      return 'Source tool names cannot be empty.';
    }
    if (toolLabel.length > MAX_SOURCE_TOOL_LABEL_LENGTH) {
      return `Source tool names must be ${MAX_SOURCE_TOOL_LABEL_LENGTH} characters or fewer.`;
    }
    if (modelLabel.length > MAX_SOURCE_MODEL_LABEL_LENGTH) {
      return `Source model names must be ${MAX_SOURCE_MODEL_LABEL_LENGTH} characters or fewer.`;
    }

    const toolSlug = slugifySourceTool(
      typeof row.toolSlug === 'string' && row.toolSlug.trim() ? row.toolSlug : toolLabel
    );
    if (!toolSlug) {
      return 'Source tool names must include letters or numbers.';
    }
    if (RESERVED_SOURCE_CATALOG_SLUGS.has(toolSlug)) {
      return `The source tool name "${toolLabel}" is reserved.`;
    }

    if (modelLabel) {
      const modelSlug = slugifySourceTool(
        typeof row.modelSlug === 'string' && row.modelSlug.trim() ? row.modelSlug : modelLabel
      );
      if (!modelSlug) {
        return 'Source model names must include letters or numbers.';
      }
      if (RESERVED_SOURCE_CATALOG_SLUGS.has(modelSlug)) {
        return `The source model name "${modelLabel}" is reserved.`;
      }
    } else if (row.createModel === true) {
      return 'Choose a source model name before creating it.';
    }
  }

  return null;
}

export function formatSourceToolWithModel(params: {
  toolLabel: string | null | undefined;
  modelLabel?: string | null;
}): string | null {
  const tool = params.toolLabel?.trim();
  if (!tool) return null;

  const model = params.modelLabel?.trim();
  if (!model) return tool;

  return `${tool} · ${model}`;
}

export function formatSourceToolsCompact(
  tools: Array<{ toolLabel: string; modelLabel?: string | null }>
): string | null {
  const filled = tools.filter((t) => t.toolLabel.trim());
  if (filled.length === 0) return null;

  const first = formatSourceToolWithModel(filled[0]);
  if (filled.length === 1) return first;

  return `${first} + ${filled.length - 1} more`;
}
