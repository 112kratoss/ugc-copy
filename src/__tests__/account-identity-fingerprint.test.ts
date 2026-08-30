import { createHmac } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_IDENTITY_FINGERPRINT_TABLE,
  deriveAccountIdentityFingerprints,
  deriveIdentityFingerprintSignals,
  hashIdentityFingerprintSignal,
  recordClaimedIdentityFingerprints,
  type FingerprintableUser,
} from '@/lib/account-identity-fingerprint';

const appleUser = {
  email: ' Creator@Example.COM ',
  identities: [
    {
      id: 'apple-sub-001',
      provider: 'apple',
      identity_data: { sub: 'apple-sub-001', email: 'Relay-XYZ@privaterelay.appleid.com' },
    },
  ],
} as unknown as FingerprintableUser;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('identity fingerprint signals', () => {
  it('derives the primary email and every OAuth subject, normalized', () => {
    // The policy: email alone is beatable with aliases and disposable domains;
    // the Apple/Google subject is stable per real account even behind
    // Hide-My-Email, so both are recorded, plus the identity's own email to
    // survive a primary-email swap done before deletion.
    expect(deriveIdentityFingerprintSignals(appleUser)).toEqual([
      'email:creator@example.com',
      'oauth:apple:apple-sub-001',
      'email:relay-xyz@privaterelay.appleid.com',
    ]);
  });

  it('skips email and phone identities, whose provider id is the account uuid', () => {
    // That id dies with the account and can never match a re-registration —
    // recording it would only add a dead ledger row per claim.
    const user = {
      email: 'plain@example.com',
      identities: [
        { id: '4f65b4aa-2ac5-4f35-9291-5cc663fe7f0d', provider: 'email', identity_data: { email: 'plain@example.com' } },
        { id: '4f65b4aa-2ac5-4f35-9291-5cc663fe7f0d', provider: 'phone', identity_data: {} },
      ],
    } as unknown as FingerprintableUser;

    expect(deriveIdentityFingerprintSignals(user)).toEqual(['email:plain@example.com']);
  });

  it('tolerates a user with no email and no identities', () => {
    expect(deriveIdentityFingerprintSignals({ email: undefined, identities: undefined } as FingerprintableUser))
      .toEqual([]);
  });

  it('falls back to identity_data.sub when the identity id is absent', () => {
    const user = {
      email: null,
      identities: [{ id: undefined, provider: 'google', identity_data: { sub: 'google-sub-9' } }],
    } as unknown as FingerprintableUser;

    expect(deriveIdentityFingerprintSignals(user)).toEqual(['oauth:google:google-sub-9']);
  });
});

describe('fingerprint digests', () => {
  it('is exactly HMAC-SHA256(secret, signal) in hex — the durable wire format', () => {
    // Pinned deliberately: these digests must keep matching rows written in
    // production across refactors. Changing the scheme silently voids the
    // ledger's memory of past claims.
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    expect(hashIdentityFingerprintSignal('email:creator@example.com')).toBe(
      createHmac('sha256', 'pinned-test-secret').update('email:creator@example.com').digest('hex'),
    );
    expect(hashIdentityFingerprintSignal('   ')).toBeNull();
    expect(hashIdentityFingerprintSignal(null)).toBeNull();
  });

  it('dedupes signals that collapse to the same digest and never leaks the raw value', () => {
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    const user = {
      email: 'same@example.com',
      identities: [
        { id: 'g-sub', provider: 'google', identity_data: { sub: 'g-sub', email: 'SAME@example.com' } },
      ],
    } as unknown as FingerprintableUser;

    const fingerprints = deriveAccountIdentityFingerprints(user);
    // email + identity email normalize identically → one digest, plus the sub.
    expect(fingerprints).toHaveLength(2);
    for (const fingerprint of fingerprints) {
      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(fingerprint).not.toContain('example.com');
    }
  });
});

describe('recordClaimedIdentityFingerprints', () => {
  function adminStub({
    grants,
    users,
    upsertError = null,
  }: {
    grants: Array<{ user_id: string; program_key: string }>;
    users: Record<string, { user: unknown } | { error: { status: number } }>;
    upsertError?: { message: string } | null;
  }) {
    const upsert = vi.fn(async () => ({ data: null, error: upsertError }));
    const grantsQuery = {
      select: vi.fn(),
      in: vi.fn(async () => ({ data: grants, error: null })),
    };
    grantsQuery.select.mockReturnValue(grantsQuery);
    const getUserById = vi.fn(async (userId: string) => {
      const entry = users[userId];
      if (!entry) return { data: { user: null }, error: { status: 404, message: 'User not found' } };
      if ('error' in entry) return { data: { user: null }, error: entry.error };
      return { data: entry, error: null };
    });
    const admin = {
      from: vi.fn((table: string) => {
        if (table === 'credit_grants') return grantsQuery;
        if (table === ACCOUNT_IDENTITY_FINGERPRINT_TABLE) return { upsert };
        throw new Error(`Unexpected table: ${table}`);
      }),
      auth: { admin: { getUserById } },
    } as unknown as SupabaseClient;
    return { admin, upsert, getUserById };
  }

  it('records every claimed program × fingerprint pair, duplicates ignored', async () => {
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    const { admin, upsert } = adminStub({
      grants: [{ user_id: 'u1', program_key: 'welcome_credits_v1' }],
      users: { u1: { user: { email: 'gone-soon@example.com', identities: [] } } },
    });

    const result = await recordClaimedIdentityFingerprints(admin, ['u1'], 'deletion');

    expect(result).toEqual({ usersWithGrants: 1, fingerprintRows: 1 });
    expect(upsert).toHaveBeenCalledWith(
      [expect.objectContaining({ program_key: 'welcome_credits_v1', recorded_via: 'deletion' })],
      { onConflict: 'program_key,fingerprint', ignoreDuplicates: true },
    );
    const [rows] = upsert.mock.calls[0] as unknown as [Array<{ fingerprint: string }>];
    expect(rows[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does nothing for users without grants and skips already-deleted auth rows', async () => {
    const { admin, upsert, getUserById } = adminStub({
      grants: [{ user_id: 'deleted-user', program_key: 'welcome_credits_v1' }],
      users: {},
    });

    // Guests linked into a deletion never have grants; a 404 means a linked
    // identity was already removed on a retry — its claim-time rows are the
    // durable record, so both are quiet skips, never failures.
    const result = await recordClaimedIdentityFingerprints(admin, ['deleted-user', 'guest']);

    expect(result).toEqual({ usersWithGrants: 1, fingerprintRows: 0 });
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('short-circuits on an empty id list without touching the database', async () => {
    const { admin, upsert, getUserById } = adminStub({ grants: [], users: {} });

    await expect(recordClaimedIdentityFingerprints(admin, [])).resolves.toEqual({
      usersWithGrants: 0,
      fingerprintRows: 0,
    });
    expect(getUserById).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('throws when the ledger write fails, leaving the deletion job retryable', async () => {
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    const { admin } = adminStub({
      grants: [{ user_id: 'u1', program_key: 'welcome_credits_v1' }],
      users: { u1: { user: { email: 'gone-soon@example.com', identities: [] } } },
      upsertError: { message: 'ledger unavailable' },
    });

    await expect(recordClaimedIdentityFingerprints(admin, ['u1'])).rejects.toMatchObject({
      message: 'ledger unavailable',
    });
  });
});
