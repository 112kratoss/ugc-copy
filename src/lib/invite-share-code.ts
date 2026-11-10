import { normalizeInviteShareCode } from '../../ugc-mobile/lib/invite-share-link/invite-share-link';

/**
 * The invite code of the account signed in to this browser, for the links it
 * shares (`share-client.ts`). The link's shape is the shared module's
 * (`ugc-mobile/lib/invite-share-link/`); this is how the web comes to hold the
 * code at the moment a share is made.
 *
 * A share has to go out in the click that asked for it: `navigator.share` is
 * only allowed while the browser still counts that click as the user's, so the
 * code cannot be fetched then. It is asked for once, in idle time after the
 * account signs in (`AuthProvider`), kept in `localStorage` under the account's
 * id, and asked for again only after a week. That is one request per account
 * per browser per week for something every later share reads for free, and the
 * request is the same `POST /api/referrals/link` the Invite page makes, so the
 * account's link is created by it if it had none.
 *
 * A share made before the code has arrived goes out without it. So does every
 * share of a guest or a signed-out visitor, who have no invite to carry.
 */

export const INVITE_SHARE_CODE_STORAGE_KEY = 'mb.invite-share-code.v1';
/** A stored answer is asked for again after this long. */
export const INVITE_SHARE_CODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredInviteShareCode = {
  userId: string;
  /** Null when the account has no link to share: an operator switched it off. */
  code: string | null;
  readAt: number;
};

type CodeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `readAt` is null until an answer has been read, from the store or the server. */
let held: { userId: string; code: string | null; readAt: number | null } | null = null;
const pending = new Map<string, Promise<string | null>>();

function browserStorage(): CodeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Storage is refused outright in some private modes.
    return null;
  }
}

function readStored(storage: CodeStorage | null, userId: string): StoredInviteShareCode | null {
  if (!storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(INVITE_SHARE_CODE_STORAGE_KEY) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const stored = parsed as Partial<StoredInviteShareCode>;
    if (stored.userId !== userId || typeof stored.readAt !== 'number' || !Number.isFinite(stored.readAt)) return null;
    const code = stored.code === null ? null : normalizeInviteShareCode(stored.code);
    // A value that is neither "no link" nor a code is no answer at all: read as
    // "no link" it would keep the account's shares bare for a week.
    if (stored.code !== null && code === null) return null;
    return { userId, code, readAt: stored.readAt };
  } catch {
    return null;
  }
}

function writeStored(storage: CodeStorage | null, stored: StoredInviteShareCode): void {
  try {
    storage?.setItem(INVITE_SHARE_CODE_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // A full or refused store only means the code is asked for again next time.
  }
}

/** The signed-in account's invite code, when this browser holds it. Null otherwise. */
export function currentInviteShareCode(): string | null {
  return held?.code ?? null;
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
): { code: string | null; readAt: number | null } {
  const stored = readStored(storage, userId);
  if (stored) {
    held = { userId, code: stored.code, readAt: stored.readAt };
  } else if (held?.userId !== userId) {
    // Nothing stored, and what is held is another account's or nobody's. An
    // answer this page already read for this account stays (a browser that
    // refuses storage still asks only once a week per page).
    held = { userId, code: null, readAt: null };
  }
  return { code: held.code, readAt: held.readAt };
}

/**
 * Holds `userId`'s code for its shares: what this browser stored at once, then
 * the server's answer when the stored one is missing or a week old. Never
 * throws and never asks twice at once; a request that fails leaves what was
 * held (an older code is still the account's code).
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
  const { code: heldCode, readAt } = holdStoredInviteShareCode(userId, storage);
  if (readAt !== null && now >= readAt && now - readAt < INVITE_SHARE_CODE_MAX_AGE_MS) {
    return heldCode;
  }

  const inFlight = pending.get(userId);
  if (inFlight) return inFlight;

  const request = (async (): Promise<string | null> => {
    try {
      const response = await fetchImpl('/api/referrals/link', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      // 503 is the route's answer for a link that is switched off: the account
      // has no invite to carry until an operator switches it on again.
      const unavailable = response.status === 503;
      if (!response.ok && !unavailable) return held?.userId === userId ? held.code : null;

      const body: unknown = unavailable ? null : await response.json().catch(() => null);
      const code = body && typeof body === 'object'
        ? normalizeInviteShareCode((body as { code?: unknown }).code)
        : null;
      if (!unavailable && !code) return held?.userId === userId ? held.code : null;

      writeStored(storage, { userId, code, readAt: now });
      // Another account may have signed in while this one's answer was on its way.
      if (held?.userId === userId) held = { userId, code, readAt: now };
      return code;
    } catch {
      return held?.userId === userId ? held.code : null;
    } finally {
      pending.delete(userId);
    }
  })();
  pending.set(userId, request);
  return request;
}

/** Test seam: the code lives as long as the page, so a test must be able to start clean. */
export function resetInviteShareCodeForTests(): void {
  held = null;
  pending.clear();
}
