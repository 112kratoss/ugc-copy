import type { Session, User } from '@supabase/supabase-js';

/**
 * Guest identity, kept out of auth.tsx so it can be unit tested.
 *
 * A guest is a real Supabase user — an anonymous auth.users row with a valid
 * access token — which is what lets the existing purchase, credit and
 * generation endpoints serve them with no changes. The distinction that
 * matters to the app is not "signed in or not" but "registered or not".
 */
export function isGuestSession(session: Session | null) {
  return session?.user?.is_anonymous === true;
}

/**
 * The registered account behind a session, or null for a guest.
 *
 * Anonymity is read from the claim the auth server signed, never from local
 * state or from the mere presence of a token, so a guest cannot be mistaken
 * for a registered user by anything that gates on `user`. Sessions minted
 * before anonymous sign-ins existed carry no claim at all and are treated as
 * registered — reading a missing claim as "guest" would sign out every user
 * who upgrades into this build.
 */
export function getRegisteredUser(session: Session | null): User | null {
  if (!session?.user || isGuestSession(session)) return null;
  return session.user;
}
