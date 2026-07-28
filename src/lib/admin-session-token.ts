/**
 * Edge-safe admin session tokens.
 *
 * `src/proxy.ts` runs on the Edge runtime, so it cannot import `node:crypto`.
 * Everything in this module is built on Web Crypto (available in both Edge and
 * Node 24) so the same verification code gates middleware and route handlers.
 * Password hashing is deliberately kept out of here — see `admin-password.ts`,
 * which is Node-only and reachable only from `runtime = 'nodejs'` routes.
 */

export const ADMIN_SESSION_COOKIE = 'mb_admin_session';
export const ADMIN_SESSION_TOKEN_VERSION = 'v1';

/** Subject of the single master admin. A per-person model would vary this. */
export const ADMIN_MASTER_SUBJECT = 'master';

export type AdminSessionPayload = {
  sub: string;
  iat: number;
  exp: number;
};

export type AdminSessionVerification =
  | { valid: true; payload: AdminSessionPayload }
  | { valid: false; reason: 'malformed' | 'unconfigured' | 'bad-signature' | 'expired' };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encodeUtf8(secret) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export function resolveAdminSessionSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = environment.ADMIN_SESSION_SECRET?.trim();
  // A short secret is treated as unconfigured rather than weak-but-accepted, so
  // a truncated or placeholder value fails closed instead of silently signing.
  return secret && secret.length >= 32 ? secret : null;
}

export async function createAdminSessionToken(options: {
  secret: string;
  subject?: string;
  issuedAt: Date;
  ttlSeconds: number;
}): Promise<string> {
  const issuedAtSeconds = Math.floor(options.issuedAt.getTime() / 1000);
  const payload: AdminSessionPayload = {
    sub: options.subject ?? ADMIN_MASTER_SUBJECT,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + options.ttlSeconds,
  };

  const encodedPayload = base64UrlEncode(encodeUtf8(JSON.stringify(payload)));
  const signingInput = `${ADMIN_SESSION_TOKEN_VERSION}.${encodedPayload}`;
  const key = await importSigningKey(options.secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encodeUtf8(signingInput) as unknown as BufferSource,
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyAdminSessionToken(
  token: string | null | undefined,
  options: { secret: string | null; now: Date },
): Promise<AdminSessionVerification> {
  if (!options.secret) {
    return { valid: false, reason: 'unconfigured' };
  }

  const parts = token?.split('.') ?? [];
  if (parts.length !== 3 || parts[0] !== ADMIN_SESSION_TOKEN_VERSION) {
    return { valid: false, reason: 'malformed' };
  }

  const [version, encodedPayload, encodedSignature] = parts;
  const signature = base64UrlDecode(encodedSignature);
  if (!signature) {
    return { valid: false, reason: 'malformed' };
  }

  const key = await importSigningKey(options.secret);
  const signatureMatches = await crypto.subtle.verify(
    'HMAC',
    key,
    signature as unknown as BufferSource,
    encodeUtf8(`${version}.${encodedPayload}`) as unknown as BufferSource,
  );
  if (!signatureMatches) {
    return { valid: false, reason: 'bad-signature' };
  }

  const payloadBytes = base64UrlDecode(encodedPayload);
  if (!payloadBytes) {
    return { valid: false, reason: 'malformed' };
  }

  let payload: AdminSessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as AdminSessionPayload;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    typeof payload?.sub !== 'string'
    || !payload.sub
    || !Number.isFinite(payload?.iat)
    || !Number.isFinite(payload?.exp)
  ) {
    return { valid: false, reason: 'malformed' };
  }

  if (Math.floor(options.now.getTime() / 1000) >= payload.exp) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, payload };
}
