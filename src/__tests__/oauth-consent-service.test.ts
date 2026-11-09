import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_ACCESS,
  CONSENT_DECISION_FAILED_MESSAGE,
  CONSENT_UNAVAILABLE_MESSAGE,
  buildConsentPath,
  buildConsentSignInHref,
  decideConsent,
  describeRedirectTarget,
  gateConsentRequest,
  loadConsentView,
  normalizeAuthorizationId,
  type OAuthConsentClient,
} from '@/lib/oauth-consent-service';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';
import { getPromptEnhancementCost } from '@/lib/prompt-enhancer';

const AUTHORIZATION_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const DETAILS = {
  authorization_id: AUTHORIZATION_ID,
  redirect_uri: 'http://localhost:8976/callback',
  client: { id: 'client-1', name: 'Claude Code', uri: 'https://claude.com/claude-code', logo_uri: '' },
  user: { id: 'user-1', email: 'creator@example.com' },
  scope: 'email',
};

function client(overrides: Partial<Record<keyof OAuthConsentClient, unknown>> = {}): OAuthConsentClient & Record<keyof OAuthConsentClient, ReturnType<typeof vi.fn>> {
  return {
    getAuthorizationDetails: vi.fn(async () => ({ data: DETAILS, error: null })),
    approveAuthorization: vi.fn(async () => ({ data: { redirect_url: 'http://localhost:8976/callback?code=abc&state=xyz' }, error: null })),
    denyAuthorization: vi.fn(async () => ({ data: { redirect_url: 'http://localhost:8976/callback?error=access_denied&state=xyz' }, error: null })),
    ...overrides,
  } as OAuthConsentClient & Record<keyof OAuthConsentClient, ReturnType<typeof vi.fn>>;
}

describe('consent gate', () => {
  it('takes only a well-formed authorization id', () => {
    expect(normalizeAuthorizationId(AUTHORIZATION_ID)).toBe(AUTHORIZATION_ID);
    expect(normalizeAuthorizationId(` ${AUTHORIZATION_ID} `)).toBe(AUTHORIZATION_ID);
    for (const bad of ['', 'short', 'has spaces in it', 'x'.repeat(129), 42, null, undefined, ['a']]) {
      expect(normalizeAuthorizationId(bad), String(bad)).toBeNull();
    }
    expect(gateConsentRequest({ authorizationId: undefined, user: { is_anonymous: false, email: 'a@b.c' } })).toEqual({ kind: 'missing' });
  });

  it('sends a signed-out visitor to sign in with a return that keeps the authorization id', () => {
    const gate = gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: null });
    expect(gate).toEqual({ kind: 'sign_in', href: buildConsentSignInHref(AUTHORIZATION_ID) });
    const href = new URL((gate as { href: string }).href, 'https://magicbooklet.test');
    expect(href.pathname).toBe('/login');
    // The login page reads `next` through getSafeAuthNextPath, which keeps the query intact.
    expect(getSafeAuthNextPath(href.searchParams.get('next'))).toBe(buildConsentPath(AUTHORIZATION_ID));
    expect(buildConsentPath(AUTHORIZATION_ID)).toBe(`/oauth/consent?authorization_id=${AUTHORIZATION_ID}`);
  });

  it('shows a guest the sign-in wall and lets an account through with its email', () => {
    expect(gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: { is_anonymous: true, email: undefined } }))
      .toEqual({ kind: 'guest', href: buildConsentSignInHref(AUTHORIZATION_ID) });
    expect(gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: { is_anonymous: false, email: ' creator@example.com ' } }))
      .toEqual({ kind: 'account', authorizationId: AUTHORIZATION_ID, email: 'creator@example.com' });
    expect(gateConsentRequest({ authorizationId: AUTHORIZATION_ID, user: { is_anonymous: false, email: undefined } }))
      .toMatchObject({ kind: 'account', email: null });
  });

  it('describes the fixed access an agent gets, never a scope string, and names the one unquoted charge', () => {
    expect(AGENT_ACCESS.map((item) => item.title)).toEqual([
      'Create images and videos with your credits',
      'Publish posts as you',
      'Read your creations',
    ]);
    expect(JSON.stringify(AGENT_ACCESS)).not.toMatch(/openid|scope/i);
    // Prompt enhancement charges with no price step; the consent screen says so with the service's own cost.
    expect(AGENT_ACCESS[0].detail).toContain(`except prompt enhancement, a fixed ${getPromptEnhancementCost()} credit`);
  });
});

describe('redirect targets', () => {
  it('names the host and flags a loopback address', () => {
    expect(describeRedirectTarget('http://localhost:8976/callback')).toEqual({ host: 'localhost:8976', loopback: true });
    expect(describeRedirectTarget('http://127.0.0.1:1455/callback/abc')).toEqual({ host: '127.0.0.1:1455', loopback: true });
    expect(describeRedirectTarget('http://[::1]:9000/cb')).toEqual({ host: '[::1]:9000', loopback: true });
    expect(describeRedirectTarget('http://app.localhost/cb')).toEqual({ host: 'app.localhost', loopback: true });
    expect(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback')).toEqual({ host: 'claude.ai', loopback: false });
    expect(describeRedirectTarget('https://www.cursor.com/agents/mcp/oauth/callback')).toEqual({ host: 'www.cursor.com', loopback: false });
    expect(describeRedirectTarget('not a url')).toBeNull();
  });
});

describe('loading the consent view', () => {
  it('follows GoTrue\'s redirect when the account already consented to this client', async () => {
    const fake = client({
      getAuthorizationDetails: vi.fn(async () => ({ data: { redirect_url: 'http://localhost:8976/callback?code=again' }, error: null })),
    });
    await expect(loadConsentView(fake, AUTHORIZATION_ID)).resolves.toEqual({
      ok: true,
      view: { kind: 'redirect', redirectUrl: 'http://localhost:8976/callback?code=again' },
    });
    expect(fake.getAuthorizationDetails).toHaveBeenCalledWith(AUTHORIZATION_ID);
  });

  it('shows the client, its site, and where the browser returns, without the scope', async () => {
    await expect(loadConsentView(client(), AUTHORIZATION_ID)).resolves.toEqual({
      ok: true,
      view: {
        kind: 'consent',
        details: {
          authorizationId: AUTHORIZATION_ID,
          clientName: 'Claude Code',
          clientUri: 'https://claude.com/claude-code',
          redirectUri: 'http://localhost:8976/callback',
          redirect: { host: 'localhost:8976', loopback: true },
        },
      },
    });
    const bare = client({
      getAuthorizationDetails: vi.fn(async () => ({
        data: { ...DETAILS, client: { ...DETAILS.client, name: '  ', uri: 'javascript:alert(1)' } },
        error: null,
      })),
    });
    const result = await loadConsentView(bare, AUTHORIZATION_ID);
    expect(result.ok && result.view.kind === 'consent' ? result.view.details : null).toMatchObject({ clientName: 'An app', clientUri: null });
  });

  it('answers an expired or unreadable request in words, never with the raw error', async () => {
    for (const fake of [
      client({ getAuthorizationDetails: vi.fn(async () => ({ data: null, error: { message: 'authorization not found' } })) }),
      client({ getAuthorizationDetails: vi.fn(async () => ({ data: null, error: null })) }),
      client({ getAuthorizationDetails: vi.fn(async () => ({ data: { authorization_id: AUTHORIZATION_ID } as never, error: null })) }),
      // A redirect the browser must not be sent into: only http(s) is followed.
      client({ getAuthorizationDetails: vi.fn(async () => ({ data: { redirect_url: 'javascript:alert(1)' }, error: null })) }),
      client({ getAuthorizationDetails: vi.fn(async () => ({ data: { redirect_url: 'myapp://callback?code=x' }, error: null })) }),
    ]) {
      await expect(loadConsentView(fake, AUTHORIZATION_ID)).resolves.toEqual({ ok: false, message: CONSENT_UNAVAILABLE_MESSAGE });
    }
  });
});

describe('deciding', () => {
  it('approves and denies without GoTrue\'s own redirect, and hands back the URL to follow', async () => {
    const fake = client();
    await expect(decideConsent(fake, AUTHORIZATION_ID, 'approve')).resolves.toEqual({
      ok: true,
      redirectUrl: 'http://localhost:8976/callback?code=abc&state=xyz',
    });
    expect(fake.approveAuthorization).toHaveBeenCalledWith(AUTHORIZATION_ID, { skipBrowserRedirect: true });
    expect(fake.denyAuthorization).not.toHaveBeenCalled();

    await expect(decideConsent(fake, AUTHORIZATION_ID, 'deny')).resolves.toEqual({
      ok: true,
      redirectUrl: 'http://localhost:8976/callback?error=access_denied&state=xyz',
    });
    expect(fake.denyAuthorization).toHaveBeenCalledWith(AUTHORIZATION_ID, { skipBrowserRedirect: true });
  });

  it('says so when the answer did not go through, or came back with a redirect that is not http(s)', async () => {
    const failing = client({
      approveAuthorization: vi.fn(async () => ({ data: null, error: { message: 'network' } })),
      denyAuthorization: vi.fn(async () => ({ data: { not_a_redirect: true } as never, error: null })),
    });
    await expect(decideConsent(failing, AUTHORIZATION_ID, 'approve')).resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
    await expect(decideConsent(failing, AUTHORIZATION_ID, 'deny')).resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });

    const unsafe = client({
      approveAuthorization: vi.fn(async () => ({ data: { redirect_url: 'javascript:alert(1)' }, error: null })),
    });
    await expect(decideConsent(unsafe, AUTHORIZATION_ID, 'approve')).resolves.toEqual({ ok: false, message: CONSENT_DECISION_FAILED_MESSAGE });
  });
});
