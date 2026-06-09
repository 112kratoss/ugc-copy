import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SourceToolSelection } from '@/lib/source-tools';

export class PostSourceToolsWriteError extends Error {
  constructor(message = 'Failed to save source tool metadata.') {
    super(message);
    this.name = 'PostSourceToolsWriteError';
  }
}

function buildSourceToolRows(postId: string, sourceTools: SourceToolSelection[]) {
  return sourceTools.map((sourceTool, index) => ({
    post_id: postId,
    tool_label: sourceTool.toolLabel,
    tool_slug: sourceTool.toolSlug,
    model_label: sourceTool.modelLabel ?? null,
    model_slug: sourceTool.modelSlug ?? null,
    sort_order: index,
  }));
}

export async function insertPostSourceTools(params: {
  supabase: SupabaseClient;
  postId: string;
  sourceTools: SourceToolSelection[];
}) {
  if (params.sourceTools.length === 0) {
    return;
  }

  const { error } = await params.supabase
    .from('post_source_tools')
    .insert(buildSourceToolRows(params.postId, params.sourceTools));

  if (error) {
    throw new PostSourceToolsWriteError(error.message);
  }
}

export async function replacePostSourceTools(params: {
  supabase: SupabaseClient;
  postId: string;
  sourceTools: SourceToolSelection[];
}) {
  const { error: deleteError } = await params.supabase
    .from('post_source_tools')
    .delete()
    .eq('post_id', params.postId);

  if (deleteError) {
    throw new PostSourceToolsWriteError(deleteError.message);
  }

  await insertPostSourceTools(params);
}
