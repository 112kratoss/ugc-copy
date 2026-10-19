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
 * The toast counts its six seconds only while it can be seen
 * (`inViewOnly`): paused while the window is out of focus or another dialog is
 * over it, and taken down unread when the page is hidden. One shown while the
 * reel is open is drawn inside the reel's dialog (`setToastHost`), where a
 * screen reader can reach it and it sits below the reel's header.
 */
export { SAVER_NOTICE_MESSAGE };
export type { SaverNoticeFields };

/**
 * The account's record of being told, as one read gave it: the page as it was
 * drawn, or a profile read since (`AuthProvider`). Each read is a new object,
 * and each is taken in once.
 */
export interface SaverNoticeRecord {
  userId: string;
  seen: boolean;
}

const SAVER_NOTICE_ROUTE = '/api/profile/saver-notice';

/** The last token seen for each account, so a telling is recorded as that account. */
const tokens = new Map<string, string>();
const toastIds = new Map<string, number>();
/**
 * Records taken in. The page hands out the same record at every sync (a token
 * refresh, another save surface mounting): taken in again, a "not told" from
 * the page load would wipe a telling another tab has made since.
 */
let appliedRecords = new WeakSet<SaverNoticeRecord>();

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
      inViewOnly: true,
      onDismiss: (how) => {
        toastIds.delete(accountId);
        policy.settle(accountId, how);
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
 * The account signed in on this page, or null, with the latest record of its
 * telling the page has read (`AuthProvider`'s `saverNoticeRecord`).
 */
export function syncSaverNotice(
  accountId: string | null,
  accessToken?: string | null,
  record?: SaverNoticeRecord | null,
) {
  if (accountId && accessToken) tokens.set(accountId, accessToken);
  if (accountId) policy.restore(accountId, readStored(accountId));
  policy.setActiveAccount(accountId);
  if (!accountId || !record || record.userId !== accountId || appliedRecords.has(record)) return;
  appliedRecords.add(record);
  policy.applyServerRecord(accountId, record.seen);
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
  appliedRecords = new WeakSet();
}
