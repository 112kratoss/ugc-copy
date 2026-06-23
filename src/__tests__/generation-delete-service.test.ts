import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
};

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
    showcase_asset_path: 'user-1/showcase.webp',
  },
  inputMediaRows = [
    { storage_path: 'generation_inputs/user-1/input-1.png' },
  ],
  linkedPosts = [],
  rateLimitAllowed = true,
}: {
  generation?: GenerationRow | null;
  inputMediaRows?: Array<{ storage_path: string | null }>;
  linkedPosts?: Array<{ id: string }>;
  rateLimitAllowed?: boolean;
} = {}) {
  const deletes: string[] = [];
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
              maybeSingle: vi.fn(async () => {
                if (table === 'generations' && filters.id === generation?.id && filters.user_id === generation.user_id) {
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
  let createAdminSupabase: ReturnType<typeof vi.fn>;
  let createUserSupabase: ReturnType<typeof vi.fn>;

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
      body: { error: 'Unauthorized' },
      status: 401,
    });
    expect(createAdminSupabase).not.toHaveBeenCalled();
  });

  it('maps rate limits before generation reads, deletes, or storage cleanup', async () => {
    const admin = createAdminSupabaseMock({ rateLimitAllowed: false });
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
      status: 429,
      rateLimitError: expect.any(BackendRateLimitError),
    });
    expect(admin.selects).toEqual([]);
    expect(admin.deletes).toEqual([]);
    expect(admin.storageRemovals).toEqual([]);
  });

  it('deletes the generation and only input media when linked posts must be retained', async () => {
    const admin = createAdminSupabaseMock({
      linkedPosts: [{ id: 'post-1' }],
      inputMediaRows: [
        { storage_path: 'generation_inputs/user-1/input-1.png' },
        { storage_path: 'generation_inputs/user-1/input-2.png' },
      ],
    });
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
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
  });

  it('deletes unlinked generation input, output, and showcase media', async () => {
    const admin = createAdminSupabaseMock({
      linkedPosts: [],
      inputMediaRows: [
        { storage_path: 'generation_inputs/user-1/input-1.png' },
      ],
    });
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');

    const result = await deleteOwnerGenerationForRoute({
      createAdminSupabase,
      createUserSupabase,
      generationId: 'gen-1',
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
      { bucket: 'showcase_media', paths: ['user-1/showcase.webp'] },
    ]);
  });
});
