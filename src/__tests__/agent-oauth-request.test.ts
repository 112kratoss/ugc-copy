import { describe, expect, it, vi } from 'vitest';

import {
  AgentOAuthError,
  buildAuthorizationResponseUrl,
  checkAuthorizeRequest,
  isRegisteredRedirectUri,
  readClientCredentials,
  readTokenGrantRequest,
  resolveGrantSurface,
  singleParameter,
  surfaceOfResource,
  widestSurfaceOf,
  type AgentOAuthClient,
} from '@/lib/agent-oauth-request';
import { MCP_POSTING_ONLY_CLIENT_IDS } from '@/lib/mcp-client-directory';

const SITE = 'https://magicbooklet.test';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CLIENT_ID = 'cf5743f9-c83c-4f6c-9afb-0803d5aee698';
const REDIRECT = 'http://localhost:8976/callback';

function client(overrides: Partial<AgentOAuthClient> = {}): AgentOAuthClient {
  return {
    clientId: CLIENT_ID,
    clientName: 'Claude Code',
    clientUri: null,
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none',
    clientSecretHash: null,
    surface: 'full',
    disabledAt: null,
    ...overrides,
  };
}

function authorizeParams(overrides: Record<string, string | null> = {}, extra: Array<[string, string]> = []) {
  const base: Record<string, string | null> = {
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...overrides,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) if (value !== null) params.set(key, value);
  for (const [key, value] of extra) params.append(key, value);
  return params;
}

const check = (params: URLSearchParams, found: AgentOAuthClient | null = client()) => checkAuthorizeRequest(params, {
  siteOrigin: SITE,
  findClient: vi.fn(async () => found),
});

async function expectOAuthError(run: () => unknown, error: string, status = 400) {
  try {
    run();
  } catch (caught) {
    expect(caught).toBeInstanceOf(AgentOAuthError);
    expect((caught as AgentOAuthError).error).toBe(error);
    expect((caught as AgentOAuthError).status).toBe(status);
    return;
  }
  throw new Error(`expected ${error}`);
}

// What the app's authorization server accepts (docs/plans/agent-token-broker-plan-2026-11-26.md).
describe('agent OAuth request rules', () => {
  it('refuses a parameter sent more than once', async () => {
    const params = new URLSearchParams('a=1&a=2&b=3&c=');
    await expectOAuthError(() => singleParameter(params, 'a'), 'invalid_request');
    expect(singleParameter(params, 'b')).toBe('3');
    expect(singleParameter(params, 'c')).toBeNull();
    expect(singleParameter(params, 'missing')).toBeNull();
  });

  it('reads a resource as one of the two MCP servers of this origin, and nothing else', () => {
    expect(surfaceOfResource(`${SITE}/api/mcp`, SITE)).toBe('full');
    expect(surfaceOfResource(`${SITE}/api/mcp/`, SITE)).toBe('full');
    expect(surfaceOfResource(`${SITE}/api/mcp/posts`, SITE)).toBe('posts');
    expect(surfaceOfResource(SITE, SITE)).toBeNull();
    expect(surfaceOfResource(`${SITE}/api/mcp/other`, SITE)).toBeNull();
    expect(surfaceOfResource('https://evil.test/api/mcp', SITE)).toBeNull();
    expect(surfaceOfResource(`${SITE}/api/mcp?x=1`, SITE)).toBeNull();
    expect(surfaceOfResource(`${SITE}/api/mcp#frag`, SITE)).toBeNull();
    expect(surfaceOfResource(`${SITE}.evil.test/api/mcp`, SITE)).toBeNull();
  });

  it('never grants a posting-only client the full server', () => {
    const full = { clientId: CLIENT_ID, surface: 'full' as const };
    const posts = { clientId: CLIENT_ID, surface: 'posts' as const };
    expect(resolveGrantSurface(full, `${SITE}/api/mcp`, SITE)).toBe('full');
    expect(resolveGrantSurface(full, `${SITE}/api/mcp/posts`, SITE)).toBe('posts');
    expect(resolveGrantSurface(full, null, SITE)).toBe('full');
    expect(resolveGrantSurface(posts, `${SITE}/api/mcp/posts`, SITE)).toBe('posts');
    expect(resolveGrantSurface(posts, null, SITE)).toBe('posts');
    expect(resolveGrantSurface(posts, `${SITE}/api/mcp`, SITE)).toBeNull();
    expect(resolveGrantSurface(full, 'https://evil.test/api/mcp', SITE)).toBeNull();
  });

  it('holds a client the code lists as posting-only to posting, whatever its row says', async () => {
    // A row registered or imported as `full` by mistake: the code's list still decides.
    for (const clientId of Object.values(MCP_POSTING_ONLY_CLIENT_IDS)) {
      const mislabelled = { clientId, surface: 'full' as const };
      expect(widestSurfaceOf(mislabelled)).toBe('posts');
      expect(resolveGrantSurface(mislabelled, null, SITE)).toBe('posts');
      expect(resolveGrantSurface(mislabelled, `${SITE}/api/mcp/posts`, SITE)).toBe('posts');
      expect(resolveGrantSurface(mislabelled, `${SITE}/api/mcp`, SITE)).toBeNull();
      const refused = await check(
        authorizeParams({ client_id: clientId, resource: `${SITE}/api/mcp` }),
        client({ clientId, surface: 'full' }),
      );
      expect(refused).toMatchObject({ ok: false, kind: 'redirect', error: 'invalid_target' });
    }
    expect(widestSurfaceOf({ clientId: CLIENT_ID, surface: 'full' })).toBe('full');
  });

  it('matches a redirect URI as an exact string', () => {
    const registered = client({ redirectUris: ['http://localhost:8976/callback', 'https://claude.ai/api/mcp/auth_callback'] });
    expect(isRegisteredRedirectUri(registered, 'http://localhost:8976/callback')).toBe(true);
    for (const other of [
      'http://localhost:8977/callback',
      'http://127.0.0.1:8976/callback',
      'http://localhost:8976/callback/',
      'http://localhost:8976/callback?x=1',
      'http://localhost:8976/Callback',
      'https://claude.ai/api/mcp/auth_callback/../evil',
      'https://claude.ai.evil.test/api/mcp/auth_callback',
    ]) {
      expect(isRegisteredRedirectUri(registered, other), other).toBe(false);
    }
  });
});

describe('/oauth/authorize', () => {
  it('accepts a code request with PKCE S256 from a registered client', async () => {
    await expect(check(authorizeParams({ resource: `${SITE}/api/mcp/posts`, scope: 'mcp' }))).resolves.toEqual({
      ok: true,
      request: { clientId: CLIENT_ID, redirectUri: REDIRECT, surface: 'posts', state: 'xyz', scope: 'mcp', codeChallenge: CHALLENGE },
    });
    const bare = await check(authorizeParams({ state: null }));
    expect(bare).toMatchObject({ ok: true, request: { surface: 'full', state: null, scope: null } });
  });

  it('shows the person a page, and redirects nowhere, until the client and its redirect URI hold', async () => {
    const cases: Array<[URLSearchParams, AgentOAuthClient | null]> = [
      [authorizeParams({ client_id: null }), client()],
      [authorizeParams({ client_id: 'x' }), client()],
      [authorizeParams(), null],
      [authorizeParams(), client({ disabledAt: '2026-11-26T00:00:00Z' })],
      [authorizeParams({ redirect_uri: null }), client()],
      [authorizeParams({ redirect_uri: 'https://evil.test/callback' }), client()],
      [authorizeParams({ redirect_uri: `${REDIRECT}/` }), client()],
      [authorizeParams({}, [['redirect_uri', 'https://evil.test/callback']]), client()],
      [authorizeParams({}, [['client_id', 'another-client-id']]), client()],
    ];
    for (const [params, found] of cases) {
      const result = await check(params, found);
      expect(result, params.toString()).toMatchObject({ ok: false, kind: 'page' });
    }
  });

  it('asks the database about a well-formed client id only', async () => {
    const findClient = vi.fn(async () => client());
    await checkAuthorizeRequest(authorizeParams({ client_id: "x' or 1=1" }), { siteOrigin: SITE, findClient });
    expect(findClient).not.toHaveBeenCalled();
  });

  it('sends every later refusal to the registered redirect URI, with the state', async () => {
    const cases: Array<[URLSearchParams, string]> = [
      [authorizeParams({ response_type: 'token' }), 'unsupported_response_type'],
      [authorizeParams({ response_type: null }), 'invalid_request'],
      [authorizeParams({ code_challenge: null }), 'invalid_request'],
      [authorizeParams({ code_challenge_method: 'plain' }), 'invalid_request'],
      [authorizeParams({ code_challenge_method: null }), 'invalid_request'],
      [authorizeParams({ code_challenge: 'too-short' }), 'invalid_request'],
      [authorizeParams({ resource: 'https://evil.test/api/mcp' }), 'invalid_target'],
      [authorizeParams({ scope: 'x'.repeat(513) }), 'invalid_scope'],
      [authorizeParams({}, [['code_challenge', CHALLENGE]]), 'invalid_request'],
      [authorizeParams({}, [['resource', `${SITE}/api/mcp`], ['resource', `${SITE}/api/mcp/posts`]]), 'invalid_request'],
    ];
    for (const [params, error] of cases) {
      const result = await check(params);
      expect(result, params.toString()).toMatchObject({ ok: false, kind: 'redirect', redirectUri: REDIRECT, state: 'xyz', error });
    }
    const posting = await check(authorizeParams({ resource: `${SITE}/api/mcp` }), client({ surface: 'posts' }));
    expect(posting).toMatchObject({ ok: false, kind: 'redirect', error: 'invalid_target' });
  });

  it('does not echo a state it refuses for its length', async () => {
    const result = await check(authorizeParams({ state: 's'.repeat(2049) }));
    expect(result).toMatchObject({ ok: false, kind: 'redirect', state: null, error: 'invalid_request' });
  });

  it('builds the redirect with the answer in the query, keeping the URI\'s own query', () => {
    expect(buildAuthorizationResponseUrl(REDIRECT, { code: 'mbac_abc' }, 'xyz'))
      .toBe('http://localhost:8976/callback?code=mbac_abc&state=xyz');
    expect(buildAuthorizationResponseUrl('https://client.test/cb?tenant=1', { code: 'c' }, null))
      .toBe('https://client.test/cb?tenant=1&code=c');
    const denied = new URL(buildAuthorizationResponseUrl(REDIRECT, { error: 'access_denied', description: 'The account declined.' }, 'a b&c'));
    expect(denied.searchParams.get('error')).toBe('access_denied');
    expect(denied.searchParams.get('error_description')).toBe('The account declined.');
    expect(denied.searchParams.get('state')).toBe('a b&c');
    expect(denied.hash).toBe('');
  });

  it('builds no answer for an address that is not http(s), whatever a row came to hold', () => {
    for (const redirectUri of ['javascript:alert(1)', 'data:text/html,x', 'myapp://callback', 'file:///etc/hosts']) {
      expect(() => buildAuthorizationResponseUrl(redirectUri, { code: 'c' }, null), redirectUri).toThrow(/not an http\(s\) address/);
      expect(() => buildAuthorizationResponseUrl(redirectUri, { error: 'access_denied' }, 's'), redirectUri).toThrow();
    }
  });
});

describe('/oauth/token request', () => {
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

  it('reads a public client from the body', () => {
    expect(readClientCredentials(new URLSearchParams({ client_id: CLIENT_ID }), null))
      .toEqual({ clientId: CLIENT_ID, clientSecret: null, via: 'none' });
    // A bearer header is not client authentication and is ignored here.
    expect(readClientCredentials(new URLSearchParams({ client_id: CLIENT_ID }), 'Bearer something'))
      .toEqual({ clientId: CLIENT_ID, clientSecret: null, via: 'none' });
  });

  it('reads a confidential client from the body or a Basic header, never both', async () => {
    expect(readClientCredentials(new URLSearchParams({ client_id: CLIENT_ID, client_secret: 's3cret' }), null))
      .toEqual({ clientId: CLIENT_ID, clientSecret: 's3cret', via: 'post' });
    expect(readClientCredentials(new URLSearchParams(), basic(CLIENT_ID, 'p@ss:word +1')))
      .toEqual({ clientId: CLIENT_ID, clientSecret: 'p@ss:word +1', via: 'basic' });
    expect(readClientCredentials(new URLSearchParams({ client_id: CLIENT_ID }), basic(CLIENT_ID, 's')))
      .toMatchObject({ via: 'basic' });
    await expectOAuthError(() => readClientCredentials(new URLSearchParams({ client_secret: 'x' }), basic(CLIENT_ID, 's')), 'invalid_request');
    await expectOAuthError(() => readClientCredentials(new URLSearchParams({ client_id: 'another-client-id' }), basic(CLIENT_ID, 's')), 'invalid_request');
  });

  it('answers 401 invalid_client when it cannot tell who is asking', async () => {
    await expectOAuthError(() => readClientCredentials(new URLSearchParams(), null), 'invalid_client', 401);
    await expectOAuthError(() => readClientCredentials(new URLSearchParams({ client_id: 'bad id' }), null), 'invalid_client', 401);
    await expectOAuthError(() => readClientCredentials(new URLSearchParams(), 'Basic !!!'), 'invalid_client', 401);
    await expectOAuthError(() => readClientCredentials(new URLSearchParams(), `Basic ${Buffer.from('no-colon').toString('base64')}`), 'invalid_client', 401);
    await expectOAuthError(() => readClientCredentials(new URLSearchParams('client_id=a&client_id=b'), null), 'invalid_request');
  });

  it('reads the two grants and refuses every other', async () => {
    expect(readTokenGrantRequest(new URLSearchParams({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v', redirect_uri: REDIRECT, resource: `${SITE}/api/mcp` })))
      .toEqual({ grantType: 'authorization_code', code: 'c', codeVerifier: 'v', redirectUri: REDIRECT, resource: `${SITE}/api/mcp` });
    expect(readTokenGrantRequest(new URLSearchParams({ grant_type: 'authorization_code', code: 'c', code_verifier: 'v' })))
      .toMatchObject({ redirectUri: null, resource: null });
    expect(readTokenGrantRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'r' })))
      .toEqual({ grantType: 'refresh_token', refreshToken: 'r' });
    await expectOAuthError(() => readTokenGrantRequest(new URLSearchParams({ grant_type: 'authorization_code', code: 'c' })), 'invalid_request');
    await expectOAuthError(() => readTokenGrantRequest(new URLSearchParams({ grant_type: 'authorization_code', code_verifier: 'v' })), 'invalid_request');
    await expectOAuthError(() => readTokenGrantRequest(new URLSearchParams({ grant_type: 'refresh_token' })), 'invalid_request');
    await expectOAuthError(() => readTokenGrantRequest(new URLSearchParams()), 'invalid_request');
    for (const grant of ['password', 'client_credentials', 'implicit', 'urn:ietf:params:oauth:grant-type:device_code']) {
      await expectOAuthError(() => readTokenGrantRequest(new URLSearchParams({ grant_type: grant })), 'unsupported_grant_type');
    }
  });
});
