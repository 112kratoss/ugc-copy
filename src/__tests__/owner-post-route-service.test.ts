import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deleteOwnerPostRoute,
  getOwnerPostDetailForRoute,
  updateOwnerPostRoute,
} from '@/lib/owner-post-route-service';

describe('owner post route service', () => {
  const createUserClient = vi.fn();
  const createServiceClient = vi.fn();
  const getOwnerPostDetail = vi.fn();
  const updateOwnerPostForRoute = vi.fn();
  const deleteOwnerPostForRoute = vi.fn();
  const adminSupabase = { service: 'supabase-admin' };

  beforeEach(() => {
    createUserClient.mockReset();
    createUserClient.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: { id: 'user-1' } },
          error: null,
        })),
      },
    });
    createServiceClient.mockReset();
    createServiceClient.mockReturnValue(adminSupabase);
    getOwnerPostDetail.mockReset();
    getOwnerPostDetail.mockResolvedValue({ id: 'post-1', title: 'Draft post' });
    updateOwnerPostForRoute.mockReset();
    updateOwnerPostForRoute.mockResolvedValue({
      ok: true,
      body: {
        success: true,
        postId: 'post-1',
        visibility: 'private',
        showcasePath: null,
        ownerPath: '/post/post-1/edit',
        resourceBundlePath: '/post/post-1/edit#resources',
        resourceBundleStatus: null,
      },
    });
    deleteOwnerPostForRoute.mockReset();
    deleteOwnerPostForRoute.mockResolvedValue({
      ok: true,
      body: { success: true, deleted: true },
    });
  });

  it('loads owner post detail with the viewer country after authenticating the request', async () => {
    const request = new Request('http://localhost/api/posts/post-1', {
      headers: {
        Authorization: 'Bearer token',
        'x-vercel-ip-country': 'IN',
      },
    });

    const result = await getOwnerPostDetailForRoute({
      request,
      postId: 'post-1',
      dependencies: {
        createUserClient,
        getOwnerPostDetail,
      },
    });

    expect(result).toEqual({
      ok: true,
      body: {
        success: true,
        post: { id: 'post-1', title: 'Draft post' },
      },
    });
    expect(getOwnerPostDetail).toHaveBeenCalledWith('post-1', 'user-1', {
      countryCode: 'IN',
    });
    expect(createServiceClient).not.toHaveBeenCalled();
  });

  it('updates an owner post by parsing JSON and delegating to the update service', async () => {
    const request = new Request('http://localhost/api/posts/post-1', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Updated title',
        visibility: 'private',
      }),
    });

    const result = await updateOwnerPostRoute({
      request,
      postId: 'post-1',
      dependencies: {
        createUserClient,
        createServiceClient,
        updateOwnerPostForRoute,
      },
    });

    expect(result.ok).toBe(true);
    expect(createServiceClient).toHaveBeenCalledTimes(1);
    expect(updateOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase,
      ownerUserId: 'user-1',
      postId: 'post-1',
      body: {
        title: 'Updated title',
        visibility: 'private',
      },
    });
  });

  it('deletes without reading JSON when the request has no body', async () => {
    const request = new Request('http://localhost/api/posts/post-1', {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token' },
    });

    const result = await deleteOwnerPostRoute({
      request,
      postId: 'post-1',
      dependencies: {
        createUserClient,
        createServiceClient,
        deleteOwnerPostForRoute,
      },
    });

    expect(result).toEqual({
      ok: true,
      body: { success: true, deleted: true },
    });
    expect(deleteOwnerPostForRoute).toHaveBeenCalledWith({
      adminSupabase,
      ownerUserId: 'user-1',
      postId: 'post-1',
      forceDelete: false,
    });
  });

  it('rejects unauthenticated mutations before creating a privileged client', async () => {
    createUserClient.mockReturnValueOnce({
      auth: {
        getUser: vi.fn(async () => ({
          data: { user: null },
          error: { message: 'invalid token' },
        })),
      },
    });

    const result = await updateOwnerPostRoute({
      request: new Request('http://localhost/api/posts/post-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Ignored' }),
      }),
      postId: 'post-1',
      dependencies: {
        createUserClient,
        createServiceClient,
        updateOwnerPostForRoute,
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      body: { error: 'Unauthorized' },
    });
    expect(createServiceClient).not.toHaveBeenCalled();
    expect(updateOwnerPostForRoute).not.toHaveBeenCalled();
  });
});
