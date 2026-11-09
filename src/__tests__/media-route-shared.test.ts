import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(() => [{ name: 'sb-project-auth-token', value: 'cookie-session' }]),
  getClaims: vi.fn(),
  createServerClient: vi.fn(),
  createUserClient: vi.fn(),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ getAll: mocks.getAll })),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: (...args: unknown[]) => mocks.createServerClient(...args),
}));
vi.mock('@/lib/server-helpers', () => ({
  createUserClient: (request: Request) => mocks.createUserClient(request),
}));

import { createMediaSupabaseClient } from '@/lib/media-route-shared';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const cookieClient = { tag: 'cookie', auth: { getClaims: mocks.getClaims } };
const userClient = { tag: 'user' };

function sessionClaims(extra: Record<string, unknown> = {}) {
  return { data: { claims: { sub: USER_ID, role: 'authenticated', is_anonymous: false, ...extra } }, error: null };
}

/**
 * The media routes (`/api/media/*`, a post's media, the NSFW reveal) take a browser's cookie
 * session when a request carries no bearer token. An agent's OAuth-issued token (agent-token.ts)
 * is a valid user token, so put in that cookie it would be served as the creator; it drives
 * /api/mcp alone, and here it is nobody.
 */
describe('createMediaSupabaseClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockReturnValue(cookieClient);
    mocks.createUserClient.mockReturnValue(userClient);
  });

  it('hands a bearer request to the user client without reading cookies', async () => {
    const request = new Request('https://magicbooklet.test/api/media/x', { headers: { Authorization: 'Bearer app-token' } });
    expect(await createMediaSupabaseClient(request)).toBe(userClient);
    expect(mocks.createUserClient).toHaveBeenCalledWith(request);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
    expect(mocks.getClaims).not.toHaveBeenCalled();
  });

  it("hands a browser's cookie session to the cookie client", async () => {
    mocks.getClaims.mockResolvedValue(sessionClaims());
    const request = new Request('https://magicbooklet.test/api/media/x');
    expect(await createMediaSupabaseClient(request)).toBe(cookieClient);
    expect(mocks.getClaims).toHaveBeenCalledTimes(1);
    expect(mocks.createUserClient).not.toHaveBeenCalled();
  });

  it("refuses an agent's token in the auth cookie: the request is served as one with no session", async () => {
    mocks.getClaims.mockResolvedValue(sessionClaims({ client_id: 'client-claude' }));
    const request = new Request('https://magicbooklet.test/api/media/x');
    expect(await createMediaSupabaseClient(request)).toBe(userClient);
    // The anon client, built from a request with no Authorization header: no cookie is read, so
    // requireIdentity finds no user and answers 401.
    expect(mocks.createUserClient).toHaveBeenCalledTimes(1);
    const [handed] = mocks.createUserClient.mock.calls[0] as [Request];
    expect(handed).toBe(request);
    expect(handed.headers.get('Authorization')).toBeNull();
  });

  it('keeps the cookie client when there is no session to read, or the read throws', async () => {
    mocks.getClaims.mockResolvedValueOnce({ data: null, error: { message: 'no session' } });
    expect(await createMediaSupabaseClient(new Request('https://magicbooklet.test/api/media/x'))).toBe(cookieClient);
    mocks.getClaims.mockRejectedValueOnce(new Error('network'));
    expect(await createMediaSupabaseClient(new Request('https://magicbooklet.test/api/media/x'))).toBe(cookieClient);
    expect(mocks.createUserClient).not.toHaveBeenCalled();
  });
});
