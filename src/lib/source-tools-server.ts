import 'server-only';

import { createServiceClient } from '@/lib/server-helpers';
import { FALLBACK_SOURCE_TOOLS, type SourceToolOption } from '@/lib/source-tools';

type SourceToolRow = {
  id: string;
  slug: string;
  label: string;
  supported_media_kinds: string[] | null;
  sort_order: number | null;
};

type SourceToolModelRow = {
  source_tool_id: string;
  slug: string;
  label: string;
  sort_order: number | null;
};

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

export async function listSourceToolsCatalog(): Promise<SourceToolOption[]> {
  const supabase = createServiceClient();

  const { data: tools, error: toolsError } = await supabase
    .from('source_tools')
    .select('id, slug, label, supported_media_kinds, sort_order')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });

  if (toolsError) {
    if (isMissingCatalogSchemaError(toolsError)) {
      return FALLBACK_SOURCE_TOOLS;
    }
    throw toolsError;
  }

  const toolRows = (tools ?? []) as SourceToolRow[];
  if (toolRows.length === 0) {
    return FALLBACK_SOURCE_TOOLS;
  }

  const toolIds = toolRows.map((tool) => tool.id);
  const { data: models, error: modelsError } = await supabase
    .from('source_tool_models')
    .select('source_tool_id, slug, label, sort_order')
    .in('source_tool_id', toolIds)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });

  if (modelsError) {
    if (isMissingCatalogSchemaError(modelsError)) {
      return FALLBACK_SOURCE_TOOLS;
    }
    throw modelsError;
  }

  const modelsByToolId = new Map<string, SourceToolModelRow[]>();
  for (const model of ((models ?? []) as SourceToolModelRow[])) {
    const list = modelsByToolId.get(model.source_tool_id) ?? [];
    list.push(model);
    modelsByToolId.set(model.source_tool_id, list);
  }

  return toolRows.map((tool) => ({
    slug: tool.slug,
    label: tool.label,
    supportedMediaKinds: normalizeSupportedMediaKinds(tool.supported_media_kinds),
    models: (modelsByToolId.get(tool.id) ?? []).map((model) => ({
      slug: model.slug,
      label: model.label,
    })),
  }));
}
