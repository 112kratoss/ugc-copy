import type { User } from '@supabase/supabase-js';

import type { BrowserSupabaseClient } from '@/lib/browser-session';

/**
 * The signed-in viewer's two reads in the browser, asked once for everything on the page that
 * needs them: Supabase Auth's check of the session (`auth.getUser`, a round trip to GoTrue), and
 * the viewer's own `profiles` row.
 *
 * A signed-in post page asked for each on its own in three places (production, 2026-11-20, build
 * 788a6edf2): the page's provider (`AuthProvider`: the check, then the balance and the saver
 * notice's record), the top bar's account (`AppShellAccount`, which sits above every route's
 * provider and cannot read it: the check, then the name, the picture and the balance) and the
 * comment composer's avatar (`account-avatar.ts`: the name and the picture). That was two
 * `/auth/v1/user` and three `/rest/v1/profiles` requests on every load, where one of each answers
 * them all.
 *
 * - A check is of one access token: whoever asks about the same token while it is out, or for
 *   `ACCOUNT_READ_KEPT_MS` after it was answered, is given its answer. It is still Supabase Auth's
 *   own answer about that token, never the session's word for itself (`getSession`). A check that
 *   failed or was refused is not kept: the next caller asks again, as each did before. Nor is one
 *   still out `ACCOUNT_READ_KEPT_MS` after it was asked: a request that hangs is joined by nobody
 *   after that, and whoever asks next asks on their own.
 * - A read of the row is of one account, with every column any of them draws
 *   (`OWN_PROFILE_COLUMNS`), shared the same way. A balance that moved (`credits_updated`, which
 *   every change made on the page announces) ends the reads made before it, so nothing asked
 *   afterwards is given a figure from before the change. A read that failed or found no row is not
 *   kept.
 * - A page asks as it always did (`askedSince`): a page made by a client navigation (Back and
 *   Forward included) takes only what was asked for since it began, so its provider checks the
 *   session and reads the balance as each new page's provider did, and shares them with whatever
 *   else asks meanwhile. A page that came with the document began with it: its provider shares
 *   with the top bar, whichever asks first (on a page that streams, the top bar's part of the HTML
 *   can hydrate and ask before the page's). The top bar and the composer ask once per document.
 * - What must be asked anew is asked anew (`fresh`): a page's explicit re-check
 *   (`refreshSessionState`), a re-read of the balance after `credits_updated`, and the check after
 *   Supabase says the user changed (`USER_UPDATED`). That answer is then the one the next caller
 *   shares.
 * - A sign-out forgets everything (`forgetAccountReads`).
 */

/**
 * How long a check or a read answers whoever asks next: from when it was answered, or, while it is
 * still out, from when it was asked.
 */
export const ACCOUNT_READ_KEPT_MS = 10_000;

/**
 * The columns of the viewer's own row that anything on the page draws: the top bar's name, picture
 * and balance, the provider's balance, its promotional part and the saver notice's record.
 */
export const OWN_PROFILE_COLUMNS = 'display_name, avatar_url, credits, promotional_credits, saver_notice_seen_at';

export interface OwnProfileRow {
  display_name?: string | null;
  avatar_url?: string | null;
  credits?: number | null;
  promotional_credits?: number | null;
  saver_notice_seen_at?: string | null;
}

/** Supabase Auth's answer about an access token, as each caller read it before. */
export interface SessionUserCheck {
  /** The user Supabase Auth named, when it answered. */
  user: User | null;
  /** The check returned an error or threw: `error` says which. */
  failed: boolean;
  /** The check threw rather than returning its error (auth-js returns every error of its own). */
  threw: boolean;
  error: unknown;
}

/** The viewer's own row, or null with `error` when it could not be read. */
export interface OwnProfileRead {
  row: OwnProfileRow | null;
  error: unknown;
}

export interface AccountReadOptions {
  /** Ask Supabase anew whatever is kept or out; whoever asks after shares this answer. */
  fresh?: boolean;
  /**
   * Take only an answer asked for at or after this moment (`performance.now()`): when the page
   * asking began. Left out, any answer still kept is taken.
   */
  askedSince?: number;
}

type Kept<T> = {
  promise: Promise<T>;
  /** When it was asked for (`performance.now()`). */
  askedAt: number;
  /**
   * When it was answered (`performance.now()`, which a change of the computer's clock does not
   * move), null while it is out.
   */
  answeredAt: number | null;
  /** The balance's generation it was asked under (reads of the row only). */
  generation: number;
};

const sessionUserChecks = new Map<string, Kept<SessionUserCheck>>();
const ownProfileReads = new Map<string, Kept<OwnProfileRead>>();
/** Raised by every balance change: a read asked for under an earlier one answers nobody new. */
let profileGeneration = 0;

// Every balance on the page reads itself again on this event (AuthProvider's `announceCredits`,
// the creators, the checkout, the shell's return to the tab): a read from before it is stale.
// Listened for from the moment this module loads, ahead of the providers and the top bar that
// import it, so whatever they read on the same event is read under the new count.
if (typeof window !== 'undefined') {
  window.addEventListener('credits_updated', () => {
    profileGeneration += 1;
  });
}

/**
 * Whether `kept` may be given to someone new: for `ACCOUNT_READ_KEPT_MS` after it was answered, or
 * while it is out, for as long after it was asked (a request that hangs is not joined forever).
 */
function stillAnswers(kept: Kept<unknown>): boolean {
  return performance.now() - (kept.answeredAt ?? kept.askedAt) < ACCOUNT_READ_KEPT_MS;
}

/** Whether `kept` answers a caller who asks with `options`. */
function answers(kept: Kept<unknown>, { fresh = false, askedSince = -Infinity }: AccountReadOptions): boolean {
  return !fresh && kept.askedAt >= askedSince && stillAnswers(kept);
}

/**
 * Keeps `asked` as the one answer for `key` until it settles, and after that while `keep` says
 * the answer may be shared.
 */
function share<T>(
  held: Map<string, Kept<T>>,
  key: string,
  asked: Promise<T>,
  generation: number,
  keep: (answer: T) => boolean,
): Promise<T> {
  // What no longer answers anyone goes: an earlier token's check, an earlier account's read.
  for (const [heldKey, heldAnswer] of held) {
    if (!stillAnswers(heldAnswer)) held.delete(heldKey);
  }
  const kept: Kept<T> = { promise: asked, askedAt: performance.now(), answeredAt: null, generation };
  kept.promise = asked.then((answer) => {
    if (held.get(key) === kept) {
      if (keep(answer)) kept.answeredAt = performance.now();
      else held.delete(key);
    }
    return answer;
  });
  held.set(key, kept);
  return kept.promise;
}

/**
 * Supabase Auth's check of `accessToken` (`auth.getUser(accessToken)`), shared by every caller that
 * asks about the same token while it is out or for `ACCOUNT_READ_KEPT_MS` after it was answered
 * (`AccountReadOptions` narrows which). Never rejects: a check that threw answers with its `error`,
 * as one that returned an error does.
 */
export function checkSessionUser(
  supabase: BrowserSupabaseClient,
  accessToken: string,
  options: AccountReadOptions = {},
): Promise<SessionUserCheck> {
  const held = sessionUserChecks.get(accessToken);
  if (held && answers(held, options)) return held.promise;

  let asked: Promise<SessionUserCheck>;
  try {
    asked = Promise.resolve(supabase.auth.getUser(accessToken)).then(
      ({ data, error }) => ({ user: data?.user ?? null, failed: Boolean(error), threw: false, error }),
      (error: unknown) => ({ user: null, failed: true, threw: true, error }),
    );
  } catch (error) {
    asked = Promise.resolve({ user: null, failed: true, threw: true, error });
  }
  // Only an answer naming a user is kept: an outage or a refusal is asked about again.
  return share(sessionUserChecks, accessToken, asked, 0, (check) => !check.failed && check.user !== null);
}

/**
 * The viewer's own `profiles` row (`OWN_PROFILE_COLUMNS`), shared by every caller that asks about
 * the same account while it is out or for `ACCOUNT_READ_KEPT_MS` after it was answered, unless the
 * balance has moved since it was asked for (`AccountReadOptions` narrows which). Never rejects: a
 * failed read answers with its `error`.
 */
export function readOwnProfile(
  supabase: BrowserSupabaseClient,
  userId: string,
  options: AccountReadOptions = {},
): Promise<OwnProfileRead> {
  const held = ownProfileReads.get(userId);
  if (held && held.generation === profileGeneration && answers(held, options)) return held.promise;

  let asked: Promise<OwnProfileRead>;
  try {
    // Asked in the caller's own turn, as each caller asked before.
    const query = supabase.from('profiles').select(OWN_PROFILE_COLUMNS).eq('id', userId).maybeSingle();
    asked = Promise.resolve(query).then(
      ({ data, error }) => ({ row: (data as OwnProfileRow | null) ?? null, error: error ?? null }),
      (error: unknown) => ({ row: null, error }),
    );
  } catch (error) {
    asked = Promise.resolve({ row: null, error });
  }
  // A row read is kept; a failure, or no row for the account (a read that raced a sign-in), is not.
  return share(ownProfileReads, userId, asked, profileGeneration, (read) => !read.error && read.row !== null);
}

/**
 * Forgets every check and read: a sign-out, a session refused or lost. Whatever is still out
 * answers the callers that asked for it, and nobody after them.
 */
export function forgetAccountReads(): void {
  sessionUserChecks.clear();
  ownProfileReads.clear();
  profileGeneration += 1;
}
