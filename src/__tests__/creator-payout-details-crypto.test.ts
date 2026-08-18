import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CreatorPayoutDetailsCryptoError,
  decryptCreatorPayoutDetails,
  encryptCreatorPayoutDetails,
  isEncryptedCreatorPayoutDetails,
} from '@/lib/creator-payout-details-crypto';

const key = randomBytes(32).toString('base64');

function environment(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY: key,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe('creator payout details crypto', () => {
  it('round-trips details through the tagged ciphertext format', () => {
    const stored = encryptCreatorPayoutDetails('upi: creator@bank, contact +91 98x', environment());

    expect(stored.startsWith('enc.v1.')).toBe(true);
    expect(isEncryptedCreatorPayoutDetails(stored)).toBe(true);
    // Dot-delimited base64url only — the value must survive dotenv-expand and
    // the DB length check without surprises.
    expect(stored).toMatch(/^enc\.v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const decrypted = decryptCreatorPayoutDetails(stored, environment());
    expect(decrypted).toEqual({
      ok: true,
      plaintext: 'upi: creator@bank, contact +91 98x',
      encrypted: true,
    });
  });

  it('keeps worst-case ciphertext within the database bound', () => {
    // 500 characters of 4-byte UTF-8 is the largest plaintext the service
    // accepts; its ciphertext must fit the relaxed 4000-character CHECK.
    const stored = encryptCreatorPayoutDetails('\u{1F4B8}'.repeat(500), environment());
    expect(stored.length).toBeLessThanOrEqual(4000);
  });

  it('passes legacy plaintext rows through unchanged', () => {
    expect(decryptCreatorPayoutDetails('upi: legacy@bank', environment())).toEqual({
      ok: true,
      plaintext: 'upi: legacy@bank',
      encrypted: false,
    });
  });

  it('reports tampered ciphertext instead of returning garbage', () => {
    const stored = encryptCreatorPayoutDetails('upi: creator@bank', environment());
    const tampered = `${stored.slice(0, -4)}AAAA`;

    expect(decryptCreatorPayoutDetails(tampered, environment())).toEqual({
      ok: false,
      reason: 'decrypt_failed',
    });
  });

  it('reports an unconfigured key instead of failing the whole queue read', () => {
    const stored = encryptCreatorPayoutDetails('upi: creator@bank', environment());

    expect(decryptCreatorPayoutDetails(stored, environment({
      CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY: undefined,
    }))).toEqual({ ok: false, reason: 'key_unconfigured' });
  });

  it('fails closed in production when the key is unconfigured', () => {
    expect(() => encryptCreatorPayoutDetails('upi: creator@bank', environment({
      NODE_ENV: 'production',
      CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY: undefined,
    }))).toThrow(CreatorPayoutDetailsCryptoError);
  });

  it('stores plaintext with a warning outside production when the key is unconfigured', () => {
    // Local development must not require minting a key.
    expect(encryptCreatorPayoutDetails('upi: creator@bank', environment({
      CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY: undefined,
    }))).toBe('upi: creator@bank');
  });

  it('rejects keys that are not exactly 32 bytes', () => {
    expect(() => encryptCreatorPayoutDetails('upi: creator@bank', environment({
      CREATOR_PAYOUT_DETAILS_ENCRYPTION_KEY: randomBytes(16).toString('base64'),
    }))).toThrow(CreatorPayoutDetailsCryptoError);
  });
});
