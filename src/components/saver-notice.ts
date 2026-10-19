import { hasFeedbackViewport, pushToast } from './feedback-state';

/**
 * Saves were private until the creator's alert began naming whoever saved
 * ("@maya saved your post"). The server names a saver only for a save whose
 * request says the person had been told, so that field and the telling come
 * from this one place.
 *
 * Told is remembered per account, so a browser two people share tells each of
 * them. The save that tells someone goes out unnamed: only saves made after
 * the notice name them.
 */
const SAVER_NOTICE_STORAGE_KEY_PREFIX = 'magicbooklet:saver-notice:v1:';
const SAVER_NOTICE_DURATION_MS = 6000;

export const SAVER_NOTICE_MESSAGE = 'Creators can see who saved their posts.';

const toldOnThisPage = new Set<string>();

function storageKey(accountId: string) {
  return `${SAVER_NOTICE_STORAGE_KEY_PREFIX}${accountId}`;
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

/** Shows the notice and remembers it for this account, unless nothing on the page would draw it. */
function tell(accountId: string) {
  // A toast pushed with nothing subscribed is never seen: tell them at a later save.
  if (!hasFeedbackViewport()) return;

  pushToast({ tone: 'info', message: SAVER_NOTICE_MESSAGE, durationMs: SAVER_NOTICE_DURATION_MS });
  toldOnThisPage.add(accountId);
  try {
    window.localStorage.setItem(storageKey(accountId), '1');
  } catch {
    // Told on this page; a refused write only means telling them again on the next.
  }
}

/**
 * The field that lets the creator's alert name whoever saved, spread into each
 * save request. An account not told yet is told now, and that save goes out
 * unnamed. Send `creatorSeesSaver` only through here: the server takes it as
 * word that the person was told.
 */
export function creatorSeesSaverFields(
  accountId: string | null | undefined,
  shouldSave: boolean,
): { creatorSeesSaver?: true } {
  if (!shouldSave || !accountId) return {};
  if (hasBeenTold(accountId)) return { creatorSeesSaver: true };

  tell(accountId);
  return {};
}

/** Tests only: forget what this page has told. */
export function resetSaverNoticeForTests() {
  toldOnThisPage.clear();
}
