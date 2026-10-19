import AsyncStorage from '@react-native-async-storage/async-storage';

import { showMessageDialog } from '@/lib/dialog';

/**
 * Saves were private until the creator's alert began naming whoever saved
 * ("@maya saved your post"). The server names a saver only for a save whose
 * request says the person had been told, so that field and the telling come
 * from this one place.
 *
 * Told is remembered per account, so a phone two people share tells each of
 * them, and it counts only once the notice is dismissed: Android draws one
 * dialog at a time, and a dialog raised after the notice (a failed save's
 * error) takes its place unseen. The save that tells someone goes out
 * unnamed; only saves made after the notice name them.
 */
const SAVER_NOTICE_STORAGE_KEY_PREFIX = 'magicbooklet:saver-notice:v1:';

export const SAVER_NOTICE = {
  title: 'Creators can see who saved their posts.',
} as const;

const toldOnThisRun = new Set<string>();
/** Accounts whose notice is up and not yet dismissed: one notice at a time. */
const showing = new Set<string>();

function storageKey(accountId: string) {
  return `${SAVER_NOTICE_STORAGE_KEY_PREFIX}${accountId}`;
}

async function hasBeenTold(accountId: string) {
  if (toldOnThisRun.has(accountId)) return true;

  try {
    if (await AsyncStorage.getItem(storageKey(accountId))) {
      toldOnThisRun.add(accountId);
      return true;
    }
  } catch {
    // Unreadable storage: this run's memory is all there is.
  }
  return false;
}

function markTold(accountId: string) {
  showing.delete(accountId);
  toldOnThisRun.add(accountId);
  void AsyncStorage.setItem(storageKey(accountId), '1').catch(() => {
    // Told in this run; a refused write only means telling them again in the next.
  });
}

/**
 * The field that lets the creator's alert name whoever saved, spread into each
 * save request. An account not told yet is told now, and that save (and any
 * made while the notice is up) goes out unnamed. Send `creatorSeesSaver` only
 * through here: the server takes it as word that the person was told.
 */
export async function creatorSeesSaverFields(
  accountId: string | null | undefined,
  shouldSave: boolean,
): Promise<{ creatorSeesSaver?: true }> {
  if (!shouldSave || !accountId) return {};
  if (await hasBeenTold(accountId)) return { creatorSeesSaver: true };

  if (!showing.has(accountId)) {
    showing.add(accountId);
    showMessageDialog({ ...SAVER_NOTICE, onDismiss: () => markTold(accountId) });
  }
  return {};
}

/** Tests only: forget what this run has told and shown. */
export function resetSaverNoticeForTests() {
  toldOnThisRun.clear();
  showing.clear();
}
