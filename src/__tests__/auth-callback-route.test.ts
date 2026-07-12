import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAuthRouteClient: vi.fn(),
  resolveServerPostAuthPath: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  finalizePendingReferralForAuth: vi.fn(),
  clearReferralVisitCookie: vi.fn(),
}));

vi.mock('@/lib/auth-onboarding-server', () => ({
  createAuthRouteClient: () => mocks.createAuthRouteClient(),
  resolveServerPostAuthPath: (...args: unknown[]) => mocks.resolveServerPostAuthPath(...args),
}));

vi.mock('@/lib/referral-route-service', () => ({
  finalizePendingReferralForAuth: (...args: unknown[]) => mocks.finalizePendingReferralForAuth(...args),
  clearReferralVisitCookie: (...args: unknown[]) => mocks.clearReferralVisitCookie(...args),
}));

describe('/auth/callback', () => {
  beforeEach(() => {
    mocks.createAuthRouteClient.mockReset();
    mocks.resolveServerPostAuthPath.mockReset();
    mocks.exchangeCodeForSession.mockReset();
    mocks.getUser.mockReset();
    mocks.finalizePendingReferralForAuth.mockReset();
    mocks.finalizePendingReferralForAuth.mockResolvedValue(false);
    mocks.clearReferralVisitCookie.mockReset();
    mocks.createAuthRouteClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mocks.exchangeCodeForSession,
        getUser: mocks.getUser,
      },
    });
    mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mocks.resolveServerPostAuthPath.mockResolvedValue('/create/video?model=kling');
  });

  it('checks profile readiness on the server before honoring the requested route', async () => {
    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate%2Fvideo%3Fmodel%3Dkling'
    ));

    expect(mocks.exchangeCodeForSession).toHaveBeenCalledWith('auth-code');
    expect(mocks.getUser).toHaveBeenCalled();
    expect(mocks.finalizePendingReferralForAuth).toHaveBeenCalledWith(expect.any(Request), 'user-1');
    expect(mocks.resolveServerPostAuthPath).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.any(Object) }),
      'user-1',
      '/create/video?model=kling',
      { skipProfileOnboarding: false }
    );
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/create/video?model=kling'
    );
  });

  it('clears a finalized referral cookie without changing the auth destination', async () => {
    mocks.finalizePendingReferralForAuth.mockResolvedValue(true);
    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate'
    ));

    expect(response.headers.get('location')).toBe('https://magicbooklet.com/create/video?model=kling');
    expect(mocks.clearReferralVisitCookie).toHaveBeenCalledWith(response, true);
  });

  it('preserves the safe next path when the auth code is expired', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: new Error('expired') });

    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/callback?code=expired&next=%2Fcreate%2Fimage'
    ));

    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.resolveServerPostAuthPath).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/auth/auth-code-error?next=%2Fcreate%2Fimage'
    );
  });

  it('does not create an auth client for a missing code and rejects unsafe intent', async () => {
    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/callback?next=https%3A%2F%2Fattacker.example'
    ));

    expect(mocks.createAuthRouteClient).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/auth/auth-code-error?next=%2Fcreate'
    );
  });
});

describe('/auth/continue', () => {
  beforeEach(() => {
    mocks.createAuthRouteClient.mockReset();
    mocks.resolveServerPostAuthPath.mockReset();
    mocks.getUser.mockReset();
    mocks.finalizePendingReferralForAuth.mockReset();
    mocks.finalizePendingReferralForAuth.mockResolvedValue(false);
    mocks.clearReferralVisitCookie.mockReset();
    mocks.createAuthRouteClient.mockResolvedValue({
      auth: { getUser: mocks.getUser },
    });
    mocks.getUser.mockResolvedValue({
      data: { user: { id: 'user-1' } },
      error: null,
    });
    mocks.resolveServerPostAuthPath.mockResolvedValue(
      '/profile?welcome=1&next=%2Fcreate'
    );
  });

  it('applies the same server-side readiness gate after password sign-in', async () => {
    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/continue?next=%2Fcreate'
    ));

    expect(mocks.resolveServerPostAuthPath).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.any(Object) }),
      'user-1',
      '/create',
      { skipProfileOnboarding: false }
    );
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/profile?welcome=1&next=%2Fcreate'
    );
  });
});
