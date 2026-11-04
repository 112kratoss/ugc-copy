import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';

type GenerationRow = {
  id: string;
  user_id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  playback_rendition_path?: string | null;
  preview_url?: string | null;
  display_url?: string | null;
  workflow_settings?: Record<string, unknown> | null;
};

/** A post as the read after the delete returns it: unlinked, recording the creation. */
type RemainingPost = {
  id: string;
  output_url: string | null;
  showcase_asset_path: string | null;
  post_media?: Array<Record<string, string | null>> | null;
};

type IdentityState = 'active' | 'merged' | 'deleting';

const loggerMocks = vi.hoisted(() => ({
  logBackendError: vi.fn(),
  logBackendWarning: vi.fn(),
}));

vi.mock('@/lib/backend-logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/backend-logger')>(),
  ...loggerMocks,
}));

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
  deletedPlaybackPath,
  postsAfterDelete,
  postsAfterDeleteError = null,
  storageRemoveErrors = {},
  storageRemoveThrows = {},
}: {
  generation?: GenerationRow | null;
  inputMediaRows?: Array<{ user_id: string; storage_path: string | null }>;
  identityLookupError?: Error | null;
  identityState?: IdentityState | null;
  linkedGuestIds?: string[];
  linkedPosts?: Array<{ id: string }>;
  rateLimitAllowed?: boolean;
  deletedPlaybackPath?: string;
  /**
   * The posts that record the creation once its delete unlinked them. By
   * default each linked post, serving the creation's copy and naming its
   * original, as a publish leaves it.
   */
  postsAfterDelete?: RemainingPost[];
  postsAfterDeleteError?: Error | null;
  /** Answers a bucket's remove with this error. */
  storageRemoveErrors?: Record<string, { message: string }>;
  /** Throws from a bucket's remove. */
  storageRemoveThrows?: Record<string, Error>;
} = {}) {
  const deletes: string[] = [];
  const ownerFilters: Array<{ operation: 'delete' | 'select'; table: string; values: unknown[] }> = [];
  const selects: string[] = [];
  const storageRemovals: Array<{ bucket: string; paths: string[] }> = [];
  const postReads: Array<Record<string, unknown>> = [];
  const queuedShowcasePaths: string[][] = [];
  const privateCleanupTickets: Array<Record<string, unknown>> = [];
  const remainingPosts: RemainingPost[] = postsAfterDelete ?? linkedPosts.map((post) => ({
    id: post.id,
    output_url: generation?.output_url ?? null,
    showcase_asset_path: generation?.showcase_asset_path ?? null,
    post_media: [],
  }));
  const rpc = vi.fn(async (fn: string, args?: Record<string, unknown>) => {
    if (fn === 'queue_unrecorded_showcase_media') {
      queuedShowcasePaths.push([...(args?.p_paths as string[])]);
      return { data: (args?.p_paths as string[]).length, error: null };
    }

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
    postReads,
    privateCleanupTickets,
    queuedShowcasePaths,
    rpc,
    selects,
    storageRemovals,
    client: {
      rpc,
      from(table: string) {
        return {
          // The private cleanup outbox, as the service role writes it.
          async upsert(rows: Array<Record<string, unknown>>, options: Record<string, unknown>) {
            if (table !== 'post_media_object_cleanup') throw new Error(`Unexpected upsert into ${table}`);
            privateCleanupTickets.push(...rows.map((row) => ({ ...row, options })));
            return { data: null, error: null };
          },
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
              then(resolve: (value: { data: unknown; error: unknown }) => void) {
                if (table === 'posts' && 'deleted_generation_id' in filters) {
                  postReads.push({ ...filters, columns });
                  return Promise.resolve(postsAfterDeleteError
                    ? { data: null, error: postsAfterDeleteError }
                    : {
                      data: deletes.includes('generations') && filters.deleted_generation_id === generation?.id
                        ? remainingPosts
                        : [],
                      error: null,
                    }).then(resolve);
                }

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
              select: async (columns = '') => {
                selects.push(`${table}:delete:${columns}`);
                return { data: generation ? [{...generation,
                ...(deletedPlaybackPath ? {playback_rendition_path:deletedPlaybackPath} : {}),
              }] : [], error: null };
              },
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
              if (storageRemoveThrows[bucket]) throw storageRemoveThrows[bucket];
              return { data: null, error: storageRemoveErrors[bucket] ?? null };
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

  // No post plays the creation's private rendition: a public post serves its
  // own copy's rendition, and a private one its original. Once the creation
  // is gone nothing names it, linked post or not.
  it.each([false, true])('cleans private playback whether or not a post stays (linked: %s)', async linked => {
    const admin = createAdminSupabaseMock({
      generation: { id: 'gen-1', user_id: 'user-1', output_url: 'generated_videos/user-1/original.mp4',
        showcase_asset_path: null, playback_rendition_path: 'generated_videos/user-1/playback/gen-1/abc.mp4' },
      linkedPosts: linked ? [{id:'post-1'}] : [], inputMediaRows: [],
    });
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const {deleteOwnerGenerationForRoute} = await import('@/lib/generation-delete-service');
    const result=await deleteOwnerGenerationForRoute({createAdminSupabase,createUserSupabase,
      generationId:'gen-1',invalidateFeedCache:vi.fn(),request:new Request('http://localhost/api/generations/gen-1')});
    expect(result.ok).toBe(true);
    expect(admin.selects.some(s=>s.includes('playback_rendition_path'))).toBe(true);
    expect(admin.storageRemovals.some(r=>r.paths.includes('user-1/playback/gen-1/abc.mp4'))).toBe(true);
    // The original stays while the post names it.
    expect(admin.storageRemovals.some(r=>r.paths.includes('user-1/original.mp4'))).toBe(!linked);
  });

  it('cleans the rendition published between the initial read and deletion', async () => {
    const path='generated_videos/user-1/playback/gen-1/finished.mp4';
    const admin=createAdminSupabaseMock({deletedPlaybackPath:path});
    createAdminSupabase.mockReturnValueOnce(admin.client);
    const {deleteOwnerGenerationForRoute}=await import('@/lib/generation-delete-service');
    await deleteOwnerGenerationForRoute({createAdminSupabase,createUserSupabase,generationId:'gen-1',
      invalidateFeedCache:vi.fn(),request:new Request('http://localhost/api/generations/gen-1')});
    expect(admin.storageRemovals).toContainEqual({bucket:'generated_videos',paths:['user-1/playback/gen-1/finished.mp4']});
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
      { bucket: 'generation_inputs', paths: ['user-1/input-1.png', 'user-1/input-2.png'] },
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

  describe('what a deleted creation leaves behind', () => {
    const imageGeneration: GenerationRow = {
      id: 'gen-1',
      user_id: 'user-1',
      output_url: 'generated_images/user-1/generated_p1_0.png',
      showcase_asset_path: 'showcase/gen-1/generated_p1_0.abc123.png',
      preview_url: 'generated_images/user-1/generated_p1_0.preview.1111222233334444.webp',
      display_url: 'generated_images/user-1/generated_p1_0.display.5555666677778888.webp',
      playback_rendition_path: null,
      workflow_settings: {
        prompt: 'four cats',
        // A reference the run read is the caller's input, never its output.
        references: [{ storagePath: 'generation_inputs/user-1/gen-1/00-reference.png' }],
        outputs: [
          { index: 0, storagePath: 'generated_images/user-1/generated_p1_0.png' },
          { index: 1, storagePath: 'generated_images/user-1/generated_p1_1.png' },
          { index: 2, storagePath: 'generated_images/user-1/generated_p1_2.png' },
          // Another account's file is never this delete's to remove.
          { index: 3, storagePath: 'generated_images/user-2/generated_p9_3.png' },
        ],
        primaryOutputIndex: 0,
      },
    };

    async function deleteCreation(options: Parameters<typeof createAdminSupabaseMock>[0]) {
      const admin = createAdminSupabaseMock({ inputMediaRows: [], ...options });
      createAdminSupabase.mockReturnValueOnce(admin.client);
      const { deleteOwnerGenerationForRoute } = await import('@/lib/generation-delete-service');
      const result = await deleteOwnerGenerationForRoute({
        createAdminSupabase,
        createUserSupabase,
        generationId: 'gen-1',
        invalidateFeedCache: vi.fn(),
        request: new Request('http://localhost/api/generations/gen-1'),
      });
      return { admin, result };
    }

    function removedPaths(removals: Array<{ bucket: string; paths: string[] }>) {
      return removals.flatMap(({ bucket, paths }) => paths.map((path) => `${bucket}/${path}`)).sort();
    }

    beforeEach(() => {
      loggerMocks.logBackendError.mockClear();
      loggerMocks.logBackendWarning.mockClear();
    });

    it('removes its preview, display and every extra output with the original', async () => {
      const { admin, result } = await deleteCreation({ generation: imageGeneration });

      expect(result.ok).toBe(true);
      expect(removedPaths(admin.storageRemovals)).toEqual([
        'generated_images/user-1/generated_p1_0.display.5555666677778888.webp',
        'generated_images/user-1/generated_p1_0.png',
        'generated_images/user-1/generated_p1_0.preview.1111222233334444.webp',
        'generated_images/user-1/generated_p1_1.png',
        'generated_images/user-1/generated_p1_2.png',
        'showcase_media/showcase/gen-1/generated_p1_0.abc123.png',
      ]);
    });

    it('reads the paths the delete itself returned, so a preview recorded meanwhile goes too', async () => {
      const { admin } = await deleteCreation({ generation: imageGeneration });

      const deleteSelect = admin.selects.find((select) => select.startsWith('generations:delete:'));
      expect(deleteSelect).toContain('preview_url');
      expect(deleteSelect).toContain('display_url');
      expect(deleteSelect).toContain('workflow_settings');
    });

    it('keeps what a remaining post names and removes the rest of the private files', async () => {
      const { admin, result } = await deleteCreation({
        generation: imageGeneration,
        linkedPosts: [{ id: 'post-1' }],
        postsAfterDelete: [{
          id: 'post-1',
          output_url: 'generated_images/user-1/generated_p1_0.png',
          showcase_asset_path: 'showcase/gen-1/generated_p1_0.abc123.png',
          post_media: [{
            storage_path: 'showcase/gen-1/generated_p1_0.abc123.png',
            preview_storage_path: 'showcase/gen-1/generated_p1_0.abc123.preview.aaaa.webp',
            display_storage_path: null,
            rendition_storage_path: null,
            teaser_storage_path: null,
          }],
        }],
      });

      expect(result).toMatchObject({ ok: true, body: { linkedPostRetained: true } });
      expect(admin.postReads).toEqual([expect.objectContaining({ deleted_generation_id: 'gen-1' })]);
      expect(removedPaths(admin.storageRemovals)).toEqual([
        'generated_images/user-1/generated_p1_0.display.5555666677778888.webp',
        'generated_images/user-1/generated_p1_0.preview.1111222233334444.webp',
        'generated_images/user-1/generated_p1_1.png',
        'generated_images/user-1/generated_p1_2.png',
      ]);
      expect(admin.queuedShowcasePaths).toEqual([]);
    });

    it('lets the original go when the remaining post names another file', async () => {
      const { admin } = await deleteCreation({
        generation: imageGeneration,
        linkedPosts: [{ id: 'post-1' }],
        postsAfterDelete: [{
          id: 'post-1',
          output_url: 'https://tempfile.example.com/provider-output.png',
          showcase_asset_path: 'showcase/gen-1/generated_p1_0.abc123.png',
          post_media: [],
        }],
      });

      expect(removedPaths(admin.storageRemovals)).toContain('generated_images/user-1/generated_p1_0.png');
      expect(removedPaths(admin.storageRemovals)).not.toContain('showcase_media/showcase/gen-1/generated_p1_0.abc123.png');
    });

    it('hands a copy no remaining post serves to the revocation queue rather than removing it', async () => {
      const { admin } = await deleteCreation({
        generation: imageGeneration,
        linkedPosts: [{ id: 'post-1' }],
        postsAfterDelete: [{
          id: 'post-1',
          output_url: 'generated_images/user-1/generated_p1_0.png',
          showcase_asset_path: 'showcase/gen-1/generated_p1_0.newer999.png',
          post_media: [],
        }],
      });

      expect(admin.queuedShowcasePaths).toEqual([['showcase/gen-1/generated_p1_0.abc123.png']]);
      expect(removedPaths(admin.storageRemovals)).not.toContain('showcase_media/showcase/gen-1/generated_p1_0.abc123.png');
    });

    it('catches a post the delete unlinked although the first read found none', async () => {
      const { admin, result } = await deleteCreation({
        generation: imageGeneration,
        linkedPosts: [],
        postsAfterDelete: [{
          id: 'post-2',
          output_url: 'generated_images/user-1/generated_p1_0.png',
          showcase_asset_path: 'showcase/gen-1/generated_p1_0.abc123.png',
          post_media: [],
        }],
      });

      expect(result).toMatchObject({ ok: true, body: { linkedPostRetained: true } });
      expect(removedPaths(admin.storageRemovals)).not.toContain('generated_images/user-1/generated_p1_0.png');
      expect(removedPaths(admin.storageRemovals)).not.toContain('showcase_media/showcase/gen-1/generated_p1_0.abc123.png');
    });

    it('keeps every private file and the copy when the remaining posts cannot be read', async () => {
      const { admin, result } = await deleteCreation({
        generation: imageGeneration,
        linkedPosts: [{ id: 'post-1' }],
        postsAfterDeleteError: new Error('posts unavailable'),
        inputMediaRows: [{ user_id: 'user-1', storage_path: 'generation_inputs/user-1/gen-1/00-reference.png' }],
      });

      expect(result.ok).toBe(true);
      // The creation's own inputs are its alone, read before the delete.
      expect(removedPaths(admin.storageRemovals)).toEqual([
        'generation_inputs/user-1/gen-1/00-reference.png',
      ]);
      expect(loggerMocks.logBackendError).toHaveBeenCalledWith(
        'failed_to_load_posts_after_generation_delete',
        expect.anything(),
      );
    });

    // A post marked NSFW serves a private copy, private-posts/<creation>/, in
    // the private bucket. With no post left, nothing else names it.
    describe('the private copy of a creation marked NSFW', () => {
      const nsfwGeneration: GenerationRow = {
        ...imageGeneration,
        showcase_asset_path: 'private-posts/gen-1/generated_p1_0.abc123.png',
      };

      it('goes with the creation when no post remains', async () => {
        const { admin } = await deleteCreation({ generation: nsfwGeneration });

        expect(removedPaths(admin.storageRemovals)).toContain('post_media/private-posts/gen-1/generated_p1_0.abc123.png');
      });

      it('stays while a remaining post serves it', async () => {
        const { admin } = await deleteCreation({
          generation: nsfwGeneration,
          linkedPosts: [{ id: 'post-1' }],
          postsAfterDelete: [{
            id: 'post-1',
            output_url: 'generated_images/user-1/generated_p1_0.png',
            showcase_asset_path: 'private-posts/gen-1/generated_p1_0.abc123.png',
            post_media: [],
          }],
        });

        expect(removedPaths(admin.storageRemovals)).not.toContain('post_media/private-posts/gen-1/generated_p1_0.abc123.png');
        expect(admin.privateCleanupTickets).toEqual([]);
      });

      it('goes to the private cleanup outbox, which checks references again, when its removal fails', async () => {
        const { admin, result } = await deleteCreation({
          generation: nsfwGeneration,
          storageRemoveErrors: { post_media: { message: 'storage unavailable' } },
        });

        expect(result.ok).toBe(true);
        expect(admin.privateCleanupTickets).toEqual([{
          storage_path: 'private-posts/gen-1/generated_p1_0.abc123.png',
          options: expect.objectContaining({ onConflict: 'storage_path', ignoreDuplicates: true }),
        }]);
      });

      it('never takes a path outside the creation\'s own folder', async () => {
        const { admin } = await deleteCreation({
          generation: { ...nsfwGeneration, showcase_asset_path: 'private-posts/gen-2/other.png' },
        });

        expect(removedPaths(admin.storageRemovals).some((path) => path.startsWith('post_media/'))).toBe(false);
      });
    });

    it('logs a failed removal and hands failed public paths to the revocation queue', async () => {
      const { admin, result } = await deleteCreation({
        generation: imageGeneration,
        storageRemoveErrors: { showcase_media: { message: 'storage unavailable' } },
        storageRemoveThrows: { generated_images: new Error('socket hang up') },
      });

      expect(result.ok).toBe(true);
      expect(admin.queuedShowcasePaths).toEqual([['showcase/gen-1/generated_p1_0.abc123.png']]);
      expect(loggerMocks.logBackendError).toHaveBeenCalledWith(
        'failed_to_remove_deleted_generation_media',
        expect.objectContaining({
          bucket: 'generated_images',
          generationId: 'gen-1',
          paths: expect.arrayContaining(['user-1/generated_p1_0.png', 'user-1/generated_p1_1.png']),
        }),
      );
      expect(loggerMocks.logBackendError).toHaveBeenCalledWith(
        'failed_to_remove_deleted_generation_media',
        expect.objectContaining({ bucket: 'showcase_media', paths: ['showcase/gen-1/generated_p1_0.abc123.png'] }),
      );
    });
  });
});
