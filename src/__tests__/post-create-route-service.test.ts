import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import mobileApiContract from '../../contracts/mobile-api-v1.json';
import {
  createOwnerPostForRoute,
  readPostCreateIdempotencyKey,
  type ExistingPostForCreate,
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
  // second post. The composer's Idempotency-Key is the new post's id, and a repeat answers it.
  describe('with an Idempotency-Key', () => {
    const idempotency = mobileApiContract.endpoints.createPost.idempotency;
    const key = idempotency.key;
    const NOW = Date.parse('2026-11-27T10:00:00.000Z');

    function existing(overrides: Partial<ExistingPostForCreate> = {}): ExistingPostForCreate {
      return {
        userId: 'user-1',
        visibility: 'public',
        postFormat: 'media',
        createdAt: '2026-11-27T09:00:00.000Z',
        tombstoned: false,
        mediaCount: 1,
        bundleStatus: null,
        ...overrides,
      };
    }

    function run(read: Awaited<ReturnType<NonNullable<Parameters<typeof createOwnerPostForRoute>[0]['dependencies']>['readExistingPostForCreate']>>) {
      const admin = createRateLimitClient();
      const readFormData = vi.fn(async () => new FormData());
      const publishPreparedPost = vi.fn(async () => ({ ok: true as const, body: idempotency.replay.response as never }));
      const readExistingPostForCreate = vi.fn(async () => read);
      const result = createOwnerPostForRoute({
        adminSupabase: admin.client,
        ownerUserId: 'user-1',
        readFormData,
        idempotencyKey: key,
        createPostId: () => 'random-id',
        now: () => NOW,
        dependencies: {
          listSourceToolsCatalog: vi.fn(async () => sourceToolCatalog),
          preparePostCreationSubmission: vi.fn(async () => ({ ok: true as const, submission: {} as PostCreationSubmission })),
          publishPreparedPost,
          readExistingPostForCreate,
        },
      });
      return { result, readFormData, publishPreparedPost, readExistingPostForCreate };
    }

    it('reads only a UUID as a key, and anything else as no key', () => {
      expect(readPostCreateIdempotencyKey(key)).toBe(key);
      expect(readPostCreateIdempotencyKey(` ${key.toUpperCase()} `)).toBe(key);
      for (const value of [null, '', 'mobile:abc', `${key}0`, 'post-1', '00000000-0000-0000-0000-000000000000']) {
        expect(readPostCreateIdempotencyKey(value)).toBeNull();
      }
    });

    it('makes the post under the key when no post has it', async () => {
      const { result, publishPreparedPost, readExistingPostForCreate } = run({ ok: true, post: null });
      expect((await result).ok).toBe(true);
      expect(readExistingPostForCreate).toHaveBeenCalledWith(expect.anything(), key);
      expect(publishPreparedPost).toHaveBeenCalledWith(expect.objectContaining({ postId: key }));
    });

    it('answers a repeat with the post in the shape of a fresh create, and creates nothing', async () => {
      const { result, readFormData, publishPreparedPost } = run({ ok: true, post: existing() });
      expect(await result).toEqual({ ok: true, body: idempotency.replay.response });
      expect(readFormData).not.toHaveBeenCalled();
      expect(publishPreparedPost).not.toHaveBeenCalled();
    });

    it('answers a private post and a recipe still a draft as a fresh create would', async () => {
      const { result } = run({ ok: true, post: existing({ visibility: 'private', bundleStatus: 'draft' }) });
      expect(await result).toEqual({
        ok: true,
        body: {
          success: true,
          postId: key,
          visibility: 'private',
          showcasePath: null,
          ownerPath: `/post/${key}/edit`,
          resourceBundlePath: `/post/${key}/edit#recipe`,
          resourceBundleStatus: 'draft',
        },
      });
    });

    it('refuses another account\'s post without saying whose, and a post deleted since', async () => {
      for (const post of [existing({ userId: 'user-2' }), existing({ tombstoned: true })]) {
        const { result, publishPreparedPost } = run({ ok: true, post });
        expect(await result).toEqual({ ok: false, status: idempotency.errors.conflict.status, body: idempotency.errors.conflict.response });
        expect(publishPreparedPost).not.toHaveBeenCalled();
      }
    });

    it('says a media post with none of its files yet is still being saved, and one left so is unfinished', async () => {
      const saving = run({ ok: true, post: existing({ mediaCount: 0, visibility: 'private', createdAt: new Date(NOW - 30_000).toISOString() }) });
      expect(await saving.result).toEqual({ ok: false, status: idempotency.errors.inProgress.status, body: idempotency.errors.inProgress.response });
      const left = run({ ok: true, post: existing({ mediaCount: 0, visibility: 'private', createdAt: new Date(NOW - 600_000).toISOString() }) });
      expect(await left.result).toEqual({ ok: false, status: idempotency.errors.conflict.status, body: idempotency.errors.conflict.response });
      const text = run({ ok: true, post: existing({ mediaCount: 0, postFormat: 'text' }) });
      expect((await text.result).ok).toBe(true);
    });

    it('creates nothing when whether the post exists cannot be read', async () => {
      const { result, publishPreparedPost } = run({ ok: false });
      expect(await result).toEqual({ ok: false, status: 500, body: { error: 'Failed to create post.' } });
      expect(publishPreparedPost).not.toHaveBeenCalled();
    });
  });
});
