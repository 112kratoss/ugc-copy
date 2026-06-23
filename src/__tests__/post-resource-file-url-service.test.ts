import { describe, expect, it, vi } from 'vitest';

import {
  createPostResourceFileReadUrlForRoute,
  type PostResourceFileReadUrlClient,
} from '@/lib/post-resource-file-url-service';

function createClient({
  allowed = true,
  signedUrl = 'https://signed.example.com/reference.png',
  storageError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 120,
      remaining: allowed ? 119 : 0,
      retryAfterSeconds: allowed ? 0 : 18,
      resetAt: '2026-06-22T06:30:00.000Z',
    },
    error: null,
  }));
  const createSignedUrl = vi.fn(async () => ({
    data: storageError ? null : { signedUrl },
    error: storageError,
  }));
  const from = vi.fn(() => ({ createSignedUrl }));

  return {
    client: {
      rpc,
      storage: { from },
    } satisfies PostResourceFileReadUrlClient,
    createSignedUrl,
    from,
    rpc,
  };
}

function createAccessibleDetail(storagePath: string, title = 'Hero reference') {
  return {
    viewerCanAccess: true,
    resources: {
      attachments: [],
      items: [{
        title,
        storagePath,
      }],
    },
  };
}

describe('createPostResourceFileReadUrlForRoute', () => {
  it('rejects missing paths before bundle lookup or privileged signing work', async () => {
    const client = createClient();
    const clientFactory = vi.fn(() => client.client);
    const getDetailByPostId = vi.fn();

    const result = await createPostResourceFileReadUrlForRoute({
      body: {},
      client: clientFactory,
      countryCode: 'IN',
      getDetailByPostId,
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Missing resource file path.' },
    });
    expect(getDetailByPostId).not.toHaveBeenCalled();
    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  it('blocks locked or unrelated bundle files before rate-limit and storage work', async () => {
    const client = createClient();
    const clientFactory = vi.fn(() => client.client);
    const getLockedDetail = vi.fn(async () => ({
      viewerCanAccess: false,
      resources: null,
    }));

    await expect(createPostResourceFileReadUrlForRoute({
      body: { storagePath: 'user-1/generation-references/gen-1/reference.png' },
      client: clientFactory,
      countryCode: null,
      getDetailByPostId: getLockedDetail,
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    })).resolves.toEqual({
      ok: false,
      status: 403,
      body: { error: 'Unlock this resource before downloading files.' },
    });

    const getAccessibleDetail = vi.fn(async () => createAccessibleDetail('different-file.png'));
    await expect(createPostResourceFileReadUrlForRoute({
      body: { storagePath: 'user-1/generation-references/gen-1/reference.png' },
      client: clientFactory,
      countryCode: null,
      getDetailByPostId: getAccessibleDetail,
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    })).resolves.toEqual({
      ok: false,
      status: 404,
      body: { error: 'Resource file not found on this unlock.' },
    });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  it('signs generation input and legacy upload resource items from the correct buckets', async () => {
    const client = createClient();
    const getGenerationInputDetail = vi.fn(async () =>
      createAccessibleDetail('generation_inputs/user-1/gen-1/00-reference-image.png', 'Image input'));

    await expect(createPostResourceFileReadUrlForRoute({
      body: { storagePath: 'generation_inputs/user-1/gen-1/00-reference-image.png' },
      client: client.client,
      countryCode: 'IN',
      getDetailByPostId: getGenerationInputDetail,
      postId: 'post-1',
      rateLimitKey: '127.0.0.1',
      viewerUserId: null,
    })).resolves.toEqual({
      ok: true,
      body: {
        success: true,
        signedUrl: 'https://signed.example.com/reference.png',
      },
    });
    expect(client.from).toHaveBeenCalledWith('generation_inputs');
    expect(client.createSignedUrl).toHaveBeenCalledWith(
      'user-1/gen-1/00-reference-image.png',
      600,
      { download: 'Image input' },
    );

    const uploadClient = createClient();
    const getUploadDetail = vi.fn(async () =>
      createAccessibleDetail('uploads/user-1/legacy-reference.jpeg', 'Element 1'));

    await createPostResourceFileReadUrlForRoute({
      body: { storagePath: '/uploads/user-1/legacy-reference.jpeg' },
      client: uploadClient.client,
      countryCode: null,
      getDetailByPostId: getUploadDetail,
      postId: 'post-1',
      rateLimitKey: '127.0.0.1',
      viewerUserId: null,
    });
    expect(uploadClient.from).toHaveBeenCalledWith('uploads');
    expect(uploadClient.createSignedUrl).toHaveBeenCalledWith(
      'user-1/legacy-reference.jpeg',
      600,
      { download: 'Element 1' },
    );
  });

  it('rate limits before storage signing and returns stable storage failures', async () => {
    const denied = createClient({ allowed: false });
    const getDetailByPostId = vi.fn(async () =>
      createAccessibleDetail('user-1/generation-references/gen-1/reference.png'));

    const deniedResult = await createPostResourceFileReadUrlForRoute({
      body: { storagePath: 'user-1/generation-references/gen-1/reference.png' },
      client: denied.client,
      countryCode: null,
      getDetailByPostId,
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    });

    expect(deniedResult.ok).toBe(false);
    expect(deniedResult).toHaveProperty('rateLimitError');
    expect(denied.createSignedUrl).not.toHaveBeenCalled();

    const storageFailure = createClient({ storageError: new Error('storage outage') });
    await expect(createPostResourceFileReadUrlForRoute({
      body: { storagePath: 'user-1/generation-references/gen-1/reference.png' },
      client: storageFailure.client,
      countryCode: null,
      getDetailByPostId,
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to prepare resource file.' },
    });
  });
});
