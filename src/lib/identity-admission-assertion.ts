import type { User } from '@supabase/supabase-js';

export const IDENTITY_ADMISSION_HEADER = 'x-magicbooklet-identity-admission';
export const IDENTITY_PROXY_TIMING_HEADER = 'x-magicbooklet-proxy-timing';

const ASSERTION_VERSION = 1;
const ASSERTION_TTL_MS = 30_000;
const MAX_ASSERTION_LENGTH = 16_384;

type IdentityState = 'active' | 'merged' | 'deleting';

type AssertionUser = Pick<
  User,
  'id' | 'aud' | 'role' | 'email' | 'phone' | 'is_anonymous' | 'app_metadata' | 'user_metadata' | 'created_at'
>;

type IdentityAdmissionPayload = {
  v: typeof ASSERTION_VERSION;
  iat: number;
  exp: number;
  method: string;
  pathname: string;
  tokenHash: string;
  state: IdentityState;
  user: AssertionUser;
};

export type VerifiedIdentityAdmission = {
  state: IdentityState;
  user: User;
};

type RegisteredAdmissionContext = {
  assertion: string;
  authorization: string;
  method: string;
  pathname: string;
  verified?: Promise<VerifiedIdentityAdmission | null>;
};

const admissionContexts = new WeakMap<object, RegisteredAdmissionContext>();
const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      .padEnd(Math.ceil(value.length / 4) * 4, '=');
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value)),
  ));
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export function resolveIdentityAdmissionSecret(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = environment.IDENTITY_ADMISSION_SECRET?.trim();
  return secret && encoder.encode(secret).byteLength >= 32 ? secret : null;
}

function safeUserMetadata(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    ['full_name', 'name', 'avatar_url', 'picture']
      .filter((key) => typeof value[key] === 'string')
      .map((key) => [key, value[key]]),
  );
}

function assertionUser(user: User): AssertionUser {
  return {
    id: user.id,
    aud: user.aud,
    role: user.role,
    email: user.email,
    phone: user.phone,
    is_anonymous: user.is_anonymous === true,
    app_metadata: {},
    user_metadata: safeUserMetadata(user.user_metadata),
    created_at: user.created_at,
  };
}

export async function signIdentityAdmission({
  authorization,
  method,
  pathname,
  state,
  user,
  now = Date.now(),
  secret = resolveIdentityAdmissionSecret(),
}: {
  authorization: string;
  method: string;
  pathname: string;
  state: IdentityState;
  user: User;
  now?: number;
  secret?: string | null;
}): Promise<string | null> {
  if (!secret) return null;
  const payload: IdentityAdmissionPayload = {
    v: ASSERTION_VERSION,
    iat: now,
    exp: now + ASSERTION_TTL_MS,
    method: method.toUpperCase(),
    pathname,
    tokenHash: await sha256(authorization),
    state,
    user: assertionUser(user),
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = bytesToBase64Url(await hmac(encodedPayload, secret));
  return `${encodedPayload}.${signature}`;
}

function parsePayload(value: Uint8Array): IdentityAdmissionPayload | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(value)) as unknown;
    if (
      !isRecord(payload)
      || payload.v !== ASSERTION_VERSION
      || typeof payload.iat !== 'number'
      || typeof payload.exp !== 'number'
      || typeof payload.method !== 'string'
      || typeof payload.pathname !== 'string'
      || typeof payload.tokenHash !== 'string'
      || (payload.state !== 'active' && payload.state !== 'merged' && payload.state !== 'deleting')
      || !isRecord(payload.user)
      || typeof payload.user.id !== 'string'
      || typeof payload.user.created_at !== 'string'
      || !isRecord(payload.user.user_metadata)
      || !isRecord(payload.user.app_metadata)
    ) return null;
    return payload as unknown as IdentityAdmissionPayload;
  } catch {
    return null;
  }
}

export async function verifyIdentityAdmission(
  assertion: string,
  {
    authorization,
    method,
    pathname,
    now = Date.now(),
    secret = resolveIdentityAdmissionSecret(),
  }: {
    authorization: string;
    method: string;
    pathname: string;
    now?: number;
    secret?: string | null;
  },
): Promise<VerifiedIdentityAdmission | null> {
  if (!secret || !assertion || assertion.length > MAX_ASSERTION_LENGTH) return null;
  const segments = assertion.split('.');
  if (segments.length !== 2) return null;
  const [encodedPayload, encodedSignature] = segments;
  if (!encodedPayload || !encodedSignature) return null;
  const payloadBytes = base64UrlToBytes(encodedPayload);
  const suppliedSignature = base64UrlToBytes(encodedSignature);
  if (!payloadBytes || !suppliedSignature) return null;
  const expectedSignature = await hmac(encodedPayload, secret);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

  const payload = parsePayload(payloadBytes);
  if (
    !payload
    || payload.iat > now + 5_000
    || payload.exp < now
    || payload.exp - payload.iat > ASSERTION_TTL_MS
    || payload.method !== method.toUpperCase()
    || payload.pathname !== pathname
    || payload.tokenHash !== await sha256(authorization)
  ) return null;

  return {
    state: payload.state,
    user: payload.user as User,
  };
}

export function registerIdentityAdmissionContext(client: object, request: Request): void {
  const assertion = request.headers.get(IDENTITY_ADMISSION_HEADER)?.trim();
  const authorization = request.headers.get('authorization')?.trim();
  if (!assertion || !authorization) return;
  admissionContexts.set(client, {
    assertion,
    authorization,
    method: request.method,
    pathname: new URL(request.url).pathname,
  });
}

export async function getVerifiedIdentityAdmission(
  client: object,
): Promise<VerifiedIdentityAdmission | null> {
  const context = admissionContexts.get(client);
  if (!context) return null;
  context.verified ??= verifyIdentityAdmission(context.assertion, context);
  return context.verified;
}
