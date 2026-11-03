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

  // The website's Continue with Apple: Apple redeems and revokes a code only as the
  // client it was issued to, and a website code only with the return URL it went to.
  it('redeems and revokes a website code as the Services ID, with the return URL Apple sent it to', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        access_token: 'apple-access-token',
        refresh_token: 'apple-refresh-token',
        id_token: 'apple-id-token',
      }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const websiteDependencies = {
      ...dependencies({ fetcher }),
      environment: { ...environment, NEXT_PUBLIC_APPLE_SERVICES_ID: 'com.magicbooklet.mobile.web' },
    };

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'website-one-time-code',
      client: 'web',
      expectedAppleSubject: 'apple-user-1',
    }, websiteDependencies)).resolves.toBeUndefined();

    expect(websiteDependencies.createClientSecret).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'com.magicbooklet.mobile.web',
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
    }));
    const [tokenUrl, tokenInit] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(APPLE_ACCOUNT_DELETION_ENDPOINTS.token);
    expect(Object.fromEntries(new URLSearchParams(String(tokenInit.body)))).toEqual({
      client_id: 'com.magicbooklet.mobile.web',
      client_secret: 'signed-client-secret',
      code: 'website-one-time-code',
      grant_type: 'authorization_code',
      redirect_uri: 'https://magicbooklet.com/delete-account',
    });
    expect(websiteDependencies.verifyIdentityToken).toHaveBeenCalledWith('apple-id-token', 'com.magicbooklet.mobile.web');
    const [revokeUrl, revokeInit] = fetcher.mock.calls[1] as [string, RequestInit];
    expect(revokeUrl).toBe(APPLE_ACCOUNT_DELETION_ENDPOINTS.revoke);
    expect(Object.fromEntries(new URLSearchParams(String(revokeInit.body)))).toEqual({
      client_id: 'com.magicbooklet.mobile.web',
      client_secret: 'signed-client-secret',
      token: 'apple-refresh-token',
      token_type_hint: 'refresh_token',
    });
  });

  it('keeps an account whose website code names another Apple user, revoking nothing', async () => {
    const fetcher = vi.fn(async () => jsonResponse({
      access_token: 'apple-access-token',
      refresh_token: 'apple-refresh-token',
      id_token: 'apple-id-token',
    }));

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'website-one-time-code',
      client: 'web',
      expectedAppleSubject: 'apple-user-1',
    }, {
      ...dependencies({ fetcher, subject: 'apple-user-2' }),
      environment: { ...environment, NEXT_PUBLIC_APPLE_SERVICES_ID: 'com.magicbooklet.mobile.web' },
    })).rejects.toMatchObject({ code: 'ACCOUNT_REAUTH_MISMATCH', status: 403 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed for a website code while no Services ID is configured, asking Apple nothing', async () => {
    const fetcher = vi.fn();

    await expect(authorizeAppleAccountDeletion({
      authorizationCode: 'website-one-time-code',
      client: 'web',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher }))).rejects.toMatchObject({
      code: 'APPLE_REVOCATION_UNAVAILABLE',
      status: 503,
      reauthenticate: false,
      detail: 'missing NEXT_PUBLIC_APPLE_SERVICES_ID',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  // For the server log: what Apple or the configuration refused, never a code or a token.
  it.each<[string, () => Promise<Response>, Array<() => Promise<Response>>, string]>([
    ['the token endpoint refuses the client', async () => jsonResponse({ error: 'invalid_client' }, 400), [], 'token endpoint 400 invalid_client'],
    ['the token endpoint fails without JSON', async () => new Response('Bad gateway', { status: 502 }), [], 'token endpoint 502'],
    ['the token endpoint answers without the tokens', async () => jsonResponse({ id_token: 'apple-id-token' }), [], 'token response incomplete'],
    [
      'the revoke endpoint fails',
      async () => jsonResponse({ access_token: 'a', refresh_token: 'apple-refresh-token', id_token: 'apple-id-token' }),
      [async () => jsonResponse({ error: 'invalid_request' }, 400)],
      'revoke endpoint 400',
    ],
  ])('names what failed when %s', async (_label, token, rest, detail) => {
    const fetcher = vi.fn(token);
    for (const next of rest) fetcher.mockImplementationOnce(token).mockImplementationOnce(next);

    const error = await authorizeAppleAccountDeletion({
      authorizationCode: 'fresh-one-time-code',
      expectedAppleSubject: 'apple-user-1',
    }, dependencies({ fetcher })).catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: 'APPLE_REVOCATION_UNAVAILABLE', status: 503, detail });
    expect(JSON.stringify(error)).not.toMatch(/fresh-one-time-code|apple-refresh-token|signed-client-secret/);
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

  // Whether Apple took the code: after it did, a retry with the same code only spends one
  // of the hour's attempts, so the website asks Apple for a fresh one instead.
  describe('whether Apple took the code', () => {
    const tokens = async () => jsonResponse({ access_token: 'a', refresh_token: 'apple-refresh-token', id_token: 'apple-id-token' });
    const failedFetch = async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    };
    const unverifiable = Object.assign(new Error('signature verification failed'), { code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' });

    it.each<[string, Array<() => Promise<Response>>, { subject?: string; verifyError?: Error }, Record<string, unknown>]>([
      ['the token request fails', [failedFetch], {}, { code: 'APPLE_REVOCATION_UNAVAILABLE', detail: 'token request failed', codeSpent: false }],
      ['the token endpoint fails', [async () => new Response('Bad gateway', { status: 502 })], {}, { code: 'APPLE_REVOCATION_UNAVAILABLE', detail: 'token endpoint 502', codeSpent: false }],
      ['Apple refuses the code', [async () => jsonResponse({ error: 'invalid_grant' }, 400)], {}, { code: 'APPLE_REAUTH_FAILED', detail: 'token endpoint 400 invalid_grant', codeSpent: true }],
      ['the token answer is unreadable', [async () => new Response('<html>', { status: 200 })], {}, { code: 'APPLE_REVOCATION_UNAVAILABLE', detail: 'token response unreadable', codeSpent: true }],
      ["Apple's id token cannot be verified", [tokens], { verifyError: unverifiable }, { code: 'APPLE_REAUTH_FAILED', detail: 'id token unverifiable (ERR_JWS_SIGNATURE_VERIFICATION_FAILED)', codeSpent: true }],
      ['the id token names another Apple user', [tokens], { subject: 'apple-user-2' }, { code: 'ACCOUNT_REAUTH_MISMATCH', detail: 'id token names another Apple user', codeSpent: true }],
      ['the revoke request fails', [tokens, failedFetch], {}, { code: 'APPLE_REVOCATION_UNAVAILABLE', detail: 'revoke request failed', codeSpent: true }],
    ])('says so when %s', async (_label, answers, { subject, verifyError }, expected) => {
      const fetcher = vi.fn<typeof fetch>();
      for (const answer of answers) fetcher.mockImplementationOnce(answer);
      const resolved = dependencies({ fetcher, subject });
      if (verifyError) resolved.verifyIdentityToken.mockRejectedValueOnce(verifyError);

      await expect(authorizeAppleAccountDeletion({
        authorizationCode: 'fresh-one-time-code',
        expectedAppleSubject: 'apple-user-1',
      }, resolved)).rejects.toMatchObject(expected);
    });
  });

  // A body that never ends holds the route as an answer that never comes would, up to its
  // maximum duration: the one timeout covers both.
  it("gives up on an Apple answer whose body never ends", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => ({
        ok: false,
        status: 502,
        text: () => new Promise<string>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }),
      }) as unknown as Response);
      const settled = authorizeAppleAccountDeletion({
        authorizationCode: 'fresh-one-time-code',
        expectedAppleSubject: 'apple-user-1',
      }, dependencies({ fetcher })).catch((thrown: unknown) => thrown);

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(settled).resolves.toMatchObject({
        code: 'APPLE_REVOCATION_UNAVAILABLE',
        detail: 'token request failed',
        codeSpent: false,
      });
    } finally {
      vi.useRealTimers();
    }
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
