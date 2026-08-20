import { describe, expect, it, vi } from 'vitest';

import {
  deleteAdminSessionResponse,
  postAdminSessionResponse,
} from '@/lib/admin-auth-route-adapter-service';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
  deriveAdminCredentialVersion,
  verifyAdminSessionToken,
} from '@/lib/admin-session-token';

const SECRET = 'r'.repeat(48);
const REVIEWER_ID = '3f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c31';
const SESSION_ID = '8f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c35';
const PASSWORD_HASH = `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'A'.repeat(86)}`;
const NOW = new Date('2026-08-19T11:00:00.000Z');

function environment(): NodeJS.ProcessEnv {
  return {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: PASSWORD_HASH,
    ADMIN_SESSION_SECRET: SECRET,
    ADMIN_REVIEWER_USER_ID: REVIEWER_ID,
    NODE_ENV: 'test',
  } as unknown as NodeJS.ProcessEnv;
}

async function sessionToken() {
  return createAdminSessionToken({
    secret: SECRET,
    sessionId: SESSION_ID,
    credentialVersion: await deriveAdminCredentialVersion({
      secret: SECRET,
      passwordHash: PASSWORD_HASH,
    }),
    issuedAt: NOW,
    ttlSeconds: 3600,
  });
}

describe('admin session route', () => {
  it('persists the authoritative session before issuing a v2 cookie', async () => {
    const insert = vi.fn().mockResolvedValue({ error: null });
    const client = { from: vi.fn(() => ({ insert })) } as never;

    const response = await postAdminSessionResponse(new Request(
      'https://magicbooklet.com/api/admin/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'correct password' }),
      },
    ), {
      createServiceClient: () => client,
      enforceBackendRateLimit: vi.fn().mockResolvedValue(undefined),
      verifyAdminPassword: vi.fn().mockResolvedValue(true),
      createSessionId: () => SESSION_ID,
      environment: environment(),
      now: () => NOW,
    });

    expect(response.status).toBe(200);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]?.[0]).toMatchObject({
      session_id: SESSION_ID,
      subject: 'master',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    });

    const cookie = response.headers.get('set-cookie') ?? '';
    const token = cookie.match(new RegExp(`${ADMIN_SESSION_COOKIE}=([^;]+)`))?.[1];
    const verification = await verifyAdminSessionToken(token, { secret: SECRET, now: NOW });
    expect(verification.valid).toBe(true);
    if (verification.valid) expect(verification.payload.sid).toBe(SESSION_ID);
  });

  it('does not issue a cookie when authoritative session storage fails', async () => {
    const insert = vi.fn().mockResolvedValue({ error: { message: 'database offline' } });
    const client = { from: vi.fn(() => ({ insert })) } as never;

    const response = await postAdminSessionResponse(new Request(
      'https://magicbooklet.com/api/admin/session',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'correct password' }),
      },
    ), {
      createServiceClient: () => client,
      enforceBackendRateLimit: vi.fn().mockResolvedValue(undefined),
      verifyAdminPassword: vi.fn().mockResolvedValue(true),
      createSessionId: () => SESSION_ID,
      environment: environment(),
      now: () => NOW,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('revokes the server row before clearing the cookie', async () => {
    const token = await sessionToken();
    const is = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn(() => ({ is }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: vi.fn(() => ({ update })) } as never;

    const response = await deleteAdminSessionResponse(new Request(
      'https://magicbooklet.com/api/admin/session',
      { method: 'DELETE', headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } },
    ), {
      createServiceClient: () => client,
      environment: environment(),
      now: () => NOW,
    });

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ revoked_at: NOW.toISOString() });
    expect(eq).toHaveBeenCalledWith('session_id', SESSION_ID);
    expect(response.headers.get('set-cookie')).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('keeps the cookie when revocation cannot be confirmed', async () => {
    const token = await sessionToken();
    const is = vi.fn().mockResolvedValue({ error: { message: 'database offline' } });
    const eq = vi.fn(() => ({ is }));
    const update = vi.fn(() => ({ eq }));
    const client = { from: vi.fn(() => ({ update })) } as never;

    const response = await deleteAdminSessionResponse(new Request(
      'https://magicbooklet.com/api/admin/session',
      { method: 'DELETE', headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } },
    ), {
      createServiceClient: () => client,
      environment: environment(),
      now: () => NOW,
    });

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});
