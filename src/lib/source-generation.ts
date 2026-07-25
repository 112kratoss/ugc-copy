import type { SupabaseClient } from '@supabase/supabase-js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

  // `generations.id` is a uuid column, so any other shape can never resolve.
  // Rejecting it up front keeps malformed client input out of the query and
  // avoids uuid cast failures surfacing as server errors.
  const sourceGenerationId = rawSourceGenerationId.trim();
  if (!UUID_PATTERN.test(sourceGenerationId)) {
    throw new SourceGenerationValidationError('Source generation not found or inaccessible.');
  }

  // Visibility is enforced by the ownership/public check below (and by RLS for
  // user-scoped clients). Keeping the filter out of the query avoids
  // interpolating values into a PostgREST `.or()` expression, which
  // postgrest-js does not escape.
  const { data, error } = await supabase
    .from('generations')
    .select('id, user_id, is_public')
    .eq('id', sourceGenerationId)
    .maybeSingle();

  if (error) {
    throw new SourceGenerationValidationError('Failed to validate the remix source.', 500);
  }

  if (!data || (!data.is_public && data.user_id !== userId)) {
    throw new SourceGenerationValidationError('Source generation not found or inaccessible.');
  }

  return sourceGenerationId;
}
