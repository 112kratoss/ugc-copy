import AsyncStorage from '@react-native-async-storage/async-storage';

import type { MagicbookletApiClient } from './api-client';
import { heldInviteShareCode, holdInviteShareCode } from './invite-share-code-state';
import {
  inviteShareCodeRetryAt,
  parseInviteShareCodeStore,
  readInviteShareLinkAnswer,
  shouldRequestInviteShareCode,
  withInviteShareCodeEntry,
  type InviteShareCodeEntry,
  type InviteShareCodeStore,
  type InviteShareLinkAnswer,
} from './invite-share-link/invite-share-code-policy';

/**
 * Fills the app's holder of the signed-in account's invite code
 * (`invite-share-code-state.ts`), so the links it shares carry the invite
 * (`lib/invite-share-link/`, shared with the web, and so are the rules for
 * keeping the code: `invite-share-code-policy.ts`).
 *
 * A share should open its sheet at the tap, not after a request, so the code is
 * asked for ahead of time: when the account is known, and again when the app
 * comes back if it still has none (`lib/auth.tsx`). It is kept on the phone
 * under the account's id; a code never changes, so it is not asked for again.
 * The request is the Invite screen's own, `POST /api/referrals/link`, so it
 * makes the account's link if it had none, and it names this installation,
 * which the referral abuse guard records. A share made before the code has
 * arrived goes out without it, as a guest's always does.
 */

export const INVITE_SHARE_CODE_STORAGE_KEY = 'magicbooklet.invite.shareCodes.v1';

type CodeStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

type InviteLinkApi = Pick<MagicbookletApiClient, 'createReferralLink'>;

const pending = new Map<string, Promise<string | null>>();
const failures = new Map<string, { count: number; retryAt: number }>();
/** Answers read this run, for a phone whose storage fails. */
let memoryStore: InviteShareCodeStore = {};

async function readStore(storage: CodeStorage): Promise<InviteShareCodeStore> {
  try {
    return parseInviteShareCodeStore(await storage.getItem(INVITE_SHARE_CODE_STORAGE_KEY));
  } catch {
    return {};
  }
}

async function writeEntry(storage: CodeStorage, userId: string, entry: InviteShareCodeEntry): Promise<void> {
  memoryStore = withInviteShareCodeEntry(memoryStore, userId, entry);
  try {
    const stored = await readStore(storage);
    await storage.setItem(INVITE_SHARE_CODE_STORAGE_KEY, JSON.stringify(withInviteShareCodeEntry(stored, userId, entry)));
  } catch {
    // Held for this run; asked for again at the next start.
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
}

/**
 * Holds `userId`'s code for its shares: what the phone stored first, then the
 * server's answer when there is none yet (or a day-old "no link"). Never
 * throws and never asks twice at once; after a failure it waits longer each
 * time before asking again, and keeps whatever it held.
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
  const heldCode = () => (stillHeld() ? heldInviteShareCode()!.code : null);

  if (!stillHeld()) holdInviteShareCode(userId, null, null);
  const stored = (await readStore(storage))[userId] ?? memoryStore[userId] ?? null;
  if (!stillHeld()) return null;
  const entry = stored && stored.readAt <= now ? stored : null;
  if (entry) holdInviteShareCode(userId, entry.code, entry.readAt);

  if (!shouldRequestInviteShareCode(entry, now)) return heldCode();

  const failure = failures.get(userId);
  if (failure && now < failure.retryAt) return heldCode();

  const inFlight = pending.get(userId);
  if (inFlight) return inFlight;

  const request = (async (): Promise<string | null> => {
    let answer: InviteShareLinkAnswer;
    try {
      answer = { ok: true, body: await api.createReferralLink() };
    } catch (error) {
      answer = { ok: false, errorCode: errorCode(error) };
    }

    const outcome = readInviteShareLinkAnswer(answer);
    if (outcome.kind === 'retry') {
      const count = (failures.get(userId)?.count ?? 0) + 1;
      failures.set(userId, { count, retryAt: inviteShareCodeRetryAt(count, now) });
      return heldCode();
    }

    failures.delete(userId);
    const code = outcome.kind === 'code' ? outcome.code : null;
    void writeEntry(storage, userId, { code, readAt: now });
    if (stillHeld()) holdInviteShareCode(userId, code, now);
    return code;
  })().finally(() => {
    pending.delete(userId);
  });
  pending.set(userId, request);
  return request;
}

/** For tests: a fresh app start. */
export function resetInviteShareCodePrimingForTests(): void {
  pending.clear();
  failures.clear();
  memoryStore = {};
}
