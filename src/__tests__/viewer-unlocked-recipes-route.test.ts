import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({ getVerifiedAuthUserResult: vi.fn() }));
vi.mock('@/lib/server-auth-user', () => ({ getVerifiedAuthUserResult: authMocks.getVerifiedAuthUserResult }));

import {
  VIEWER_UNLOCKED_RECIPE_IDS_LIMIT,
  createViewerUnlockedRecipesRouteHandlers,
  listViewerUnlockedRecipeIds,
} from '@/lib/viewer-unlocked-recipes-route-adapter-service';

function purchasesTable(rows: Array<{ bundle_id: string }> | null, error: { message: string } | null = null) {
  const calls: Record<string, unknown[]> = {};
  const query = {
    select: vi.fn((columns: string) => { calls.select = [columns]; return query; }),
    eq: vi.fn((column: string, value: string) => { calls.eq = [column, value]; return query; }),
    limit: vi.fn(async (count: number) => { calls.limit = [count]; return { data: rows, error }; }),
  };
  return { client: { from: vi.fn(() => query) } as never, calls };
}

describe('the ids of the recipes a viewer has', () => {
  it('reads the purchases by buyer, deduplicated and capped', async () => {
    const { client, calls } = purchasesTable([{ bundle_id: 'b1' }, { bundle_id: 'b2' }, { bundle_id: 'b1' }]);
    await expect(listViewerUnlockedRecipeIds({ adminSupabase: client, viewerUserId: 'buyer-1' })).resolves.toEqual(['b1', 'b2']);
    expect(calls.eq).toEqual(['buyer_user_id', 'buyer-1']);
    expect(calls.limit).toEqual([VIEWER_UNLOCKED_RECIPE_IDS_LIMIT]);
  });

  it('throws what the read failed with', async () => {
    const { client } = purchasesTable(null, { message: 'down' });
    await expect(listViewerUnlockedRecipeIds({ adminSupabase: client, viewerUserId: 'buyer-1' })).rejects.toMatchObject({ message: 'down' });
  });
});

describe('GET /api/me/unlocked-recipes', () => {
  beforeEach(() => authMocks.getVerifiedAuthUserResult.mockReset());

  function handlers(listIds = vi.fn(async () => ['b1'])) {
    const logError = vi.fn();
    const { GET } = createViewerUnlockedRecipesRouteHandlers({
      dependencies: {
        createUserClient: () => ({ user: true }) as never,
        createServiceClient: () => ({ service: true }) as never,
        listViewerUnlockedRecipeIds: listIds,
        logError,
      },
    });
    return { GET, listIds, logError };
  }

  it('answers a signed-out request 401 and asks nothing of the database', async () => {
    authMocks.getVerifiedAuthUserResult.mockResolvedValue({ data: { user: null }, error: null });
    const { GET, listIds } = handlers();
    const response = await GET(new Request('https://magicbooklet.com/api/me/unlocked-recipes'));
    expect(response.status).toBe(401);
    expect(listIds).not.toHaveBeenCalled();
  });

  it("answers the caller's own ids, private and never cached", async () => {
    authMocks.getVerifiedAuthUserResult.mockResolvedValue({ data: { user: { id: 'buyer-1' } }, error: null });
    const { GET, listIds } = handlers();
    const response = await GET(new Request('https://magicbooklet.com/api/me/unlocked-recipes'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, bundleIds: ['b1'] });
    expect(response.headers.get('cache-control')).toMatch(/private/);
    expect(response.headers.get('cache-control')).toMatch(/no-store/);
    expect(listIds).toHaveBeenCalledWith(expect.objectContaining({ viewerUserId: 'buyer-1' }));
  });

  it('answers 500 and logs when the read fails', async () => {
    authMocks.getVerifiedAuthUserResult.mockResolvedValue({ data: { user: { id: 'buyer-1' } }, error: null });
    const { GET, logError } = handlers(vi.fn(async () => { throw new Error('down'); }));
    const response = await GET(new Request('https://magicbooklet.com/api/me/unlocked-recipes'));
    expect(response.status).toBe(500);
    expect(logError).toHaveBeenCalled();
  });
});
