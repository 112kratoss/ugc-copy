import type { SupabaseClient } from '@supabase/supabase-js';

import { logBackendError } from '@/lib/backend-logger';
import { getCanonicalStoredMediaLocation } from '@/lib/storage-ownership';

/**
 * Whose an input of a creation is, as its recipe reads it (owner, 2026-10-29: the creators'
 * recipe, shared by default, leaves the creator's own uploads out unless they add them):
 * - `others`: another account's: a reference a remix brought back from its original, which
 *   keeps the original's own storage path as its source (`loadCandidateMedia` says why), or
 *   another account's creation used as one;
 * - `own`: everything else: the creator's uploads and creations, and an input whose source is
 *   not on record, which stays with the creator.
 */
export type GenerationInputOrigin = 'own' | 'others';

/** What an input says of its source: a stored row of `generation_input_media`, or a legacy reading of one. */
export type GenerationInputOriginSource = {
  /** `sourceStoragePath` and `sourceUrl`, which `persistGenerationInputMedia` keeps; `legacy` on a legacy reading. */
  metadata?: Record<string, unknown> | null;
  /** The input's own copy, which is the creator's for a stored row; a legacy reading's names its source. */
  storagePath?: string | null;
  sourceGenerationId?: string | null;
};

export type GenerationInputOriginContext = {
  /** The creator and the guest identities linked to them. */
  ownerIds: ReadonlySet<string>;
  /** The owner of each source generation the inputs name (`loadSourceGenerationOwners`). */
  sourceGenerationOwners: ReadonlyMap<string, string | null>;
};

/** The account a stored file belongs to: the first segment of its path in a user-scoped bucket, as a path or a storage link. */
export function storedMediaOwnerId(path: unknown): string | null {
  if (typeof path !== 'string' || !path.trim()) return null;
  const location = getCanonicalStoredMediaLocation(path);
  const owner = location?.filePath.split('/')[0];
  return owner || null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Where an input says it came from: a stored row's own path is always the creator's copy, so its source; a legacy reading's path. */
function sourcePaths(input: GenerationInputOriginSource): Array<string | null> {
  const metadata = input.metadata ?? {};
  return metadata.legacy === true
    ? [text(input.storagePath)]
    : [text(metadata.sourceStoragePath), text(metadata.sourceUrl)];
}

/** Whose an input is rests on its source generation's owner: it names one, and no source path names an owner. */
export function needsSourceGenerationOwner(input: GenerationInputOriginSource): boolean {
  return Boolean(input.sourceGenerationId) && sourcePaths(input).every((path) => !storedMediaOwnerId(path));
}

export function generationInputOrigin(
  input: GenerationInputOriginSource,
  context: GenerationInputOriginContext,
): GenerationInputOrigin {
  for (const path of sourcePaths(input)) {
    const owner = storedMediaOwnerId(path);
    if (owner) return context.ownerIds.has(owner) ? 'own' : 'others';
  }
  if (input.sourceGenerationId) {
    const owner = context.sourceGenerationOwners.get(input.sourceGenerationId);
    if (owner) return context.ownerIds.has(owner) ? 'own' : 'others';
  }
  return 'own';
}

/**
 * Who owns each of these generations, in one read. A read that fails leaves them unknown, so
 * the inputs naming them stay with the creator: left out of a shared recipe unless added.
 */
export async function loadSourceGenerationOwners(
  supabase: SupabaseClient,
  generationIds: Iterable<string | null | undefined>,
): Promise<Map<string, string | null>> {
  const ids = [...new Set([...generationIds].filter((id): id is string => typeof id === 'string' && Boolean(id)))];
  const owners = new Map<string, string | null>();
  if (ids.length === 0) return owners;
  const { data, error } = await supabase.from('generations').select('id, user_id').in('id', ids);
  if (error) {
    logBackendError('generation_input_source_owners_load_failed', { error });
    return owners;
  }
  for (const row of (data ?? []) as Array<{ id: string; user_id: string | null }>) {
    owners.set(row.id, row.user_id);
  }
  return owners;
}
