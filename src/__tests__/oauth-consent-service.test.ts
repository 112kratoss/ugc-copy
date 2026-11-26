import { describe, expect, it } from 'vitest';

import {
  AGENT_ACCESS,
  POSTING_AGENT_ACCESS,
  agentAccessForSurface,
  buildConsentPath,
  buildConsentSignInHref,
  describeRedirectTarget,
  gateConsentRequest,
  normalizeAuthorizationId,
} from '@/lib/oauth-consent-service';
import { getSafeAuthNextPath } from '@/lib/auth-onboarding';
import { getPromptEnhancementCost } from '@/lib/prompt-enhancer';

const AUTHORIZATION_ID = `mbar_${'a'.repeat(43)}`;

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
    // Publishing covers every source of a post, the creator's creations, media the agent brings
    // from elsewhere and text posts (the MCP server's publish_post), and what a post may carry: a
    // prompt or a guide, free or on sale. All of it is said before the person allows it, in the
    // owner's wording (2026-11-10).
    expect(`${AGENT_ACCESS[1].title}: ${AGENT_ACCESS[1].detail}`).toBe(
      'Publish posts as you: Your creations, pictures and videos the agent brings from elsewhere, and text posts, with prompts or guides attached free or at a price you approve, on your profile, in Explore and in the Marketplace, under your name, with the rules every post follows.',
    );
    // A price is the person's to approve, and a sale reaches the Marketplace: neither is left out.
    expect(AGENT_ACCESS[1].detail).toContain('free or at a price you approve');
    expect(AGENT_ACCESS[1].detail).toContain('in the Marketplace');
    // Prompt enhancement charges with no price step; the consent screen says so with the service's own cost.
    expect(AGENT_ACCESS[0].detail).toContain(`except prompt enhancement, a fixed ${getPromptEnhancementCost()} credit`);
  });

  it('shows a grant for the posting server the posting-only list: every posting tool, no run, no charge', () => {
    expect(agentAccessForSurface('posts')).toBe(POSTING_AGENT_ACCESS);
    expect(agentAccessForSurface('full')).toBe(AGENT_ACCESS);
    expect(POSTING_AGENT_ACCESS.map((item) => item.title)).toEqual([
      'Publish posts as you',
      'Change and delete your posts',
      'Read your creations and posts',
      'No tool that spends credits',
    ]);
    // delete_post and a visibility change are the person's to know before they allow it, and
    // get_post reads another account's post while it is public.
    expect(POSTING_AGENT_ACCESS[1].detail).toBe('Make a post public or private, or delete one of your posts, when you ask.');
    expect(POSTING_AGENT_ACCESS[2].detail).toContain('Of other accounts, only posts that are public.');
    expect(JSON.stringify(POSTING_AGENT_ACCESS)).not.toMatch(/openid|scope|Create images and videos/i);
    // What a post may carry and where a sale goes is said here as on the full list.
    expect(POSTING_AGENT_ACCESS[0].detail).toContain('free or at a price you approve');
    expect(POSTING_AGENT_ACCESS[0].detail).toContain('in the Marketplace');
    // What it has no tool for, said as that.
    expect(POSTING_AGENT_ACCESS[3].detail).toBe('It is given no way to create media, enhance a prompt or use your balance.');
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
