export interface SourceToolModel {
  slug: string;
  label: string;
}

export interface SourceToolOption {
  slug: string;
  label: string;
  models: SourceToolModel[];
  supportedMediaKinds: Array<'image' | 'video'>;
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

const APP_SOURCE_TOOL: SourceToolOption = {
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
  ],
  supportedMediaKinds: ['image', 'video'],
};

export const FALLBACK_SOURCE_TOOLS: SourceToolOption[] = [
  APP_SOURCE_TOOL,
  {
    slug: 'higgsfield',
    label: 'Higgsfield',
    models: [
      { slug: 'soul', label: 'Soul' },
      { slug: 'k2', label: 'K2' },
    ],
    supportedMediaKinds: ['image', 'video'],
  },
  {
    slug: 'freepik',
    label: 'Freepik',
    models: [
      { slug: 'mystic', label: 'Mystic' },
      { slug: 'classic', label: 'Classic' },
    ],
    supportedMediaKinds: ['image'],
  },
  {
    slug: 'runway',
    label: 'Runway',
    models: [
      { slug: 'gen-3', label: 'Gen-3' },
      { slug: 'gen-4', label: 'Gen-4' },
    ],
    supportedMediaKinds: ['image', 'video'],
  },
  {
    slug: 'midjourney',
    label: 'Midjourney',
    models: [],
    supportedMediaKinds: ['image'],
  },
  {
    slug: 'kling',
    label: 'Kling',
    models: [
      { slug: 'kling-2.6', label: 'Kling 2.6' },
      { slug: 'kling-3.0', label: 'Kling 3.0' },
    ],
    supportedMediaKinds: ['image', 'video'],
  },
  {
    slug: 'sora',
    label: 'Sora',
    models: [],
    supportedMediaKinds: ['video'],
  },
  {
    slug: 'veo',
    label: 'Veo',
    models: [
      { slug: 'veo-3.1', label: 'Veo 3.1' },
    ],
    supportedMediaKinds: ['video'],
  },
  {
    slug: 'capcut',
    label: 'CapCut',
    models: [],
    supportedMediaKinds: ['image', 'video'],
  },
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
