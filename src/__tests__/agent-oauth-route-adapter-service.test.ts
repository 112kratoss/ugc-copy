import type { SupabaseClient, User } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentOAuthError } from '@/lib/agent-oauth-request';
import { BackendRateLimitError } from '@/lib/backend-rate-limit';

const service = vi.hoisted(() => ({
  startAgentAuthorization: vi.fn(),
  exchangeAgentToken: vi.fn(),
  revokeAgentToken: vi.fn(),
  decideAgentConsent: vi.fn(),
  listAgentGrants: vi.fn(),
  disconnectAgentClient: vi.fn(),
}));
vi.mock('@/lib/agent-oauth-server-service', () => service);

const logs = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/backend-logger', () => ({
  logBackendWarning: logs.warning,
  logBackendError: logs.error,
  logBackendInfo: logs.info,
}));

const {
  AGENT_OAUTH_AUTHORIZE_RATE_LIMIT,
  AGENT_OAUTH_CONSENT_RATE_LIMIT,
  AGENT_OAUTH_TOKEN_RATE_LIMIT,
  createAgentOAuthAuthorizeHandlers,
  createAgentOAuthConsentHandlers,
  createAgentOAuthGrantsHandlers,
  createAgentOAuthRevokeHandlers,
  createAgentOAuthTokenHandlers,
} = await import('@/lib/agent-oauth-route-adapter-service');

const SITE = 'https://magicbooklet.test';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const admin = { marker: 'admin' } as unknown as SupabaseClient;

function jwt(claims: Record<string, unknown>) {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'ES256' })}.${part(claims)}.c2lnbmF0dXJl`;
}

const WEB_SESSION = jwt({ sub: USER_ID, role: 'authenticated' });
const AGENT_JWT = jwt({ sub: USER_ID, role: 'authenticated', client_id: 'client-claude' });

function harness(overrides: {
  user?: Partial<User> | null;
  rateLimit?: () => Promise<unknown>;
} = {}) {
  const user = overrides.user === null ? null : { id: USER_ID, is_anonymous: false, ...overrides.user };
  const getUser = vi.fn(async () => ({ data: { user }, error: user ? null : new Error('no session') }));
  const createUserClient = vi.fn(() => ({ auth: { getUser } }) as unknown as SupabaseClient);
  const enforceBackendRateLimit = vi.fn(overrides.rateLimit ?? (async () => ({ allowed: true })));
  const dependencies = {
    siteUrl: SITE,
    createServiceClient: () => admin,
    createUserClient,
    enforceBackendRateLimit: enforceBackendRateLimit as never,
  };
  return { dependencies, createUserClient, enforceBackendRateLimit, getUser };
}

const tooMany = () => Promise.reject(new BackendRateLimitError({ allowed: false, limit: 1, remaining: 0, retryAfterSeconds: 42, resetAt: '2026-11-26T12:01:00Z' }));

const form = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => new Request(`${SITE}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-vercel-forwarded-for': '203.0.113.7', ...headers },
  body: new URLSearchParams(fields),
});

const consentRequest = (body: unknown, headers: Record<string, string> = {}) => new Request(`${SITE}/api/oauth/consent`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: SITE, authorization: `Bearer ${WEB_SESSION}`, ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

const ANSWER = { authorizationId: `mbar_${'a'.repeat(43)}`, decision: 'approve', consentToken: `mbct_${'c'.repeat(43)}` };

beforeEach(() => {
  for (const mock of [...Object.values(service), ...Object.values(logs)]) mock.mockReset();
});

describe('GET /oauth/authorize', () => {
  it('sends the browser to the consent page on the host it came to, counted per network address', async () => {
    service.startAgentAuthorization.mockResolvedValue({ kind: 'consent', location: '/oauth/consent?authorization_id=mbar_x' });
    const { dependencies, enforceBackendRateLimit } = harness();
    const response = await createAgentOAuthAuthorizeHandlers(dependencies).GET(new Request('https://www.magicbooklet.test/oauth/authorize?client_id=c&state=s', {
      headers: { 'x-vercel-forwarded-for': '203.0.113.7' },
    }));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://www.magicbooklet.test/oauth/consent?authorization_id=mbar_x');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(admin, { ...AGENT_OAUTH_AUTHORIZE_RATE_LIMIT, key: '203.0.113.7' });
    const [params, options] = service.startAgentAuthorization.mock.calls[0];
    expect((params as URLSearchParams).get('client_id')).toBe('c');
    expect(options).toMatchObject({ admin, siteOrigin: SITE });
  });

  it('follows a refusal to the client\'s redirect URI, and shows a plain page when there is none to trust', async () => {
    const { dependencies } = harness();
    const handlers = createAgentOAuthAuthorizeHandlers(dependencies);
    service.startAgentAuthorization.mockResolvedValueOnce({ kind: 'redirect', location: 'http://localhost:8976/callback?error=invalid_request&state=s' });
    const redirected = await handlers.GET(new Request(`${SITE}/oauth/authorize`));
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBe('http://localhost:8976/callback?error=invalid_request&state=s');

    service.startAgentAuthorization.mockResolvedValueOnce({ kind: 'page', description: 'The app that sent you here is not registered with Magicbooklet.' });
    const page = await handlers.GET(new Request(`${SITE}/oauth/authorize?redirect_uri=https://evil.test`));
    expect(page.status).toBe(400);
    expect(page.headers.get('location')).toBeNull();
    expect(page.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(page.text()).resolves.toContain('not registered');
  });

  it('answers a page, never a redirect, when it is rate limited or the database is down', async () => {
    const limited = harness({ rateLimit: tooMany });
    const tooManyResponse = await createAgentOAuthAuthorizeHandlers(limited.dependencies).GET(new Request(`${SITE}/oauth/authorize`));
    expect(tooManyResponse.status).toBe(429);
    expect(service.startAgentAuthorization).not.toHaveBeenCalled();

    service.startAgentAuthorization.mockRejectedValue(new Error('db down'));
    const down = await createAgentOAuthAuthorizeHandlers(harness().dependencies).GET(new Request(`${SITE}/oauth/authorize`));
    expect(down.status).toBe(503);
    expect(down.headers.get('location')).toBeNull();
  });
});

describe('POST /oauth/token', () => {
  const tokens = { access_token: `mbat_${'a'.repeat(43)}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `mbrt_${'r'.repeat(43)}`, scope: 'mcp' };

  it('answers the tokens uncached and cross-origin, and logs none of them', async () => {
    service.exchangeAgentToken.mockResolvedValue(tokens);
    const { dependencies, enforceBackendRateLimit } = harness();
    const response = await createAgentOAuthTokenHandlers(dependencies).POST(form('/oauth/token', { grant_type: 'authorization_code', code: 'mbac_secret-code', client_id: 'c' }, { authorization: 'Basic abc' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await expect(response.json()).resolves.toEqual(tokens);
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(admin, { ...AGENT_OAUTH_TOKEN_RATE_LIMIT, key: '203.0.113.7' });
    const [input, options] = service.exchangeAgentToken.mock.calls[0];
    expect((input as { form: URLSearchParams }).form.get('code')).toBe('mbac_secret-code');
    expect((input as { authorizationHeader: string }).authorizationHeader).toBe('Basic abc');
    expect(options).toMatchObject({ admin, siteOrigin: SITE });
    const logged = JSON.stringify([logs.warning.mock.calls, logs.error.mock.calls, logs.info.mock.calls]);
    expect(logged).not.toContain('mbat_');
    expect(logged).not.toContain('mbac_');
  });

  it('answers an OAuth error in RFC 6749\'s shape, and logs its code, never its description', async () => {
    service.exchangeAgentToken.mockRejectedValue(new AgentOAuthError('invalid_grant', 'code_verifier does not match mbac_leaky.'));
    const response = await createAgentOAuthTokenHandlers(harness().dependencies).POST(form('/oauth/token', { grant_type: 'authorization_code' }));
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    await expect(response.json()).resolves.toEqual({ error: 'invalid_grant', error_description: 'code_verifier does not match mbac_leaky.' });
    expect(logs.warning).toHaveBeenCalledWith('agent_oauth_token_refused', { error: 'invalid_grant', status: 400 });
    expect(JSON.stringify(logs.warning.mock.calls)).not.toContain('mbac_leaky');
  });

  it('tells a client refreshing too often to wait, with how long', async () => {
    service.exchangeAgentToken.mockRejectedValue(new AgentOAuthError('temporarily_unavailable', 'This connection is refreshing too often. Wait before trying again.', 429));
    const response = await createAgentOAuthTokenHandlers(harness().dependencies).POST(form('/oauth/token', { grant_type: 'refresh_token' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('300');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('challenges with Basic only a client that tried Basic', async () => {
    service.exchangeAgentToken.mockRejectedValue(new AgentOAuthError('invalid_client', 'The client is unknown or its credentials are wrong.', 401));
    const handlers = createAgentOAuthTokenHandlers(harness().dependencies);
    const viaBasic = await handlers.POST(form('/oauth/token', { grant_type: 'refresh_token' }, { authorization: 'Basic abc' }));
    expect(viaBasic.status).toBe(401);
    expect(viaBasic.headers.get('www-authenticate')).toContain('Basic realm=');
    const viaBody = await handlers.POST(form('/oauth/token', { grant_type: 'refresh_token' }));
    expect(viaBody.status).toBe(401);
    expect(viaBody.headers.get('www-authenticate')).toBeNull();
  });

  it('reads a form body only, of a form\'s size', async () => {
    const handlers = createAgentOAuthTokenHandlers(harness().dependencies);
    const asJson = await handlers.POST(new Request(`${SITE}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"grant_type":"refresh_token"}' }));
    expect(asJson.status).toBe(400);
    await expect(asJson.json()).resolves.toMatchObject({ error: 'invalid_request' });
    const huge = await handlers.POST(form('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x'.repeat(20_000) }));
    expect(huge.status).toBe(400);
    expect(service.exchangeAgentToken).not.toHaveBeenCalled();
  });

  it('answers 429 when limited and 503 when it cannot answer, never a guess', async () => {
    const limited = await createAgentOAuthTokenHandlers(harness({ rateLimit: tooMany }).dependencies).POST(form('/oauth/token', { grant_type: 'refresh_token' }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('42');
    expect(service.exchangeAgentToken).not.toHaveBeenCalled();

    service.exchangeAgentToken.mockRejectedValue(new Error('db down'));
    const down = await createAgentOAuthTokenHandlers(harness().dependencies).POST(form('/oauth/token', { grant_type: 'refresh_token' }));
    expect(down.status).toBe(503);
    await expect(down.json()).resolves.toMatchObject({ error: 'temporarily_unavailable' });
  });

  it('answers the preflight a browser-based client sends', () => {
    const response = createAgentOAuthTokenHandlers(harness().dependencies).OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});

describe('POST /oauth/revoke', () => {
  it('answers 200 with no body whatever the token was', async () => {
    service.revokeAgentToken.mockResolvedValue(undefined);
    const response = await createAgentOAuthRevokeHandlers(harness().dependencies).POST(form('/oauth/revoke', { token: 'anything', client_id: 'c' }));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('');
    expect(service.revokeAgentToken).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller that is not a registered client', async () => {
    service.revokeAgentToken.mockRejectedValue(new AgentOAuthError('invalid_client', 'The client is unknown or its credentials are wrong.', 401));
    const response = await createAgentOAuthRevokeHandlers(harness().dependencies).POST(form('/oauth/revoke', { token: 'x' }));
    expect(response.status).toBe(401);
  });
});

describe('POST /api/oauth/consent', () => {
  it('records the signed-in account\'s answer and says where the browser goes', async () => {
    service.decideAgentConsent.mockResolvedValue({ redirectUrl: 'http://localhost:8976/callback?code=mbac_x&state=s' });
    const { dependencies, enforceBackendRateLimit } = harness();
    const response = await createAgentOAuthConsentHandlers(dependencies).POST(consentRequest(ANSWER, { 'sec-fetch-site': 'same-origin' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({ redirect_url: 'http://localhost:8976/callback?code=mbac_x&state=s' });
    expect(service.decideAgentConsent).toHaveBeenCalledWith(
      { authorizationId: ANSWER.authorizationId, userId: USER_ID, consentToken: ANSWER.consentToken, decision: 'approve' },
      expect.objectContaining({ admin }),
    );
    expect(enforceBackendRateLimit).toHaveBeenCalledWith(admin, { ...AGENT_OAUTH_CONSENT_RATE_LIMIT, key: USER_ID });
  });

  it('takes the answer from this site\'s own page only', async () => {
    const handlers = createAgentOAuthConsentHandlers(harness().dependencies);
    const refused = [
      consentRequest(ANSWER, { origin: 'https://evil.test' }),
      consentRequest(ANSWER, { origin: 'null' }),
      consentRequest(ANSWER, { 'sec-fetch-site': 'cross-site' }),
      consentRequest(ANSWER, { 'sec-fetch-site': 'same-site' }),
      new Request(`${SITE}/api/oauth/consent`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${WEB_SESSION}` }, body: JSON.stringify(ANSWER) }),
    ];
    for (const request of refused) {
      const response = await handlers.POST(request);
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: 'CROSS_ORIGIN_REFUSED' });
    }
    expect(service.decideAgentConsent).not.toHaveBeenCalled();
  });

  it('takes the answer from a registered account\'s web session, never a guest, an agent or nobody', async () => {
    const signedOut = await createAgentOAuthConsentHandlers(harness({ user: null }).dependencies).POST(consentRequest(ANSWER));
    expect(signedOut.status).toBe(401);
    const guest = await createAgentOAuthConsentHandlers(harness({ user: { is_anonymous: true } }).dependencies).POST(consentRequest(ANSWER));
    expect(guest.status).toBe(403);
    await expect(guest.json()).resolves.toMatchObject({ code: 'REGISTRATION_REQUIRED' });
    // An agent's Supabase token, even one the user lookup accepts, never answers for the account.
    const agent = await createAgentOAuthConsentHandlers(harness().dependencies).POST(consentRequest(ANSWER, { authorization: `Bearer ${AGENT_JWT}` }));
    expect(agent.status).toBe(403);
    await expect(agent.json()).resolves.toMatchObject({ code: 'AGENT_TOKEN_NOT_ALLOWED' });
    expect(service.decideAgentConsent).not.toHaveBeenCalled();
  });

  it('refuses a malformed answer before it reaches the service', async () => {
    const handlers = createAgentOAuthConsentHandlers(harness().dependencies);
    const bodies: unknown[] = [
      { ...ANSWER, decision: 'maybe' },
      { ...ANSWER, consentToken: undefined },
      { ...ANSWER, authorizationId: 42 },
      [ANSWER],
      'not json',
    ];
    for (const body of bodies) expect((await handlers.POST(consentRequest(body))).status).toBe(400);
    const asForm = await handlers.POST(new Request(`${SITE}/api/oauth/consent`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE, authorization: `Bearer ${WEB_SESSION}` },
      body: new URLSearchParams({ authorizationId: ANSWER.authorizationId, decision: 'approve', consentToken: ANSWER.consentToken }),
    }));
    expect(asForm.status).toBe(400);
    expect(service.decideAgentConsent).not.toHaveBeenCalled();
  });

  it('says a request that can no longer be answered is unavailable, and limits attempts per account', async () => {
    service.decideAgentConsent.mockResolvedValue(null);
    const gone = await createAgentOAuthConsentHandlers(harness().dependencies).POST(consentRequest(ANSWER));
    expect(gone.status).toBe(409);
    await expect(gone.json()).resolves.toMatchObject({ code: 'CONSENT_UNAVAILABLE' });
    const limited = await createAgentOAuthConsentHandlers(harness({ rateLimit: tooMany }).dependencies).POST(consentRequest(ANSWER));
    expect(limited.status).toBe(429);
    service.decideAgentConsent.mockRejectedValue(new Error('db down'));
    const down = await createAgentOAuthConsentHandlers(harness().dependencies).POST(consentRequest(ANSWER));
    expect(down.status).toBe(503);
  });
});

describe('/api/oauth/grants', () => {
  const list = (headers: Record<string, string> = {}) => new Request(`${SITE}/api/oauth/grants`, { headers: { authorization: `Bearer ${WEB_SESSION}`, ...headers } });
  const disconnect = (body: unknown, headers: Record<string, string> = {}) => new Request(`${SITE}/api/oauth/grants`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', origin: SITE, authorization: `Bearer ${WEB_SESSION}`, ...headers },
    body: JSON.stringify(body),
  });

  it('lists the signed-in account\'s connected apps', async () => {
    service.listAgentGrants.mockResolvedValue([{ clientId: 'client-claude', name: 'Claude Code', uri: null, grantedAt: '2026-11-26T12:00:00.000Z', surface: 'posts' }]);
    const response = await createAgentOAuthGrantsHandlers(harness().dependencies).GET(list());
    await expect(response.json()).resolves.toEqual({
      grants: [{ client: { id: 'client-claude', name: 'Claude Code', uri: null }, granted_at: '2026-11-26T12:00:00.000Z', surface: 'posts' }],
    });
    expect(service.listAgentGrants).toHaveBeenCalledWith(admin, USER_ID);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('ends every grant the account gave the client', async () => {
    service.disconnectAgentClient.mockResolvedValue(2);
    const response = await createAgentOAuthGrantsHandlers(harness().dependencies).DELETE(disconnect({ clientId: 'client-claude' }));
    await expect(response.json()).resolves.toEqual({ revoked: 2 });
    expect(service.disconnectAgentClient).toHaveBeenCalledWith(admin, { userId: USER_ID, clientId: 'client-claude' });
  });

  it('ends one named client\'s grants and takes no request for all of them', async () => {
    const handlers = createAgentOAuthGrantsHandlers(harness().dependencies);
    expect((await handlers.DELETE(disconnect({ all: true }))).status).toBe(400);
    expect((await handlers.DELETE(disconnect({ all: true, clientId: 42 }))).status).toBe(400);
    expect(service.disconnectAgentClient).not.toHaveBeenCalled();
  });

  it('answers only a registered account\'s web session, and a disconnect only from this site', async () => {
    const grants = (overrides: Parameters<typeof harness>[0] = {}) => createAgentOAuthGrantsHandlers(harness(overrides).dependencies);
    expect((await grants({ user: null }).GET(list())).status).toBe(401);
    expect((await grants({ user: { is_anonymous: true } }).GET(list())).status).toBe(403);
    expect((await grants().GET(list({ authorization: `Bearer ${AGENT_JWT}` }))).status).toBe(403);
    expect((await grants().DELETE(disconnect({ clientId: 'client-claude' }, { authorization: `Bearer ${AGENT_JWT}` }))).status).toBe(403);
    expect((await grants().DELETE(disconnect({ clientId: 'client-claude' }, { origin: 'https://evil.test' }))).status).toBe(403);
    expect((await grants().DELETE(disconnect({ clientId: 'bad id' }))).status).toBe(400);
    expect((await grants().DELETE(disconnect({}))).status).toBe(400);
    expect(service.listAgentGrants).not.toHaveBeenCalled();
    expect(service.disconnectAgentClient).not.toHaveBeenCalled();
  });

  it('never reads a failure as an empty list', async () => {
    service.listAgentGrants.mockRejectedValue(new Error('db down'));
    const response = await createAgentOAuthGrantsHandlers(harness().dependencies).GET(list());
    expect(response.status).toBe(503);
  });
});
