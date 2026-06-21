import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rawCreateClientMock = vi.hoisted(() => vi.fn());
const createUserClientMock = vi.hoisted(() => vi.fn());
const getUserMock = vi.fn();
const rpcMock = vi.fn();
const serviceFromMock = vi.fn();
const eventInsertMock = vi.fn();
const notifyPostSocialActivityMock = vi.fn();
const findPublicPostReferenceByIdOrGenerationIdMock = vi.fn();
const isMissingPostsSchemaErrorMock = vi.fn<(error: unknown) => boolean>(() => false);
const createServiceClientMock = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => rawCreateClientMock(...args),
}));

vi.mock('@/lib/posts-server', () => ({
  findPublicPostReferenceByIdOrGenerationId: (id: string) =>
    findPublicPostReferenceByIdOrGenerationIdMock(id),
  isMissingPostsSchemaError: (error: unknown) => isMissingPostsSchemaErrorMock(error),
}));

vi.mock('@/lib/mobile-notifications', () => ({
  notifyPostSocialActivity: (client: unknown, payload: unknown) =>
    notifyPostSocialActivityMock(client, payload),
}));

vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => createUserClientMock(request),
  createServiceClient: () => createServiceClientMock(),
}));

const missingSetPostSaveStateError = {
  code: 'PGRST202',
  details: 'Searched for the function public.set_post_save_state with parameters p_post_id, p_should_save, p_user_id.',
  hint: null,
  message: 'Could not find the function public.set_post_save_state(p_post_id, p_should_save, p_user_id) in the schema cache',
};

function publicPost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post-1',
    generation_id: 'gen-1',
    user_id: 'creator-1',
    visibility: 'public',
    category: 'image',
    prompt: 'Prompt',
    source_kind: 'magicbooklet',
    ...overrides,
  };
}

function serviceSingleResult(data: unknown, error: unknown = null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data, error });
  const eq = vi.fn(() => ({ eq, maybeSingle }));
  const select = vi.fn(() => ({ eq, maybeSingle }));

  return { select };
}

function mockLegacySaveState({
  isCurrentlySaved,
  saveCount,
}: {
  isCurrentlySaved: boolean;
  saveCount: number;
}) {
  serviceFromMock.mockImplementation((table: string) => {
    if (table === 'post_save_events') {
      return { insert: eventInsertMock };
    }

    if (table === 'post_saves') {
      return serviceSingleResult(isCurrentlySaved ? { id: 'save-1' } : null);
    }

    if (table === 'posts') {
      return serviceSingleResult({ save_count: saveCount });
    }

    throw new Error(`Unexpected table: ${table}`);
  });
}

function saveRpcResult({
  isSaved,
  saveCount,
  changed,
}: {
  isSaved: boolean;
  saveCount: number;
  changed: boolean;
}) {
  return {
    data: [{
      is_saved: isSaved,
      save_count: saveCount,
      changed,
    }],
    error: null,
  };
}

async function postSave(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/showcase/save/route');
  return POST(
    new Request('http://localhost/api/showcase/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify(body),
    }) as never
  );
}

describe('/api/showcase/save route', () => {
  beforeEach(() => {
    vi.resetModules();
    getUserMock.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    const userClient = {
      auth: {
        getUser: getUserMock,
      },
    };
    rawCreateClientMock.mockReset();
    rawCreateClientMock.mockReturnValue(userClient);
    createUserClientMock.mockReset();
    createUserClientMock.mockReturnValue(userClient);
    rpcMock.mockReset();
    eventInsertMock.mockReset();
    notifyPostSocialActivityMock.mockReset();
    findPublicPostReferenceByIdOrGenerationIdMock.mockReset();
    isMissingPostsSchemaErrorMock.mockReturnValue(false);
    createServiceClientMock.mockReset();
    serviceFromMock.mockReset();
    serviceFromMock.mockImplementation((table: string) => {
      if (table !== 'post_save_events') {
        throw new Error(`Unexpected table: ${table}`);
      }
      return { insert: eventInsertMock };
    });
    createServiceClientMock.mockReturnValue({ from: serviceFromMock, rpc: rpcMock });
    eventInsertMock.mockResolvedValue({ data: null, error: null });
    findPublicPostReferenceByIdOrGenerationIdMock.mockResolvedValue(publicPost());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('idempotently saves a post, records analytics, and notifies only when state changes to saved', async () => {
    rpcMock.mockResolvedValueOnce(saveRpcResult({ isSaved: true, saveCount: 5, changed: true }));

    const response = await postSave({
      postId: 'post-1',
      shouldSave: true,
      sourceSurface: 'showcase',
    });

    await expect(response.json()).resolves.toEqual({
      success: true,
      isSaved: true,
      saveCount: 5,
      changed: true,
      message: 'Saved to bookmarks',
    });
    expect(response.status).toBe(200);
    expect(createUserClientMock).toHaveBeenCalledTimes(1);
    expect(rawCreateClientMock).not.toHaveBeenCalled();
    expect(rpcMock).toHaveBeenCalledWith('set_post_save_state', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
      p_should_save: true,
    });
    expect(createServiceClientMock).toHaveBeenCalledTimes(1);
    expect(eventInsertMock).toHaveBeenCalledWith({
      user_id: 'user-1',
      post_id: 'post-1',
      requested_state: true,
      result_state: true,
      changed: true,
      source_surface: 'showcase',
    });
    expect(notifyPostSocialActivityMock).toHaveBeenCalledWith(expect.anything(), {
      type: 'post_saved',
      recipientUserId: 'creator-1',
      actorUserId: 'user-1',
      postId: 'post-1',
    });
  });

  it('does not notify when saving an already saved post is a no-op', async () => {
    rpcMock.mockResolvedValueOnce(saveRpcResult({ isSaved: true, saveCount: 5, changed: false }));

    const response = await postSave({
      postId: 'post-1',
      shouldSave: true,
      sourceSurface: 'mobile-viewer',
    });

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      isSaved: true,
      saveCount: 5,
      changed: false,
    });
    expect(eventInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      requested_state: true,
      result_state: true,
      changed: false,
      source_surface: 'mobile-viewer',
    }));
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });

  it('idempotently unsaves without notifying creators', async () => {
    rpcMock.mockResolvedValueOnce(saveRpcResult({ isSaved: false, saveCount: 4, changed: true }));

    const response = await postSave({
      postId: 'post-1',
      shouldSave: false,
      sourceSurface: 'showcase-reel',
    });

    await expect(response.json()).resolves.toEqual({
      success: true,
      isSaved: false,
      saveCount: 4,
      changed: true,
      message: 'Removed from bookmarks',
    });
    expect(eventInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      requested_state: false,
      result_state: false,
      changed: true,
      source_surface: 'showcase-reel',
    }));
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });

  it('supports generation id lookup with the idempotent contract', async () => {
    rpcMock.mockResolvedValueOnce(saveRpcResult({ isSaved: true, saveCount: 9, changed: false }));

    const response = await postSave({
      generationId: 'gen-1',
      shouldSave: true,
      sourceSurface: 'legacy-client',
    });

    expect(response.status).toBe(200);
    expect(findPublicPostReferenceByIdOrGenerationIdMock).toHaveBeenCalledWith('gen-1');
    expect(rpcMock).toHaveBeenCalledWith('set_post_save_state', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
      p_should_save: true,
    });
  });

  it('falls back to a no-op save when set_post_save_state is missing and the post is already saved', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: missingSetPostSaveStateError });
    mockLegacySaveState({ isCurrentlySaved: true, saveCount: 12 });

    const response = await postSave({
      postId: 'post-1',
      shouldSave: true,
      sourceSurface: 'mobile-viewer',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      isSaved: true,
      saveCount: 12,
      changed: false,
      message: 'Saved to bookmarks',
    });
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(eventInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      requested_state: true,
      result_state: true,
      changed: false,
    }));
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });

  it('falls back to toggle_post_save once when set_post_save_state is missing and save needs to change state', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: missingSetPostSaveStateError })
      .mockResolvedValueOnce({ data: true, error: null });
    mockLegacySaveState({ isCurrentlySaved: false, saveCount: 13 });

    const response = await postSave({
      postId: 'post-1',
      shouldSave: true,
      sourceSurface: 'mobile-viewer',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      isSaved: true,
      saveCount: 13,
      changed: true,
      message: 'Saved to bookmarks',
    });
    expect(rpcMock).toHaveBeenLastCalledWith('toggle_post_save', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
    });
    expect(eventInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      requested_state: true,
      result_state: true,
      changed: true,
    }));
    expect(notifyPostSocialActivityMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      type: 'post_saved',
      postId: 'post-1',
    }));
  });

  it('falls back to toggle_post_save once when set_post_save_state is missing and unsave needs to change state', async () => {
    rpcMock
      .mockResolvedValueOnce({ data: null, error: missingSetPostSaveStateError })
      .mockResolvedValueOnce({ data: false, error: null });
    mockLegacySaveState({ isCurrentlySaved: true, saveCount: 4 });

    const response = await postSave({
      postId: 'post-1',
      shouldSave: false,
      sourceSurface: 'mobile-viewer',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      isSaved: false,
      saveCount: 4,
      changed: true,
      message: 'Removed from bookmarks',
    });
    expect(rpcMock).toHaveBeenLastCalledWith('toggle_post_save', {
      p_post_id: 'post-1',
      p_user_id: 'user-1',
    });
    expect(eventInsertMock).toHaveBeenCalledWith(expect.objectContaining({
      requested_state: false,
      result_state: false,
      changed: true,
    }));
    expect(notifyPostSocialActivityMock).not.toHaveBeenCalled();
  });
});
