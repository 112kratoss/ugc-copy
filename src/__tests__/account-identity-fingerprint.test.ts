import { createHmac } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_IDENTITY_FINGERPRINT_TABLE,
  DELETED_ACCOUNT_IDENTITY_FINGERPRINT_TABLE,
  deriveAccountIdentityFingerprints,
  deriveIdentityFingerprintSignals,
  hashIdentityFingerprintSignal,
  loadAccountIdentityFingerprints,
  recordClaimedIdentityFingerprints,
  recordDeletedAccountIdentityFingerprints,
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

// Invite & Earn is for new accounts. A sign-in that had an account before is
// not one, whatever that account had claimed, so its digests are kept when the
// account goes (20261109213008) and the referral claim is given the new
// account's to compare.
describe('the deleted-identity record', () => {
  function adminStub({
    user,
    lookupError = null,
    upsertError = null,
  }: {
    user?: unknown;
    lookupError?: { status: number; message?: string } | null;
    upsertError?: { message: string } | null;
  }) {
    const upsert = vi.fn(async () => ({ data: null, error: upsertError }));
    const getUserById = vi.fn(async () => ({ data: { user: user ?? null }, error: lookupError }));
    const admin = {
      from: vi.fn((table: string) => {
        if (table === DELETED_ACCOUNT_IDENTITY_FINGERPRINT_TABLE) return { upsert };
        throw new Error(`Unexpected table: ${table}`);
      }),
      auth: { admin: { getUserById } },
    } as unknown as SupabaseClient;
    return { admin, upsert, getUserById };
  }

  it('records every digest of the account, once, whatever it had claimed', async () => {
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    const { admin, upsert, getUserById } = adminStub({ user: appleUser });

    await expect(recordDeletedAccountIdentityFingerprints(admin, 'u1')).resolves.toEqual({ fingerprintRows: 3 });

    expect(getUserById).toHaveBeenCalledWith('u1');
    // A digest keeps the time it was first recorded: the claim compares that
    // time with the claiming account's creation.
    expect(upsert).toHaveBeenCalledWith(
      deriveAccountIdentityFingerprints(appleUser).map((fingerprint) => ({ fingerprint })),
      { onConflict: 'fingerprint', ignoreDuplicates: true },
    );
  });

  it('records nothing for a guest, which has no sign-in to come back with', async () => {
    // Even one holding an address it has not confirmed: until it registers, the
    // address is nobody's sign-in, and recording it would refuse its real owner.
    const { admin, upsert } = adminStub({ user: { is_anonymous: true, email: 'unconfirmed@example.com', identities: [] } });

    await expect(recordDeletedAccountIdentityFingerprints(admin, 'guest')).resolves.toEqual({ fingerprintRows: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('records nothing for an account already gone, so a retried deletion goes on', async () => {
    const { admin, upsert } = adminStub({ lookupError: { status: 404, message: 'User not found' } });

    await expect(recordDeletedAccountIdentityFingerprints(admin, 'gone')).resolves.toEqual({ fingerprintRows: 0 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('throws when the account cannot be read or the record cannot be written, leaving the job retryable', async () => {
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    await expect(recordDeletedAccountIdentityFingerprints(
      adminStub({ lookupError: { status: 503, message: 'auth unavailable' } }).admin,
      'u1',
    )).rejects.toMatchObject({ message: 'auth unavailable' });

    await expect(recordDeletedAccountIdentityFingerprints(
      adminStub({ user: appleUser, upsertError: { message: 'ledger unavailable' } }).admin,
      'u1',
    )).rejects.toMatchObject({ message: 'ledger unavailable' });
  });

  it('loads an account’s digests for a claim, and throws when the account cannot be read', async () => {
    vi.stubEnv('ACCOUNT_IDENTITY_FINGERPRINT_SECRET', 'pinned-test-secret');
    await expect(loadAccountIdentityFingerprints(adminStub({ user: appleUser }).admin, 'u1'))
      .resolves.toEqual(deriveAccountIdentityFingerprints(appleUser));

    await expect(loadAccountIdentityFingerprints(
      adminStub({ lookupError: { status: 404, message: 'User not found' } }).admin,
      'gone',
    )).rejects.toMatchObject({ message: 'User not found' });
  });
});
