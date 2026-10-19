import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  SAVER_NOTICE_TAP_GUARD_MS,
  createSaverNoticePolicy,
  saverNoticeStorageKey,
  type SaverNoticeFields,
} from '../../ugc-mobile/lib/saver-notice-policy/saver-notice-policy';
import { dismissToast, hasFeedbackViewport, pushToast } from './feedback-state';

/**
 * The web's half of the saver notice: the policy is shared with the app
 * (`ugc-mobile/lib/saver-notice-policy/saver-notice-policy.ts`); this gives it
 * the browser's storage, the account's record on the server and a toast.
 *
 * A toast that ran out on a page out of view was not read. One shown while the
 * reel is open is drawn inside the reel's dialog (`setToastHost`), where a
 * screen reader can reach it and it sits below the reel's header.
 */
export { SAVER_NOTICE_MESSAGE };
export type { SaverNoticeFields };

const SAVER_NOTICE_ROUTE = '/api/profile/saver-notice';

/** The last token seen for each account, so a telling is recorded as that account. */
const tokens = new Map<string, string>();
const toastIds = new Map<string, number>();
/** Accounts whose record was asked for on this page. */
const requested = new Set<string>();
/** Accounts whose record as the page was drawn has been taken in. */
const pageRecordsApplied = new Set<string>();

function readStored(accountId: string) {
  try {
    return window.localStorage.getItem(saverNoticeStorageKey(accountId));
  } catch {
    // Storage refused (a private window): this page's memory is all there is.
    return null;
  }
}

const policy = createSaverNoticePolicy({
  remember(accountId, memory) {
    try {
      const key = saverNoticeStorageKey(accountId);
      if (memory) window.localStorage.setItem(key, memory);
      else window.localStorage.removeItem(key);
    } catch {
      // Remembered on this page; the server's record tells the next one.
    }
  },
  async record(accountId) {
    const accessToken = tokens.get(accountId);
    if (!accessToken) return false;
    try {
      const response = await fetch(SAVER_NOTICE_ROUTE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  },
  show(accountId) {
    // A toast pushed with nothing subscribed is never seen: tell them at a later tap.
    if (!hasFeedbackViewport()) return false;
    const toastId = pushToast({
      tone: 'info',
      message: SAVER_NOTICE_MESSAGE,
      durationMs: SAVER_NOTICE_DURATION_MS,
      closeGuardMs: SAVER_NOTICE_TAP_GUARD_MS,
      onDismiss: (how) => {
        toastIds.delete(accountId);
        // A notice that ran out on a page out of view was not read.
        const unread = how === 'interrupted' || (how === 'expired' && document.visibilityState === 'hidden');
        policy.settle(accountId, unread ? 'interrupted' : how === 'expired' ? 'expired' : 'closed');
      },
    });
    toastIds.set(accountId, toastId);
    return true;
  },
  hide(accountId) {
    const toastId = toastIds.get(accountId);
    if (toastId !== undefined) dismissToast(toastId, 'interrupted');
  },
});

/**
 * The account signed in on this page, or null. `seen` is its record as the
 * page was drawn (`ServerAuthState.saverNoticeSeen`); when the page could not
 * know it (a sign-in without a reload), the record is asked for once.
 */
export function syncSaverNotice(
  accountId: string | null,
  accessToken?: string | null,
  seen?: boolean | null,
) {
  if (accountId && accessToken) tokens.set(accountId, accessToken);
  if (accountId) policy.restore(accountId, readStored(accountId));
  policy.setActiveAccount(accountId);
  if (!accountId) return;

  if (typeof seen === 'boolean') {
    // The page hands out the record it was drawn with for as long as it is
    // open, and syncs again at every token refresh: taken in once, or a "not
    // told" from the page load would wipe a telling recorded since.
    if (!pageRecordsApplied.has(accountId)) {
      pageRecordsApplied.add(accountId);
      policy.applyServerRecord(accountId, seen);
    }
    return;
  }
  if (!accessToken || requested.has(accountId)) return;
  requested.add(accountId);
  void (async () => {
    try {
      const response = await fetch(SAVER_NOTICE_ROUTE, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) throw new Error(`saver notice record: ${response.status}`);
      const data = await response.json() as { seen?: unknown };
      policy.applyServerRecord(accountId, data.seen === true);
    } catch {
      // Asked again at the next sync on this page.
      requested.delete(accountId);
    }
  })();
}

/**
 * The fields a save request carries about telling its saver, decided at the
 * tap and spread into the request whenever it goes out. Send these only
 * through here: the server takes them as word of what the person was told.
 */
export function creatorSeesSaverFields(
  accountId: string | null | undefined,
  shouldSave: boolean,
  accessToken?: string | null,
): SaverNoticeFields {
  if (accountId && accessToken) tokens.set(accountId, accessToken);
  if (accountId) {
    policy.restore(accountId, readStored(accountId));
    // Whoever saves is the account signed in now.
    policy.setActiveAccount(accountId);
  }
  return policy.fieldsForSave(accountId, shouldSave);
}

/** Tests only: forget what this page has told, shown and read. */
export function resetSaverNoticeForTests() {
  policy.reset();
  tokens.clear();
  toastIds.clear();
  requested.clear();
  pageRecordsApplied.clear();
}
