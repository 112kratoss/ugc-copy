import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import {
  APPLE_ACCOUNT_DELETION_ENDPOINTS,
  AppleAccountDeletionError,
  authorizeAppleAccountDeletion,
  createAppleClientSecret,
} from '@/lib/apple-account-deletion-service';

const environment = {
  APPLE_TEAM_ID: 'TEAM123456',
  IOS_BUNDLE_ID: 'com.magicbooklet.mobile',
  APPLE_SIGN_IN_KEY_ID: 'KEY1234567',
  APPLE_SIGN_IN_PRIVATE_KEY: 'unused-by-test-double',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dependencies(options: {
  fetcher?: typeof fetch;
  subject?: string | null;
} = {}) {
  return {
    environment,
    createClientSecret: vi.fn(async () => 'signed-client-secret'),
    verifyIdentityToken: vi.fn(async () => options.subject ?? 'apple-user-1'),
    fetcher: options.fetcher,
    now: () => new Date('2026-09-01T10:00:00.000Z'),
  };
}

describe('Apple account deletion authorization', () => {
  it('exchanges, binds, and revokes a fresh Apple authorization before returning', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'apple-access-token',
        refresh_token: 'apple-refresh-token',
        id_token: 'apple-id-token',
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'fresh-one-time-code',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher }))).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(APPLE_ACCOUNT_DELETION_ENDPOINTS.token);
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit.body)))).toEqual({
      client_id: 'com.magicbooklet.mobile',
      client_secret: 'signed-client-secret',
      code: 'fresh-one-time-code',
      grant_type: 'authorization_code',
    });
    const [revokeUrl, revokeInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(revokeUrl).toBe(APPLE_ACCOUNT_DELETION_ENDPOINTS.revoke);
    expect(Object.fromEntries(new URLSearchParams(String(revokeInit.body)))).toEqual({
      client_id: 'com.magicbooklet.mobile',
      client_secret: 'signed-client-secret',
      token: 'apple-refresh-token',
      token_type_hint: 'refresh_token',
    });
  });

  it('rejects a different Apple subject before token revocation', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      access_token: 'apple-access-token',
      refresh_token: 'apple-refresh-token',
      id_token: 'apple-id-token',
    }));

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'fresh-one-time-code',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher, subject: 'apple-user-2' }))).rejects.toMatchObject({
      code: 'ACCOUNT_REAUTH_MISMATCH',
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('turns a consumed or invalid authorization code into a visible reauthentication failure', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'consumed-code',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher }))).rejects.toMatchObject({
      code: 'APPLE_REAUTH_FAILED',
      status: 403,
      reauthenticate: true,
    });
  });

  it('does not loop reauthentication when Apple reports invalid server credentials', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: 'invalid_client' }, 400));

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'fresh-one-time-code',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher }))).rejects.toMatchObject({
      code: 'APPLE_REVOCATION_UNAVAILABLE',
      status: 503,
      reauthenticate: false,
    });
  });

  it('fails closed when Apple token revocation is unavailable', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'apple-access-token',
        refresh_token: 'apple-refresh-token',
        id_token: 'apple-id-token',
      }))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_client' }, 400));

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'fresh-one-time-code',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher }))).rejects.toMatchObject({
      code: 'APPLE_REVOCATION_UNAVAILABLE',
      status: 503,
    });
  });

  it('fails closed without exposing credentials when server configuration is incomplete', async () => {
    let error: unknown;
    try {
      await authorizeAppleAccountDeletion({
        authorizationCode: 'fresh-one-time-code',
        expectedAppleSubject: 'apple-user-1',
      }, {
        ...dependencies(),
        environment: { ...environment, APPLE_SIGN_IN_PRIVATE_KEY: '' },
      });
    } catch (nextError) {
      error = nextError;
    }

    expect(error).toBeInstanceOf(AppleAccountDeletionError);
    expect(error).toMatchObject({ code: 'APPLE_REVOCATION_UNAVAILABLE', status: 503 });
    expect(JSON.stringify(error)).not.toContain('fresh-one-time-code');
    expect(String(error)).not.toContain('APPLE_SIGN_IN_PRIVATE_KEY');
  });

  it('creates a short-lived ES256 Apple client secret with the required claims', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privateKeyPem = await exportPKCS8(privateKey);
    const now = new Date('2026-09-01T10:00:00.000Z');
    const token = await createAppleClientSecret({
      clientId: 'com.magicbooklet.mobile',
      keyId: 'KEY1234567',
      now,
      privateKey: privateKeyPem.replace(/\n/g, '\\n'),
      teamId: 'TEAM123456',
    });

    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      algorithms: ['ES256'],
      audience: 'https://appleid.apple.com',
      currentDate: now,
      issuer: 'TEAM123456',
      subject: 'com.magicbooklet.mobile',
    });
    expect(protectedHeader).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(payload.exp).toBe(payload.iat! + 300);
  });
});
