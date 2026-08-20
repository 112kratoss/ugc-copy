import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
};

type IdentityState = 'active' | 'merged' | 'deleting';

function createUserSupabaseMock(user: { id: string } | null = { id: 'user-1' }) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user },
        error: user ? null : new Error('missing session'),
      })),
    },
  };
}

function createAdminSupabaseMock({
  generation = {
    id: 'gen-1',
    user_id: 'user-1',
    output_url: 'generated_images/user-1/output.png',
    showcase_asset_path: 'showcase/gen-1/showcase.webp',
  },
  inputMediaRows = [
    { user_id: 'user-1', storage_path: 'generation_inputs/user-1/input-1.png' },
  ],
  identityLookupError = null,
  identityState = 'active',
  linkedGuestIds = [],
  linkedPosts = [],
  rateLimitAllowed = true,
}: {
  generation?: GenerationRow | null;
  inputMediaRows?: Array<{ user_id: string; storage_path: string | null }>;
  identityLookupError?: Error | null;
  identityState?: IdentityState | null;
  linkedGuestIds?: string[];
  linkedPosts?: Array<{ id: string }>;
  rateLimitAllowed?: boolean;
} = {}) {
  const deletes: string[] = [];
  const ownerFilters: Array<{ operation: 'delete' | 'select'; table: string; values: unknown[] }> = [];
  const selects: string[] = [];
  const storageRemovals: Array<{ bucket: string; paths: string[] }> = [];
  const rpc = vi.fn(async (fn: string) => {
    if (fn === 'check_backend_rate_limit') {
      return {
        data: {
          allowed: rateLimitAllowed,
          limit: 60,
          remaining: rateLimitAllowed ? 59 : 0,
          retryAfterSeconds: rateLimitAllowed ? 0 : 44,
          resetAt: '2026-06-22T07:00:00.000Z',
        },
        error: null,
      };
    }

    throw new Error(`Unexpected rpc: ${fn}`);
  });

  return {
    deletes,
    ownerFilters,
    rpc,
    selects,
    storageRemovals,
    client: {
      rpc,
      from(table: string) {
        return {
          select(columns = '') {
            selects.push(`${table}:${columns}`);
            const filters: Record<string, unknown> = {};
            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              in(column: string, values: unknown[]) {
                filters[column] = values;
                if (column === 'user_id') {
                  ownerFilters.push({ operation: 'select', table, values: [...values] });
                }
                return query;
              },
              is(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              maybeSingle: vi.fn(async () => {
                if (table === 'profiles' && columns === 'identity_state') {
                  return {
                    data: identityState ? { identity_state: identityState } : null,
                    error: identityLookupError,
                  };
                }

                if (
                  generation
                  && table === 'generations'
                  && filters.id === generation.id
                  // Owner scoping is `in` over the linked-account set, so this
                  // arrives as an array once a guest identity is linked.
                  && (Array.isArray(filters.user_id)
                    ? filters.user_id.includes(generation.user_id)
                    : filters.user_id === generation.user_id)
                ) {
                  return { data: generation, error: null };
                }

                return { data: null, error: null };
              }),
              then(resolve: (value: { data: unknown; error: null }) => void) {
                if (table === 'posts') {
                  return Promise.resolve({ data: linkedPosts, error: null }).then(resolve);
                }

                if (table === 'generation_input_media') {
                  return Promise.resolve({ data: inputMediaRows, error: null }).then(resolve);
                }

                if (table === 'profiles' && columns === 'id') {
                  return Promise.resolve({
                    data: linkedGuestIds.map((id) => ({ id })),
                    error: null,
                  }).then(resolve);
                }

                return Promise.resolve({ data: null, error: null }).then(resolve);
              },
            };

            return query;
          },
          delete() {
            deletes.push(table);
            const query = {
              eq() {
                return query;
              },
              in(column: string, values: unknown[]) {
                if (column === 'user_id') {
                  ownerFilters.push({ operation: 'delete', table, values: [...values] });
                }
                return query;
              },
              is() {
                return query;
              },
              then(resolve: (value: { error: null }) => void) {
                return Promise.resolve({ error: null }).then(resolve);
              },
            };

            return query;
          },
        };
      },
      storage: {
        from(bucket: string) {
          return {
            async remove(paths: string[]) {
              storageRemovals.push({ bucket, paths });
              return { data: null, error: null };
            },
          };
        },
      },
    },
  };
}

describe('generation delete service', () => {
  let createAdminSupabase: Mock<() => unknown>;
  let createUserSupabase: Mock<() => unknown>;

  beforeEach(() => {
    createAdminSupabase = vi.fn(() => createAdminSupabaseMock().client);
    createUserSupabase = vi.fn(() => createUserSupabaseMock());
  });

  it('authenticates before privileged clients, rate limits, reads, or deletes', async () => {
    createUserSupabase.mockReturnValueOnce(createUserSupabaseMock(null));
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      request: new Request('http://localhost/api/generations/gen-1'),
    });

    expect(result).toEqual({
      ok: false,
      body: { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      status: 401,
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('maps rate limits before generation reads, deletes, or storage cleanup', async () => {
    const admin = createAdminSupabaseMock({ rateLimitAllowed: false });
    const invalidateFeedCache = vi.fn();
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      invalidateFeedCache,
      request: new Request('http://localhost/api/generations/gen-1'),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      rateLimitError: expect.any(BackendRateLimitError),
    });
    expect(admin.selects).toEqual(['profiles:identity_state']);
    expect(admin.deletes).toEqual([]);
    expect(admin.storageRemovals).toEqual([]);
    expect(invalidateFeedCache).not.toHaveBeenCalled();
  });

  it('deletes the generation and only input media when linked posts must be retained', async () => {
    const admin = createAdminSupabaseMock({
      linkedPosts: [{ id: 'post-1' }],
      inputMediaRows: [
        { user_id: 'user-1', storage_path: 'generation_inputs/user-1/input-1.png' },
        { user_id: 'user-1', storage_path: 'generation_inputs/user-1/input-2.png' },
      ],
    });
    const invalidateFeedCache = vi.fn();
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      invalidateFeedCache,
      request: new Request('http://localhost/api/generations/gen-1'),
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        deleted: true,
        linkedPostRetained: true,
        message: 'The creation was deleted from your workspace. Any linked post stays intact, but generation-based remix linkage may no longer work.',
      },
    });
    expect(admin.deletes).toEqual(['generations']);
    expect(admin.storageRemovals).toEqual([
      { bucket: 'generation_inputs', paths: ['user-1/input-1.png'] },
      { bucket: 'generation_inputs', paths: ['user-1/input-2.png'] },
    ]);
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it('deletes unlinked generation input, output, and showcase media', async () => {
    const admin = createAdminSupabaseMock({
      linkedPosts: [],
      inputMediaRows: [
        { user_id: 'user-1', storage_path: 'generation_inputs/user-1/input-1.png' },
      ],
    });
    const invalidateFeedCache = vi.fn();
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      invalidateFeedCache,
      request: new Request('http://localhost/api/generations/gen-1'),
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        deleted: true,
        linkedPostRetained: false,
        message: 'The creation was deleted from your workspace.',
      },
    });
    expect(admin.storageRemovals).toEqual([
      { bucket: 'generation_inputs', paths: ['user-1/input-1.png'] },
      { bucket: 'generated_images', paths: ['user-1/output.png'] },
      { bucket: 'showcase_media', paths: ['showcase/gen-1/showcase.webp'] },
    ]);
    expect(invalidateFeedCache).toHaveBeenCalledOnce();
  });

  it.each([
    {
      identityState: 'merged' as const,
      identityLookupError: null,
      status: 409,
      code: 'SESSION_MERGED',
    },
    {
      identityState: 'deleting' as const,
      identityLookupError: null,
      status: 409,
      code: 'ACCOUNT_DELETING',
    },
    {
      identityState: 'active' as const,
      identityLookupError: new Error('database unavailable'),
      status: 503,
      code: 'IDENTITY_CHECK_UNAVAILABLE',
    },
  ])('rejects $code before delete rate limits or privileged mutation', async ({
    code,
    identityLookupError,
    identityState,
    status,
  }) => {
    const admin = createAdminSupabaseMock({ identityLookupError, identityState });
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      request: new Request('http://localhost/api/generations/gen-1'),
    });

    expect(result).toMatchObject({
      ok: false,
      status,
      body: { code },
    });
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(admin.deletes).toEqual([]);
    expect(admin.storageRemovals).toEqual([]);
  });

  it('keeps every owner filter linked-account scoped when a registered user deletes a guest generation', async () => {
    const admin = createAdminSupabaseMock({
      generation: {
        id: 'gen-1',
        user_id: 'guest-1',
        output_url: 'generated_images/guest-1/output.png',
        showcase_asset_path: 'showcase/gen-1/showcase.webp',
      },
      inputMediaRows: [
        { user_id: 'guest-1', storage_path: 'generation_inputs/guest-1/input-1.png' },
      ],
      linkedGuestIds: ['guest-1'],
    });
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      request: new Request('http://localhost/api/generations/gen-1'),
    });

    expect(result).toMatchObject({ ok: true, body: { success: true, deleted: true } });
    expect(admin.ownerFilters).toEqual([
      { operation: 'select', table: 'generations', values: ['user-1', 'guest-1'] },
      { operation: 'select', table: 'posts', values: ['user-1', 'guest-1'] },
      { operation: 'select', table: 'generation_input_media', values: ['user-1', 'guest-1'] },
      { operation: 'delete', table: 'generations', values: ['user-1', 'guest-1'] },
    ]);
    expect(admin.storageRemovals).toEqual([
      { bucket: 'generation_inputs', paths: ['guest-1/input-1.png'] },
      { bucket: 'generated_images', paths: ['guest-1/output.png'] },
      { bucket: 'showcase_media', paths: ['showcase/gen-1/showcase.webp'] },
    ]);
  });

  it('never removes paths outside the exact row owner or generation showcase scope', async () => {
    const admin = createAdminSupabaseMock({
      generation: {
        id: 'gen-1',
        user_id: 'user-1',
        output_url: 'generated_images/user-2/private.png',
        showcase_asset_path: 'showcase/gen-2/private.webp',
      },
      inputMediaRows: [
        { user_id: 'user-1', storage_path: 'generation_inputs/user-2/private.png' },
        { user_id: 'user-1', storage_path: 'generation_inputs/user-1%252f..%252fuser-2/private.png' },
      ],
    });
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    await expect(deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
      request: new Request('http://localhost/api/generations/gen-1'),
    })).resolves.toMatchObject({ ok: true });

    expect(admin.storageRemovals).toEqual([]);
  });
});
