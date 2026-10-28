import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAuthRouteClient: vi.fn(),
  resolveServerPostAuthPath: vi.fn(),
  exchangeCodeForSession: vi.fn(),
  getUser: vi.fn(),
  getSession: vi.fn(),
  claimReferralForUser: vi.fn(),
  clearReferralVisitCookie: vi.fn(),
  postOnboardingEventRouteResponse: vi.fn(),
  after: vi.fn(),
  logBackendError: vi.fn(),
}));

vi.mock('@/lib/auth-onboarding-server', () => ({
  createAuthRouteClient: () => mocks.createAuthRouteClient(),
  resolveServerPostAuthPath: (...args: unknown[]) => mocks.resolveServerPostAuthPath(...args),
}));

vi.mock('@/lib/referral-route-service', () => ({
  claimReferralForUser: (...args: unknown[]) => mocks.claimReferralForUser(...args),
  clearReferralVisitCookie: (...args: unknown[]) => mocks.clearReferralVisitCookie(...args),
}));

vi.mock('@/lib/server-helpers', () => ({
  createServiceClient: () => ({ service: true }),
}));

vi.mock('@/lib/onboarding-route-adapter-service', () => ({
  postOnboardingEventRouteResponse: (...args: unknown[]) => mocks.postOnboardingEventRouteResponse(...args),
}));

vi.mock('@/lib/backend-logger', () => ({
  logBackendError: (...args: unknown[]) => mocks.logBackendError(...args),
  logBackendWarning: vi.fn(),
}));

vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: mocks.after };
});

const VISIT_TOKEN = '0b5f0f8e-6a3c-4c4e-9d1a-2f3b4c5d6e7f';
const NEW_ACCOUNT_DESTINATION = '/profile?welcome=1&next=%2Fwelcome-reward%3Fnext%3D%252Fcreate';

function withVisitCookie(url: string) {
  return new Request(url, { headers: { cookie: `theme=dark; mb_referral_visit=${VISIT_TOKEN}` } });
}

function locationOf(response: Response) {
  return new URL(response.headers.get('location') ?? '');
}

// The welcome-reward page a new account reaches after its profile step.
function nestedWelcomeRewardUrl(response: Response) {
  return new URL(locationOf(response).searchParams.get('next') ?? '', 'https://magicbooklet.com');
}

async function recordedAuthEvent() {
  expect(mocks.after).toHaveBeenCalledTimes(1);
  await (mocks.after.mock.calls[0]?.[0] as () => Promise<unknown>)();
  expect(mocks.postOnboardingEventRouteResponse).toHaveBeenCalledTimes(1);
  const { request } = mocks.postOnboardingEventRouteResponse.mock.calls[0]?.[0] as { request: Request };
  return { request, body: await request.json() as Record<string, unknown> };
}

function resetMocks() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getUser.mockResolvedValue({
    data: { user: { id: 'user-1', user_metadata: {} } },
    error: null,
  });
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'session-access-token' } } });
  mocks.exchangeCodeForSession.mockResolvedValue({ error: null });
  mocks.claimReferralForUser.mockResolvedValue({ claimed: true, clearCookie: true });
  mocks.postOnboardingEventRouteResponse.mockResolvedValue(new Response('{}'));
}

describe('/auth/callback', () => {
  beforeEach(() => {
    resetMocks();
    mocks.createAuthRouteClient.mockResolvedValue({
      auth: {
        exchangeCodeForSession: mocks.exchangeCodeForSession,
        getUser: mocks.getUser,
        getSession: mocks.getSession,
      },
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
    // No invite was opened in this browser, so nothing is claimed.
    expect(mocks.claimReferralForUser).not.toHaveBeenCalled();
    expect(mocks.resolveServerPostAuthPath).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.any(Object) }),
      'user-1',
      '/create/video?model=kling',
      { skipProfileOnboarding: false }
    );
    expect(response.headers.get('location')).toBe(
      'https://magicbooklet.com/create/video?model=kling'
    );
    expect(mocks.clearReferralVisitCookie).not.toHaveBeenCalled();
  });

  it('clears a claimed invite and drops its status when the destination cannot show it', async () => {
    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate'
    ));

    expect(mocks.claimReferralForUser).toHaveBeenCalledWith({
      adminSupabase: { service: true },
      userId: 'user-1',
      visitToken: VISIT_TOKEN,
    });
    expect(response.headers.get('location')).toBe('https://magicbooklet.com/create/video?model=kling');
    expect(mocks.clearReferralVisitCookie).toHaveBeenCalledWith(response, true);
  });

  it('tells a new account its invite was applied on the welcome-reward page after its profile step', async () => {
    mocks.resolveServerPostAuthPath.mockResolvedValue(NEW_ACCOUNT_DESTINATION);

    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate'
    ));

    const location = locationOf(response);
    expect(location.pathname).toBe('/profile');
    expect(location.searchParams.get('welcome')).toBe('1');
    // The profile page forwards its `next` untouched, so the status rides inside it.
    expect(location.searchParams.get('referral')).toBeNull();
    const welcomeReward = nestedWelcomeRewardUrl(response);
    expect(welcomeReward.pathname).toBe('/welcome-reward');
    expect(welcomeReward.searchParams.get('next')).toBe('/create');
    expect(welcomeReward.searchParams.get('referral')).toBe('applied');
    expect(mocks.clearReferralVisitCookie).toHaveBeenCalledWith(response, true);
  });

  it('tells an account back at the creator its sign-up started from how its invite went', async () => {
    mocks.resolveServerPostAuthPath.mockResolvedValue('/create-video?prompt=boat&welcome=1');

    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate-video%3Fprompt%3Dboat'
    ));

    const location = locationOf(response);
    expect(location.pathname).toBe('/create-video');
    expect(location.searchParams.get('prompt')).toBe('boat');
    expect(location.searchParams.get('welcome')).toBe('1');
    expect(location.searchParams.get('referral')).toBe('applied');
  });

  it('drops the invite status on a creator that has nobody to greet', async () => {
    mocks.resolveServerPostAuthPath.mockResolvedValue('/create-video?prompt=boat');

    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate-video%3Fprompt%3Dboat'
    ));

    expect(response.headers.get('location')).toBe('https://magicbooklet.com/create-video?prompt=boat');
  });

  it('carries the reason an invite was refused', async () => {
    mocks.claimReferralForUser.mockResolvedValue({ claimed: false, clearCookie: true, reason: 'existing_account' });
    mocks.resolveServerPostAuthPath.mockResolvedValue('/welcome-reward?next=%2Fcreate');

    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate'
    ));

    const location = locationOf(response);
    expect(location.pathname).toBe('/welcome-reward');
    expect(location.searchParams.get('next')).toBe('/create');
    expect(location.searchParams.get('referral')).toBe('existing_account');
    expect(mocks.clearReferralVisitCookie).toHaveBeenCalledWith(response, true);
  });

  it('keeps the invite for the next sign-in, and says nothing, when the claim cannot conclude', async () => {
    mocks.resolveServerPostAuthPath.mockResolvedValue(NEW_ACCOUNT_DESTINATION);
    const { GET } = await import('@/app/auth/callback/route');

    // The profile row is not there yet.
    mocks.claimReferralForUser.mockResolvedValueOnce({ claimed: false, clearCookie: false, reason: 'profile_not_found' });
    const deferred = await GET(withVisitCookie('https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate'));
    expect(deferred.headers.get('location')).toBe(`https://magicbooklet.com${NEW_ACCOUNT_DESTINATION}`);

    // Attribution is down: the sign-in still lands where it was going.
    mocks.claimReferralForUser.mockRejectedValueOnce(new Error('rpc unavailable'));
    const failed = await GET(withVisitCookie('https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate'));
    expect(failed.headers.get('location')).toBe(`https://magicbooklet.com${NEW_ACCOUNT_DESTINATION}`);
    expect(mocks.logBackendError).toHaveBeenCalledWith('post_auth_referral_finalization_deferred', {
      error: expect.any(Error),
    });

    expect(mocks.clearReferralVisitCookie).not.toHaveBeenCalled();
  });

  it('counts a provider or email-link sign-in as auth_succeeded', async () => {
    const { GET } = await import('@/app/auth/callback/route');
    await GET(new Request('https://magicbooklet.com/auth/callback?code=auth-code&next=%2Fcreate%2Fvideo%3Fmodel%3Dkling'));

    const { body } = await recordedAuthEvent();
    expect(body).toMatchObject({ eventName: 'auth_succeeded', platform: 'web', step: '/create/video' });
  });

  it('preserves the safe next path when the auth code is expired', async () => {
    mocks.exchangeCodeForSession.mockResolvedValue({ error: new Error('expired') });

    const { GET } = await import('@/app/auth/callback/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/callback?code=expired&next=%2Fcreate%2Fimage'
    ));

    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.resolveServerPostAuthPath).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
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
    resetMocks();
    mocks.createAuthRouteClient.mockResolvedValue({
      auth: { getUser: mocks.getUser, getSession: mocks.getSession },
    });
    mocks.resolveServerPostAuthPath.mockResolvedValue(NEW_ACCOUNT_DESTINATION);
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
      `https://magicbooklet.com${NEW_ACCOUNT_DESTINATION}`
    );
  });

  it('records auth_succeeded for the web through the onboarding events route, after the redirect', async () => {
    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(new Request(
      'https://magicbooklet.com/auth/continue?next=%2Fcreate%2Fvideo%3Fprompt%3Dsecret%2Bidea'
    ));

    // Scheduled, not awaited: the redirect is already answered.
    expect(response.status).toBe(307);
    expect(mocks.postOnboardingEventRouteResponse).not.toHaveBeenCalled();

    const { request, body } = await recordedAuthEvent();
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/onboarding/events');
    // The route verifies this bearer and links the row to the account.
    expect(request.headers.get('authorization')).toBe('Bearer session-access-token');
    expect(body).toMatchObject({
      eventName: 'auth_succeeded',
      platform: 'web',
      // Where the sign-in was headed, without the query that carries what was typed.
      step: '/create/video',
    });
    expect(body.clientEventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body.installationId).toMatch(/^fid_[a-f0-9]{64}$/);
  });

  it('keeps one installation key per account and never more than 64 characters of step', async () => {
    const { GET } = await import('@/app/auth/continue/route');
    await GET(new Request(`https://magicbooklet.com/auth/continue?next=%2F${'a'.repeat(80)}`));
    const first = await recordedAuthEvent();
    mocks.after.mockClear();
    mocks.postOnboardingEventRouteResponse.mockClear();
    await GET(new Request('https://magicbooklet.com/auth/continue?next=%2Fcreate'));
    const second = await recordedAuthEvent();

    expect(first.body.step).toBe(`/${'a'.repeat(63)}`);
    expect(first.body.installationId).toBe(second.body.installationId);
    expect(first.body.clientEventId).not.toBe(second.body.clientEventId);
  });

  it('still signs the person in when the event cannot be built', async () => {
    mocks.getSession.mockRejectedValue(new Error('storage unavailable'));

    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(new Request('https://magicbooklet.com/auth/continue?next=%2Fcreate'));

    expect(response.headers.get('location')).toBe(`https://magicbooklet.com${NEW_ACCOUNT_DESTINATION}`);
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.logBackendError).toHaveBeenCalledWith('web_auth_succeeded_event_not_recorded', {
      error: expect.any(Error),
    });
  });

  // /login sends a visitor who is already signed in through here (`signedIn=1`):
  // the same claim and destination, but no new sign-in to count.
  it('sends an already signed-in visitor on as before and counts no sign-in', async () => {
    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/continue?next=%2Fcreate&signedIn=1'
    ));

    expect(mocks.resolveServerPostAuthPath).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expect.any(Object) }),
      'user-1',
      '/create',
      { skipProfileOnboarding: false }
    );
    expect(nestedWelcomeRewardUrl(response).searchParams.get('referral')).toBe('applied');
    expect(mocks.clearReferralVisitCookie).toHaveBeenCalledWith(response, true);
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.after).not.toHaveBeenCalled();
    expect(mocks.postOnboardingEventRouteResponse).not.toHaveBeenCalled();
  });

  it('records nothing when the session cannot be verified', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('expired') });

    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(new Request('https://magicbooklet.com/auth/continue?next=%2Fcreate'));

    expect(response.headers.get('location')).toBe('https://magicbooklet.com/auth/auth-code-error?next=%2Fcreate&method=password');
    expect(mocks.after).not.toHaveBeenCalled();
  });

  it('tells a new password account its invite was applied', async () => {
    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(withVisitCookie('https://magicbooklet.com/auth/continue?next=%2Fcreate'));

    expect(nestedWelcomeRewardUrl(response).searchParams.get('referral')).toBe('applied');
    expect(mocks.clearReferralVisitCookie).toHaveBeenCalledWith(response, true);
  });

  it('never puts the status on a password-recovery landing', async () => {
    mocks.claimReferralForUser.mockResolvedValue({ claimed: false, clearCookie: true, reason: 'self_referral' });
    mocks.resolveServerPostAuthPath.mockResolvedValue('/auth/reset-password?next=%2Fcreate');

    const { GET } = await import('@/app/auth/continue/route');
    const response = await GET(withVisitCookie(
      'https://magicbooklet.com/auth/continue?next=%2Fauth%2Freset-password%3Fnext%3D%252Fcreate'
    ));

    expect(response.headers.get('location')).toBe('https://magicbooklet.com/auth/reset-password?next=%2Fcreate');
  });
});
