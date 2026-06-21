import type { SupabaseClient } from '@supabase/supabase-js';

export class SourceGenerationValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'SourceGenerationValidationError';
    this.status = status;
  }
}

export async function resolveSourceGenerationId(
  supabase: SupabaseClient,
  userId: string,
  rawSourceGenerationId: unknown
): Promise<string | null> {
  if (typeof rawSourceGenerationId !== 'string' || rawSourceGenerationId.trim().length === 0) {
    return null;
  }

  const sourceGenerationId = rawSourceGenerationId.trim();
  const { data, error } = await supabase
    .from('generations')
    .select('id, user_id, is_public')
    .eq('id', sourceGenerationId)
    .or(`user_id.eq.${userId},is_public.eq.true`)
    .maybeSingle();

  if (error) {
    throw new SourceGenerationValidationError('Failed to validate the remix source.', 500);
  }

  if (!data || (!data.is_public && data.user_id !== userId)) {
    throw new SourceGenerationValidationError('Source generation not found or inaccessible.');
  }

  return sourceGenerationId;
}
