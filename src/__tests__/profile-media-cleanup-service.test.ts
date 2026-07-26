import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cleanupProfileMedia,
  type ProfileMediaCleanupClient,
} from '@/lib/profile-media-cleanup-service';

const rateLimitAllowed = {
  allowed: true,
  limit: 30,
  remaining: 29,
  retryAfterSeconds: 0,
  resetAt: '2026-06-23T04:00:00.000Z',
};

function createClient(overrides?: {
  rpcResult?: unknown;
  storageError?: { message: string } | Error | null;
}) {
  const rpc = vi.fn(async () => ({
    data: overrides?.rpcResult ?? rateLimitAllowed,
    error: null,
  }));
  const remove = vi.fn(async () => ({ error: overrides?.storageError ?? null }));
  const from = vi.fn(() => ({ remove }));

  return {
    client: {
      rpc,
      storage: { from },
    } satisfies ProfileMediaCleanupClient,
    rpc,
    from,
    remove,
  };
}

describe('cleanupProfileMedia', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid cleanup payloads before privileged client work', async () => {
    const createAdminClient = vi.fn(() => createClient().client);

    const result = await cleanupProfileMedia({
      body: { paths: [] },
      userId: 'user-1',
      client: createAdminClient,
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      body: { error: 'Invalid profile media cleanup request.' },
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('rejects cleanup paths outside the authenticated user folder before privileged client work', async () => {
    const createAdminClient = vi.fn(() => createClient().client);

    const result = await cleanupProfileMedia({
      body: {
        paths: [
          'user-1/avatar.png',
          'user-2/cover.png',
        ],
      },
      userId: 'user-1',
      client: createAdminClient,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: 'Invalid profile media cleanup request.' },
    });
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it('removes validated profile media paths after enforcing the cleanup rate limit', async () => {
    const { client, rpc, from, remove } = createClient();

    const result = await cleanupProfileMedia({
      body: {
        paths: [
          'user-1/avatar-server-issued.png',
          'user-1/cover-server-issued.png',
        ],
      },
      userId: 'user-1',
      client,
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true },
    });
    expect(rpc).toHaveBeenCalledWith('check_backend_rate_limit', {
      p_scope: 'profile-media-upload:cleanup',
      p_subject_key: 'user-1',
      p_limit: 30,
      p_window_seconds: 600,
    });
    expect(from).toHaveBeenCalledWith('profiles');
    expect(remove).toHaveBeenCalledWith([
      'user-1/avatar-server-issued.png',
      'user-1/cover-server-issued.png',
    ]);
  });

  it('returns a route-ready rate-limit result when cleanup is throttled', async () => {
    const { client, remove } = createClient({
      rpcResult: {
        allowed: false,
        limit: 30,
        remaining: 0,
        retryAfterSeconds: 42,
        resetAt: '2026-06-23T04:10:00.000Z',
      },
    });

    const result = await cleanupProfileMedia({
      body: { paths: ['user-1/avatar.png'] },
      userId: 'user-1',
      client,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 429,
      body: {
        code: 'RATE_LIMITED',
        retryAfterSeconds: 42,
        limit: 30,
        resetAt: '2026-06-23T04:10:00.000Z',
      },
    });
    if (result.ok) throw new Error('Expected a rate-limit error');
    expect(result.rateLimitError?.retryAfterSeconds).toBe(42);
    expect(remove).not.toHaveBeenCalled();
  });

  it('maps storage removal failures without exposing bucket internals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = createClient({ storageError: new Error('storage denied') });

    const result = await cleanupProfileMedia({
      body: { paths: ['user-1/avatar.png'] },
      userId: 'user-1',
      client,
    });

    expect(result).toEqual({
      ok: false,
      status: 500,
      body: { error: 'Failed to clean up profile media.' },
    });
  });
});
