import { normalizeInviteShareCode } from './invite-share-link';

/**
 * How each client holds its signed-in account's invite code for the links it
 * shares (`src/lib/invite-share-code.ts` on the web, `ugc-mobile/lib/invite-share-code.ts`
 * in the app). One set of rules, so the two keep, ask again and give up alike;
 * each client brings only its storage and its request (review of 2026-11-10:
 * the rules were written twice, and a fix had to be made twice).
 *
 * - An account's code never changes (a database trigger keeps it), so a code
 *   once read is kept until the account signs out. Only "no link to share"
 *   (an operator switched the link off) is asked about again, after a day.
 * - Only the server's `REFERRAL_LINK_DISABLED` answer means "no link". An
 *   outage, a refused token or a rate limit means "ask later", with a growing
 *   wait, and never replaces a code already held.
 * - A browser or phone keeps the codes of its last few accounts, so two
 *   accounts taking turns on one device do not ask on every switch.
 *
 * Shared with the web by relative import: no React Native, Expo or Node here.
 */

/**
 * The error code the link route answers a switched-off link with (409). The
 * server's copy is `src/lib/referral-link-status.ts`;
 * `src/__tests__/invite-share-code-policy.test.ts` holds the two equal.
 */
export const REFERRAL_LINK_DISABLED_CODE = 'REFERRAL_LINK_DISABLED';

/** A stored "no link to share" is asked about again after this long. */
export const INVITE_SHARE_NO_LINK_RECHECK_MS = 24 * 60 * 60 * 1000;

/** The waits after one, two, three and four or more failed requests in a row. */
export const INVITE_SHARE_CODE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

/** At most this many accounts' codes are kept on one browser or phone. */
export const INVITE_SHARE_CODE_MAX_ACCOUNTS = 5;

export type InviteShareCodeEntry = {
  /** Null when the account has no link to share: an operator switched it off. */
  code: string | null;
  /** When the server said so, in epoch milliseconds. */
  readAt: number;
};

/** Each account's answer, by account id. */
export type InviteShareCodeStore = Record<string, InviteShareCodeEntry>;

/** Reads a stored store, dropping anything that is not a well-formed answer. */
export function parseInviteShareCodeStore(raw: string | null | undefined): InviteShareCodeStore {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const store: InviteShareCodeStore = {};
  for (const [userId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!userId || !value || typeof value !== 'object') continue;
    const entry = value as { code?: unknown; readAt?: unknown };
    if (typeof entry.readAt !== 'number' || !Number.isFinite(entry.readAt)) continue;
    // "No link" is null; anything else must be a code, or it is no answer at
    // all. Read as "no link" it would keep the account's shares bare.
    const code = entry.code === null ? null : normalizeInviteShareCode(entry.code);
    if (entry.code !== null && code === null) continue;
    store[userId] = { code, readAt: entry.readAt };
  }
  return store;
}

/** The store with `userId`'s answer in it, keeping the accounts read most recently. */
export function withInviteShareCodeEntry(
  store: InviteShareCodeStore,
  userId: string,
  entry: InviteShareCodeEntry,
  maxAccounts: number = INVITE_SHARE_CODE_MAX_ACCOUNTS,
): InviteShareCodeStore {
  const next: InviteShareCodeStore = { ...store, [userId]: entry };
  const others = Object.keys(next)
    .filter((id) => id !== userId)
    .sort((a, b) => next[b]!.readAt - next[a]!.readAt);
  for (const id of others.slice(Math.max(0, maxAccounts - 1))) delete next[id];
  return next;
}

/**
 * Whether the server should be asked for `entry`'s account now. A code is
 * kept; "no link" is asked about again after a day; a time from the future is
 * no answer.
 */
export function shouldRequestInviteShareCode(
  entry: InviteShareCodeEntry | null | undefined,
  now: number,
): boolean {
  if (!entry || entry.readAt > now) return true;
  if (entry.code !== null) return false;
  return now - entry.readAt >= INVITE_SHARE_NO_LINK_RECHECK_MS;
}

/** A link request's answer, as either client got it. */
export type InviteShareLinkAnswer =
  | { ok: true; body: unknown }
  | { ok: false; errorCode: unknown };

export type InviteShareLinkOutcome =
  | { kind: 'code'; code: string }
  | { kind: 'none' }
  | { kind: 'retry' };

/** What a link request's answer means for the holder. */
export function readInviteShareLinkAnswer(answer: InviteShareLinkAnswer): InviteShareLinkOutcome {
  if (answer.ok) {
    const body = answer.body && typeof answer.body === 'object' ? answer.body as { code?: unknown } : null;
    const code = normalizeInviteShareCode(body?.code);
    return code ? { kind: 'code', code } : { kind: 'retry' };
  }
  return answer.errorCode === REFERRAL_LINK_DISABLED_CODE ? { kind: 'none' } : { kind: 'retry' };
}

/** When to ask again after `failures` failed requests in a row. */
export function inviteShareCodeRetryAt(failures: number, now: number): number {
  const delays = INVITE_SHARE_CODE_RETRY_DELAYS_MS;
  const index = Math.min(Math.max(Math.floor(failures), 1), delays.length) - 1;
  return now + delays[index]!;
}
