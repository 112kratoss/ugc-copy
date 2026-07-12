import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  archiveOwnerGenerationForRoute,
  restoreOwnerGenerationForRoute,
} from '@/lib/generation-lifecycle-service';

type QueryResult = {
  data: unknown;
  error: Error | null;
};

type UpdateCall = {
  table: string;
  values: Record<string, unknown>;
  filters: Array<[string, ...unknown[]]>;
  selectColumns: string | null;
};

function createClient({
  allowed = true,
  generationResult = { data: { id: 'generation-1' }, error: null } as QueryResult,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 60,
      remaining: allowed ? 59 : 0,
      retryAfterSeconds: allowed ? 0 : 44,
      resetAt: '2026-06-23T00:30:00.000Z',
    },
    error: null,
  }));
  const updateCalls: UpdateCall[] = [];
  const from = vi.fn((table: string) => ({
    update(values: Record<string, unknown>) {
      const call: UpdateCall = {
        table,
        values,
        filters: [],
        selectColumns: null,
      };
      updateCalls.push(call);
      const query = {
        eq(column: string, value: unknown) {
          call.filters.push(['eq', column, value]);
          return query;
        },
        is(column: string, value: unknown) {
          call.filters.push(['is', column, value]);
          return query;
        },
        not(column: string, operator: string, value: unknown) {
          call.filters.push(['not', column, operator, value]);
          return query;
        },
        select(columns: string) {
          call.selectColumns = columns;
          return query;
        },
        async maybeSingle() {
          return generationResult;
        },
      };
      return query;
    },
  }));

  return {
    client: { rpc, from } as unknown as SupabaseClient,
    from,
    rpc,
    updateCalls,
  };
}

describe('generation lifecycle service', () => {
  it('rate limits before archive mutation work', async () => {
    const client = createClient({ allowed: false });

    const result = await archiveOwnerGenerationForRoute({
      adminSupabase: client.client,
      generationId: 'generation-1',
      ownerUserId: 'user-1',
    });

    expect(result).toMatchObject({ ok: false });
    expect(result).toHaveProperty('rateLimitError');
    expect(client.from).not.toHaveBeenCalled();
  });

  it('archives only an active owned generation and removes public showcase state', async () => {
    const client = createClient();

    await expect(archiveOwnerGenerationForRoute({
      adminSupabase: client.client,
      generationId: 'generation-1',
      now: () => new Date('2026-06-23T00:00:00.000Z'),
      ownerUserId: 'user-1',
    })).resolves.toEqual({
      ok: true,
      body: { success: true, archived: true },
    });

    expect(client.updateCalls).toEqual([{
      table: 'generations',
      values: {
        archived_at: '2026-06-23T00:00:00.000Z',
        archived_by_user_id: 'user-1',
        is_public: false,
        showcase_asset_path: null,
      },
      filters: [
        ['eq', 'id', 'generation-1'],
        ['eq', 'user_id', 'user-1'],
        ['is', 'template_run_id', null],
        ['is', 'template_run_step_id', null],
        ['is', 'archived_at', null],
      ],
      selectColumns: 'id',
    }]);
  });

  it('returns not found when no active owned generation matches', async () => {
    const client = createClient({ generationResult: { data: null, error: null } });

    await expect(archiveOwnerGenerationForRoute({
      adminSupabase: client.client,
      generationId: 'generation-1',
      ownerUserId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creation not found.' },
    });
  });

  it('maps archive database failures to the stable route error', async () => {
    const client = createClient({
      generationResult: { data: null, error: new Error('write failed') },
    });

    await expect(archiveOwnerGenerationForRoute({
      adminSupabase: client.client,
      generationId: 'generation-1',
      ownerUserId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to archive creation.' },
    });
  });

  it('restores only an archived generation owned by the caller', async () => {
    const client = createClient();

    await expect(restoreOwnerGenerationForRoute({
      adminSupabase: client.client,
      generationId: 'generation-1',
      ownerUserId: 'user-1',
    })).resolves.toEqual({
      ok: true,
      body: { success: true, restored: true },
    });

    expect(client.updateCalls).toEqual([{
      table: 'generations',
      values: { archived_at: null, archived_by_user_id: null },
      filters: [
        ['eq', 'id', 'generation-1'],
        ['eq', 'user_id', 'user-1'],
        ['is', 'template_run_id', null],
        ['is', 'template_run_step_id', null],
        ['not', 'archived_at', 'is', null],
      ],
      selectColumns: 'id',
    }]);
  });

  it('returns not found when no archived owned generation matches', async () => {
    const client = createClient({ generationResult: { data: null, error: null } });

    await expect(restoreOwnerGenerationForRoute({
      adminSupabase: client.client,
      generationId: 'generation-1',
      ownerUserId: 'user-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Creation not found.' },
    });
  });
});
