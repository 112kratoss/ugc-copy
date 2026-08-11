import type { SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Who is calling, and what they are allowed to be.
 *
 * Before guest checkout there was one question — "is there a valid JWT?" — and
 * every authenticated route asked it the same way. Anonymous sessions split that
 * into two genuinely different questions, and the split is not cosmetic: a guest
 * holds a perfectly valid JWT, so any route still asking the old question now
 * silently admits them. These helpers exist so the choice is made explicitly,
 * once per route, and can be audited.
 */

/** Stable code for a session whose guest identity has already been linked. */
export const SESSION_MERGED = 'SESSION_MERGED' as const;

export type IdentityKind = 'guest' | 'registered';

export interface AccountIdentity {
  user: User;
  userId: string;
  kind: IdentityKind;
  isGuest: boolean;
}

export type IdentityFailure = {
  ok: false;
  status: number;
  code: 'UNAUTHORIZED' | 'REGISTRATION_REQUIRED' | typeof SESSION_MERGED;
  error: string;
};

export type IdentityResult =
  | { ok: true; identity: AccountIdentity }
  | IdentityFailure;

export function isGuestUser(user: Pick<User, 'is_anonymous'> | null | undefined) {
  return user?.is_anonymous === true;
}

const unauthorized: IdentityFailure = {
  ok: false,
  status: 401,
  code: 'UNAUTHORIZED',
  error: 'Unauthorized',
};

const registrationRequired: IdentityFailure = {
  ok: false,
  status: 403,
  code: 'REGISTRATION_REQUIRED',
  error: 'Create an account to use this feature.',
};

/**
 * A linked guest session is spent. Its credits and the right to act for its data
 * now belong to the registered account, so continuing to serve it would let two
 * sessions act for one balance — and would let a device that never noticed the
 * link keep spending against a row that is permanently zero.
 *
 * 409 rather than 401: the token is genuine and the client should not try to
 * refresh it. The stable code tells the app to move to its registered session.
 */
const sessionMerged: IdentityFailure = {
  ok: false,
  status: 409,
  code: SESSION_MERGED,
  error: 'This guest session has been linked to an account. Sign in to continue.',
};

async function resolveUser(userSupabase: SupabaseClient) {
  const { data: { user }, error } = await userSupabase.auth.getUser();
  return error || !user ? null : user;
}

async function isLinkedGuest(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin
    .from('profiles')
    .select('merged_into_user_id')
    .eq('id', userId)
    .maybeSingle();

  // Fail closed only on a definite answer. A read error here would otherwise
  // reject every guest request during a transient database blip.
  if (error) return false;
  return Boolean((data as { merged_into_user_id?: string | null } | null)?.merged_into_user_id);
}

/**
 * Accepts an active guest or a registered user.
 *
 * Use for anything funded by credits or owned by the identity itself: buying,
 * restoring, reading a balance, every creation tool, and the media those tools
 * produce. Registration buys cross-device access and a public presence, not the
 * right to spend your own credits — that distinction is what guideline 5.1.1(v)
 * turns on.
 */
export async function requireIdentity(
  userSupabase: SupabaseClient,
  admin: SupabaseClient,
): Promise<IdentityResult> {
  const user = await resolveUser(userSupabase);
  if (!user) return unauthorized;

  const guest = isGuestUser(user);
  if (guest && await isLinkedGuest(admin, user.id)) {
    return sessionMerged;
  }

  return {
    ok: true,
    identity: {
      user,
      userId: user.id,
      kind: guest ? 'guest' : 'registered',
      isGuest: guest,
    },
  };
}

/**
 * Rejects guests, linked or not.
 *
 * Use for anything with a public presence or an identity of record: profile
 * mutation and username claims, posts, comments, follows, saves, reports,
 * publishing, remixing, the marketplace, unlocks, referrals, payouts,
 * notifications, push registration, and registration rewards. These are the
 * "account-specific functionality" the guideline explicitly permits gating.
 */
export async function requireRegisteredUser(
  userSupabase: SupabaseClient,
  admin: SupabaseClient,
): Promise<IdentityResult> {
  const result = await requireIdentity(userSupabase, admin);
  if (!result.ok) return result;
  if (result.identity.isGuest) return registrationRequired;
  return result;
}

/**
 * Every user id this account may act for: its own, plus any guest identity
 * linked to it.
 *
 * Guest-created rows keep their original guest UUID forever — the financial
 * tables physically refuse to be rewritten, and the rest are kept consistent
 * with them on purpose. So an owner-scoped read filtered on `= userId` silently
 * hides everything the person made before registering: they link their account,
 * the credits arrive, and their creations appear to have been deleted. Owner
 * reads use `in(...)` over this set instead.
 *
 * Returns the id alone on any failure. Degrading to "your own rows only" is the
 * safe direction — it can hide linked history, but it can never show one
 * account another's work.
 */
export async function resolveLinkedAccountIds(
  admin: SupabaseClient,
  userId: string,
): Promise<string[]> {
  try {
    const { data, error } = await admin
      .from('profiles')
      .select('id')
      .eq('merged_into_user_id', userId);

    if (error || !Array.isArray(data)) return [userId];

    const linked = (data as Array<{ id: string }>)
      .map((row) => row?.id)
      .filter((id): id is string => typeof id === 'string' && id !== userId);

    return [userId, ...linked];
  } catch {
    // Catches, rather than propagating, on purpose. This sits inside read paths
    // that already work — the library list, status polling, archive, delete — so
    // a failure here must degrade to the pre-guest behaviour rather than take
    // those endpoints down with it. Hiding linked history is recoverable on the
    // next request; a 500 on someone's library is not.
    return [userId];
  }
}

/**
 * The identity for an optional-auth route.
 *
 * Public surfaces treat a guest as an unsigned viewer unless they are explicitly
 * guest-enabled: a guest has no follows, saves or blocks to personalise against,
 * and feeding an anonymous id into viewer-scoped queries would attribute
 * engagement to an identity that is about to be linked away.
 */
export async function resolveViewerIdentity(
  userSupabase: SupabaseClient,
  { guestEnabled = false }: { guestEnabled?: boolean } = {},
): Promise<{ viewerId: string | null; isGuest: boolean }> {
  const user = await resolveUser(userSupabase);
  if (!user) return { viewerId: null, isGuest: false };

  const guest = isGuestUser(user);
  return {
    viewerId: guest && !guestEnabled ? null : user.id,
    isGuest: guest,
  };
}
