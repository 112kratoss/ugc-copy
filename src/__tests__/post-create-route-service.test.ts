import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  createOwnerPostForRoute,
  postIdForCreateKey,
  readPostCreateIdempotencyKey,
} from '@/lib/post-create-route-service';
import type { PostCreationSubmission } from '@/lib/post-creation-submission-service';
import type { SourceToolOption } from '@/lib/source-tools';

const sourceToolCatalog: SourceToolOption[] = [
  { slug: 'magicbooklet', label: 'magicbooklet', models: [], supportedMediaKinds: ['image', 'video'] },
];

function createRateLimitClient(options?: { rateLimited?: boolean; rpcError?: Error | null }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({
        data: {
          allowed: !options?.rateLimited,
          limit: 60,
          remaining: options?.rateLimited ? 0 : 59,
          retryAfterSeconds: options?.rateLimited ? 37 : 0,
          resetAt: '2026-06-23T06:30:00.000Z',
        },
        error: options?.rpcError ?? null,
      });
    },
  };

  return {
    calls,
    client: client as unknown as SupabaseClient,
  };
}

describe('createOwnerPostForRoute', () => {
  it('rate limits before parsing form data or publishing posts', async () => {
    const admin = createRateLimitClient({ rateLimited: true });
    const readFormData = vi.fn(async () => new FormData());
    const listSourceToolsCatalog = vi.fn(async () => sourceToolCatalog);
    const preparePostCreationSubmission = vi.fn();
    const publishPreparedPost = vi.fn();

    const result = await createOwnerPostForRoute({
      adminSupabase: admin.client,
      ownerUserId: 'user-1',
      readFormData,
      createPostId: () => 'post-1',
      dependencies: {
        listSourceToolsCatalog,
        preparePostCreationSubmission,
        publishPreparedPost,
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected a rate-limit error');
    expect(result).toHaveProperty('rateLimitError');
    expect(result.status).toBe(429);
    expect(admin.calls).toEqual([
      {
        name: 'check_backend_rate_limit',
        args: {
          p_scope: 'post:mutate',
          p_subject_key: 'user-1',
          p_limit: 60,
          p_window_seconds: 600,
        },
      },
    ]);
    expect(readFormData).not.toHaveBeenCalled();
    expect(listSourceToolsCatalog).not.toHaveBeenCalled();
    expect(preparePostCreationSubmission).not.toHaveBeenCalled();
    expect(publishPreparedPost).not.toHaveBeenCalled();
  });

  it('prepares and publishes posts with a generated post id after rate limiting', async () => {
    const admin = createRateLimitClient();
    const formData = new FormData();
    const preparedSubmission = {
      submittedMediaItems: [],
      hasSubmittedMedia: false,
      body: 'A compact launch note.',
      postFormat: 'text',
      mediaMimeType: '',
      category: 'text',
      visibility: 'public',
      title: 'A compact launch note.',
      description: null,
      sourceTools: [],
      normalizedSourceTool: { label: null, slug: null },
      sourceKind: 'manual',
      resourceBundle: null,
    } satisfies PostCreationSubmission;
    const publishBody = {
      success: true,
      postId: 'post-123',
      visibility: 'public',
      showcasePath: '/showcase/post-123',
      ownerPath: '/post/post-123/edit',
      resourceBundlePath: '/showcase/post-123#recipe',
      resourceBundleStatus: null,
    } as const;
    const readFormData = vi.fn(async () => formData);
    const listSourceToolsCatalog = vi.fn(async () => sourceToolCatalog);
    const preparePostCreationSubmission = vi.fn(async () => ({
      ok: true as const,
      submission: preparedSubmission,
    }));
    const publishPreparedPost = vi.fn(async () => ({
      ok: true as const,
      body: publishBody,
    }));

    const result = await createOwnerPostForRoute({
      adminSupabase: admin.client,
      ownerUserId: 'user-1',
      readFormData,
      createPostId: () => 'post-123',
      dependencies: {
        listSourceToolsCatalog,
        preparePostCreationSubmission,
        publishPreparedPost,
      },
    });

    expect(result).toEqual({
      ok: true,
      body: publishBody,
    });
    expect(preparePostCreationSubmission).toHaveBeenCalledWith({
      formData,
      userId: 'user-1',
      sourceToolCatalog,
    });
    expect(publishPreparedPost).toHaveBeenCalledWith({
      adminSupabase: admin.client,
      ownerUserId: 'user-1',
      postId: 'post-123',
      submission: preparedSubmission,
    });
  });

  it('returns preparation validation failures without publishing', async () => {
    const admin = createRateLimitClient();
    const publishPreparedPost = vi.fn();

    const result = await createOwnerPostForRoute({
      adminSupabase: admin.client,
      ownerUserId: 'user-1',
      readFormData: vi.fn(async () => new FormData()),
      createPostId: () => 'post-1',
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        preparePostCreationSubmission: vi.fn(async () => ({
          ok: false as const,
          status: 400 as const,
          body: { error: 'Media is required.' },
        })),
        publishPreparedPost,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Media is required.' },
    });
    expect(publishPreparedPost).not.toHaveBeenCalled();
  });

  it('maps rate limit infrastructure failures to stable post creation errors', async () => {
    const admin = createRateLimitClient({ rpcError: new Error('rpc unavailable') });

    const result = await createOwnerPostForRoute({
      adminSupabase: admin.client,
      ownerUserId: 'user-1',
      readFormData: vi.fn(async () => new FormData()),
      createPostId: () => 'post-1',
      dependencies: {
        listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
        preparePostCreationSubmission: vi.fn(),
        publishPreparedPost: vi.fn(),
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to create post.' },
    });
  });

  // Audit 2026-11-27, finding 4: a publish whose answer was lost and was pressed again made a
  // second post. The composer's Idempotency-Key names one create; the server derives the post's id
  // from the account and the key, claims the key before anything is written, and answers a repeat
  // with the post. These drive the real create path over an in-memory database.
  describe('with an Idempotency-Key', () => {
    const idempotency = mobileApiContract.endpoints.createPost.idempotency;
    const key = idempotency.key;
    const NOW = Date.parse('2026-11-27T10:00:00.000Z');
    const inProgress = { ok: false, status: idempotency.errors.inProgress.status, body: idempotency.errors.inProgress.response };
    const conflict = { ok: false, status: idempotency.errors.conflict.status, body: idempotency.errors.conflict.response };

    type PostRow = { id: string; user_id: string; visibility: string; post_format: string; created_at: string; tombstoned_at: string | null };
    type ClaimRow = { user_id: string; idempotency_key: string; post_id: string; claimed_at: string };

    /** Just enough of supabase-js for the create path: posts, post_media, bundles, claims and the limiter. */
    function memoryDatabase() {
      const db = {
        posts: [] as PostRow[],
        post_media: [] as Array<{ post_id: string }>,
        post_resource_bundles: [] as Array<{ post_id: string; status: string }>,
        post_create_claims: [] as ClaimRow[],
        rateLimitCalls: 0,
      };
      type Table = 'posts' | 'post_media' | 'post_resource_bundles' | 'post_create_claims';
      function query(table: Table) {
        const filters: Array<[string, unknown]> = [];
        let head = false;
        const rows = () => (db[table] as Array<Record<string, unknown>>).filter((row) => filters.every(([column, value]) => row[column] === value));
        const builder = {
          select(_columns?: string, options?: { head?: boolean }) { head = Boolean(options?.head); return builder; },
          eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
          async maybeSingle() { return { data: rows()[0] ?? null, error: null }; },
          then(resolve: (value: unknown) => void) {
            resolve(head ? { count: rows().length, error: null, data: null } : { data: rows(), error: null });
          },
          async insert(row: ClaimRow) {
            if (table === 'post_create_claims'
              && db.post_create_claims.some((claim) => claim.user_id === row.user_id && claim.idempotency_key === row.idempotency_key)) {
              return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            (db[table] as unknown[]).push({ claimed_at: new Date(NOW).toISOString(), ...row });
            return { error: null };
          },
          delete() {
            return {
              eq(column: string, value: unknown) {
                filters.push([column, value]);
                return this;
              },
              then(resolve: (value: unknown) => void) {
                const doomed = new Set(rows());
                (db as Record<string, unknown>)[table] = (db[table] as Array<Record<string, unknown>>).filter((row) => !doomed.has(row));
                resolve({ error: null });
              },
            };
          },
        };
        return builder;
      }
      const client = {
        from: (table: Table) => query(table),
        rpc: async () => {
          db.rateLimitCalls += 1;
          return { data: { allowed: true, limit: 60, remaining: 59, retryAfterSeconds: 0, resetAt: '2026-11-27T10:10:00.000Z' }, error: null };
        },
      };
      return { db, client: client as unknown as SupabaseClient };
    }

    function visibilityForm(visibility: 'public' | 'private' = 'public') {
      const form = new FormData();
      form.set('visibility', visibility);
      return form;
    }

    /** A publish the test lets finish when it says, writing its post as the real one does. */
    function heldPublish(database: ReturnType<typeof memoryDatabase>, outcome: 'public' | 'failed' | 'draft' = 'public') {
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      const publishPreparedPost = vi.fn(async ({ postId, ownerUserId }: { postId: string; ownerUserId: string }) => {
        await released;
        if (outcome === 'failed') return { ok: false as const, status: 500 as const, body: { error: 'Failed to prepare uploaded media.' } };
        database.db.posts.push({ id: postId, user_id: ownerUserId, visibility: outcome === 'draft' ? 'private' : 'public', post_format: 'media', created_at: new Date(NOW).toISOString(), tombstoned_at: null });
        database.db.post_media.push({ post_id: postId });
        if (outcome === 'draft') {
          return { ok: false as const, status: 500 as const, body: { error: 'Your post was saved as a private draft, but publishing failed. Open it from your posts to publish again.' } };
        }
        return { ok: true as const, body: { success: true as const, postId, visibility: 'public' as const, showcasePath: `/showcase/${postId}`, ownerPath: `/post/${postId}/edit`, resourceBundlePath: `/showcase/${postId}#recipe`, resourceBundleStatus: null } };
      });
      return { publishPreparedPost, release };
    }

    function create(database: ReturnType<typeof memoryDatabase>, publishPreparedPost: unknown, options: { userId?: string; now?: number; visibility?: 'public' | 'private' } = {}) {
      return createOwnerPostForRoute({
        adminSupabase: database.client,
        ownerUserId: options.userId ?? 'user-1',
        readFormData: async () => visibilityForm(options.visibility),
        idempotencyKey: key,
        now: () => options.now ?? NOW,
        dependencies: {
          listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
          preparePostCreationSubmission: vi.fn(async () => ({ ok: true as const, submission: {} as PostCreationSubmission })),
          publishPreparedPost: publishPreparedPost as never,
        },
      });
    }

    async function settle() {
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
    }

    it('reads only a UUID as a key, and anything else as no key', () => {
      expect(readPostCreateIdempotencyKey(key)).toBe(key);
      expect(readPostCreateIdempotencyKey(` ${key.toUpperCase()} `)).toBe(key);
      for (const value of [null, '', 'mobile:abc', `${key}0`, 'post-1', '00000000-0000-0000-0000-000000000000']) {
        expect(readPostCreateIdempotencyKey(value)).toBeNull();
      }
    });

    it('never uses the key as the post id: the id is derived from the account and the key', () => {
      const id = postIdForCreateKey('user-1', key);
      expect(id).not.toBe(key);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(postIdForCreateKey('user-1', key)).toBe(id);
      expect(postIdForCreateKey('user-2', key)).not.toBe(id);
    });

    it('makes the post once under the derived id, and answers a retry after success with it, uncounted', async () => {
      const database = memoryDatabase();
      const first = heldPublish(database);
      const pending = create(database, first.publishPreparedPost);
      first.release();
      const made = await pending;
      expect(made.ok).toBe(true);
      expect(first.publishPreparedPost).toHaveBeenCalledWith(expect.objectContaining({ postId: postIdForCreateKey('user-1', key) }));
      const countsAfterFirst = database.db.rateLimitCalls;

      const retry = heldPublish(database);
      const replay = await create(database, retry.publishPreparedPost);
      expect(replay).toEqual(made);
      expect(Object.keys((replay as { body: object }).body).sort()).toEqual(Object.keys(idempotency.replay.response).sort());
      expect(retry.publishPreparedPost).not.toHaveBeenCalled();
      expect(database.db.rateLimitCalls).toBe(countsAfterFirst);
      expect(database.db.posts).toHaveLength(1);
    });

    it('answers a retry during the media phase "in progress" and runs nothing for it', async () => {
      const database = memoryDatabase();
      const first = heldPublish(database);
      const pending = create(database, first.publishPreparedPost);
      await settle();
      expect(first.publishPreparedPost).toHaveBeenCalledTimes(1);

      const retry = heldPublish(database);
      expect(await create(database, retry.publishPreparedPost, { now: NOW + 60_000 })).toEqual(inProgress);
      expect(retry.publishPreparedPost).not.toHaveBeenCalled();

      first.release();
      expect((await pending).ok).toBe(true);
      expect(database.db.posts).toHaveLength(1);
    });

    it('lets exactly one of two simultaneous requests run', async () => {
      const database = memoryDatabase();
      const publish = heldPublish(database);
      const both = [create(database, publish.publishPreparedPost), create(database, publish.publishPreparedPost)];
      await settle();
      publish.release();
      const results = await Promise.all(both);

      expect(publish.publishPreparedPost).toHaveBeenCalledTimes(1);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([inProgress]);
      expect(database.db.posts).toHaveLength(1);
    });

    it('says the key cannot be used once its claim outlived the route, and the first attempt left nothing', async () => {
      const database = memoryDatabase();
      database.db.post_create_claims.push({ user_id: 'user-1', idempotency_key: key, post_id: postIdForCreateKey('user-1', key), claimed_at: new Date(NOW - 400_000).toISOString() });
      const retry = heldPublish(database);
      expect(await create(database, retry.publishPreparedPost)).toEqual(conflict);
      expect(retry.publishPreparedPost).not.toHaveBeenCalled();
    });

    it('lets go of its claim when its attempt made nothing, so a retry of the key can run', async () => {
      const database = memoryDatabase();
      const failed = heldPublish(database, 'failed');
      failed.release();
      expect((await create(database, failed.publishPreparedPost)).ok).toBe(false);
      expect(database.db.post_create_claims).toEqual([]);

      const retry = heldPublish(database);
      retry.release();
      expect((await create(database, retry.publishPreparedPost)).ok).toBe(true);
    });

    it('never answers a request for public with a private post: a draft left by a failed promotion fails again', async () => {
      const database = memoryDatabase();
      const first = heldPublish(database, 'draft');
      first.release();
      const firstAnswer = await create(database, first.publishPreparedPost);
      expect(firstAnswer).toMatchObject({ ok: false, status: 500 });

      expect(await create(database, vi.fn())).toEqual(firstAnswer);
      const privateRequest = await create(database, vi.fn(), { visibility: 'private' });
      expect(privateRequest).toMatchObject({ ok: true, body: { visibility: 'private' } });
    });

    it('refuses a post deleted since', async () => {
      const database = memoryDatabase();
      database.db.posts.push({ id: postIdForCreateKey('user-1', key), user_id: 'user-1', visibility: 'private', post_format: 'media', created_at: new Date(NOW - 3_600_000).toISOString(), tombstoned_at: new Date(NOW).toISOString() });
      expect(await create(database, vi.fn())).toEqual(conflict);
    });
  });
});
