import type { Session } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import { getRegisteredUser, isGuestSession } from '@/lib/guest-session';

function sessionFor(user: Record<string, unknown> | null) {
  return (user ? { access_token: 'token-1', user } : null) as unknown as Session | null;
}

describe('guest session identity', () => {
  it('treats an anonymous session as not registered', () => {
    // The load-bearing assertion for this whole feature. Roughly seventy
    // `!user` checks across the app gate publishing, comments, follows, the
    // marketplace and payouts. If a guest ever reads as registered, all of them
    // open at once — a far bigger behavioural change than App Review asked for.
    const guest = sessionFor({ id: 'guest-1', is_anonymous: true });

    expect(isGuestSession(guest)).toBe(true);
    expect(getRegisteredUser(guest)).toBeNull();
  });

  it('passes a registered session through unchanged', () => {
    const registered = sessionFor({ id: 'user-1', is_anonymous: false, email: 'real@example.com' });

    expect(isGuestSession(registered)).toBe(false);
    expect(getRegisteredUser(registered)?.id).toBe('user-1');
  });

  it('treats a session with no anonymity claim as registered', () => {
    // Sessions minted before anonymous sign-ins existed carry no is_anonymous
    // claim. Reading a missing claim as "guest" would sign out every user who
    // upgrades into this build.
    const legacy = sessionFor({ id: 'user-2', email: 'legacy@example.com' });

    expect(isGuestSession(legacy)).toBe(false);
    expect(getRegisteredUser(legacy)?.id).toBe('user-2');
  });

  it('reports no identity when there is no session at all', () => {
    // Anonymous bootstrap is allowed to fail — offline, or the project setting
    // not yet flipped. The app must fall back to its pre-guest behaviour rather
    // than invent an identity.
    expect(isGuestSession(null)).toBe(false);
    expect(getRegisteredUser(null)).toBeNull();
  });

  it('does not infer registration from a truthy access token', () => {
    // Anonymity comes from the claim the auth server signed, never from the
    // presence of a token — a guest holds a perfectly valid one.
    const guest = sessionFor({ id: 'guest-2', is_anonymous: true });

    expect(getRegisteredUser(guest)).toBeNull();
  });
});
