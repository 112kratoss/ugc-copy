import type { User } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  APP_GRANTS_API_PATH,
  CONNECTED_APP_ACCESS,
  POSTING_CONNECTED_APP_ACCESS,
  connectedAppAccess,
  createAppGrantsClient,
  disconnectApp,
  listConnectedApps,
  toConnectedApps,
} from '@/lib/connected-apps';
import { getVerifiedIdentityAdmission, registerAdmittedIdentity } from '@/lib/identity-admission-assertion';
import {
  AGENT_ACCESS,
  AGENT_CONSENT_API_PATH,
  CONSENT_DECISION_FAILED_MESSAGE,
  CONSENT_UNAVAILABLE_MESSAGE,
  POSTING_AGENT_ACCESS,
  agentAccessForSurface,
  buildConsentPath,
  gateConsentRequest,
  normalizeAuthorizationId,
  sendAgentConsentAnswer,
} from '@/lib/oauth-consent-service';
import { buildOAuthProtectedResourceMetadata } from '@/lib/oauth-protected-resource-metadata';
import { routeIdentityPolicyForRequest } from '@/lib/route-identity-policy';
import { getVerifiedAuthUserResult } from '@/lib/server-auth-user';

// What this app's own pages and documents do with the app's own authorization server
// (docs/archive/agent-token-broker-plan-2026-11-26.md): the consent page's answer, Connected apps,
// the protected-resource document, and the identity a route may register.

const AUTHORIZATION_ID = `mbar_${'a'.repeat(43)}`;
const ANSWER = { authorizationId: AUTHORIZATION_ID, decision: 'approve' as const, consentToken: `mbct_${'c'.repeat(43)}` };

function answerOf(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

describe('the consent page and the app\'s own requests', () => {
  it('takes the app\'s authorization id through the same gate and the same sign-in round trip', () => {
    expect(normalizeAuthorizationId(AUTHORIZATION_ID)).toBe(AUTHORIZATION_ID);
    expect(gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: null })).toEqual({
      kind: 'sign_in',
      href: `/login?next=${encodeURIComponent(buildConsentPath(AUTHORIZATION_ID))}`,
    });
    expect(gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: { is_anonymous: true, email: undefined } }).kind).toBe('guest');
    expect(gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: { is_anonymous: false, email: 'a@b.test' } }))
      .toEqual({ kind: 'account', authorizationId: AUTHORIZATION_ID, email: 'a@b.test' });
  });

  it('lists what the grant\'s server allows: the posting list for the posting server', () => {
    expect(agentAccessForSurface('full')).toBe(AGENT_ACCESS);
    expect(agentAccessForSurface('posts')).toBe(POSTING_AGENT_ACCESS);
  });

  it('sends the answer same-origin with the session\'s token and no cookie', async () => {
    const send = answerOf(200, { redirect_url: 'http://localhost:8976/callback?code=mbac_x&state=s' });
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: 'web-session-token', fetch: send }))
      .resolves.toEqual({ ok: true, redirectUrl: 'http://localhost:8976/callback?code=mbac_x&state=s' });
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(AGENT_CONSENT_API_PATH);
    expect(url.startsWith('/')).toBe(true);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer web-session-token' });
    expect(JSON.parse(init.body as string)).toEqual(ANSWER);
  });

  it('does not ask without a session, and follows only an http(s) redirect', async () => {
    const send = answerOf(200, { redirect_url: 'javascript:alert(1)' });
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: null, fetch: send })).resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
    expect(send).not.toHaveBeenCalled();
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: 't', fetch: send })).resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
  });

  it('says an answered or expired request is unavailable, and any other failure that the answer did not arrive', async () => {
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: 't', fetch: answerOf(409, { code: 'CONSENT_UNAVAILABLE' }) }))
      .resolves.toEqual({ ok: false, message: CONSENT_UNAVAILABLE_MESSAGE });
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: 't', fetch: answerOf(503, { code: 'CONSENT_FAILED' }) }))
      .resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
    // A 200 that carries a redirect on a refusal status is still a refusal.
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: 't', fetch: answerOf(403, { redirect_url: 'https://client.test/cb?code=x' }) }))
      .resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
    const failing = vi.fn(async () => { throw new Error('offline'); });
    await expect(sendAgentConsentAnswer(ANSWER, { accessToken: 't', fetch: failing })).resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
  });
});

describe('Connected apps over the app\'s own grants', () => {
  const APP_GRANT = { client: { id: 'client-claude', name: 'Claude Code', uri: 'https://claude.com/claude-code' }, granted_at: '2026-11-26T12:00:00.000Z', surface: 'full' };
  const POSTS_GRANT = { client: { id: 'client-posting', name: 'Claude (posting)', uri: null }, granted_at: '2026-11-25T12:00:00.000Z', surface: 'posts' };

  it('reads the grants with the session\'s token, and a failure as a failure', async () => {
    const send = answerOf(200, { grants: [APP_GRANT, POSTS_GRANT] });
    const client = createAppGrantsClient({ getAccessToken: async () => 'web-session-token', fetch: send });
    await expect(listConnectedApps(client)).resolves.toEqual([
      { clientId: 'client-claude', name: 'Claude Code', uri: 'https://claude.com/claude-code', grantedAt: '2026-11-26T12:00:00.000Z' },
      { clientId: 'client-posting', name: 'Claude (posting)', uri: null, grantedAt: '2026-11-25T12:00:00.000Z', postingOnly: true },
    ]);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(APP_GRANTS_API_PATH);
    expect(init.method).toBe('GET');
    expect(init.credentials).toBe('omit');
    expect(init.headers).toEqual({ Authorization: 'Bearer web-session-token' });

    await expect(listConnectedApps(createAppGrantsClient({ getAccessToken: async () => 't', fetch: answerOf(503, { error: 'The connected apps could not be read.' }) })))
      .rejects.toThrow('The connected apps could not be read.');
    await expect(listConnectedApps(createAppGrantsClient({ getAccessToken: async () => null, fetch: send }))).rejects.toThrow(/Sign in again/);
    const offline = vi.fn(async () => { throw new Error('offline'); });
    await expect(listConnectedApps(createAppGrantsClient({ getAccessToken: async () => 't', fetch: offline }))).rejects.toThrow();
  });

  it('disconnects by client id, and a refusal is a refusal', async () => {
    const send = answerOf(200, { revoked: 1 });
    const client = createAppGrantsClient({ getAccessToken: async () => 't', fetch: send });
    await expect(client.revokeGrant({ clientId: 'client-claude' })).resolves.toEqual({ error: null });
    const [, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(JSON.parse(init.body as string)).toEqual({ clientId: 'client-claude' });
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer t' });
    const refused = createAppGrantsClient({ getAccessToken: async () => 't', fetch: answerOf(503, { error: 'The app could not be disconnected. Try again.' }) });
    await expect(disconnectApp(refused, { clientId: 'client-claude', name: 'Claude Code', uri: null, grantedAt: null })).rejects.toThrow('The app could not be disconnected. Try again.');
  });

  it('says a posting grant is posting-only, and a client with any full grant is not', () => {
    expect(connectedAppAccess('client-anything', true)).toBe(POSTING_CONNECTED_APP_ACCESS);
    expect(connectedAppAccess('client-anything', false)).toBe(CONNECTED_APP_ACCESS);
    expect(connectedAppAccess('client-anything')).toBe(CONNECTED_APP_ACCESS);
    const both = toConnectedApps([{ ...POSTS_GRANT, client: APP_GRANT.client }, APP_GRANT]);
    expect(both).toHaveLength(1);
    expect(both[0].postingOnly).toBeUndefined();
    const onlyPosts = toConnectedApps([POSTS_GRANT, { ...POSTS_GRANT, granted_at: '2026-11-20T00:00:00.000Z' }]);
    expect(onlyPosts[0]).toMatchObject({ postingOnly: true, grantedAt: '2026-11-20T00:00:00.000Z' });
  });

  it('leaves out a grant without a client id', () => {
    expect(toConnectedApps([{ client: { client_id: 'client-codex', name: 'Codex' }, granted_at: '2026-11-08T09:00:00.000Z' }, APP_GRANT]))
      .toMatchObject([{ clientId: 'client-claude' }]);
    expect(toConnectedApps(null)).toEqual([]);
  });
});

describe('the protected-resource document', () => {
  it('names the app as the authorization server, for both servers, and needs no Supabase URL', () => {
    for (const surface of ['full', 'posts'] as const) {
      const metadata = buildOAuthProtectedResourceMetadata({ siteUrl: 'https://magicbooklet.com/', surface });
      expect(metadata?.authorization_servers).toEqual(['https://magicbooklet.com']);
      expect(JSON.stringify(metadata)).not.toMatch(/supabase|auth\/v1/u);
    }
    expect(buildOAuthProtectedResourceMetadata({ siteUrl: '' })).toBeNull();
  });
});

describe('who may reach the app\'s own OAuth routes', () => {
  it('keeps the consent answer and Connected apps to registered accounts, every method', () => {
    for (const [path, method] of [['/api/oauth/consent', 'POST'], ['/api/oauth/grants', 'GET'], ['/api/oauth/grants', 'DELETE']] as const) {
      expect(routeIdentityPolicyForRequest(path, method), `${method} ${path}`).toBe('registered');
    }
  });
});

describe('an identity a route established itself', () => {
  const user = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', is_anonymous: false, app_metadata: {}, user_metadata: {}, created_at: '2026-10-01T00:00:00Z' } as User;

  it('is the answer for that client object, with no call to Auth', async () => {
    const client = { auth: { getUser: vi.fn(async () => ({ data: { user: null as User | null }, error: null as unknown })) } };
    registerAdmittedIdentity(client, user);
    await expect(getVerifiedIdentityAdmission(client)).resolves.toEqual({ state: 'active', user });
    const { data } = await getVerifiedAuthUserResult(client);
    expect(data.user).toBe(user);
    expect(client.auth.getUser).not.toHaveBeenCalled();
  });

  it('says nothing of any other client object', async () => {
    const admitted = {};
    registerAdmittedIdentity(admitted, user);
    await expect(getVerifiedIdentityAdmission({})).resolves.toBeNull();
    const other = { auth: { getUser: vi.fn(async () => ({ data: { user: null as User | null }, error: new Error('no session') as unknown })) } };
    const { data, error } = await getVerifiedAuthUserResult(other);
    expect(data.user).toBeNull();
    expect(error).toBeInstanceOf(Error);
    expect(other.auth.getUser).toHaveBeenCalledTimes(1);
  });
});
