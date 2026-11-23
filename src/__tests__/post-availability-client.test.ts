import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkPostAvailability } from '@/lib/post-availability-client';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('checkPostAvailability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks the live-post resolver for the post', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true, postId: 'post 1' }));

    await checkPostAvailability('post 1', { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('/api/showcase/posts/post%201/resolve', {
      cache: 'no-store',
      headers: {},
    });
  });

  it('sends the viewer token, so the answer is the server’s own rather than a CDN copy', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true, postId: 'post-1' }));

    await checkPostAvailability('post-1', { accessToken: 'token-1', fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith('/api/showcase/posts/post-1/resolve', {
      cache: 'no-store',
      headers: { Authorization: 'Bearer token-1' },
    });
  });

  it('is live when the resolver finds the post', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { success: true, postId: 'post-1' }));

    await expect(checkPostAvailability('post-1', { fetchImpl })).resolves.toBe('live');
  });

  it('is gone when the resolver answers 404: the post left public view', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'Post not found.' }));

    await expect(checkPostAvailability('post-1', { fetchImpl })).resolves.toBe('gone');
  });

  it.each([429, 500, 503])('is unknown on %i, never gone', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { error: 'nope' }));

    await expect(checkPostAvailability('post-1', { fetchImpl })).resolves.toBe('unknown');
  });

  it('is unknown when the request itself fails (offline)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(checkPostAvailability('post-1', { fetchImpl })).resolves.toBe('unknown');
  });

  it('asks once for a post while an answer is on its way, and again after it arrives', async () => {
    let answer!: (response: Response) => void;
    const fetchImpl = vi.fn(() => new Promise<Response>((resolve) => {
      answer = resolve;
    }));

    const first = checkPostAvailability('post-1', { fetchImpl });
    const second = checkPostAvailability('post-1', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    answer(jsonResponse(404, { error: 'Post not found.' }));
    await expect(first).resolves.toBe('gone');
    await expect(second).resolves.toBe('gone');

    const third = checkPostAvailability('post-1', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    answer(jsonResponse(200, { success: true, postId: 'post-1' }));
    await expect(third).resolves.toBe('live');
  });
});
