import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MagicbookletApiClient } from './api-client';
import { heldInviteShareCode, holdInviteShareCode } from './invite-share-code-state';
import { normalizeInviteShareCode } from './invite-share-link/invite-share-link';

/**
 * Fills the app's holder of the signed-in account's invite code
 * (`invite-share-code-state.ts`), so the links it shares carry the invite
 * (`lib/invite-share-link/`, shared with the web).
 *
 * A share should open its sheet at the tap, not after a request, so the code is
 * asked for ahead of time: once when the account is known (`lib/auth.tsx`), kept
 * on the phone under the account's id, and asked for again only after a week.
 * The request is the Invite screen's own, `POST /api/referrals/link`, so it
 * makes the account's link if it had none; it also tells the server which
 * installation the account uses the program from, which the referral abuse
 * guard reads. A share made before the code has arrived goes out without it,
 * as a guest's always does.
 */

export const INVITE_SHARE_CODE_STORAGE_KEY = 'magicbooklet.invite.shareCode.v1';
/** A stored answer is asked for again after this long. */
export const INVITE_SHARE_CODE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type StoredInviteShareCode = {
  userId: string;
  /** Null when the account has no link to share: an operator switched it off. */
  code: string | null;
  readAt: number;
};

type CodeStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

type InviteLinkApi = Pick<MagicbookletApiClient, 'createReferralLink'>;

const pending = new Map<string, Promise<string | null>>();

async function readStored(storage: CodeStorage, userId: string): Promise<StoredInviteShareCode | null> {
  try {
    const parsed: unknown = JSON.parse((await storage.getItem(INVITE_SHARE_CODE_STORAGE_KEY)) ?? 'null');
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

function errorStatus(error: unknown): number {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status?: unknown }).status)
    : 0;
}

/**
 * Holds `userId`'s code for its shares: what the phone stored first, then the
 * server's answer when the stored one is missing or a week old. Never throws
 * and never asks twice at once; a request that fails leaves what was held (an
 * older code is still the account's code).
 */
export async function primeInviteShareCode(
  api: InviteLinkApi,
  userId: string,
  options: { storage?: CodeStorage; now?: number } = {},
): Promise<string | null> {
  const storage = options.storage ?? AsyncStorage;
  const now = options.now ?? Date.now();
  // Is this account still the one in front? Another may sign in while a read
  // or a request is on its way, and must not be handed this one's code.
  const stillHeld = () => heldInviteShareCode()?.userId === userId;

  if (!stillHeld()) holdInviteShareCode(userId, null, null);
  const stored = await readStored(storage, userId);
  if (!stillHeld()) return null;
  if (stored) holdInviteShareCode(userId, stored.code, stored.readAt);

  const held = heldInviteShareCode()!;
  if (held.readAt !== null && now >= held.readAt && now - held.readAt < INVITE_SHARE_CODE_MAX_AGE_MS) {
    return held.code;
  }

  const inFlight = pending.get(userId);
  if (inFlight) return inFlight;

  const request = (async (): Promise<string | null> => {
    const answer = (code: string | null) => {
      void storage
        .setItem(INVITE_SHARE_CODE_STORAGE_KEY, JSON.stringify({ userId, code, readAt: now } satisfies StoredInviteShareCode))
        .catch(() => {
          // Held for this run; asked for again at the next start.
        });
      if (stillHeld()) holdInviteShareCode(userId, code, now);
      return code;
    };
    try {
      const link = await api.createReferralLink();
      const code = normalizeInviteShareCode(link?.code);
      return code ? answer(code) : (stillHeld() ? heldInviteShareCode()!.code : null);
    } catch (error) {
      // 503 is the route's answer for a link that is switched off: the account
      // has no invite to carry until an operator switches it on again.
      if (errorStatus(error) === 503) return answer(null);
      return stillHeld() ? heldInviteShareCode()!.code : null;
    } finally {
      pending.delete(userId);
    }
  })();
  pending.set(userId, request);
  return request;
}

/** For tests: a fresh app start. */
export function resetInviteShareCodePrimingForTests(): void {
  pending.clear();
}
