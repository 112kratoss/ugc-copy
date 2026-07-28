import { describe, expect, it } from 'vitest';

import { resolveAdminConfig, resolveAdminIdentity } from '@/lib/admin-identity';
import { hashAdminPassword, parseAdminPasswordHash, verifyAdminPassword } from '@/lib/admin-password';
import {
  ADMIN_SESSION_COOKIE,
  createAdminSessionToken,
  resolveAdminSessionSecret,
  verifyAdminSessionToken,
} from '@/lib/admin-session-token';

const SECRET = 'a'.repeat(48);
const REVIEWER_ID = '3f1b7c2e-6d4a-4f8b-9c1d-2a5e7b9f0c31';

function environment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: `scrypt.16384.8.1.c2FsdHNhbHRzYWx0c2E.${'A'.repeat(86)}`,
    ADMIN_SESSION_SECRET: SECRET,
    ADMIN_REVIEWER_USER_ID: REVIEWER_ID,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('admin password hashing', () => {
  it('round-trips a password through scrypt', async () => {
    const hash = await hashAdminPassword('correct-horse-battery');
    await expect(verifyAdminPassword('correct-horse-battery', hash)).resolves.toBe(true);
    await expect(verifyAdminPassword('correct-horse-batteru', hash)).resolves.toBe(false);
  });

  it('produces a different hash per call so the salt is not reused', async () => {
    const [first, second] = await Promise.all([
      hashAdminPassword('correct-horse-battery'),
      hashAdminPassword('correct-horse-battery'),
    ]);
    expect(first).not.toBe(second);
  });

  it('rejects a password below the minimum length', async () => {
    await expect(hashAdminPassword('short')).rejects.toThrow(/at least 12/);
  });

  it('fails closed on a malformed or missing stored hash', async () => {
    await expect(verifyAdminPassword('anything', null)).resolves.toBe(false);
    await expect(verifyAdminPassword('anything', '')).resolves.toBe(false);
    await expect(verifyAdminPassword('anything', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyAdminPassword('anything', 'bcrypt.16384.8.1.c2FsdA.a2V5')).resolves.toBe(false);
    // Cost below the floor is rejected rather than silently accepted.
    expect(parseAdminPasswordHash('scrypt.1.8.1.c2FsdA.a2V5')).toBeNull();
  });

  it('emits a hash that survives dotenv variable expansion', async () => {
    // Regression guard. The conventional `$`-delimited MCF encoding is silently
    // rewritten by dotenv-expand when Next.js loads .env files, turning
    // `scrypt$16384$8$1$<salt>$<key>` into a corrupted value that fails to
    // parse and locks the operator out. Restrict the alphabet so no layer —
    // dotenv, shell, or URL — can reinterpret any character.
    const hash = await hashAdminPassword('correct-horse-battery');

    expect(hash).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(hash).not.toContain('$');
    expect(hash.split('.')).toHaveLength(6);
    expect(hash.startsWith('scrypt.16384.8.1.')).toBe(true);
  });
});

describe('admin session tokens', () => {
  const issuedAt = new Date('2026-07-28T10:00:00.000Z');

  it('verifies a token it just signed', async () => {
    const token = await createAdminSessionToken({ secret: SECRET, issuedAt, ttlSeconds: 3600 });
    const result = await verifyAdminSessionToken(token, { secret: SECRET, now: issuedAt });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.sub).toBe('master');
      expect(result.payload.exp).toBe(result.payload.iat + 3600);
    }
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await createAdminSessionToken({ secret: SECRET, issuedAt, ttlSeconds: 3600 });
    const result = await verifyAdminSessionToken(token, { secret: 'b'.repeat(48), now: issuedAt });

    expect(result).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('rejects a token whose payload was tampered with', async () => {
    const token = await createAdminSessionToken({ secret: SECRET, issuedAt, ttlSeconds: 3600 });
    const [version, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'master', iat: 0, exp: 99999999999 }),
    ).toString('base64url');

    const result = await verifyAdminSessionToken(
      `${version}.${forgedPayload}.${signature}`,
      { secret: SECRET, now: issuedAt },
    );
    expect(result).toEqual({ valid: false, reason: 'bad-signature' });
  });

  it('rejects an expired token', async () => {
    const token = await createAdminSessionToken({ secret: SECRET, issuedAt, ttlSeconds: 60 });
    const result = await verifyAdminSessionToken(token, {
      secret: SECRET,
      now: new Date(issuedAt.getTime() + 61_000),
    });

    expect(result).toEqual({ valid: false, reason: 'expired' });
  });

  it('rejects malformed input and an unconfigured secret', async () => {
    await expect(verifyAdminSessionToken(null, { secret: SECRET, now: issuedAt }))
      .resolves.toEqual({ valid: false, reason: 'malformed' });
    await expect(verifyAdminSessionToken('v1.only-two-parts', { secret: SECRET, now: issuedAt }))
      .resolves.toEqual({ valid: false, reason: 'malformed' });
    await expect(verifyAdminSessionToken('v2.a.b', { secret: SECRET, now: issuedAt }))
      .resolves.toEqual({ valid: false, reason: 'malformed' });
    await expect(verifyAdminSessionToken('v1.a.b', { secret: null, now: issuedAt }))
      .resolves.toEqual({ valid: false, reason: 'unconfigured' });
  });

  it('treats a short secret as unconfigured rather than weak-but-accepted', () => {
    expect(resolveAdminSessionSecret({ ADMIN_SESSION_SECRET: 'too-short' } as NodeJS.ProcessEnv)).toBeNull();
    expect(resolveAdminSessionSecret({ ADMIN_SESSION_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(SECRET);
    expect(resolveAdminSessionSecret({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('names the cookie consistently', () => {
    expect(ADMIN_SESSION_COOKIE).toBe('mb_admin_session');
  });
});

describe('admin configuration', () => {
  it('accepts a fully configured environment', () => {
    const config = resolveAdminConfig(environment());
    expect(config.configured).toBe(true);
    expect(config.issues).toEqual([]);
    expect(config.reviewerUserId).toBe(REVIEWER_ID);
    expect(config.sessionTtlSeconds).toBe(8 * 60 * 60);
  });

  it('fails closed when any variable is missing', () => {
    for (const key of [
      'ADMIN_USERNAME',
      'ADMIN_PASSWORD_HASH',
      'ADMIN_SESSION_SECRET',
      'ADMIN_REVIEWER_USER_ID',
    ]) {
      const config = resolveAdminConfig(environment({ [key]: undefined }));
      expect(config.configured, `${key} should be required`).toBe(false);
      expect(config.issues.length).toBeGreaterThan(0);
    }
  });

  it('requires the reviewer id to be a UUID because reviewed_by is a foreign key', () => {
    const config = resolveAdminConfig(environment({ ADMIN_REVIEWER_USER_ID: 'me' }));
    expect(config.configured).toBe(false);
    expect(config.issues.join(' ')).toMatch(/UUID of a real Supabase auth user/);
  });

  it('rejects a password hash that is not a valid scrypt record', () => {
    const config = resolveAdminConfig(environment({ ADMIN_PASSWORD_HASH: 'plaintext-password' }));
    expect(config.configured).toBe(false);
    expect(config.issues.join(' ')).toMatch(/not a valid scrypt hash/);
  });

  it('clamps an out-of-range session TTL back to the default', () => {
    expect(resolveAdminConfig(environment({ ADMIN_SESSION_TTL_SECONDS: '10' })).sessionTtlSeconds)
      .toBe(8 * 60 * 60);
    expect(resolveAdminConfig(environment({ ADMIN_SESSION_TTL_SECONDS: '999999' })).sessionTtlSeconds)
      .toBe(8 * 60 * 60);
    expect(resolveAdminConfig(environment({ ADMIN_SESSION_TTL_SECONDS: '1800' })).sessionTtlSeconds)
      .toBe(1800);
  });

  it('resolves no identity while the deployment is unconfigured', () => {
    expect(resolveAdminIdentity('master', environment({ ADMIN_USERNAME: undefined }))).toBeNull();
    expect(resolveAdminIdentity('master', environment())).toEqual({
      subject: 'master',
      username: 'admin',
      reviewerUserId: REVIEWER_ID,
    });
  });
});
