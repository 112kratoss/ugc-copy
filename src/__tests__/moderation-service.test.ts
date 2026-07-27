import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  loadBlockedCreatorIds,
  setUserBlockForRoute,
  submitModerationReportForRoute,
} from '@/lib/moderation-service';

type Row = Record<string, unknown>;

const REPORTER_ID = '10000000-0000-4000-8000-000000000001';
const CREATOR_ID = '20000000-0000-4000-8000-000000000002';
const GENERATION_ID = '30000000-0000-4000-8000-000000000003';
const OTHER_USER_ID = '40000000-0000-4000-8000-000000000004';
const VIEWER_ID = '50000000-0000-4000-8000-000000000005';
const SECOND_CREATOR_ID = '60000000-0000-4000-8000-000000000006';
const THIRD_CREATOR_ID = '70000000-0000-4000-8000-000000000007';

function createClient({
  generations = [{ id: GENERATION_ID, user_id: REPORTER_ID }],
  profiles = [{ id: CREATOR_ID }],
  userBlocks = [] as Array<{ blocker_user_id: string; blocked_user_id: string }>,
} = {}) {
  const state = {
    follows: [
      { follower_id: REPORTER_ID, following_id: CREATOR_ID },
      { follower_id: CREATOR_ID, following_id: REPORTER_ID },
    ],
    moderationReports: [] as Row[],
    userBlocks: [...userBlocks],
  };
  const rpc = vi.fn(async () => ({
    data: {
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfterSeconds: 0,
      resetAt: '2026-07-20T12:00:00.000Z',
    },
    error: null,
  }));

  function from(table: string) {
    const filters: Record<string, unknown> = {};
    const inFilters: Record<string, unknown[]> = {};
    let operation: 'select' | 'delete' = 'select';

    const filteredRows = () => {
      const source: Row[] = table === 'profiles'
        ? profiles
        : table === 'generations'
          ? generations
          : table === 'user_blocks'
            ? state.userBlocks
            : table === 'follows'
              ? state.follows
              : [];
      return source.filter((row) => (
        Object.entries(filters).every(([column, value]) => row[column] === value)
        && Object.entries(inFilters).every(([column, values]) => values.includes(row[column]))
      ));
    };

    const execute = async () => {
      if (operation === 'delete') {
        if (table === 'follows') {
          state.follows = state.follows.filter((row) => !filteredRows().includes(row));
        } else if (table === 'user_blocks') {
          state.userBlocks = state.userBlocks.filter((row) => !filteredRows().includes(row));
        }
      }
      return { data: operation === 'select' ? filteredRows() : null, error: null };
    };

    const query = {
      select() {
        operation = 'select';
        return query;
      },
      delete() {
        operation = 'delete';
        return query;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return query;
      },
      in(column: string, values: unknown[]) {
        inFilters[column] = values;
        return query;
      },
      async maybeSingle() {
        const rows = filteredRows();
        return { data: rows[0] ?? null, error: null };
      },
      async insert(payload: Row) {
        if (table === 'moderation_reports') state.moderationReports.push(payload);
        return { error: null };
      },
      async upsert(payload: { blocker_user_id: string; blocked_user_id: string }) {
        if (table === 'user_blocks' && !state.userBlocks.some((row) => (
          row.blocker_user_id === payload.blocker_user_id
          && row.blocked_user_id === payload.blocked_user_id
        ))) {
          state.userBlocks.push(payload);
        }
        return { error: null };
      },
      then<TResult1 = { data: Row[] | null; error: null }, TResult2 = never>(
        onfulfilled?: ((value: { data: Row[] | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return execute().then(onfulfilled, onrejected);
      },
    };
    return query;
  }

  return {
    client: { from, rpc } as unknown as SupabaseClient,
    rpc,
    state,
  };
}

describe('moderation service', () => {
  it('validates reports before rate limiting or persistence', async () => {
    const client = createClient();
    await expect(submitModerationReportForRoute({
      adminSupabase: client.client,
      body: { targetType: 'user', targetId: CREATOR_ID, reason: 'offensive_ai_output' },
      reporterUserId: REPORTER_ID,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Choose a valid report target and reason.' },
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.state.moderationReports).toEqual([]);
  });

  it('rejects malformed database identifiers before privileged queries', async () => {
    const client = createClient();

    await expect(setUserBlockForRoute({
      actorUserId: REPORTER_ID,
      adminSupabase: client.client,
      blockedUserId: 'not-a-uuid',
      shouldBlock: true,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      body: { error: 'Choose a valid user to block.' },
    });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.state.userBlocks).toEqual([]);
  });

  it('records a normalized user report in the service-only moderation queue', async () => {
    const client = createClient();
    const result = await submitModerationReportForRoute({
      adminSupabase: client.client,
      body: {
        targetType: 'user',
        targetId: CREATOR_ID,
        reason: 'harassment',
        sourceSurface: 'creator-profile',
        details: `  ${'x'.repeat(1100)}  `,
      },
      reporterUserId: REPORTER_ID,
    });

    expect(result).toEqual({ ok: true, body: { success: true } });
    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'moderation-report:submit',
      p_subject_key: REPORTER_ID,
      p_limit: 10,
      p_window_seconds: 600,
    });
    expect(client.state.moderationReports).toEqual([{
      reporter_user_id: REPORTER_ID,
      target_type: 'user',
      reported_user_id: CREATOR_ID,
      generation_id: null,
      comment_id: null,
      reason: 'harassment',
      details: 'x'.repeat(1000),
      source_surface: 'creator-profile',
    }]);
  });

  it('only lets users report AI output from their own generation library', async () => {
    const client = createClient({
      generations: [{ id: GENERATION_ID, user_id: OTHER_USER_ID }],
    });

    await expect(submitModerationReportForRoute({
      adminSupabase: client.client,
      body: {
        targetType: 'generation',
        targetId: GENERATION_ID,
        reason: 'offensive_ai_output',
        sourceSurface: 'generation-viewer',
      },
      reporterUserId: REPORTER_ID,
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Generation not found.' },
    });
    expect(client.state.moderationReports).toEqual([]);
  });

  it('blocks idempotently, removes follows in both directions, and invalidates feeds', async () => {
    const client = createClient();
    const invalidateFeedCache = vi.fn();

    const result = await setUserBlockForRoute({
      actorUserId: REPORTER_ID,
      adminSupabase: client.client,
      blockedUserId: CREATOR_ID,
      shouldBlock: true,
      invalidateFeedCache,
    });

    expect(result).toEqual({ ok: true, body: { success: true, blocked: true } });
    expect(client.state.userBlocks).toEqual([{
      blocker_user_id: REPORTER_ID,
      blocked_user_id: CREATOR_ID,
    }]);
    expect(client.state.follows).toEqual([]);
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('loads blocks in both relationship directions for content filtering', async () => {
    const client = createClient({
      userBlocks: [
        { blocker_user_id: VIEWER_ID, blocked_user_id: CREATOR_ID },
        { blocker_user_id: SECOND_CREATOR_ID, blocked_user_id: VIEWER_ID },
      ],
    });

    await expect(loadBlockedCreatorIds({
      adminSupabase: client.client,
      creatorIds: [CREATOR_ID, SECOND_CREATOR_ID, THIRD_CREATOR_ID],
      viewerUserId: VIEWER_ID,
    })).resolves.toEqual(new Set([CREATOR_ID, SECOND_CREATOR_ID]));
  });
});
