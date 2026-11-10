import { hasSupabaseAuthCookie, readSupabaseAuthCookieUserId } from '@/lib/supabase-auth-cookie';

import {
  inviteShareCodeRetryAt,
  parseInviteShareCodeStore,
  readInviteShareLinkAnswer,
  shouldRequestInviteShareCode,
  withInviteShareCodeEntry,
  type InviteShareCodeEntry,
  type InviteShareCodeStore,
  type InviteShareLinkAnswer,
} from '../../ugc-mobile/lib/invite-share-link/invite-share-code-policy';

/**
 * The invite code of the account signed in to this browser, for the links it
 * shares (`share-client.ts`). The link's shape is the shared module's
 * (`ugc-mobile/lib/invite-share-link/`), and so are the rules for keeping the
 * code (`invite-share-code-policy.ts`); this is how the web comes to hold it at
 * the moment a share is made.
 *
 * A share has to go out in the click that asked for it: `navigator.share` is
 * only allowed while the browser still counts that click as the user's, so the
 * code cannot be fetched then. It is asked for in idle time after the account
 * signs in (`AuthProvider`), with the same `POST /api/referrals/link` the
 * Invite page makes, and kept in `localStorage` under the account's id. A code
 * never changes, so it is not asked for again.
 *
 * A share made before the code has arrived goes out without it. So does every
 * share of a guest or a signed-out visitor, who have no invite to carry.
 */

export const INVITE_SHARE_CODE_STORAGE_KEY = 'mb.invite-share-codes.v1';

type CodeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let held: { userId: string; code: string | null } | null = null;
/** Answers read this page, for a browser that refuses storage. */
let memoryStore: InviteShareCodeStore = {};
const pending = new Map<string, Promise<string | null>>();
const failures = new Map<string, { count: number; retryAt: number }>();

function browserStorage(): CodeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage is refused outright in some private modes.
    return null;
  }
}

function readEntry(storage: CodeStorage | null, userId: string): InviteShareCodeEntry | null {
  let stored: InviteShareCodeStore = {};
  try {
    stored = parseInviteShareCodeStore(storage?.getItem(INVITE_SHARE_CODE_STORAGE_KEY));
  } catch {
    // Unreadable storage holds nothing.
  }
  return stored[userId] ?? memoryStore[userId] ?? null;
}

function writeEntry(storage: CodeStorage | null, userId: string, entry: InviteShareCodeEntry): void {
  memoryStore = withInviteShareCodeEntry(memoryStore, userId, entry);
  try {
    const stored = parseInviteShareCodeStore(storage?.getItem(INVITE_SHARE_CODE_STORAGE_KEY));
    storage?.setItem(INVITE_SHARE_CODE_STORAGE_KEY, JSON.stringify(withInviteShareCodeEntry(stored, userId, entry)));
  } catch {
    // A full or refused store only means the code is asked for again next page.
  }
}

/**
 * The signed-in account's invite code, when this browser holds it. Null
 * otherwise.
 *
 * The session cookie is checked at the moment of the share: a sign-out made
 * on a page that runs no `AuthProvider` (Pricing, Alerts, the login page), or
 * another account signing in there, never reached this module, and the next
 * share in that tab carried the last account's code (review of 2026-11-10).
 */
export function currentInviteShareCode(cookieHeader?: string): string | null {
  if (!held?.code) return null;
  if (!hasSupabaseAuthCookie(cookieHeader)) {
    held = null;
    return null;
  }
  const cookieUserId = readSupabaseAuthCookieUserId(cookieHeader);
  if (cookieUserId && cookieUserId !== held.userId) {
    held = null;
    return null;
  }
  return held.code;
}

/**
 * Lets go of the code, when the account signs out or another signs in: a link
 * shared after that must not carry the last account's invite. The stored copy
 * stays, under that account's id, for when it signs in here again.
 */
export function forgetInviteShareCode(): void {
  held = null;
}

/**
 * Holds what this browser stored for `userId`, at once and without a request:
 * the account's shares carry its code from its first click after signing in,
 * not from whenever the idle request below gets its turn.
 */
export function holdStoredInviteShareCode(
  userId: string,
  storage: CodeStorage | null = browserStorage(),
  now: number = Date.now(),
): InviteShareCodeEntry | null {
  const entry = readEntry(storage, userId);
  const usable = entry && entry.readAt <= now ? entry : null;
  if (usable) held = { userId, code: usable.code };
  else if (held?.userId !== userId) held = { userId, code: null };
  return usable;
}

function heldCodeOf(userId: string): string | null {
  return held?.userId === userId ? held.code : null;
}

/**
 * Holds `userId`'s code for its shares: what this browser stored at once, then
 * the server's answer when there is none yet (or a day-old "no link"). Never
 * throws and never asks twice at once; after a failure it waits longer each
 * time before asking again, and keeps whatever it held.
 */
export async function primeInviteShareCode({
  userId,
  accessToken,
  now = Date.now(),
  storage = browserStorage(),
  fetchImpl = fetch,
}: {
  userId: string;
  accessToken: string;
  now?: number;
  storage?: CodeStorage | null;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const entry = holdStoredInviteShareCode(userId, storage, now);
  if (!shouldRequestInviteShareCode(entry, now)) return heldCodeOf(userId);

  const failure = failures.get(userId);
  if (failure && now < failure.retryAt) return heldCodeOf(userId);

  const inFlight = pending.get(userId);
  if (inFlight) return inFlight;

  const request = (async (): Promise<string | null> => {
    let answer: InviteShareLinkAnswer;
    try {
      const response = await fetchImpl('/api/referrals/link', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body: unknown = await response.json().catch(() => null);
      answer = response.ok
        ? { ok: true, body }
        : { ok: false, errorCode: body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined };
    } catch {
      answer = { ok: false, errorCode: undefined };
    }

    const outcome = readInviteShareLinkAnswer(answer);
    if (outcome.kind === 'retry') {
      const count = (failures.get(userId)?.count ?? 0) + 1;
      failures.set(userId, { count, retryAt: inviteShareCodeRetryAt(count, now) });
      return heldCodeOf(userId);
    }

    failures.delete(userId);
    const code = outcome.kind === 'code' ? outcome.code : null;
    writeEntry(storage, userId, { code, readAt: now });
    // Another account may have signed in while this one's answer was on its way.
    if (held?.userId === userId) held = { userId, code };
    return code;
  })().finally(() => {
    pending.delete(userId);
  });
  pending.set(userId, request);
  return request;
}

/** Test seam: the code lives as long as the page, so a test must be able to start clean. */
export function resetInviteShareCodeForTests(): void {
  held = null;
  memoryStore = {};
  pending.clear();
  failures.clear();
}
