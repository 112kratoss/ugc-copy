import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

export type SearchDictionaryRebuildResult = {
  added: number;
  removed: number;
  /** The phrases and names `search_phrases` holds after the run. */
  phrases: number;
  /** The rows `search_popularity` holds after the run. */
  subjects: number;
  /** False when `SEARCH_PHRASES_REBUILD_DISABLED` left the phrases as they were: both counts are then 0. */
  phrasesRebuilt: boolean;
};

type Environment = Record<string, string | undefined>;

/**
 * `SEARCH_PHRASES_REBUILD_DISABLED=1` (or `true`) stops the second half of
 * the job alone: `rebuild_search_phrases()` is not called and the dictionary
 * is still rebuilt. For a phrases rebuild that runs into the statement
 * timeout or holds a lock too long. Nothing serves stale phrases meanwhile:
 * every read of `search_phrases` and `search_popularity` ignores them once
 * their last rebuild is over three hours old (`search_phrases_are_fresh`),
 * and answers dictionary completions, the all-time lists and the hand-picked
 * searches (docs/production-deployment-runbook.md, "Search Suggestions").
 */
export function isSearchPhrasesRebuildDisabled(env: Environment = process.env): boolean {
  const value = env.SEARCH_PHRASES_REBUILD_DISABLED?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The search-dictionary job: makes the spelling dictionary `search_terms`
 * exactly the words unlabelled public posts and listed recipes show now,
 * through the database function `rebuild_search_terms()` (migration
 * `20261111224010_search_recall_models_prefixes_stems_typos.sql`, widened to
 * recipes by `20261111231942_recipe_search_recall_and_relevance.sql`). No post
 * or recipe save writes that table, so this hourly run is what keeps it current.
 *
 * Then, as a call of its own, `rebuild_search_phrases()` (migration
 * `20261115105944_search_content_suggestions.sql`): the phrases and model and
 * tool names typeahead completes with, the starter's searches and related
 * searches (`search_phrases`), and each model's, tool's and creator's week
 * (`search_popularity`), made from the same documents. Two calls, so each has
 * the statement timeout to itself; the dictionary is already rebuilt when the
 * second one fails, and the run then fails where it is seen.
 * `SEARCH_PHRASES_REBUILD_DISABLED` skips the second call.
 */
export async function rebuildSearchDictionary(
  client: SupabaseClient,
  env: Environment = process.env,
): Promise<SearchDictionaryRebuildResult> {
  const { data, error } = await client.rpc('rebuild_search_terms');
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  const added = (row as { added?: unknown } | null | undefined)?.added;
  const removed = (row as { removed?: unknown } | null | undefined)?.removed;
  if (!isCount(added) || !isCount(removed)) {
    throw new Error('rebuild_search_terms returned an unexpected answer.');
  }

  if (isSearchPhrasesRebuildDisabled(env)) {
    return { added, removed, phrases: 0, subjects: 0, phrasesRebuilt: false };
  }

  const phrased = await client.rpc('rebuild_search_phrases');
  if (phrased.error) throw phrased.error;
  const phraseRow = Array.isArray(phrased.data) ? phrased.data[0] : phrased.data;
  const phrases = (phraseRow as { phrases?: unknown } | null | undefined)?.phrases;
  const subjects = (phraseRow as { subjects?: unknown } | null | undefined)?.subjects;
  if (!isCount(phrases) || !isCount(subjects)) {
    throw new Error('rebuild_search_phrases returned an unexpected answer.');
  }
  return { added, removed, phrases, subjects, phrasesRebuilt: true };
}
