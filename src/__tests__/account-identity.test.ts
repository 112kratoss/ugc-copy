import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

import {
  ACCOUNT_DELETING,
  IDENTITY_CHECK_UNAVAILABLE,
  isGuestUser,
  requireIdentity,
  requireRegisteredUser,
  resolveLinkedAccountIds,
  resolveViewerIdentity,
  SESSION_MERGED,
} from '@/lib/account-identity';

function adminFor(options: {
  linkedIds?: string[];
  identityState?: 'active' | 'merged' | 'deleting';
  profilesError?: unknown;
  throwOnProfiles?: boolean;
} = {}) {
  const {
    linkedIds = [],
    identityState = 'active',
    profilesError = null,
    throwOnProfiles = false,
  } = options;

  return {
    from: vi.fn(() => {
      if (throwOnProfiles) throw new Error('profiles unavailable');
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({
          data: { identity_state: identityState },
          error: profilesError,
        })),
        then: (resolve: (value: unknown) => void) => Promise.resolve({
          data: linkedIds.map((id) => ({ id })),
          error: profilesError,
        }).then(resolve),
      };
      return query;
    }),
  } as unknown as SupabaseClient;
}

function userClientFor(user: Record<string, unknown> | null) {
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user },
        error: user ? null : new Error('no session'),
      })),
    },
  } as unknown as SupabaseClient;
}

const guest = { id: 'guest-1', is_anonymous: true };
const registered = { id: 'user-1', is_anonymous: false };

describe('account identity', () => {
  describe('resolveLinkedAccountIds', () => {
    it('returns the caller alone when nothing is linked', () => {
      // The overwhelmingly common case, and it must reproduce the pre-guest
      // behaviour exactly.
      return expect(resolveLinkedAccountIds(adminFor(), 'user-1')).resolves.toEqual(['user-1']);
    });

    it('includes every guest identity linked to the account', async () => {
      // The user-visible bug this fixes: work made before registering keeps its
      // guest UUID, so an owner read filtered on the caller alone made someone's
      // whole pre-registration library look deleted the moment they signed up.
      const ids = await resolveLinkedAccountIds(
        adminFor({ linkedIds: ['guest-1', 'guest-2'] }),
        'user-1',
      );

      expect(ids).toEqual(['user-1', 'guest-1', 'guest-2']);
    });

    it('never repeats the caller if it somehow appears linked to itself', async () => {
      const ids = await resolveLinkedAccountIds(adminFor({ linkedIds: ['user-1'] }), 'user-1');

      expect(ids).toEqual(['user-1']);
    });

    it('degrades to the caller alone rather than failing the request', async () => {
      // This sits inside read paths that already work — the library, status
      // polling, archive, delete. Hiding linked history is recoverable on the
      // next request; a 500 on someone's library is not.
      await expect(resolveLinkedAccountIds(adminFor({ throwOnProfiles: true }), 'user-1'))
        .resolves.toEqual(['user-1']);
      await expect(resolveLinkedAccountIds(adminFor({ profilesError: new Error('nope') }), 'user-1'))
        .resolves.toEqual(['user-1']);
    });
  });

  describe('requireIdentity', () => {
    it('admits an active guest', async () => {
      const result = await requireIdentity(userClientFor(guest), adminFor());

      expect(result.ok).toBe(true);
      expect(result.ok && result.identity).toMatchObject({ userId: 'guest-1', kind: 'guest', isGuest: true });
    });

    it('admits a registered user', async () => {
      const result = await requireIdentity(userClientFor(registered), adminFor());

      expect(result.ok && result.identity.kind).toBe('registered');
    });

    it('rejects a guest session that has already been linked', async () => {
      // A linked guest session is spent: its credits and the right to act for
      // its data now belong to the registered account. Serving it would let two
      // sessions act for one balance.
      const result = await requireIdentity(userClientFor(guest), adminFor({ identityState: 'merged' }));

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe(SESSION_MERGED);
      // 409, not 401: the token is genuine and refreshing it will not help.
      expect(!result.ok && result.status).toBe(409);
    });

    it('rejects a deleting identity before it can reach application work', async () => {
      const result = await requireIdentity(
        userClientFor(registered),
        adminFor({ identityState: 'deleting' }),
      );

      expect(result.ok).toBe(false);
      expect(!result.ok && result.code).toBe(ACCOUNT_DELETING);
      expect(!result.ok && result.status).toBe(409);
    });

    it('fails closed with 503 when profile state cannot be loaded', async () => {
      const failed = await requireIdentity(
        userClientFor(registered),
        adminFor({ profilesError: new Error('database unavailable') }),
      );
      const thrown = await requireIdentity(
        userClientFor(registered),
        adminFor({ throwOnProfiles: true }),
      );
      const authLookupThrown = await requireIdentity({
        auth: {
          getUser: vi.fn(async () => {
            throw new Error('auth service unavailable');
          }),
        },
      } as unknown as SupabaseClient, adminFor());
      const adminFactoryThrown = await requireIdentity(
        userClientFor(registered),
        () => {
          throw new Error('service client unavailable');
        },
      );

      for (const result of [failed, thrown, authLookupThrown, adminFactoryThrown]) {
        expect(result.ok).toBe(false);
        expect(!result.ok && result.code).toBe(IDENTITY_CHECK_UNAVAILABLE);
        expect(!result.ok && result.status).toBe(503);
      }
    });

    it('rejects an unauthenticated caller', async () => {
      const result = await requireIdentity(userClientFor(null), adminFor());

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(401);
    });
  });

  describe('requireRegisteredUser', () => {
    it('rejects an active guest with a distinct code', async () => {
      const result = await requireRegisteredUser(userClientFor(guest), adminFor());

      expect(result.ok).toBe(false);
      expect(!result.ok && result.status).toBe(403);
      expect(!result.ok && result.code).toBe('REGISTRATION_REQUIRED');
    });

    it('admits a registered user', async () => {
      const result = await requireRegisteredUser(userClientFor(registered), adminFor());

      expect(result.ok).toBe(true);
    });
  });

  describe('resolveViewerIdentity', () => {
    it('treats a guest as an unsigned viewer by default', async () => {
      // A guest has no follows, saves or blocks to personalise against, and
      // attributing engagement to an identity that is about to be linked away
      // would poison the feed signals it feeds.
      const result = await resolveViewerIdentity(userClientFor(guest));

      expect(result).toEqual({ viewerId: null, isGuest: true });
    });

    it('passes the guest id through where a surface opts in', async () => {
      const result = await resolveViewerIdentity(userClientFor(guest), { guestEnabled: true });

      expect(result).toEqual({ viewerId: 'guest-1', isGuest: true });
    });

    it('always passes a registered viewer through', async () => {
      const result = await resolveViewerIdentity(userClientFor(registered));

      expect(result).toEqual({ viewerId: 'user-1', isGuest: false });
    });
  });

  describe('isGuestUser', () => {
    it('only treats an explicit anonymity claim as a guest', () => {
      // Sessions minted before anonymous sign-ins existed carry no claim at all.
      // Reading a missing claim as "guest" would lock out every existing user.
      expect(isGuestUser({ is_anonymous: true })).toBe(true);
      expect(isGuestUser({ is_anonymous: false })).toBe(false);
      expect(isGuestUser({} as never)).toBe(false);
      expect(isGuestUser(null)).toBe(false);
    });
  });
});
