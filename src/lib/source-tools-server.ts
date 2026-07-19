import 'server-only';

import type { GenerationModelCatalog } from '@/lib/generation-model-catalog';
import { loadPublishedGenerationModelCatalog } from '@/lib/generation-model-catalog-store';
import { createServiceClient } from '@/lib/server-helpers';
import {
  FALLBACK_SOURCE_TOOLS,
  type SourceToolCapability,
  type SourceToolCatalogTier,
  type SourceToolOption,
  type SourceToolStatus,
  type SourceToolType,
} from '@/lib/source-tools';

type SourceToolRow = {
  id: string;
  slug: string;
  label: string;
  supported_media_kinds: string[] | null;
  sort_order: number | null;
  tool_type: string | null;
  capabilities: string[] | null;
  catalog_tier: string | null;
  status: string | null;
  provider_slug: string | null;
  aliases: string[] | null;
};

type SourceToolModelRow = {
  source_tool_id: string;
  slug: string;
  label: string;
  sort_order: number | null;
  capabilities: string[] | null;
  status: string | null;
  provider_slug: string | null;
  aliases: string[] | null;
};

const SOURCE_TOOLS_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedCatalog: {
  expiresAt: number;
  tools: SourceToolOption[];
} | null = null;
let pendingCatalogLoad: Promise<SourceToolOption[]> | null = null;

function isMissingCatalogSchemaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';

  return code === '42P01' || code === 'PGRST205' || /source_tools|source_tool_models/i.test(message);
}

function normalizeSupportedMediaKinds(value: string[] | null): Array<'image' | 'video'> {
  const normalized = (value ?? []).filter((kind): kind is 'image' | 'video' => kind === 'image' || kind === 'video');
  return normalized.length > 0 ? normalized : ['image', 'video'];
}

const SOURCE_TOOL_TYPES = new Set<SourceToolType>(['platform', 'editor', 'workflow', 'api-marketplace']);
const SOURCE_TOOL_CAPABILITIES = new Set<SourceToolCapability>(['image', 'video', 'audio', 'avatar', 'design', '3d', 'vfx']);
const SOURCE_TOOL_CATALOG_TIERS = new Set<SourceToolCatalogTier>(['featured', 'extended', 'historical']);
const SOURCE_TOOL_STATUSES = new Set<SourceToolStatus>(['current', 'legacy', 'deprecated', 'sunset']);

function normalizeToolType(value: string | null): SourceToolType {
  return value && SOURCE_TOOL_TYPES.has(value as SourceToolType) ? value as SourceToolType : 'platform';
}

function normalizeCapabilities(
  value: string[] | null,
  fallback: SourceToolCapability[] = ['image', 'video']
): SourceToolCapability[] {
  const normalized = (value ?? []).filter((capability): capability is SourceToolCapability => (
    SOURCE_TOOL_CAPABILITIES.has(capability as SourceToolCapability)
  ));
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeCatalogTier(value: string | null): SourceToolCatalogTier {
  return value && SOURCE_TOOL_CATALOG_TIERS.has(value as SourceToolCatalogTier)
    ? value as SourceToolCatalogTier
    : 'extended';
}

function normalizeStatus(value: string | null): SourceToolStatus {
  return value && SOURCE_TOOL_STATUSES.has(value as SourceToolStatus) ? value as SourceToolStatus : 'current';
}

function withGenerationCatalogModels(
  tools: SourceToolOption[],
  catalog: GenerationModelCatalog,
): SourceToolOption[] {
  const generationModels = catalog.models.map((model) => ({
    slug: model.id,
    label: model.displayName,
    capabilities: [model.kind === 'image' ? 'image' : 'video'] as SourceToolCapability[],
    status: 'current' as const,
    providerSlug: 'magicbooklet',
    aliases: [],
  }));

  return tools.map((tool) => tool.slug === 'magicbooklet'
    ? { ...tool, models: generationModels }
    : tool);
}

function cloneCatalog(tools: SourceToolOption[]): SourceToolOption[] {
  return tools.map((tool) => ({
    ...tool,
    supportedMediaKinds: normalizeSupportedMediaKinds(tool.supportedMediaKinds),
    capabilities: normalizeCapabilities(tool.capabilities ?? null, tool.supportedMediaKinds),
    aliases: [...(tool.aliases ?? [])],
    models: tool.models.map((model) => ({
      ...model,
      capabilities: [...(model.capabilities ?? [])],
      aliases: [...(model.aliases ?? [])],
    })),
  }));
}

async function loadSourceToolsCatalog(): Promise<SourceToolOption[]> {
  const supabase = createServiceClient();
  const { catalog: generationCatalog } = await loadPublishedGenerationModelCatalog({
    platform: 'web',
    schemaVersion: 1,
  });

  const { data: tools, error: toolsError } = await supabase
    .from('source_tools')
    .select('id, slug, label, supported_media_kinds, sort_order, tool_type, capabilities, catalog_tier, status, provider_slug, aliases')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });

  if (toolsError) {
    if (isMissingCatalogSchemaError(toolsError)) {
      return withGenerationCatalogModels(FALLBACK_SOURCE_TOOLS, generationCatalog);
    }
    throw toolsError;
  }

  const toolRows = (tools ?? []) as SourceToolRow[];
  if (toolRows.length === 0) {
    return withGenerationCatalogModels(FALLBACK_SOURCE_TOOLS, generationCatalog);
  }

  const toolIds = toolRows.map((tool) => tool.id);
  const { data: models, error: modelsError } = await supabase
    .from('source_tool_models')
    .select('source_tool_id, slug, label, sort_order, capabilities, status, provider_slug, aliases')
    .in('source_tool_id', toolIds)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });

  if (modelsError) {
    if (isMissingCatalogSchemaError(modelsError)) {
      return withGenerationCatalogModels(FALLBACK_SOURCE_TOOLS, generationCatalog);
    }
    throw modelsError;
  }

  const modelsByToolId = new Map<string, SourceToolModelRow[]>();
  for (const model of ((models ?? []) as SourceToolModelRow[])) {
    const list = modelsByToolId.get(model.source_tool_id) ?? [];
    list.push(model);
    modelsByToolId.set(model.source_tool_id, list);
  }

  return withGenerationCatalogModels(toolRows.map((tool) => ({
    slug: tool.slug,
    label: tool.label,
    supportedMediaKinds: normalizeSupportedMediaKinds(tool.supported_media_kinds),
    toolType: normalizeToolType(tool.tool_type),
    capabilities: normalizeCapabilities(tool.capabilities, normalizeSupportedMediaKinds(tool.supported_media_kinds)),
    catalogTier: normalizeCatalogTier(tool.catalog_tier),
    status: normalizeStatus(tool.status),
    providerSlug: tool.provider_slug,
    aliases: tool.aliases ?? [],
    models: (modelsByToolId.get(tool.id) ?? []).map((model) => ({
      slug: model.slug,
      label: model.label,
      capabilities: normalizeCapabilities(model.capabilities),
      status: normalizeStatus(model.status),
      providerSlug: model.provider_slug,
      aliases: model.aliases ?? [],
    })),
  })), generationCatalog);
}

export async function listSourceToolsCatalog(): Promise<SourceToolOption[]> {
  const now = Date.now();
  if (cachedCatalog && cachedCatalog.expiresAt > now) {
    return cloneCatalog(cachedCatalog.tools);
  }

  if (!pendingCatalogLoad) {
    pendingCatalogLoad = loadSourceToolsCatalog()
      .then((tools) => {
        cachedCatalog = {
          expiresAt: Date.now() + SOURCE_TOOLS_CATALOG_CACHE_TTL_MS,
          tools: cloneCatalog(tools),
        };
        return tools;
      })
      .finally(() => {
        pendingCatalogLoad = null;
      });
  }

  return cloneCatalog(await pendingCatalogLoad);
}
