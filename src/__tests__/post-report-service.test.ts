import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { submitPostReportForRoute } from '@/lib/post-report-service';

function createAdminSupabaseMock(options?: {
  post?: { id: string } | null;
  postError?: { message: string } | null;
  bundle?: { id: string } | null;
  bundleError?: { message: string } | null;
  rateLimited?: boolean;
  insertError?: { message: string } | null;
}) {
  const calls = {
    tables: [] as string[],
    inserts: [] as Array<Record<string, unknown>>,
    rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  };

  function createQuery(table: string) {
    const filters: Record<string, unknown> = {};
    const query = {
      select() {
        return query;
      },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return query;
      },
      is(column: string, value: unknown) {
        filters[column] = value;
        return query;
      },
      async maybeSingle() {
        if (table === 'posts') {
          return {
            data: options?.post === undefined ? { id: filters.id as string } : options.post,
            error: options?.postError ?? null,
          };
        }

        if (table === 'post_resource_bundles') {
          return {
            data: options?.bundle === undefined ? { id: filters.id as string } : options.bundle,
            error: options?.bundleError ?? null,
          };
        }

        throw new Error(`Unexpected maybeSingle table: ${table}`);
      },
    };

    return query;
  }

  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.rpc.push({ name, args });
      if (name !== 'check_backend_rate_limit') {
        throw new Error(`Unexpected RPC: ${name}`);
      }

      return Promise.resolve({
        data: {
          allowed: !options?.rateLimited,
          limit: 10,
          remaining: options?.rateLimited ? 0 : 9,
          retryAfterSeconds: options?.rateLimited ? 55 : 0,
          resetAt: '2026-06-22T06:30:00.000Z',
        },
        error: null,
      });
    },
    from(table: string) {
      calls.tables.push(table);
      if (table === 'posts' || table === 'post_resource_bundles') {
        return createQuery(table);
      }

      if (table === 'post_reports') {
        return {
          async insert(payload: Record<string, unknown>) {
            calls.inserts.push(payload);
            return { error: options?.insertError ?? null };
          },
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    },
  };

  return {
    client: client as unknown as SupabaseClient,
    calls,
  };
}

describe('submitPostReportForRoute', () => {
  it('rejects invalid reasons before creating an admin client', async () => {
    const createAdminSupabase = vi.fn();

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({ reason: 'not-real' })),
      createAdminSupabase,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Choose a valid report reason.' },
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('rate limits valid reports before post lookup or insert', async () => {
    const admin = createAdminSupabaseMock({ rateLimited: true });

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({ reason: 'spam' })),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected a rate-limit error');
    expect(result.status).toBe(429);
    expect(result).toHaveProperty('rateLimitError');
    expect(admin.calls.rpc).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'post-report:submit',
          p_subject_key: 'reporter-1',
          p_limit: 10,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(admin.calls.tables).toEqual([]);
    expect(admin.calls.inserts).toEqual([]);
  });

  it('normalizes optional details and records post-only reports', async () => {
    const admin = createAdminSupabaseMock();
    const longDetails = `  ${'a'.repeat(1100)}  `;
    const invalidateFeedCache = vi.fn();

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({
        reason: 'spam',
        details: longDetails,
      })),
      createAdminSupabase: vi.fn(() => admin.client),
      invalidateFeedCache,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(admin.calls.inserts).toEqual([
      {
        post_id: 'post-1',
        bundle_id: null,
        reporter_user_id: 'reporter-1',
        reason: 'spam',
        details: 'a'.repeat(1000),
      },
    ]);
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('returns not found when the post is missing or archived', async () => {
    const admin = createAdminSupabaseMock({ post: null });

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({ reason: 'unsafe_content' })),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      body: { error: 'Post not found.' },
    });
    expect(admin.calls.inserts).toEqual([]);
  });

  it('rejects unlock reports when the bundle does not belong to the post', async () => {
    const admin = createAdminSupabaseMock({ bundle: null });

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({
        reason: 'misleading_unlock',
        bundleId: 'bundle-2',
      })),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'That unlock does not belong to this post.' },
    });
    expect(admin.calls.inserts).toEqual([]);
  });

  it('records unlock reports only after validating the bundle belongs to the post', async () => {
    const admin = createAdminSupabaseMock();
    const invalidateFeedCache = vi.fn();

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({
        reason: 'misleading_unlock',
        bundleId: 'bundle-1',
      })),
      createAdminSupabase: vi.fn(() => admin.client),
      invalidateFeedCache,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(admin.calls.inserts).toEqual([
      {
        post_id: 'post-1',
        bundle_id: 'bundle-1',
        reporter_user_id: 'reporter-1',
        reason: 'misleading_unlock',
        details: null,
      },
    ]);
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('maps bundle validation errors without inserting a report', async () => {
    const admin = createAdminSupabaseMock({
      bundleError: { message: 'bundle lookup failed' },
    });

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({
        reason: 'misleading_unlock',
        bundleId: 'bundle-1',
      })),
      createAdminSupabase: vi.fn(() => admin.client),
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to validate unlock report.' },
    });
    expect(admin.calls.inserts).toEqual([]);
  });

  it('maps report insert errors to a stable failure', async () => {
    const admin = createAdminSupabaseMock({
      insertError: { message: 'insert failed' },
    });
    const invalidateFeedCache = vi.fn();

    const result = await submitPostReportForRoute({
      postId: 'post-1',
      reporterUserId: 'reporter-1',
      readBody: vi.fn(async () => ({ reason: 'spam' })),
      createAdminSupabase: vi.fn(() => admin.client),
      invalidateFeedCache,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to submit report.' },
    });
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });
});
