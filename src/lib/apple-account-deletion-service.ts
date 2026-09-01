import 'server-only';

import {
  createRemoteJWKSet,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from 'jose';

const APPLE_AUDIENCE = 'https://appleid.apple.com';
const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_REQUEST_TIMEOUT_MS = 10_000;
const APPLE_AUTHORIZATION_CODE_MAX_LENGTH = 8_192;

export type AppleAccountDeletionErrorCode =
  | 'APPLE_REAUTH_FAILED'
  | 'ACCOUNT_REAUTH_MISMATCH'
  | 'APPLE_REVOCATION_UNAVAILABLE';

export class AppleAccountDeletionError extends Error {
  constructor(
    message: string,
    public readonly code: AppleAccountDeletionErrorCode,
    public readonly status: 403 | 503,
    public readonly reauthenticate: boolean,
  ) {
    super(message);
    this.name = 'AppleAccountDeletionError';
  }
}

type AppleAccountDeletionEnvironmentKey =
  | 'APPLE_TEAM_ID'
  | 'IOS_BUNDLE_ID'
  | 'APPLE_SIGN_IN_KEY_ID'
  | 'APPLE_SIGN_IN_PRIVATE_KEY';
type AppleAccountDeletionEnvironment = Partial<
  Record<AppleAccountDeletionEnvironmentKey, string | undefined>
>;

type AppleTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
};

type AppleAccountDeletionDependencies = {
  createClientSecret?: typeof createAppleClientSecret;
  environment?: AppleAccountDeletionEnvironment;
  fetcher?: typeof fetch;
  now?: () => Date;
  verifyIdentityToken?: typeof verifyAppleIdentityToken;
};

function requiredEnvironmentValue(
  environment: AppleAccountDeletionEnvironment,
  key: AppleAccountDeletionEnvironmentKey,
) {
  const value = environment[key]?.trim();
  if (!value) {
    throw new AppleAccountDeletionError(
      'Apple account verification is temporarily unavailable. Please try again later.',
      'APPLE_REVOCATION_UNAVAILABLE',
      503,
      false,
    );
  }
  return value;
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

async function fetchApple(
  fetcher: typeof fetch,
  url: string,
  body: URLSearchParams,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), APPLE_REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      cache: 'no-store',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function createAppleClientSecret({
  clientId,
  keyId,
  now,
  privateKey,
  teamId,
}: {
  clientId: string;
  keyId: string;
  now: Date;
  privateKey: string;
  teamId: string;
}) {
  let signingKey;
  try {
    signingKey = await importPKCS8(privateKey.replace(/\\n/g, '\n'), 'ES256');
  } catch {
    throw new AppleAccountDeletionError(
      'Apple account verification is temporarily unavailable. Please try again later.',
      'APPLE_REVOCATION_UNAVAILABLE',
      503,
      false,
    );
  }

  const issuedAt = Math.floor(now.getTime() / 1_000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: keyId })
    .setIssuer(teamId)
    .setSubject(clientId)
    .setAudience(APPLE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 5 * 60)
    .sign(signingKey);
}

async function verifyAppleIdentityToken(idToken: string, clientId: string) {
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    algorithms: ['RS256'],
    audience: clientId,
    issuer: APPLE_ISSUER,
  });
  return stringField(payload.sub);
}

function reauthenticationFailure() {
  return new AppleAccountDeletionError(
    'Apple could not verify this deletion request. Continue with Apple again and retry.',
    'APPLE_REAUTH_FAILED',
    403,
    true,
  );
}

function upstreamFailure() {
  return new AppleAccountDeletionError(
    'Apple account verification is temporarily unavailable. Your account is still active; please try again later.',
    'APPLE_REVOCATION_UNAVAILABLE',
    503,
    false,
  );
}

export async function authorizeAppleAccountDeletion({
  authorizationCode,
  expectedAppleSubject,
}: {
  authorizationCode: string;
  expectedAppleSubject: string;
}, dependencies: AppleAccountDeletionDependencies = {}) {
  const trimmedCode = authorizationCode.trim();
  if (!trimmedCode || trimmedCode.length > APPLE_AUTHORIZATION_CODE_MAX_LENGTH) {
    throw reauthenticationFailure();
  }
  if (!expectedAppleSubject.trim()) {
    throw new AppleAccountDeletionError(
      'This Apple sign-in could not be matched to your Magicbooklet account. Your account was not deleted.',
      'ACCOUNT_REAUTH_MISMATCH',
      403,
      false,
    );
  }

  const environment: AppleAccountDeletionEnvironment = dependencies.environment ?? {
    APPLE_SIGN_IN_KEY_ID: process.env.APPLE_SIGN_IN_KEY_ID,
    APPLE_SIGN_IN_PRIVATE_KEY: process.env.APPLE_SIGN_IN_PRIVATE_KEY,
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
    IOS_BUNDLE_ID: process.env.IOS_BUNDLE_ID,
  };
  const clientId = requiredEnvironmentValue(environment, 'IOS_BUNDLE_ID');
  const teamId = requiredEnvironmentValue(environment, 'APPLE_TEAM_ID');
  const keyId = requiredEnvironmentValue(environment, 'APPLE_SIGN_IN_KEY_ID');
  const privateKey = requiredEnvironmentValue(environment, 'APPLE_SIGN_IN_PRIVATE_KEY');
  const now = dependencies.now?.() ?? new Date();
  const createClientSecret = dependencies.createClientSecret ?? createAppleClientSecret;
  const verifyIdentityToken = dependencies.verifyIdentityToken ?? verifyAppleIdentityToken;
  const fetcher = dependencies.fetcher ?? fetch;
  const clientSecret = await createClientSecret({ clientId, keyId, now, privateKey, teamId });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetchApple(fetcher, APPLE_TOKEN_URL, new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: trimmedCode,
      grant_type: 'authorization_code',
    }));
  } catch {
    throw upstreamFailure();
  }

  if (!tokenResponse.ok) {
    // `invalid_grant` is the user-actionable case: the short-lived code is
    // expired, consumed, malformed, or belongs to another client. Other Apple
    // errors (especially `invalid_client`) indicate server configuration or an
    // upstream failure and must not send the user through a reauth loop.
    if (tokenResponse.status === 400) {
      try {
        const errorPayload = await tokenResponse.json() as { error?: unknown };
        if (errorPayload.error === 'invalid_grant') throw reauthenticationFailure();
      } catch (error) {
        if (error instanceof AppleAccountDeletionError) throw error;
      }
    }
    throw upstreamFailure();
  }

  let tokenPayload: AppleTokenResponse;
  try {
    tokenPayload = await tokenResponse.json() as AppleTokenResponse;
  } catch {
    throw upstreamFailure();
  }
  const idToken = stringField(tokenPayload.id_token);
  const refreshToken = stringField(tokenPayload.refresh_token);
  const accessToken = stringField(tokenPayload.access_token);
  if (!idToken || (!refreshToken && !accessToken)) throw upstreamFailure();

  let appleSubject: string | null;
  try {
    appleSubject = await verifyIdentityToken(idToken, clientId);
  } catch {
    throw reauthenticationFailure();
  }
  if (!appleSubject || appleSubject !== expectedAppleSubject) {
    throw new AppleAccountDeletionError(
      'You continued with a different Apple account. Your Magicbooklet account was not deleted.',
      'ACCOUNT_REAUTH_MISMATCH',
      403,
      false,
    );
  }

  const tokenToRevoke = (refreshToken ?? accessToken) as string;
  const tokenTypeHint = refreshToken ? 'refresh_token' : 'access_token';
  let revokeResponse: Response;
  try {
    revokeResponse = await fetchApple(fetcher, APPLE_REVOKE_URL, new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token: tokenToRevoke,
      token_type_hint: tokenTypeHint,
    }));
  } catch {
    throw upstreamFailure();
  }
  if (!revokeResponse.ok) throw upstreamFailure();
}

export const APPLE_ACCOUNT_DELETION_ENDPOINTS = {
  revoke: APPLE_REVOKE_URL,
  token: APPLE_TOKEN_URL,
} as const;
