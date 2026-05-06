export interface SourceToolOption {
  slug: string;
  label: string;
}

const APP_SOURCE_TOOL: SourceToolOption = { slug: 'magicbooklet', label: 'magicbooklet' };

export const CURATED_SOURCE_TOOLS: SourceToolOption[] = [
  APP_SOURCE_TOOL,
  { slug: 'higgsfield', label: 'Higgsfield' },
  { slug: 'freepik', label: 'Freepik' },
  { slug: 'runway', label: 'Runway' },
  { slug: 'midjourney', label: 'Midjourney' },
  { slug: 'kling', label: 'Kling' },
  { slug: 'sora', label: 'Sora' },
  { slug: 'veo', label: 'Veo' },
  { slug: 'capcut', label: 'CapCut' },
];

const SOURCE_TOOL_BY_SLUG = new Map<string, SourceToolOption>([
  ...CURATED_SOURCE_TOOLS.map((tool) => [tool.slug, tool] as const),
  ['emptybooklet', APP_SOURCE_TOOL],
]);
const SOURCE_TOOL_BY_LABEL = new Map<string, SourceToolOption>([
  ...CURATED_SOURCE_TOOLS.map((tool) => [tool.label.toLowerCase(), tool] as const),
  ['emptybooklet', APP_SOURCE_TOOL],
]);

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

export function getSourceToolLabel(slug: string | null | undefined): string | null {
  if (!slug) {
    return null;
  }

  return SOURCE_TOOL_BY_SLUG.get(slug)?.label ?? null;
}

export function normalizeSourceToolInput(params: {
  label?: string | null;
  slug?: string | null;
}): { label: string | null; slug: string | null } {
  const requestedSlug = slugifySourceTool(params.slug);
  if (requestedSlug && SOURCE_TOOL_BY_SLUG.has(requestedSlug)) {
    const tool = SOURCE_TOOL_BY_SLUG.get(requestedSlug)!;
    return {
      label: tool.label,
      slug: tool.slug,
    };
  }

  const label = params.label?.trim() || null;
  if (!label) {
    return {
      label: null,
      slug: null,
    };
  }

  const curated = SOURCE_TOOL_BY_LABEL.get(label.toLowerCase());
  if (curated) {
    return {
      label: curated.label,
      slug: curated.slug,
    };
  }

  return {
    label,
    slug: slugifySourceTool(label),
  };
}
