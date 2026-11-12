import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

export type SearchDictionaryRebuildResult = {
  added: number;
  removed: number;
};

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The search-dictionary job: makes the spelling dictionary `search_terms`
 * exactly the words unlabelled public posts show now, through the database
 * function `rebuild_search_terms()` (migration
 * `20261111224010_search_recall_models_prefixes_stems_typos.sql`). No post save
 * writes that table, so this hourly run is what keeps it current.
 */
export async function rebuildSearchDictionary(
  client: SupabaseClient,
): Promise<SearchDictionaryRebuildResult> {
  const { data, error } = await client.rpc('rebuild_search_terms');
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  const added = (row as { added?: unknown } | null | undefined)?.added;
  const removed = (row as { removed?: unknown } | null | undefined)?.removed;
  if (!isCount(added) || !isCount(removed)) {
    throw new Error('rebuild_search_terms returned an unexpected answer.');
  }
  return { added, removed };
}
