import { describe, expect, it, vi } from 'vitest';

import {
  createWorkflowAssetReadUrl,
  type WorkflowAssetReadUrlClient,
} from '@/lib/workflow-asset-read-url';

function createClient({
  allowed = true,
  signedUrl = 'https://storage.example.test/signed/workflow-input.png',
  storageError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 80,
      remaining: allowed ? 79 : 0,
      retryAfterSeconds: allowed ? 0 : 29,
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
    } satisfies WorkflowAssetReadUrlClient,
    createSignedUrl,
    from,
    rpc,
  };
}

describe('createWorkflowAssetReadUrl', () => {
  it('rejects missing, unsafe, unsupported, or unowned paths before privileged work', async () => {
    const client = createClient();
    const clientFactory = vi.fn(() => client.client);

    await expect(createWorkflowAssetReadUrl({
      body: {},
      userId: 'user-1',
      client: clientFactory,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Workflow asset path is required.',
    });

    await expect(createWorkflowAssetReadUrl({
      body: { storagePath: 'generated_images/user-1/../reference.png' },
      userId: 'user-1',
      client: clientFactory,
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
      error: 'Workflow asset path is not available.',
    });

    await expect(createWorkflowAssetReadUrl({
      body: { storagePath: 'uploads/user-1/reference.png' },
      userId: 'user-1',
      client: clientFactory,
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
    });

    await expect(createWorkflowAssetReadUrl({
      body: { storagePath: 'generated_videos/user-2/reference.mp4' },
      userId: 'user-1',
      client: clientFactory,
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
    });

    expect(clientFactory).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  it('enforces read-url rate limits and creates signed URLs for owned workflow asset paths', async () => {
    const client = createClient();

    const result = await createWorkflowAssetReadUrl({
      body: { storagePath: 'generated_images/user-1/workflow-input-reference.png' },
      userId: 'user-1',
      client: client.client,
    });

    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'workflow-asset-upload:read-url',
      p_subject_key: 'user-1',
      p_limit: 80,
      p_window_seconds: 600,
    });
    expect(client.from).toHaveBeenCalledWith('generated_images');
    expect(client.createSignedUrl).toHaveBeenCalledWith('user-1/workflow-input-reference.png', 3600);
    expect(result).toEqual({
      ok: true,
      response: {
        success: true,
        signedUrl: 'https://storage.example.test/signed/workflow-input.png',
        expiresInSeconds: 3600,
      },
    });
  });

  it('returns stable rate-limit and storage failures without leaking storage details', async () => {
    const denied = createClient({ allowed: false });

    await expect(createWorkflowAssetReadUrl({
      body: { storagePath: 'generated_audio/user-1/reference.mp3' },
      userId: 'user-1',
      client: denied.client,
    })).resolves.toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 29,
    });
    expect(denied.createSignedUrl).not.toHaveBeenCalled();

    const storageFailure = createClient({ storageError: new Error('storage outage') });
    await expect(createWorkflowAssetReadUrl({
      body: { storagePath: 'generated_videos/user-1/reference.mp4' },
      userId: 'user-1',
      client: storageFailure.client,
    })).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'Failed to prepare workflow asset preview.',
    });
  });
});
