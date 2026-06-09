import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import type { SourceToolSelection } from '@/lib/source-tools';

export class PostSourceToolsWriteError extends Error {
  readonly isValidationError: boolean;

  constructor(message = 'Failed to save source tool metadata.', isValidationError = false) {
    super(message);
    this.name = 'PostSourceToolsWriteError';
    this.isValidationError = isValidationError;
  }
}

function isCatalogValidationError(message: string) {
  return /must be 80 characters|is reserved|creation limit|requires image or video media|create the source tool before creating a model/i.test(message);
}

async function savePostSourceTools(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  mediaKind: 'image' | 'video' | null;
  sourceTools: SourceToolSelection[];
}) {
  const { error } = await params.supabase.rpc('save_post_source_tools_with_catalog', {
    p_post_id: params.postId,
    p_owner_user_id: params.ownerUserId,
    p_media_kind: params.mediaKind,
    p_source_tools: params.sourceTools,
  });

  if (error) {
    throw new PostSourceToolsWriteError(error.message, isCatalogValidationError(error.message));
  }
}

export async function insertPostSourceTools(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  mediaKind: 'image' | 'video' | null;
  sourceTools: SourceToolSelection[];
}) {
  await savePostSourceTools(params);
}

export async function replacePostSourceTools(params: {
  supabase: SupabaseClient;
  postId: string;
  ownerUserId: string;
  mediaKind: 'image' | 'video' | null;
  sourceTools: SourceToolSelection[];
}) {
  await savePostSourceTools(params);
}
