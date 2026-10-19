import { hasFeedbackViewport, pushToast, type ToastDismissal } from './feedback-state';

/**
 * Saves were private until the creator's alert began naming whoever saved
 * ("@maya saved your post"). A save names its saver only when its request says
 * the person had been told before tapping, and only once that telling is on
 * record for the account (`/api/profile/saver-notice`), so the telling, the
 * record and those request fields come from this one place.
 *
 * Told counts once the notice has gone: closed, or left to run out on a page
 * in view. Until then the account's saves tell the creator nothing at all
 * (`saverNotYetTold`): "Someone saved your post" seconds before the first
 * alert that names them would give them away. It is remembered per account,
 * in this browser and on the server, so a person told on one device is not
 * told again on another, and a browser two people share tells each.
 */
export type SaverNoticeFields = { creatorSeesSaver?: true; saverNotYetTold?: true };

const SAVER_NOTICE_STORAGE_KEY_PREFIX = 'magicbooklet:saver-notice:v1:';
const SAVER_NOTICE_DURATION_MS = 6000;
const SAVER_NOTICE_ROUTE = '/api/profile/saver-notice';

export const SAVER_NOTICE_MESSAGE = 'Creators can see who saved their posts.';

const toldOnThisPage = new Set<string>();
/** Accounts whose notice is up: their saves wait to be named until it goes. */
const showing = new Set<string>();
/** Accounts the server has on record as told. */
const recorded = new Set<string>();
/** Accounts whose record was asked for on this page. */
const synced = new Set<string>();

function storageKey(accountId: string) {
  return `${SAVER_NOTICE_STORAGE_KEY_PREFIX}${accountId}`;
}

function rememberTold(accountId: string) {
  toldOnThisPage.add(accountId);
  try {
    window.localStorage.setItem(storageKey(accountId), '1');
  } catch {
    // Told on this page; the server's record tells the next one.
  }
}

function hasBeenTold(accountId: string) {
  if (toldOnThisPage.has(accountId)) return true;

  try {
    if (window.localStorage.getItem(storageKey(accountId))) {
      toldOnThisPage.add(accountId);
      return true;
    }
  } catch {
    // Storage refused (a private window): this page's memory is all there is.
  }
  return false;
}

async function recordOnServer(accountId: string, accessToken: string) {
  if (recorded.has(accountId)) return;
  try {
    const response = await fetch(SAVER_NOTICE_ROUTE, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) recorded.add(accountId);
  } catch {
    // The next page records it.
  }
}

/**
 * Reads the account's record once a page, before its first tap needs it: a
 * person told elsewhere is told here too, without the notice. A telling this
 * browser holds that the server missed is recorded now.
 */
export function syncSaverNotice(accountId: string, accessToken: string) {
  if (synced.has(accountId)) return;
  synced.add(accountId);

  void (async () => {
    try {
      const response = await fetch(SAVER_NOTICE_ROUTE, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) return;
      const data = await response.json() as { seen?: unknown };
      if (data.seen === true) {
        recorded.add(accountId);
        if (!hasBeenTold(accountId)) rememberTold(accountId);
        return;
      }
      if (hasBeenTold(accountId)) await recordOnServer(accountId, accessToken);
    } catch {
      // This browser's memory decides until the next page.
    }
  })();
}

function tell(accountId: string, accessToken: string) {
  if (showing.has(accountId)) return;
  // A toast pushed with nothing subscribed is never seen: tell them at a later tap.
  if (!hasFeedbackViewport()) return;

  showing.add(accountId);
  pushToast({
    tone: 'info',
    message: SAVER_NOTICE_MESSAGE,
    durationMs: SAVER_NOTICE_DURATION_MS,
    onDismiss: (how: ToastDismissal) => {
      showing.delete(accountId);
      // A notice that ran out on a page out of view was not read.
      if (how === 'expired' && document.visibilityState === 'hidden') return;
      rememberTold(accountId);
      void recordOnServer(accountId, accessToken);
    },
  });
}

/**
 * The fields a save request carries about telling its saver, decided at the
 * tap and spread into the request whenever it goes out. An account told
 * before this tap may be named (`creatorSeesSaver`). One not told yet is told
 * now, and its saves tell the creator nothing until the notice has gone
 * (`saverNotYetTold`). Send these only through here: the server takes them as
 * word of what the person was told.
 */
export function creatorSeesSaverFields(
  accountId: string | null | undefined,
  shouldSave: boolean,
  accessToken?: string | null,
): SaverNoticeFields {
  if (!shouldSave || !accountId) return {};
  if (hasBeenTold(accountId)) return { creatorSeesSaver: true };

  if (accessToken) tell(accountId, accessToken);
  return { saverNotYetTold: true };
}

/** Tests only: forget what this page has told, shown and read. */
export function resetSaverNoticeForTests() {
  toldOnThisPage.clear();
  showing.clear();
  recorded.clear();
  synced.clear();
}
