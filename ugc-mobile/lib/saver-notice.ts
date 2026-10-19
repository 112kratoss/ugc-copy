import AsyncStorage from '@react-native-async-storage/async-storage';

import { showMessageDialog } from '@/lib/dialog';

/**
 * Saves were private until the creator's alert began naming whoever saved
 * ("@maya saved your post"). The server names a saver only for a save whose
 * request says the person was told, so that field and the telling come from
 * this one place.
 */
const SAVER_NOTICE_STORAGE_KEY = 'magicbooklet:saver-notice:v1';

export const SAVER_NOTICE = {
  title: 'Saved',
  message: 'Creators can see who saved their posts.',
} as const;

let toldOnThisRun = false;
let telling: Promise<boolean> | null = null;

async function hasBeenToldBefore() {
  try {
    return Boolean(await AsyncStorage.getItem(SAVER_NOTICE_STORAGE_KEY));
  } catch {
    // Unreadable storage: tell them once in this run rather than never.
    return false;
  }
}

/** Whether this device has been told, telling it now if not. False only when the notice could not be shown. */
function tellOnce(): Promise<boolean> {
  if (toldOnThisRun) return Promise.resolve(true);

  // Two saves in quick succession share one read and one notice.
  telling ??= (async () => {
    if (!(await hasBeenToldBefore())) {
      try {
        showMessageDialog(SAVER_NOTICE);
      } catch {
        return false;
      }
      try {
        await AsyncStorage.setItem(SAVER_NOTICE_STORAGE_KEY, '1');
      } catch {
        // Told in this run; a refused write only means telling them again in the next.
      }
    }
    toldOnThisRun = true;
    return true;
  })().finally(() => {
    telling = null;
  });

  return telling;
}

/**
 * The field that lets the creator's alert name whoever saved, spread into each
 * save request. The first save on a device also shows the notice that says
 * so; a save whose notice could not be shown goes out unnamed. Send
 * `creatorSeesSaver` only through here: the server takes it as word that the
 * person was told.
 */
export async function creatorSeesSaverFields(shouldSave: boolean): Promise<{ creatorSeesSaver?: true }> {
  return shouldSave && (await tellOnce()) ? { creatorSeesSaver: true } : {};
}

/** Tests only: forget that this run has shown the notice. */
export function resetSaverNoticeForTests() {
  toldOnThisRun = false;
  telling = null;
}
