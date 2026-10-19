import { pushToast } from './feedback-state';

/**
 * Saves were private until the creator's alert began naming whoever saved
 * ("@maya saved your post"). The server names a saver only for a save whose
 * request says the person was told, so that field and the telling come from
 * this one place.
 */
const SAVER_NOTICE_STORAGE_KEY = 'magicbooklet:saver-notice:v1';
const SAVER_NOTICE_DURATION_MS = 6000;

export const SAVER_NOTICE_MESSAGE = 'Saved. Creators can see who saved their posts.';

let toldOnThisPage = false;

function hasBeenToldBefore() {
  try {
    return Boolean(window.localStorage.getItem(SAVER_NOTICE_STORAGE_KEY));
  } catch {
    // Storage refused (a private window): tell them once on this page rather than never.
    return false;
  }
}

/** Whether this browser has been told, telling it now if not. False only when the notice could not be shown. */
function tellOnce() {
  if (toldOnThisPage) return true;

  if (!hasBeenToldBefore()) {
    try {
      pushToast({ tone: 'info', message: SAVER_NOTICE_MESSAGE, durationMs: SAVER_NOTICE_DURATION_MS });
    } catch {
      return false;
    }
    try {
      window.localStorage.setItem(SAVER_NOTICE_STORAGE_KEY, '1');
    } catch {
      // Told on this page; a refused write only means telling them again on the next.
    }
  }

  toldOnThisPage = true;
  return true;
}

/**
 * The field that lets the creator's alert name whoever saved, spread into each
 * save request. The first save in a browser also shows the notice that says
 * so; a save whose notice could not be shown goes out unnamed. Send
 * `creatorSeesSaver` only through here: the server takes it as word that the
 * person was told.
 */
export function creatorSeesSaverFields(shouldSave: boolean): { creatorSeesSaver?: true } {
  return shouldSave && tellOnce() ? { creatorSeesSaver: true } : {};
}

/** Tests only: forget that this page has shown the notice. */
export function resetSaverNoticeForTests() {
  toldOnThisPage = false;
}
