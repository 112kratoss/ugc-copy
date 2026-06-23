import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  getShowcaseSavedStateForRoute,
  parseShowcaseSavedStateIds,
} from '@/lib/showcase-saved-state-service';

function createSavedStateClient(options?: {
  postRows?: Array<{ post_id: string }>;
  postError?: { code?: string; message?: string } | null;
  legacyRows?: Array<{ generation_id: string }>;
  legacyError?: { code?: string; message?: string } | null;
}) {
  const calls = {
    tables: [] as string[],
    filters: [] as Array<{ table: string; method: string; args: unknown[] }>,
  };

  function createQuery(table: 'post_saves' | 'showcase_saves') {
    const query = {
      select(columns: string) {
        calls.filters.push({ table, method: 'select', args: [columns] });
        return query;
      },
      eq(column: string, value: unknown) {
        calls.filters.push({ table, method: 'eq', args: [column, value] });
        return query;
      },
      in(column: string, value: unknown[]) {
        calls.filters.push({ table, method: 'in', args: [column, value] });
        if (table === 'post_saves') {
          return Promise.resolve({
            data: options?.postRows ?? [{ post_id: 'post-1' }],
            error: options?.postError ?? null,
          });
        }

        return Promise.resolve({
          data: options?.legacyRows ?? [{ generation_id: 'gen-1' }],
          error: options?.legacyError ?? null,
        });
      },
    };

    return query;
  }

  const client = {
    from(table: string) {
      calls.tables.push(table);
      if (table === 'post_saves' || table === 'showcase_saves') {
        return createQuery(table);
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    calls,
    client: client as unknown as SupabaseClient,
  };
}

describe('parseShowcaseSavedStateIds', () => {
  it('trims, removes blanks, and caps saved-state ids at 100', () => {
    const ids = parseShowcaseSavedStateIds(` post-1, ,post-2,${Array.from({ length: 120 }, (_, index) => `id-${index}`).join(',')}`);

    expect(ids).toHaveLength(100);
    expect(ids.slice(0, 3)).toEqual(['post-1', 'post-2', 'id-0']);
    expect(ids.at(-1)).toBe('id-97');
  });
});

describe('getShowcaseSavedStateForRoute', () => {
  it('returns an empty saved-state response without querying when no ids are provided', async () => {
    const savedState = createSavedStateClient();

    const result = await getShowcaseSavedStateForRoute({
      ids: [],
      userId: 'user-1',
      userSupabase: savedState.client,
    });

    expect(result).toEqual({ ok: true, body: [] });
    expect(savedState.calls.tables).toEqual([]);
  });

  it('returns saved post ids from post_saves without querying legacy saves', async () => {
    const savedState = createSavedStateClient({
      postRows: [{ post_id: 'post-1' }, { post_id: 'post-2' }],
    });

    const result = await getShowcaseSavedStateForRoute({
      ids: ['post-1', 'post-2', 'post-3'],
      userId: 'user-1',
      userSupabase: savedState.client,
    });

    expect(result).toEqual({ ok: true, body: ['post-1', 'post-2'] });
    expect(savedState.calls.tables).toEqual(['post_saves']);
    expect(savedState.calls.filters).toContainEqual({
      table: 'post_saves',
      method: 'eq',
      args: ['user_id', 'user-1'],
    });
    expect(savedState.calls.filters).toContainEqual({
      table: 'post_saves',
      method: 'in',
      args: ['post_id', ['post-1', 'post-2', 'post-3']],
    });
  });

  it('falls back to legacy saved generations when post_saves is missing', async () => {
    const savedState = createSavedStateClient({
      postRows: [],
      postError: {
        code: 'PGRST205',
        message: "Could not find the table 'public.post_saves'",
      },
      legacyRows: [{ generation_id: 'gen-1' }],
    });

    const result = await getShowcaseSavedStateForRoute({
      ids: ['post-1', 'gen-1'],
      userId: 'user-1',
      userSupabase: savedState.client,
    });

    expect(result).toEqual({ ok: true, body: ['gen-1'] });
    expect(savedState.calls.tables).toEqual(['post_saves', 'showcase_saves']);
    expect(savedState.calls.filters).toContainEqual({
      table: 'showcase_saves',
      method: 'in',
      args: ['generation_id', ['post-1', 'gen-1']],
    });
  });

  it('maps saved-state lookup failures to stable route errors', async () => {
    const savedState = createSavedStateClient({
      postError: { message: 'database unavailable' },
    });

    const result = await getShowcaseSavedStateForRoute({
      ids: ['post-1'],
      userId: 'user-1',
      userSupabase: savedState.client,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to fetch saved state' },
    });
  });
});
