import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isMissingPostsSchemaError } from '@/lib/posts-server';

type SavedPostRow = {
  post_id?: unknown;
};

type LegacySavedGenerationRow = {
  generation_id?: unknown;
};

export type ShowcaseSavedStateRouteResult =
  | {
      ok: true;
      body: string[];
    }
  | {
      ok: false;
      status: 500;
      body: { error: 'Failed to fetch saved state' };
    };

function toStringIds(rows: Array<Record<string, unknown>>, column: string) {
  return rows
    .map((row) => row[column])
    .filter((value): value is string => typeof value === 'string');
}

function createSavedStateError(): ShowcaseSavedStateRouteResult {
  return {
    ok: false,
    status: 500,
    body: { error: 'Failed to fetch saved state' },
  };
}

export function parseShowcaseSavedStateIds(idsParam: string | null | undefined) {
  return (idsParam ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 100);
}

export async function getShowcaseSavedStateForRoute({
  ids,
  userId,
  userSupabase,
}: {
  ids: string[];
  userId: string;
  userSupabase: SupabaseClient;
}): Promise<ShowcaseSavedStateRouteResult> {
  if (ids.length === 0) {
    return { ok: true, body: [] };
  }

  const { data: postSaveRows, error: postSaveError } = await userSupabase
    .from('post_saves')
    .select('post_id')
    .eq('user_id', userId)
    .in('post_id', ids);

  if (postSaveError && isMissingPostsSchemaError(postSaveError)) {
    const { data: legacyRows, error: legacyError } = await userSupabase
      .from('showcase_saves')
      .select('generation_id')
      .eq('user_id', userId)
      .in('generation_id', ids);

    if (legacyError) {
      console.error('Error fetching legacy showcase saved state:', legacyError);
      return createSavedStateError();
    }

    return {
      ok: true,
      body: toStringIds((legacyRows ?? []) as LegacySavedGenerationRow[], 'generation_id'),
    };
  }

  if (postSaveError) {
    console.error('Error fetching post saved state:', postSaveError);
    return createSavedStateError();
  }

  return {
    ok: true,
    body: toStringIds((postSaveRows ?? []) as SavedPostRow[], 'post_id'),
  };
}
