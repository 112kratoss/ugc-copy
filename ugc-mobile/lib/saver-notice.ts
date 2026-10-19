import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  SAVER_NOTICE_DURATION_MS,
  SAVER_NOTICE_MESSAGE,
  SAVER_NOTICE_TAP_GUARD_MS,
  createSaverNoticePolicy,
  saverNoticeStorageKey,
  type SaverNoticeEnding,
  type SaverNoticeFields,
} from '@/lib/saver-notice-policy/saver-notice-policy';

/**
 * The app's half of the saver notice: the policy is shared with the web
 * (`lib/saver-notice-policy/saver-notice-policy.ts`); this gives it the phone's
 * storage, the account's record on the server and the one-line bar at the top
 * of the screen (`components/saver-notice-bar.tsx`), which draws `current`.
 */
export { SAVER_NOTICE_DURATION_MS, SAVER_NOTICE_MESSAGE, SAVER_NOTICE_TAP_GUARD_MS };
export type { SaverNoticeEnding, SaverNoticeFields };

/** The notice the bar draws: one at a time, for the account it tells. */
export type SaverNoticeModel = { id: number; accountId: string };

/** Puts the account's telling on record; false when it could not (another account signed in, no network). */
export type SaverNoticeRecorder = (accountId: string) => Promise<boolean>;

let current: SaverNoticeModel | null = null;
let nextNoticeId = 1;
const listeners = new Set<() => void>();
let recorder: SaverNoticeRecorder | null = null;
/** Each account's read, while it is under way: a second sign-in waits on the first read. */
const reads = new Map<string, Promise<void>>();
/** Counts the calls to `setSaverNoticeAccount`: only the latest says who is signed in. */
let accountCalls = 0;

function commit(next: SaverNoticeModel | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

const policy = createSaverNoticePolicy({
  remember(accountId, memory) {
    const key = saverNoticeStorageKey(accountId);
    void (memory ? AsyncStorage.setItem(key, memory) : AsyncStorage.removeItem(key)).catch(() => {
      // Remembered in this run; the server's record tells the next one.
    });
  },
  async record(accountId) {
    try {
      return recorder ? await recorder(accountId) : false;
    } catch {
      return false;
    }
  },
  show(accountId) {
    // Nothing draws the bar (a screen mounted on its own in a test): tell them at a later tap.
    if (listeners.size === 0) return false;
    commit({ id: nextNoticeId++, accountId });
    return true;
  },
  hide(accountId) {
    if (current?.accountId === accountId) commit(null);
  },
});

/** For the bar: `useSyncExternalStore(subscribeToSaverNotice, readSaverNotice)`. */
export function subscribeToSaverNotice(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readSaverNotice() {
  return current;
}

/**
 * The account signed in now, or null, with how to record its telling. Its
 * memory on this phone is read before its first tap needs it; another
 * account's notice comes down unread.
 */
export async function setSaverNoticeAccount(accountId: string | null, record?: SaverNoticeRecorder) {
  if (record) recorder = record;
  const call = ++accountCalls;
  if (accountId && !policy.hasRestored(accountId)) {
    await readMemory(accountId);
    // Another account signed in, or this one out, while that read was under way.
    if (call !== accountCalls) return;
  }
  policy.setActiveAccount(accountId);
}

function readMemory(accountId: string) {
  let read = reads.get(accountId);
  if (!read) {
    read = Promise.resolve()
      .then(() => AsyncStorage.getItem(saverNoticeStorageKey(accountId)))
      // Unreadable storage: the server's record decides.
      .catch(() => null)
      .then((stored) => {
        policy.restore(accountId, stored);
        reads.delete(accountId);
      });
    reads.set(accountId, read);
  }
  return read;
}

/**
 * The server's record for the account, as its profile came back. False when a
 * "no record" was set aside: read before this phone's record of the telling
 * landed, so the profile it came in is out of date.
 */
export function applySaverNoticeRecord(accountId: string, seen: boolean) {
  return policy.applyServerRecord(accountId, seen);
}

/** Asks again for a telling not yet on record: the app is back in front. */
export function retrySaverNoticeRecord(accountId: string | null) {
  policy.retryRecord(accountId);
}

/**
 * The fields a save request carries about telling its saver, decided at the
 * tap and spread into the request whenever it goes out. Send these only
 * through here: the server takes them as word of what the person was told.
 */
export function creatorSeesSaverFields(accountId: string | null | undefined, shouldSave: boolean): SaverNoticeFields {
  return policy.fieldsForSave(accountId, shouldSave);
}

/** The bar says how its notice went. Only a notice that was read tells. */
export function settleSaverNotice(id: number, ending: SaverNoticeEnding) {
  if (!current || current.id !== id) return;
  const { accountId } = current;
  commit(null);
  policy.settle(accountId, ending);
}

/** Tests only: forget what this run has told, shown and read. */
export function resetSaverNoticeForTests() {
  policy.reset();
  reads.clear();
  accountCalls = 0;
  recorder = null;
  current = null;
  listeners.clear();
}
