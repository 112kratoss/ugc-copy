import { describe, expect, it, vi } from 'vitest';

import {
  createTemporaryMediaReadUrl,
  type TemporaryMediaReadUrlClient,
} from '@/lib/temporary-media-read-url';

function createClient({
  allowed = true,
  signedUrl = 'https://storage.example.test/signed/reference.png',
  storageError = null as Error | null,
} = {}) {
  const rpc = vi.fn(async () => ({
    data: {
      allowed,
      limit: 120,
      remaining: allowed ? 119 : 0,
      retryAfterSeconds: allowed ? 0 : 31,
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
    } satisfies TemporaryMediaReadUrlClient,
    rpc,
    from,
    createSignedUrl,
  };
}

describe('createTemporaryMediaReadUrl', () => {
  it('rejects missing, malformed, or unowned paths before rate-limit and storage work', async () => {
    const client = createClient();

    await expect(createTemporaryMediaReadUrl({
      body: { storagePath: 'uploads/user-2/reference.png' },
      userId: 'user-1',
      client: client.client,
    })).resolves.toEqual({
      ok: false,
      status: 403,
      error: 'Media path is not available.',
    });

    await expect(createTemporaryMediaReadUrl({
      body: { storagePath: 'uploads/user-1/../reference.png' },
      userId: 'user-1',
      client: client.client,
    })).resolves.toMatchObject({
      ok: false,
      status: 403,
    });

    for (const storagePath of [
      'uploads/user-1/%252e%252e/reference.png',
      'uploads/user-1%2fuser-2/reference.png',
      'uploads/user-1%255cuser-2/reference.png',
      'uploads/user-1//reference.png',
    ]) {
      await expect(createTemporaryMediaReadUrl({
        body: { storagePath },
        userId: 'user-1',
        client: client.client,
      })).resolves.toMatchObject({ ok: false, status: 403 });
    }

    await expect(createTemporaryMediaReadUrl({
      body: {},
      userId: 'user-1',
      client: client.client,
    })).resolves.toEqual({
      ok: false,
      status: 400,
      error: 'Media path is required.',
    });

    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.createSignedUrl).not.toHaveBeenCalled();
  });

  it('enforces read-url rate limits and creates signed URLs for owned temporary media', async () => {
    const client = createClient();

    const result = await createTemporaryMediaReadUrl({
      body: { storagePath: 'uploads/user-1/reference.png' },
      userId: 'user-1',
      client: client.client,
    });

    expect(client.rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'temporary-media-upload:read-url',
      p_subject_key: 'user-1',
      p_limit: 120,
      p_window_seconds: 600,
    });
    expect(client.from).toHaveBeenCalledWith('uploads');
    expect(client.createSignedUrl).toHaveBeenCalledWith('user-1/reference.png', 3600);
    expect(result).toEqual({
      ok: true,
      response: {
        success: true,
        signedUrl: 'https://storage.example.test/signed/reference.png',
        expiresInSeconds: 3600,
      },
    });
  });

  it('returns stable rate-limit and storage failures without leaking storage details', async () => {
    const denied = createClient({ allowed: false });

    await expect(createTemporaryMediaReadUrl({
      body: { storagePath: 'uploads/user-1/reference.png' },
      userId: 'user-1',
      client: denied.client,
    })).resolves.toMatchObject({
      ok: false,
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 31,
    });
    expect(denied.createSignedUrl).not.toHaveBeenCalled();

    const storageFailure = createClient({ storageError: new Error('storage outage') });
    await expect(createTemporaryMediaReadUrl({
      body: { storagePath: 'uploads/user-1/reference.png' },
      userId: 'user-1',
      client: storageFailure.client,
    })).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'Failed to prepare media preview.',
    });
  });
});
