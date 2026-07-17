import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createOwnerPostForRoute } from '@/lib/post-create-route-service';
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
    } as const;
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
      ok: true,
      submission: preparedSubmission,
    }));
    const publishPreparedPost = vi.fn(async () => ({
      ok: true,
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
          ok: false,
          status: 400,
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
});
