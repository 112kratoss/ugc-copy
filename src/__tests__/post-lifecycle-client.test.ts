import { describe, expect, it, vi } from 'vitest';

import {
  PostLifecycleRequestError,
  requestPostArchive,
  requestPostDelete,
  requestPostRestore,
  requestPostVisibilityChange,
} from '@/lib/post-lifecycle-client';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('post lifecycle client', () => {
  // Every post goes through the post route, the same door the mobile app
  // uses; the route itself moves a creation's media between its public and
  // private copies. Splitting by post kind is what let the two clients
  // disagree.
  it('sends a generation-backed visibility change through the post route', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      success: true,
      visibility: 'unlisted',
      ownerPath: '/post/post-1/edit',
      showcasePath: '/showcase/post-1',
      resourceBundleStatus: 'draft',
    }));

    const result = await requestPostVisibilityChange({
      post: { id: 'post-1', generationId: 'gen-1' },
      visibility: 'unlisted',
      accessToken: 'token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/posts/post-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ visibility: 'unlisted' }),
    });
    expect(result).toEqual({
      visibility: 'unlisted',
      ownerPath: '/post/post-1/edit',
      showcasePath: '/showcase/post-1',
      resourceBundleStatus: 'draft',
    });
  });

  it('sends an uploaded post visibility change through the post route', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, visibility: 'public' }));

    const result = await requestPostVisibilityChange({
      post: { id: 'post-2', generationId: null },
      visibility: 'public',
      accessToken: 'token',
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('/api/posts/post-2', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(result).toEqual({
      visibility: 'public',
      ownerPath: null,
      showcasePath: null,
      resourceBundleStatus: null,
    });
  });

  it('surfaces the server message and status when a change is refused', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { success: false, error: 'Complete your profile before publishing publicly.', code: 'PROFILE_INCOMPLETE' },
      400,
    ));

    await expect(requestPostVisibilityChange({
      post: { id: 'post-2', generationId: null },
      visibility: 'public',
      accessToken: 'token',
      fetchImpl,
    })).rejects.toMatchObject({
      name: 'PostLifecycleRequestError',
      message: 'Complete your profile before publishing publicly.',
      status: 400,
      code: 'PROFILE_INCOMPLETE',
    });
  });

  it('falls back to a generic message when the error body is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));

    await expect(requestPostArchive({ postId: 'post-1', accessToken: 'token', fetchImpl }))
      .rejects.toEqual(new PostLifecycleRequestError('Failed to archive post.', { status: 502 }));
  });

  it('posts archive and restore without a body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true }));

    await requestPostArchive({ postId: 'post-1', accessToken: 'token', fetchImpl });
    await requestPostRestore({ postId: 'post-1', accessToken: 'token', fetchImpl });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/posts/post-1/archive', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/posts/post-1/restore', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });
  });

  it('reports a sold post as needing a forced delete instead of throwing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(
      { error: 'This post has paid recipe purchases.', requiresForceDelete: true },
      409,
    ));

    await expect(requestPostDelete({ postId: 'post-1', accessToken: 'token', fetchImpl }))
      .resolves.toEqual({ deleted: false, requiresForceDelete: true });
    expect(fetchImpl).toHaveBeenCalledWith('/api/posts/post-1', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ force: false }),
    }));
  });

  it('passes force through and reports a tombstoned delete', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, deleted: true, tombstoned: true }));

    await expect(requestPostDelete({ postId: 'post-1', accessToken: 'token', force: true, fetchImpl }))
      .resolves.toEqual({ deleted: true, tombstoned: true });
    expect(fetchImpl).toHaveBeenCalledWith('/api/posts/post-1', expect.objectContaining({
      body: JSON.stringify({ force: true }),
    }));
  });
});
