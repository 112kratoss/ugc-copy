import { describe, expect, it, vi } from 'vitest';

import {
  createPostResourceFileReadUrlForRoute,
  type PostResourceFileReadUrlClient,
} from '@/lib/post-resource-file-url-service';
import type { PostResourceBundleDetail } from '@/lib/post-resource-bundles-server';

function createClient({
  allowed = true,
  signedUrl = 'https://signed.example.com/reference.png',
  signedUrlFor = null as ((path: string) => string) | null,
  storageError = null as Error | null,
  failingPaths = [] as string[],
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
  const createSignedUrl = vi.fn(async (path: string) => {
    const error = storageError ?? (failingPaths.includes(path) ? new Error('storage outage') : null);
    return {
      data: error ? null : { signedUrl: signedUrlFor ? signedUrlFor(path) : signedUrl },
      error,
    };
  });
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

function createAccessibleDetail(
  storagePath: string,
  title = 'Hero reference'
): PostResourceBundleDetail {
  return {
    viewerCanAccess: true,
    seller: { id: 'user-1' },
    resources: {
      attachments: [],
      items: [{
        title,
        storagePath,
      }],
    },
  } as unknown as PostResourceBundleDetail;
}

const batchItems = [
  { title: 'Reference 1', storagePath: 'generation_inputs/user-1/gen-1/00-reference-image.png', contentType: 'image/png' },
  { title: 'Motion', storagePath: 'generation_inputs/user-1/gen-1/01-reference-video.mp4', contentType: 'video/mp4' },
  { title: 'Voice.mp3', storagePath: 'user-1/resources/voice.mp3', contentType: 'audio/mpeg' },
];

function createBatchDetail(): PostResourceBundleDetail {
  return {
    viewerCanAccess: true,
    seller: { id: 'user-1' },
    resources: { attachments: [], items: batchItems },
  } as unknown as PostResourceBundleDetail;
}

const signedUrlFor = (path: string) => `https://signed.example.com/${path}`;

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
    const getLockedDetail = vi.fn(async (): Promise<PostResourceBundleDetail> => ({
      viewerCanAccess: false,
      resources: null,
    } as unknown as PostResourceBundleDetail));

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
      body: { storagePath: 'uploads/user-1/legacy-reference.jpeg' },
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

  it('rejects non-canonical entitled paths before service-role signing', async () => {
    for (const storagePath of [
      'uploads/user-1/../user-2/private.pdf',
      'uploads/user-1/%252fuser-2/private.pdf',
      'uploads/user-1/%255cuser-2/private.pdf',
      'uploads/user-2/private.pdf',
      'uploads//user-1/private.pdf',
    ]) {
      const client = createClient();
      const clientFactory = vi.fn(() => client.client);
      const result = await createPostResourceFileReadUrlForRoute({
        body: { storagePath },
        client: clientFactory,
        countryCode: null,
        getDetailByPostId: vi.fn(async () => createAccessibleDetail(storagePath)),
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      });

      expect(result).toEqual({
        ok: false,
        status: 404,
        body: { error: 'Resource file not found on this unlock.' },
      });
      expect(clientFactory).not.toHaveBeenCalled();
      expect(client.createSignedUrl).not.toHaveBeenCalled();
    }
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

  describe('batch form', () => {
    const batchPaths = batchItems.map((item) => item.storagePath);

    it('signs every file with one entitlement load and one limit check, in the order asked', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-06-22T06:00:00.000Z'));
      try {
        const client = createClient({ signedUrlFor });
        const getDetailByPostId = vi.fn(async () => createBatchDetail());

        const result = await createPostResourceFileReadUrlForRoute({
          // A repeated path is signed once.
          body: { storagePaths: [...batchPaths, batchPaths[0]], disposition: 'inline' },
          client: client.client,
          countryCode: 'IN',
          getDetailByPostId,
          postId: 'post-1',
          rateLimitKey: 'buyer-1',
          viewerUserId: 'buyer-1',
        });

        expect(result).toEqual({
          ok: true,
          body: {
            files: [
              {
                storagePath: batchPaths[0],
                url: 'https://signed.example.com/user-1/gen-1/00-reference-image.png',
                expiresAt: '2026-06-22T06:10:00.000Z',
              },
              {
                storagePath: batchPaths[1],
                url: 'https://signed.example.com/user-1/gen-1/01-reference-video.mp4',
                expiresAt: '2026-06-22T06:10:00.000Z',
              },
              {
                storagePath: batchPaths[2],
                url: 'https://signed.example.com/user-1/resources/voice.mp3',
                expiresAt: '2026-06-22T06:10:00.000Z',
              },
            ],
          },
        });
        expect(getDetailByPostId).toHaveBeenCalledTimes(1);
        expect(client.rpc).toHaveBeenCalledTimes(1);
        expect(client.createSignedUrl).toHaveBeenCalledTimes(3);
        // Inline: no download name, so the browser shows the file.
        expect(client.createSignedUrl).toHaveBeenCalledWith('user-1/gen-1/00-reference-image.png', 600, {});
        expect(client.from).toHaveBeenCalledWith('generation_inputs');
        expect(client.from).toHaveBeenCalledWith('post_resource_files');
      } finally {
        vi.useRealTimers();
      }
    });

    it('leaves out a path that is not on this unlock, and refuses a batch that names none', async () => {
      const client = createClient({ signedUrlFor });
      const getDetailByPostId = vi.fn(async () => createBatchDetail());

      const partial = await createPostResourceFileReadUrlForRoute({
        body: { storagePaths: [batchPaths[0], 'user-2/private.png', 'uploads/user-1/../user-2/x.png'] },
        client: client.client,
        countryCode: null,
        getDetailByPostId,
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      });
      expect(partial.ok && 'files' in partial.body ? partial.body.files.map((file) => file.storagePath) : partial)
        .toEqual([batchPaths[0]]);

      const none = createClient({ signedUrlFor });
      await expect(createPostResourceFileReadUrlForRoute({
        body: { storagePaths: ['user-2/private.png'] },
        client: none.client,
        countryCode: null,
        getDetailByPostId,
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      })).resolves.toEqual({
        ok: false,
        status: 404,
        body: { error: 'Resource file not found on this unlock.' },
      });
      expect(none.rpc).not.toHaveBeenCalled();
      expect(none.createSignedUrl).not.toHaveBeenCalled();
    });

    it('rejects a malformed batch or disposition before any lookup', async () => {
      const tooMany = Array.from({ length: 26 }, (_, index) => `user-1/resources/${index}.png`);
      const cases: Array<[unknown, string]> = [
        [{ storagePaths: [] }, 'Missing resource file path.'],
        [{ storagePaths: 'user-1/resources/a.png' }, 'Missing resource file path.'],
        [{ storagePaths: ['user-1/resources/a.png', 7] }, 'Missing resource file path.'],
        [{ storagePaths: [' user-1/resources/a.png'] }, 'Missing resource file path.'],
        [{ storagePaths: tooMany }, 'Ask for at most 25 resource files at a time.'],
        [{ storagePath: 'user-1/resources/a.png', disposition: 'download' }, 'Unknown file disposition.'],
      ];

      for (const [body, error] of cases) {
        const client = createClient();
        const getDetailByPostId = vi.fn();
        await expect(createPostResourceFileReadUrlForRoute({
          body,
          client: client.client,
          countryCode: null,
          getDetailByPostId,
          postId: 'post-1',
          rateLimitKey: 'buyer-1',
          viewerUserId: 'buyer-1',
        })).resolves.toEqual({ ok: false, status: 400, body: { error } });
        expect(getDetailByPostId).not.toHaveBeenCalled();
        expect(client.rpc).not.toHaveBeenCalled();
      }
    });

    it('answers the files that signed when one signing fails, and fails only when none did', async () => {
      const oneDown = createClient({ signedUrlFor, failingPaths: ['user-1/gen-1/01-reference-video.mp4'] });
      const partial = await createPostResourceFileReadUrlForRoute({
        body: { storagePaths: batchPaths },
        client: oneDown.client,
        countryCode: null,
        getDetailByPostId: vi.fn(async () => createBatchDetail()),
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      });
      expect(partial.ok && 'files' in partial.body ? partial.body.files.map((file) => file.storagePath) : partial)
        .toEqual([batchPaths[0], batchPaths[2]]);

      await expect(createPostResourceFileReadUrlForRoute({
        body: { storagePaths: batchPaths },
        client: createClient({ storageError: new Error('storage outage') }).client,
        countryCode: null,
        getDetailByPostId: vi.fn(async () => createBatchDetail()),
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      })).resolves.toEqual({ ok: false, status: 500, body: { error: 'Failed to prepare resource file.' } });
    });

    it('counts a denied batch once and signs nothing', async () => {
      const denied = createClient({ allowed: false });
      const result = await createPostResourceFileReadUrlForRoute({
        body: { storagePaths: batchPaths },
        client: denied.client,
        countryCode: null,
        getDetailByPostId: vi.fn(async () => createBatchDetail()),
        postId: 'post-1',
        rateLimitKey: 'buyer-1',
        viewerUserId: 'buyer-1',
      });

      expect(result).toHaveProperty('rateLimitError');
      expect(denied.rpc).toHaveBeenCalledTimes(1);
      expect(denied.createSignedUrl).not.toHaveBeenCalled();
    });
  });

  it('saves a download under its title with the extension of its content type', async () => {
    const client = createClient();
    const getDetailByPostId = vi.fn(async () => createBatchDetail());
    const sign = (storagePath: string, disposition?: string) => createPostResourceFileReadUrlForRoute({
      body: { storagePath, ...(disposition ? { disposition } : {}) },
      client: client.client,
      countryCode: null,
      getDetailByPostId,
      postId: 'post-1',
      rateLimitKey: 'buyer-1',
      viewerUserId: 'buyer-1',
    });

    // The single form answers exactly as it always has.
    await expect(sign(batchItems[0].storagePath)).resolves.toEqual({
      ok: true,
      body: { success: true, signedUrl: 'https://signed.example.com/reference.png' },
    });
    expect(client.createSignedUrl).toHaveBeenLastCalledWith('user-1/gen-1/00-reference-image.png', 600, { download: 'Reference 1.png' });

    // A title that already carries the extension keeps its own.
    await sign(batchItems[2].storagePath, 'attachment');
    expect(client.createSignedUrl).toHaveBeenLastCalledWith('user-1/resources/voice.mp3', 600, { download: 'Voice.mp3' });

    await sign(batchItems[1].storagePath, 'inline');
    expect(client.createSignedUrl).toHaveBeenLastCalledWith('user-1/gen-1/01-reference-video.mp4', 600, {});
  });
});
