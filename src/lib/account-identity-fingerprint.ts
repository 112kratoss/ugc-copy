/**
 * Durable identity fingerprints for one-time credit programs.
 *
 * `credit_grants` is the replay guard for welcome credits, and it cascades away
 * with `auth.users` — so delete-account → re-register → claim paid out 25
 * credits per cycle. The fix is the standard one for signup bonuses: record
 * every claim against HMAC digests of the account's sign-in identifiers
 * (email, OAuth provider subjects) in `credit_grant_identity_fingerprints`, a
 * table with deliberately no foreign key to `auth.users`, and refuse a claim
 * whose digest is already present. See 20260829120000.
 *
 * Deliberately not `server-only`: the request path imports this file, and so
 * does `scripts/backfills/backfill-welcome-credit-fingerprints.ts`, which runs under tsx
 * where `server-only` throws (same convention as media-upload-staging-paths).
 *
 * Unlike referral risk hashes, these digests are durable — they must match
 * across account deletions, redeploys, and (ideally) key rotations. Rotating
 * `ACCOUNT_IDENTITY_FINGERPRINT_SECRET`, or running on the service-role-derived
 * fallback and rotating that key, resets the ledger's memory of past claims.
 * Configure the dedicated secret and leave it alone.
 */

import { createHmac } from 'node:crypto';

import type { SupabaseClient, User } from '@supabase/supabase-js';

import { logBackendWarning } from '@/lib/backend-logger';

export const ACCOUNT_IDENTITY_FINGERPRINT_TABLE = 'credit_grant_identity_fingerprints';

/**
 * Digests of the identities of deleted accounts, whatever they had claimed
 * (20261109213008). Invite & Earn is for new accounts, and an account deleted
 * and opened again is not one: `claim_referral_visit` refuses a claim whose
 * digest was recorded here, or in the claim ledger above, before the claiming
 * account existed.
 */
export const DELETED_ACCOUNT_IDENTITY_FINGERPRINT_TABLE = 'deleted_account_identity_fingerprints';

/**
 * Domain separator for the fallback subkey derivation. Fixed and versioned so
 * the derived secret is stable across restarts; bumping the suffix deliberately
 * rotates every fingerprint digest (and with it, the ledger's memory).
 */
const FINGERPRINT_HASH_SUBKEY_LABEL = 'magicbooklet/account-identity-fingerprint/v1';

/**
 * The identity surface a fingerprint can be derived from. Always pass a user
 * fetched via `admin.auth.admin.getUserById` — the request-scoped `User` can
 * arrive through the identity-admission assertion path, which strips
 * `identities` entirely (identity-admission-assertion.ts).
 */
export type FingerprintableUser = Pick<User, 'email' | 'identities'>;

let hasWarnedAboutFingerprintSecretFallback = false;

function getFingerprintHashSecret(): string {
  const dedicatedSecret = process.env.ACCOUNT_IDENTITY_FINGERPRINT_SECRET?.trim();
  if (dedicatedSecret) return dedicatedSecret;

  const fallbackRootKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (fallbackRootKey) {
    if (!hasWarnedAboutFingerprintSecretFallback) {
      hasWarnedAboutFingerprintSecretFallback = true;
      logBackendWarning('account_identity_fingerprint_secret_fallback', {
        message: 'ACCOUNT_IDENTITY_FINGERPRINT_SECRET is not set; falling back to a key derived from SUPABASE_SERVICE_ROLE_KEY for identity fingerprints. These digests are durable — rotating the service-role key while on the fallback silently voids the claim ledger. Configure the dedicated secret.',
      });
    }
    // Same reasoning as the referral fallback: hand this module a PRF-derived
    // subkey rather than the key that bypasses every RLS policy.
    return createHmac('sha256', fallbackRootKey)
      .update(FINGERPRINT_HASH_SUBKEY_LABEL)
      .digest('hex');
  }

  if (process.env.NODE_ENV !== 'production') return 'local-account-identity-fingerprint-secret';
  throw new Error('ACCOUNT_IDENTITY_FINGERPRINT_SECRET is not configured');
}

/**
 * Lists the raw, domain-separated identity signals that define "the same
 * person" for one-time credit grants. Each returned string is HMAC-hashed
 * before it goes anywhere near the database; blanks and duplicates are dropped
 * by the caller.
 *
 * This function IS the fraud-vs-friction policy — everything else in the
 * feature is plumbing around it. Trade-offs to weigh:
 * - `email:<lowercased trimmed email>` — simplest durable signal, but beatable
 *   with Gmail `+aliases` (normalize?) and disposable domains.
 * - `oauth:<provider>:<sub>` per identity — strongest on mobile: the Apple and
 *   Google subjects are stable per real Apple/Google account, even behind
 *   Hide-My-Email relays. `identity.provider` + `identity.id` hold these
 *   (supabase-js puts the provider-scoped subject in `identity.id`; it also
 *   appears as `identity_data.sub`).
 * - per-identity emails (`identity.identity_data?.email`) — widens the net to
 *   catch a primary-email swap, at a slight false-positive-linking cost.
 */
export function deriveIdentityFingerprintSignals(user: FingerprintableUser): string[] {
  const signals: string[] = [];
  const email = user.email?.trim().toLowerCase();
  if (email) signals.push(`email:${email}`);

  for (const identity of user.identities ?? []) {
    // 'email'/'phone' identities carry the auth user's own UUID as their
    // provider id — a signal that dies with the account and can never match a
    // re-registration. The primary email above already covers those sign-ins.
    if (identity.provider === 'email' || identity.provider === 'phone') continue;

    // supabase-js puts the provider-scoped subject in `identity.id`;
    // `identity_data.sub` is the same value from the raw claims. Either one
    // pins the real Apple/Google account, Hide-My-Email included.
    const subject = String(identity.id ?? identity.identity_data?.sub ?? '').trim();
    if (subject) signals.push(`oauth:${identity.provider}:${subject}`);

    // The identity's own email widens the net past a primary-email swap done
    // before deletion, at a small false-positive-linking cost.
    const identityEmail = typeof identity.identity_data?.email === 'string'
      ? identity.identity_data.email.trim().toLowerCase()
      : '';
    if (identityEmail) signals.push(`email:${identityEmail}`);
  }

  return signals;
}

export function hashIdentityFingerprintSignal(signal: string | null | undefined): string | null {
  const normalized = signal?.trim();
  if (!normalized) return null;
  return createHmac('sha256', getFingerprintHashSecret()).update(normalized).digest('hex');
}

/** Signals → digests, deduped, blanks dropped. */
export function deriveAccountIdentityFingerprints(user: FingerprintableUser): string[] {
  const fingerprints = new Set<string>();
  for (const signal of deriveIdentityFingerprintSignals(user)) {
    const digest = hashIdentityFingerprintSignal(signal);
    if (digest) fingerprints.add(digest);
  }
  return [...fingerprints];
}

function isMissingAuthUserError(error: unknown) {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { status?: unknown; statusCode?: unknown };
  return String(record.status ?? record.statusCode ?? '') === '404';
}

/**
 * An account's fingerprints, read through the Auth admin API (see
 * `FingerprintableUser`). Throws when the account cannot be read: the caller
 * decides whether its guard may be skipped.
 */
export async function loadAccountIdentityFingerprints(
  admin: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    throw error ?? new Error(`Could not load auth user ${userId} for identity fingerprinting.`);
  }
  return deriveAccountIdentityFingerprints(data.user);
}

/**
 * Records the fingerprints of an account that is about to be deleted, so the
 * same sign-in coming back is known not to be a new account. Runs in the
 * account-deletion flow beside `recordClaimedIdentityFingerprints`, while the
 * Auth row still exists. Idempotent: a digest keeps the time it was first
 * recorded, which is what the referral claim compares with.
 *
 * A guest has no sign-in to come back with, and an account already gone has
 * nothing left to read: both record nothing.
 */
export async function recordDeletedAccountIdentityFingerprints(
  admin: SupabaseClient,
  userId: string,
): Promise<{ fingerprintRows: number }> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  if (error && isMissingAuthUserError(error)) return { fingerprintRows: 0 };
  if (error || !data?.user) {
    throw error ?? new Error(`Could not load auth user ${userId} for identity fingerprinting.`);
  }
  if (data.user.is_anonymous) return { fingerprintRows: 0 };

  const fingerprints = deriveAccountIdentityFingerprints(data.user);
  if (fingerprints.length === 0) return { fingerprintRows: 0 };

  const { error: insertError } = await admin
    .from(DELETED_ACCOUNT_IDENTITY_FINGERPRINT_TABLE)
    .upsert(
      fingerprints.map((fingerprint) => ({ fingerprint })),
      { onConflict: 'fingerprint', ignoreDuplicates: true },
    );
  if (insertError) throw insertError;

  return { fingerprintRows: fingerprints.length };
}

/**
 * Records identity fingerprints for every credit program the given users have
 * already claimed. Idempotent (`ON CONFLICT DO NOTHING` semantics), so callers
 * retry freely.
 *
 * The claim RPC records fingerprints at claim time; this pass exists for the
 * account-deletion flow, where it runs while the auth rows still exist and
 * catches identifiers added or changed after the claim (a swapped email, a
 * newly linked provider). A user that is already gone is skipped — the
 * claim-time rows are its durable record. A user with grants but zero
 * derivable signals is logged and skipped rather than blocking deletion:
 * deleting the account is the user's right; keeping a 25-credit guard is not
 * worth holding it hostage.
 */
export async function recordClaimedIdentityFingerprints(
  admin: SupabaseClient,
  userIds: string[],
  recordedVia: 'deletion' | 'backfill' = 'deletion',
): Promise<{ usersWithGrants: number; fingerprintRows: number }> {
  if (userIds.length === 0) return { usersWithGrants: 0, fingerprintRows: 0 };

  const { data: grants, error: grantsError } = await admin
    .from('credit_grants')
    .select('user_id,program_key')
    .in('user_id', userIds);
  if (grantsError) throw grantsError;

  const programsByUser = new Map<string, Set<string>>();
  for (const row of (grants ?? []) as Array<{ user_id: string; program_key: string }>) {
    const programs = programsByUser.get(row.user_id) ?? new Set<string>();
    programs.add(row.program_key);
    programsByUser.set(row.user_id, programs);
  }
  if (programsByUser.size === 0) return { usersWithGrants: 0, fingerprintRows: 0 };

  const rows: Array<{ program_key: string; fingerprint: string; recorded_via: string }> = [];
  for (const [userId, programs] of programsByUser) {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error && isMissingAuthUserError(error)) continue;
    if (error || !data?.user) {
      throw error ?? new Error(`Could not load auth user ${userId} for identity fingerprinting.`);
    }

    const fingerprints = deriveAccountIdentityFingerprints(data.user);
    if (fingerprints.length === 0) {
      logBackendWarning('account_identity_fingerprint_no_signals', {
        message: 'A user with claimed credit grants produced no identity fingerprint signals; deletion proceeds without a ledger entry.',
        userId,
      });
      continue;
    }

    for (const programKey of programs) {
      for (const fingerprint of fingerprints) {
        rows.push({ program_key: programKey, fingerprint, recorded_via: recordedVia });
      }
    }
  }

  if (rows.length === 0) return { usersWithGrants: programsByUser.size, fingerprintRows: 0 };

  const { error: insertError } = await admin
    .from(ACCOUNT_IDENTITY_FINGERPRINT_TABLE)
    .upsert(rows, { onConflict: 'program_key,fingerprint', ignoreDuplicates: true });
  if (insertError) throw insertError;

  return { usersWithGrants: programsByUser.size, fingerprintRows: rows.length };
}
