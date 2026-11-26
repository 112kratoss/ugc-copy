import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentOAuthError, type AgentOAuthClient } from '@/lib/agent-oauth-request';
import { codeChallengeS256, hashAgentSecret } from '@/lib/agent-oauth-tokens';
import { AGENT_ACCESS, POSTING_AGENT_ACCESS } from '@/lib/oauth-consent-service';

/**
 * The store, in memory, with the rules the migration's functions hold
 * (`20261126121704_agent_oauth_server.sql`, proved against Postgres by
 * `supabase/tests/database/agent_oauth_server.test.sql`): a code is consumed once and a replay
 * revokes its grant; a refresh token rotates, and its reuse past the grace revokes the grant.
 */
const store = vi.hoisted(() => {
  type Authorization = {
    id: string; clientId: string; redirectUri: string; surface: 'full' | 'posts'; scope: string | null; state: string | null;
    codeChallenge: string; userId: string | null; consentTokenHash: string | null;
    status: 'pending' | 'approved' | 'denied' | 'consumed'; codeHash: string | null; codeExpiresAt: string | null;
    grantId: string | null; expiresAt: string;
  };
  type Grant = { id: string; userId: string; clientId: string; surface: 'full' | 'posts'; createdAt: string; revokedAt: string | null; reason: string | null };
  type Token = { hash: string; kind: 'access' | 'refresh'; grantId: string; expiresAt: number; usedAt: number | null; createdAt: number };
  const state = {
    now: Date.parse('2026-11-26T12:00:00.000Z'),
    clients: new Map<string, AgentOAuthClient>(),
    authorizations: new Map<string, Authorization>(),
    grants: new Map<string, Grant>(),
    tokens: new Map<string, Token>(),
    purges: 0,
    nextGrant: 1,
  };
  const revokeGrant = (grantId: string | null, reason: string) => {
    const grant = grantId ? state.grants.get(grantId) : null;
    if (!grant) return false;
    const was = grant.revokedAt === null;
    if (was) { grant.revokedAt = new Date(state.now).toISOString(); grant.reason = reason; }
    for (const [hash, token] of state.tokens) if (token.grantId === grantId) state.tokens.delete(hash);
    return was;
  };
  return { state, revokeGrant };
});

vi.mock('@/lib/agent-oauth-store', () => {
  const { state, revokeGrant } = store;
  const issue = (grantId: string, accessHash: string, refreshHash: string, accessTtl: number, refreshTtl: number) => {
    state.tokens.set(accessHash, { hash: accessHash, kind: 'access', grantId, expiresAt: state.now + accessTtl * 1000, usedAt: null, createdAt: state.now });
    state.tokens.set(refreshHash, { hash: refreshHash, kind: 'refresh', grantId, expiresAt: state.now + refreshTtl * 1000, usedAt: null, createdAt: state.now });
  };
  return {
    findAgentOAuthClient: vi.fn(async (_admin: unknown, clientId: string) => state.clients.get(clientId) ?? null),
    insertAgentOAuthAuthorization: vi.fn(async (_admin: unknown, request: { id: string; clientId: string; redirectUri: string; surface: 'full' | 'posts'; scope: string | null; state: string | null; codeChallenge: string; expiresAt: string }) => {
      state.authorizations.set(request.id, { ...request, userId: null, consentTokenHash: null, status: 'pending', codeHash: null, codeExpiresAt: null, grantId: null });
    }),
    bindAgentOAuthAuthorization: vi.fn(async (_admin: unknown, input: { id: string; userId: string; consentTokenHash: string; now: string }) => {
      const row = state.authorizations.get(input.id);
      if (!row || row.status !== 'pending' || Date.parse(row.expiresAt) <= Date.parse(input.now)) return null;
      if (row.userId !== null && row.userId !== input.userId) return null;
      row.userId = input.userId;
      row.consentTokenHash = input.consentTokenHash;
      return { ...row };
    }),
    findAgentOAuthAuthorization: vi.fn(async (_admin: unknown, id: string) => {
      const row = state.authorizations.get(id);
      return row ? { ...row } : null;
    }),
    decideAgentOAuthAuthorization: vi.fn(async (_admin: unknown, input: { id: string; userId: string; consentTokenHash: string; now: string; decision: { status: 'approved'; codeHash: string; codeExpiresAt: string } | { status: 'denied' } }) => {
      const row = state.authorizations.get(input.id);
      if (!row || row.status !== 'pending' || row.userId !== input.userId || row.consentTokenHash !== input.consentTokenHash) return false;
      if (Date.parse(row.expiresAt) <= Date.parse(input.now)) return false;
      row.status = input.decision.status;
      row.consentTokenHash = null;
      if (input.decision.status === 'approved') {
        row.codeHash = input.decision.codeHash;
        row.codeExpiresAt = input.decision.codeExpiresAt;
      }
      return true;
    }),
    consumeAgentOAuthCode: vi.fn(async (_admin: unknown, codeHash: string) => {
      const row = [...state.authorizations.values()].find((candidate) => candidate.codeHash === codeHash);
      if (!row) return { outcome: 'invalid' };
      if (row.status === 'consumed') {
        revokeGrant(row.grantId, 'code_replay');
        return { outcome: 'replayed' };
      }
      if (row.status !== 'approved' || !row.codeExpiresAt || Date.parse(row.codeExpiresAt) <= state.now || !row.userId) return { outcome: 'invalid' };
      row.status = 'consumed';
      return { outcome: 'consumed', authorizationId: row.id, clientId: row.clientId, redirectUri: row.redirectUri, codeChallenge: row.codeChallenge, surface: row.surface, userId: row.userId };
    }),
    issueAgentOAuthGrant: vi.fn(async (_admin: unknown, input: { authorizationId: string; accessHash: string; refreshHash: string; accessTtlSeconds: number; refreshTtlSeconds: number }) => {
      const row = state.authorizations.get(input.authorizationId);
      if (!row || row.status !== 'consumed' || row.grantId || !row.userId) return null;
      const grantId = `grant-${state.nextGrant++}`;
      state.grants.set(grantId, { id: grantId, userId: row.userId, clientId: row.clientId, surface: row.surface, createdAt: new Date(state.now).toISOString(), revokedAt: null, reason: null });
      row.grantId = grantId;
      issue(grantId, input.accessHash, input.refreshHash, input.accessTtlSeconds, input.refreshTtlSeconds);
      return { grantId, userId: row.userId, clientId: row.clientId, surface: row.surface };
    }),
    rotateAgentOAuthRefreshToken: vi.fn(async (_admin: unknown, input: { refreshHash: string; clientId: string; accessHash: string; newRefreshHash: string; accessTtlSeconds: number; refreshTtlSeconds: number; reuseGraceSeconds: number }) => {
      const token = state.tokens.get(input.refreshHash);
      if (!token || token.kind !== 'refresh') return { outcome: 'invalid' };
      const grant = state.grants.get(token.grantId);
      if (!grant || grant.clientId !== input.clientId || grant.revokedAt) return { outcome: 'invalid' };
      if (token.expiresAt <= state.now) return { outcome: 'invalid' };
      if (token.usedAt !== null && token.usedAt < state.now - input.reuseGraceSeconds * 1000) {
        revokeGrant(grant.id, 'reuse');
        return { outcome: 'reuse_detected', grantId: grant.id, userId: grant.userId };
      }
      // Twelve refresh tokens of one grant an hour (20261126151150): the next is told to wait.
      const thisHour = [...state.tokens.values()].filter((row) => row.grantId === grant.id && row.kind === 'refresh' && row.createdAt > state.now - 3_600_000);
      if (thisHour.length >= 12) return { outcome: 'rate_limited', grantId: grant.id, userId: grant.userId };
      token.usedAt ??= state.now;
      issue(grant.id, input.accessHash, input.newRefreshHash, input.accessTtlSeconds, input.refreshTtlSeconds);
      return { outcome: 'rotated', grantId: grant.id, userId: grant.userId, clientId: grant.clientId, surface: grant.surface };
    }),
    revokeAgentOAuthGrants: vi.fn(async (_admin: unknown, input: { userId: string; clientId: string | null; reason: string }) => {
      let count = 0;
      for (const grant of state.grants.values()) {
        const named = input.clientId === null || grant.clientId === input.clientId;
        if (grant.userId === input.userId && named && revokeGrant(grant.id, input.reason)) count += 1;
      }
      return count;
    }),
    revokeAgentOAuthToken: vi.fn(async (_admin: unknown, input: { tokenHash: string; clientId: string }) => {
      const token = state.tokens.get(input.tokenHash);
      const grant = token ? state.grants.get(token.grantId) : null;
      if (!grant || grant.clientId !== input.clientId) return false;
      return revokeGrant(grant.id, 'client');
    }),
    listLiveAgentOAuthGrants: vi.fn(async (_admin: unknown, userId: string) => [...state.grants.values()]
      .filter((grant) => grant.userId === userId && !grant.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((grant) => ({
        clientId: grant.clientId,
        clientName: state.clients.get(grant.clientId)?.clientName ?? grant.clientId,
        clientUri: state.clients.get(grant.clientId)?.clientUri ?? null,
        surface: grant.surface,
        createdAt: grant.createdAt,
      }))),
    purgeExpiredAgentOAuthRows: vi.fn(async () => { state.purges += 1; }),
  };
});

const {
  authenticateAgentOAuthClient,
  decideAgentConsent,
  disconnectAgentClient,
  disconnectEveryAgentClient,
  exchangeAgentToken,
  isAgentAuthorizationId,
  listAgentGrants,
  loadAgentConsent,
  revokeAgentToken,
  startAgentAuthorization,
} = await import('@/lib/agent-oauth-server-service');

const SITE = 'https://magicbooklet.test';
const admin = {} as SupabaseClient;
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const PUBLIC_CLIENT = 'cf5743f9-c83c-4f6c-9afb-0803d5aee698';
const POSTING_CLIENT = '1e2e3615-17a1-448f-9d4c-5cbcd2a572a7';
const CONFIDENTIAL_CLIENT = '1b4db392-2141-413b-be41-f833dfdcab42';
const REDIRECT = 'http://localhost:8976/callback';
const HOSTED_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const SECRET = 'the-directory-client-secret';

const now = () => new Date(store.state.now);
const options = { admin, siteOrigin: SITE, now };
const advance = (seconds: number) => { store.state.now += seconds * 1000; };

function register(client: Partial<AgentOAuthClient> & { clientId: string }) {
  store.state.clients.set(client.clientId, {
    clientName: 'Claude Code', clientUri: 'https://claude.com/claude-code', redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: 'none', clientSecretHash: null, surface: 'full', disabledAt: null, ...client,
  });
}

beforeEach(() => {
  const { state } = store;
  state.now = Date.parse('2026-11-26T12:00:00.000Z');
  state.clients.clear();
  state.authorizations.clear();
  state.grants.clear();
  state.tokens.clear();
  state.purges = 0;
  state.nextGrant = 1;
  register({ clientId: PUBLIC_CLIENT });
  register({ clientId: POSTING_CLIENT, clientName: 'Claude (posting)', redirectUris: [HOSTED_REDIRECT], surface: 'posts' });
  register({
    clientId: CONFIDENTIAL_CLIENT, clientName: 'Claude directory', redirectUris: [HOSTED_REDIRECT], surface: 'posts',
    tokenEndpointAuthMethod: 'client_secret_post', clientSecretHash: hashAgentSecret(SECRET),
  });
});

function authorizeQuery(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: 'code', client_id: PUBLIC_CLIENT, redirect_uri: REDIRECT, state: 'st', code_challenge: codeChallengeS256(VERIFIER),
    code_challenge_method: 'S256', resource: `${SITE}/api/mcp`, ...overrides,
  });
}

async function start(overrides: Record<string, string> = {}): Promise<string> {
  const started = await startAgentAuthorization(authorizeQuery(overrides), options);
  if (started.kind !== 'consent') throw new Error(`not started: ${JSON.stringify(started)}`);
  return new URL(started.location, SITE).searchParams.get('authorization_id') as string;
}

async function approve(authorizationId: string, userId = USER) {
  const loaded = await loadAgentConsent({ authorizationId, userId }, options);
  if (!loaded) throw new Error('consent not loaded');
  const decided = await decideAgentConsent({ authorizationId, userId, consentToken: loaded.consentToken, decision: 'approve' }, options);
  if (!decided) throw new Error('not decided');
  return { code: new URL(decided.redirectUrl).searchParams.get('code') as string, redirectUrl: decided.redirectUrl, loaded };
}

const tokenForm = (fields: Record<string, string>) => ({ form: new URLSearchParams(fields), authorizationHeader: null });
const codeForm = (code: string, overrides: Record<string, string> = {}) => tokenForm({
  grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: PUBLIC_CLIENT, redirect_uri: REDIRECT, ...overrides,
});

async function connect(overrides: Record<string, string> = {}) {
  const { code } = await approve(await start(overrides));
  return exchangeAgentToken(codeForm(code, overrides.client_id ? { client_id: overrides.client_id, redirect_uri: overrides.redirect_uri ?? REDIRECT } : {}), options);
}

async function refusal(run: Promise<unknown>): Promise<AgentOAuthError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentOAuthError);
    return error as AgentOAuthError;
  }
  throw new Error('expected a refusal');
}

describe('the authorization request', () => {
  it('stores a valid request and sends the browser to the consent page with its id', async () => {
    const started = await startAgentAuthorization(authorizeQuery(), options);
    expect(started.kind).toBe('consent');
    const id = new URL((started as { location: string }).location, SITE).searchParams.get('authorization_id');
    expect(id).toMatch(/^mbar_[A-Za-z0-9_-]{43}$/);
    expect(isAgentAuthorizationId(id)).toBe(true);
    expect(isAgentAuthorizationId('a2b4c6d8e0f2a4b6c8d0e2f4a6b8c0d2')).toBe(false);
    const row = store.state.authorizations.get(id as string);
    expect(row).toMatchObject({ clientId: PUBLIC_CLIENT, redirectUri: REDIRECT, surface: 'full', state: 'st', status: 'pending', userId: null });
    // Ten minutes to answer.
    expect(Date.parse(row!.expiresAt) - store.state.now).toBe(600_000);
  });

  it('stores nothing for a request it refuses, and tells the client where it can', async () => {
    const unknown = await startAgentAuthorization(authorizeQuery({ client_id: 'unknown-client-id' }), options);
    expect(unknown.kind).toBe('page');
    const badRedirect = await startAgentAuthorization(authorizeQuery({ redirect_uri: 'https://evil.test/cb' }), options);
    expect(badRedirect.kind).toBe('page');
    const noPkce = await startAgentAuthorization(authorizeQuery({ code_challenge_method: 'plain' }), options);
    expect(noPkce.kind).toBe('redirect');
    const location = new URL((noPkce as { location: string }).location);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('st');
    expect(store.state.authorizations.size).toBe(0);
  });
});

describe('the consent page', () => {
  it('shows the request to the signed-in account with the access list of the server it is for', async () => {
    const full = await loadAgentConsent({ authorizationId: await start(), userId: USER }, options);
    expect(full?.details).toMatchObject({ clientName: 'Claude Code', clientUri: 'https://claude.com/claude-code', redirectUri: REDIRECT, redirect: { host: 'localhost:8976', loopback: true } });
    expect(full?.details.access).toBe(AGENT_ACCESS);
    expect(full?.consentToken).toMatch(/^mbct_[A-Za-z0-9_-]{43}$/);

    // The posting list for a grant to the posting server: a posting-only client's, and a full client's.
    const postingId = await start({ client_id: POSTING_CLIENT, redirect_uri: HOSTED_REDIRECT, resource: `${SITE}/api/mcp/posts` });
    expect((await loadAgentConsent({ authorizationId: postingId, userId: USER }, options))?.details.access).toBe(POSTING_AGENT_ACCESS);
    const fullClientAtPosts = await start({ resource: `${SITE}/api/mcp/posts` });
    expect((await loadAgentConsent({ authorizationId: fullClientAtPosts, userId: USER }, options))?.details.access).toBe(POSTING_AGENT_ACCESS);
  });

  it('stores only the hash of the consent token', async () => {
    const id = await start();
    const loaded = await loadAgentConsent({ authorizationId: id, userId: USER }, options);
    const row = store.state.authorizations.get(id)!;
    expect(row.consentTokenHash).toBe(hashAgentSecret(loaded!.consentToken));
    expect(JSON.stringify(row)).not.toContain(loaded!.consentToken);
  });

  it('binds the request to the first account it is shown to, and shows it to no other', async () => {
    const id = await start();
    expect(await loadAgentConsent({ authorizationId: id, userId: USER }, options)).not.toBeNull();
    expect(await loadAgentConsent({ authorizationId: id, userId: OTHER_USER }, options)).toBeNull();
    expect(store.state.authorizations.get(id)!.userId).toBe(USER);
  });

  it('has nothing to show for an unknown, expired or answered request, or a disabled client', async () => {
    expect(await loadAgentConsent({ authorizationId: `mbar_${'A'.repeat(43)}`, userId: USER }, options)).toBeNull();
    expect(await loadAgentConsent({ authorizationId: 'gotrue-style-id-0123456789abcdef', userId: USER }, options)).toBeNull();
    const expired = await start();
    advance(601);
    expect(await loadAgentConsent({ authorizationId: expired, userId: USER }, options)).toBeNull();
    const answered = await start();
    await approve(answered);
    expect(await loadAgentConsent({ authorizationId: answered, userId: USER }, options)).toBeNull();
    const disabled = await start();
    store.state.clients.get(PUBLIC_CLIENT)!.disabledAt = '2026-11-26T12:00:00Z';
    expect(await loadAgentConsent({ authorizationId: disabled, userId: USER }, options)).toBeNull();
  });
});

describe("the account's answer", () => {
  it('issues a code to the registered redirect URI, with the state, and stores only its hash', async () => {
    const id = await start();
    const { code, redirectUrl } = await approve(id);
    expect(code).toMatch(/^mbac_[A-Za-z0-9_-]{43}$/);
    expect(redirectUrl.startsWith(`${REDIRECT}?`)).toBe(true);
    expect(new URL(redirectUrl).searchParams.get('state')).toBe('st');
    const row = store.state.authorizations.get(id)!;
    expect(row.status).toBe('approved');
    expect(row.codeHash).toBe(hashAgentSecret(code));
    expect(Date.parse(row.codeExpiresAt!) - store.state.now).toBe(120_000);
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('sends access_denied for a refusal, and no code', async () => {
    const id = await start();
    const loaded = await loadAgentConsent({ authorizationId: id, userId: USER }, options);
    const decided = await decideAgentConsent({ authorizationId: id, userId: USER, consentToken: loaded!.consentToken, decision: 'deny' }, options);
    const url = new URL(decided!.redirectUrl);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('code')).toBeNull();
    expect(url.searchParams.get('state')).toBe('st');
    expect(store.state.authorizations.get(id)!.status).toBe('denied');
  });

  it('counts only from the account the page was rendered for, with the token of that render', async () => {
    const id = await start();
    const loaded = await loadAgentConsent({ authorizationId: id, userId: USER }, options);
    const answer = (overrides: Partial<{ userId: string; consentToken: string }>) => decideAgentConsent(
      { authorizationId: id, userId: USER, consentToken: loaded!.consentToken, decision: 'approve', ...overrides },
      options,
    );
    expect(await answer({ userId: OTHER_USER })).toBeNull();
    expect(await answer({ consentToken: `mbct_${'A'.repeat(43)}` })).toBeNull();
    expect(await answer({ consentToken: 'not-a-consent-token' })).toBeNull();
    expect(await answer({ consentToken: '' })).toBeNull();
    expect(store.state.authorizations.get(id)!.status).toBe('pending');
    // A later render replaces the token: the earlier page can no longer answer.
    const rerendered = await loadAgentConsent({ authorizationId: id, userId: USER }, options);
    expect(await answer({})).toBeNull();
    expect(await answer({ consentToken: rerendered!.consentToken })).not.toBeNull();
  });

  it('is given once, and not after the request expires or its client is disabled', async () => {
    const id = await start();
    const { loaded } = await approve(id);
    expect(await decideAgentConsent({ authorizationId: id, userId: USER, consentToken: loaded.consentToken, decision: 'approve' }, options)).toBeNull();
    expect(await decideAgentConsent({ authorizationId: id, userId: USER, consentToken: loaded.consentToken, decision: 'deny' }, options)).toBeNull();

    const late = await start();
    const lateLoaded = await loadAgentConsent({ authorizationId: late, userId: USER }, options);
    advance(601);
    expect(await decideAgentConsent({ authorizationId: late, userId: USER, consentToken: lateLoaded!.consentToken, decision: 'approve' }, options)).toBeNull();

    const disabled = await start();
    const disabledLoaded = await loadAgentConsent({ authorizationId: disabled, userId: USER }, options);
    store.state.clients.get(PUBLIC_CLIENT)!.disabledAt = '2026-11-26T12:00:00Z';
    expect(await decideAgentConsent({ authorizationId: disabled, userId: USER, consentToken: disabledLoaded!.consentToken, decision: 'approve' }, options)).toBeNull();
  });
});

describe('the token endpoint: authorization code', () => {
  it('exchanges a code and its verifier for opaque tokens, stored as hashes', async () => {
    const tokens = await connect();
    expect(tokens).toEqual({
      access_token: expect.stringMatching(/^mbat_[A-Za-z0-9_-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^mbrt_[A-Za-z0-9_-]{43}$/),
      scope: 'mcp',
    });
    const access = store.state.tokens.get(hashAgentSecret(tokens.access_token))!;
    const refresh = store.state.tokens.get(hashAgentSecret(tokens.refresh_token))!;
    expect(access).toMatchObject({ kind: 'access', grantId: 'grant-1' });
    expect(access.expiresAt - store.state.now).toBe(3_600_000);
    expect(refresh.expiresAt - store.state.now).toBe(90 * 86_400_000);
    expect([...store.state.tokens.keys()]).not.toContain(tokens.access_token);
    expect(store.state.grants.get('grant-1')).toMatchObject({ userId: USER, clientId: PUBLIC_CLIENT, surface: 'full', revokedAt: null });
    // Housekeeping rode on the authorize request, not on the exchange.
    expect(store.state.purges).toBe(1);
  });

  it('refuses a wrong verifier, and the code is spent', async () => {
    const { code } = await approve(await start());
    const wrong = await refusal(exchangeAgentToken(codeForm(code, { code_verifier: 'x'.repeat(43) }), options));
    expect(wrong.error).toBe('invalid_grant');
    expect(store.state.tokens.size).toBe(0);
    expect((await refusal(exchangeAgentToken(codeForm(code), options))).error).toBe('invalid_grant');
    expect(store.state.grants.size).toBe(0);
  });

  it('refuses a code from another client, a different redirect URI, and a different resource', async () => {
    const forOther = (await approve(await start())).code;
    register({ clientId: 'another-public-client', redirectUris: [REDIRECT] });
    expect((await refusal(exchangeAgentToken(codeForm(forOther, { client_id: 'another-public-client' }), options))).error).toBe('invalid_grant');

    const redirectCode = (await approve(await start())).code;
    expect((await refusal(exchangeAgentToken(codeForm(redirectCode, { redirect_uri: 'http://localhost:9999/callback' }), options))).error).toBe('invalid_grant');

    const resourceCode = (await approve(await start())).code;
    expect((await refusal(exchangeAgentToken(codeForm(resourceCode, { resource: `${SITE}/api/mcp/posts` }), options))).error).toBe('invalid_target');
    expect(store.state.tokens.size).toBe(0);
  });

  it('takes a matching resource, and no redirect URI, as OAuth 2.1 allows', async () => {
    const { code } = await approve(await start());
    const form = tokenForm({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: PUBLIC_CLIENT, resource: `${SITE}/api/mcp/` });
    await expect(exchangeAgentToken(form, options)).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('refuses an expired code, an unknown one, and anything that is not a code', async () => {
    const { code } = await approve(await start());
    advance(121);
    expect((await refusal(exchangeAgentToken(codeForm(code), options))).error).toBe('invalid_grant');
    expect((await refusal(exchangeAgentToken(codeForm(`mbac_${'A'.repeat(43)}`), options))).error).toBe('invalid_grant');
    expect((await refusal(exchangeAgentToken(codeForm('eyJhbGciOiJFUzI1NiJ9.e30.sig'), options))).error).toBe('invalid_grant');
  });

  it('revokes the grant a code produced when the code is presented again', async () => {
    const { code } = await approve(await start());
    const tokens = await exchangeAgentToken(codeForm(code), options);
    expect((await refusal(exchangeAgentToken(codeForm(code), options))).error).toBe('invalid_grant');
    expect(store.state.grants.get('grant-1')).toMatchObject({ reason: 'code_replay' });
    expect(store.state.tokens.has(hashAgentSecret(tokens.access_token))).toBe(false);
    expect(store.state.tokens.has(hashAgentSecret(tokens.refresh_token))).toBe(false);
  });
});

describe('the token endpoint: clients', () => {
  it('knows a public client by its id, and refuses one that sends a secret', async () => {
    await expect(authenticateAgentOAuthClient(admin, { clientId: PUBLIC_CLIENT, clientSecret: null, via: 'none' })).resolves.toMatchObject({ clientId: PUBLIC_CLIENT });
    const withSecret = await refusal(authenticateAgentOAuthClient(admin, { clientId: PUBLIC_CLIENT, clientSecret: 'anything', via: 'post' }));
    expect(withSecret).toMatchObject({ error: 'invalid_client', status: 401 });
  });

  it('requires the confidential client\'s own secret', async () => {
    await expect(authenticateAgentOAuthClient(admin, { clientId: CONFIDENTIAL_CLIENT, clientSecret: SECRET, via: 'post' })).resolves.toMatchObject({ clientId: CONFIDENTIAL_CLIENT });
    await expect(authenticateAgentOAuthClient(admin, { clientId: CONFIDENTIAL_CLIENT, clientSecret: SECRET, via: 'basic' })).resolves.toMatchObject({ clientId: CONFIDENTIAL_CLIENT });
    for (const clientSecret of [null, '', 'wrong', `${SECRET} `, hashAgentSecret(SECRET)]) {
      const refused = await refusal(authenticateAgentOAuthClient(admin, { clientId: CONFIDENTIAL_CLIENT, clientSecret, via: 'post' }));
      expect(refused, String(clientSecret)).toMatchObject({ error: 'invalid_client', status: 401 });
    }
  });

  it('refuses an unknown and a disabled client the same way', async () => {
    const unknown = await refusal(authenticateAgentOAuthClient(admin, { clientId: 'unknown-client-id', clientSecret: null, via: 'none' }));
    store.state.clients.get(PUBLIC_CLIENT)!.disabledAt = '2026-11-26T12:00:00Z';
    const disabled = await refusal(authenticateAgentOAuthClient(admin, { clientId: PUBLIC_CLIENT, clientSecret: null, via: 'none' }));
    expect(unknown).toMatchObject({ error: 'invalid_client', status: 401 });
    expect(disabled.description).toBe(unknown.description);
  });

  it('issues nothing to the confidential client without its secret, code in hand or not', async () => {
    const id = await start({ client_id: CONFIDENTIAL_CLIENT, redirect_uri: HOSTED_REDIRECT, resource: `${SITE}/api/mcp/posts` });
    const { code } = await approve(id);
    const form = (secret?: string) => tokenForm({
      grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: CONFIDENTIAL_CLIENT, redirect_uri: HOSTED_REDIRECT,
      ...(secret === undefined ? {} : { client_secret: secret }),
    });
    expect((await refusal(exchangeAgentToken(form(), options))).error).toBe('invalid_client');
    expect((await refusal(exchangeAgentToken(form('wrong'), options))).error).toBe('invalid_client');
    // The refusals above came before the code was read: it is still good for the real client.
    await expect(exchangeAgentToken(form(SECRET), options)).resolves.toMatchObject({ scope: 'mcp' });
    expect(store.state.grants.get('grant-1')).toMatchObject({ clientId: CONFIDENTIAL_CLIENT, surface: 'posts' });
  });
});

describe('the token endpoint: refresh', () => {
  const refreshForm = (refreshToken: string, clientId = PUBLIC_CLIENT) => tokenForm({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });

  it('rotates: a new pair every time, the old access token good until it expires', async () => {
    const first = await connect();
    advance(1800);
    const second = await exchangeAgentToken(refreshForm(first.refresh_token), options);
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(store.state.tokens.get(hashAgentSecret(first.refresh_token))!.usedAt).toBe(store.state.now);
    expect(store.state.tokens.has(hashAgentSecret(first.access_token))).toBe(true);
    expect(store.state.tokens.get(hashAgentSecret(second.refresh_token))).toMatchObject({ kind: 'refresh', usedAt: null, grantId: 'grant-1' });
    // No housekeeping on a refresh: that rides on authorize requests.
    expect(store.state.purges).toBe(1);
  });

  it('lets a rotated token be used again within ten seconds, for two processes that raced', async () => {
    const first = await connect();
    const second = await exchangeAgentToken(refreshForm(first.refresh_token), options);
    advance(9);
    const raced = await exchangeAgentToken(refreshForm(first.refresh_token), options);
    expect(raced.access_token).not.toBe(second.access_token);
    expect(store.state.grants.get('grant-1')!.revokedAt).toBeNull();
  });

  it('revokes the grant when a rotated token comes back after the grace', async () => {
    const first = await connect();
    const second = await exchangeAgentToken(refreshForm(first.refresh_token), options);
    advance(11);
    expect((await refusal(exchangeAgentToken(refreshForm(first.refresh_token), options))).error).toBe('invalid_grant');
    expect(store.state.grants.get('grant-1')).toMatchObject({ reason: 'reuse' });
    expect(store.state.tokens.size).toBe(0);
    // The newest pair died with the grant: whoever held it must connect again.
    expect((await refusal(exchangeAgentToken(refreshForm(second.refresh_token), options))).error).toBe('invalid_grant');
  });

  it('tells a grant refreshed twelve times in the hour to wait, and leaves its token good', async () => {
    let tokens = await connect();
    for (let refresh = 1; refresh <= 11; refresh += 1) {
      advance(60);
      tokens = await exchangeAgentToken(refreshForm(tokens.refresh_token), options);
    }
    const refused = await refusal(exchangeAgentToken(refreshForm(tokens.refresh_token), options));
    expect(refused).toMatchObject({ error: 'temporarily_unavailable', status: 429 });
    // Not a refusal of the token: it is unused, the grant stands, and it works once the hour moves on.
    expect(store.state.tokens.get(hashAgentSecret(tokens.refresh_token))!.usedAt).toBeNull();
    expect(store.state.grants.get('grant-1')!.revokedAt).toBeNull();
    advance(3600);
    await expect(exchangeAgentToken(refreshForm(tokens.refresh_token), options)).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('leaves a grant untouched when another client presents its refresh token', async () => {
    const tokens = await connect();
    register({ clientId: 'another-public-client' });
    expect((await refusal(exchangeAgentToken(refreshForm(tokens.refresh_token, 'another-public-client'), options))).error).toBe('invalid_grant');
    expect(store.state.tokens.get(hashAgentSecret(tokens.refresh_token))!.usedAt).toBeNull();
    await expect(exchangeAgentToken(refreshForm(tokens.refresh_token), options)).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('refuses an access token, an expired token, an unknown one and a JWT as a refresh token', async () => {
    const tokens = await connect();
    expect((await refusal(exchangeAgentToken(refreshForm(tokens.access_token), options))).error).toBe('invalid_grant');
    expect((await refusal(exchangeAgentToken(refreshForm(`mbrt_${'A'.repeat(43)}`), options))).error).toBe('invalid_grant');
    expect((await refusal(exchangeAgentToken(refreshForm('eyJhbGciOiJFUzI1NiJ9.e30.sig'), options))).error).toBe('invalid_grant');
    advance(90 * 86_400 + 1);
    expect((await refusal(exchangeAgentToken(refreshForm(tokens.refresh_token), options))).error).toBe('invalid_grant');
    expect(store.state.grants.get('grant-1')!.revokedAt).toBeNull();
  });
});

describe('revocation and Connected apps', () => {
  it('lets a client end its own grant with either token, and says nothing about any other', async () => {
    const tokens = await connect();
    register({ clientId: 'another-public-client' });
    const revoke = (token: string, clientId = PUBLIC_CLIENT) => revokeAgentToken(tokenForm({ token, client_id: clientId }), { admin });
    await revoke(tokens.access_token, 'another-public-client');
    await revoke(`mbat_${'A'.repeat(43)}`);
    await revoke('not-a-token');
    expect(store.state.grants.get('grant-1')!.revokedAt).toBeNull();
    await revoke(tokens.refresh_token);
    expect(store.state.grants.get('grant-1')).toMatchObject({ reason: 'client' });
    expect(store.state.tokens.size).toBe(0);
    expect((await refusal(revokeAgentToken(tokenForm({ client_id: PUBLIC_CLIENT }), { admin }))).error).toBe('invalid_request');
    expect((await refusal(revokeAgentToken(tokenForm({ token: tokens.access_token, client_id: 'unknown-client-id' }), { admin }))).error).toBe('invalid_client');
  });

  it('lists one app per client with its earliest approval, and disconnects all of its grants at once', async () => {
    const first = await connect();
    advance(3600);
    const posts = await connect({ resource: `${SITE}/api/mcp/posts` });
    advance(60);
    const posting = await exchangeAgentToken(
      tokenForm({
        grant_type: 'authorization_code', code_verifier: VERIFIER, client_id: POSTING_CLIENT, redirect_uri: HOSTED_REDIRECT,
        code: (await approve(await start({ client_id: POSTING_CLIENT, redirect_uri: HOSTED_REDIRECT, resource: `${SITE}/api/mcp/posts` }))).code,
      }),
      options,
    );
    expect(await listAgentGrants(admin, USER)).toEqual([
      { clientId: POSTING_CLIENT, name: 'Claude (posting)', uri: 'https://claude.com/claude-code', grantedAt: '2026-11-26T13:01:00.000Z', surface: 'posts' },
      { clientId: PUBLIC_CLIENT, name: 'Claude Code', uri: 'https://claude.com/claude-code', grantedAt: '2026-11-26T12:00:00.000Z', surface: 'full' },
    ]);
    expect(await listAgentGrants(admin, OTHER_USER)).toEqual([]);

    expect(await disconnectAgentClient(admin, { userId: USER, clientId: PUBLIC_CLIENT })).toBe(2);
    for (const token of [first.access_token, first.refresh_token, posts.access_token, posts.refresh_token]) {
      expect(store.state.tokens.has(hashAgentSecret(token))).toBe(false);
    }
    expect(store.state.tokens.has(hashAgentSecret(posting.access_token))).toBe(true);
    expect(await disconnectAgentClient(admin, { userId: USER, clientId: PUBLIC_CLIENT })).toBe(0);
    expect(await disconnectAgentClient(admin, { userId: OTHER_USER, clientId: POSTING_CLIENT })).toBe(0);
    expect((await listAgentGrants(admin, USER)).map((grant) => grant.clientId)).toEqual([POSTING_CLIENT]);
  });

  it('ends every grant of an account at once, and no other account\'s', async () => {
    const mine = await connect();
    const minePosting = await connect({ resource: `${SITE}/api/mcp/posts` });
    const theirsId = await start();
    const theirs = await exchangeAgentToken(codeForm((await approve(theirsId, OTHER_USER)).code), options);

    expect(await disconnectEveryAgentClient(admin, { userId: USER })).toBe(2);
    for (const token of [mine.access_token, mine.refresh_token, minePosting.access_token, minePosting.refresh_token]) {
      expect(store.state.tokens.has(hashAgentSecret(token))).toBe(false);
    }
    expect(store.state.tokens.has(hashAgentSecret(theirs.access_token))).toBe(true);
    expect(await listAgentGrants(admin, USER)).toEqual([]);
    expect(await disconnectEveryAgentClient(admin, { userId: USER })).toBe(0);
  });
});
