import { describe, expect, it, vi } from 'vitest';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
  deriveAdminCredentialVersion,
} from '@/lib/admin-session-token';

const SECRET = 's'.repeat(48);
const REVIEWER_ID = '3f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c31';
const SESSION_ID = '7f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c34';
const PASSWORD_HASH = `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'A'.repeat(86)}`;
const ROTATED_PASSWORD_HASH = `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'B'.repeat(86)}`;
const NOW = new Date('2026-08-19T10:00:00.000Z');

function environment(passwordHash = PASSWORD_HASH): NodeJS.ProcessEnv {
  return {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: passwordHash,
    ADMIN_SESSION_SECRET: SECRET,
    ADMIN_REVIEWER_USER_ID: REVIEWER_ID,
  } as unknown as NodeJS.ProcessEnv;
}

function sessionClient(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { client: { from } as never, from, select, eq, maybeSingle };
}

async function signedRequest() {
  const credentialVersion = await deriveAdminCredentialVersion({
    secret: SECRET,
    passwordHash: PASSWORD_HASH,
  });
  const token = await createAdminSessionToken({
    secret: SECRET,
    sessionId: SESSION_ID,
    credentialVersion,
    issuedAt: NOW,
    ttlSeconds: 3600,
  });
  return {
    credentialVersion,
    request: new Request('https://magicbooklet.com/api/admin/users', {
      headers: { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }),
  };
}

describe('authoritative admin session gate', () => {
  it('accepts a signed v2 token only while its matching database row is active', async () => {
    const { credentialVersion, request } = await signedRequest();
    const database = sessionClient({
      data: {
        session_id: SESSION_ID,
        subject: 'master',
        credential_version: credentialVersion,
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
        revoked_at: null,
      },
      error: null,
    });

    await expect(authenticateAdminRequest(request, {
      environment: environment(),
      now: NOW,
      sessionClient: database.client,
    })).resolves.toEqual({
      authenticated: true,
      identity: { subject: 'master', username: 'admin', reviewerUserId: REVIEWER_ID },
    });
    expect(database.from).toHaveBeenCalledWith('admin_sessions');
    expect(database.eq).toHaveBeenCalledWith('session_id', SESSION_ID);
  });

  it('rejects a copied token after the authoritative row is revoked', async () => {
    const { credentialVersion, request } = await signedRequest();
    const database = sessionClient({
      data: {
        session_id: SESSION_ID,
        subject: 'master',
        credential_version: credentialVersion,
        expires_at: new Date(NOW.getTime() + 3600_000).toISOString(),
        revoked_at: NOW.toISOString(),
      },
      error: null,
    });

    await expect(authenticateAdminRequest(request, {
      environment: environment(),
      now: NOW,
      sessionClient: database.client,
    })).resolves.toEqual({ authenticated: false, reason: 'unauthenticated' });
  });

  it('rejects a token whose authoritative row has expired', async () => {
    const { credentialVersion, request } = await signedRequest();
    const database = sessionClient({
      data: {
        session_id: SESSION_ID,
        subject: 'master',
        credential_version: credentialVersion,
        expires_at: new Date(NOW.getTime() - 1).toISOString(),
        revoked_at: null,
      },
      error: null,
    });

    await expect(authenticateAdminRequest(request, {
      environment: environment(),
      now: NOW,
      sessionClient: database.client,
    })).resolves.toEqual({ authenticated: false, reason: 'unauthenticated' });
  });

  it('invalidates existing tokens when the configured password hash rotates', async () => {
    const { request } = await signedRequest();
    const database = sessionClient({ data: null, error: null });

    await expect(authenticateAdminRequest(request, {
      environment: environment(ROTATED_PASSWORD_HASH),
      now: NOW,
      sessionClient: database.client,
    })).resolves.toEqual({ authenticated: false, reason: 'unauthenticated' });
    expect(database.from).not.toHaveBeenCalled();
  });

  it('fails closed when the authoritative session lookup is unavailable', async () => {
    const { request } = await signedRequest();
    const database = sessionClient({ data: null, error: { message: 'database offline' } });

    await expect(authenticateAdminRequest(request, {
      environment: environment(),
      now: NOW,
      sessionClient: database.client,
    })).resolves.toEqual({ authenticated: false, reason: 'unavailable' });
  });
});
