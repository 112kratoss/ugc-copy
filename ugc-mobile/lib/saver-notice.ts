import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Saves were private until the creator's alert began naming whoever saved
 * ("@maya saved your post"). A save names its saver only when its request says
 * the person had been told before tapping, and only once that telling is on
 * record for the account (`/api/profile/saver-notice`), so the telling, the
 * record and those request fields come from this one place.
 *
 * The telling is a one-line bar at the top of the screen
 * (`components/saver-notice-bar.tsx`), drawn in the app's own window: no
 * dialog to stop the reel or take another dialog's place. Told counts once the
 * bar has gone: OK pressed, or left to run out with the app in front. Until
 * then the account's saves tell the creator nothing at all (`saverNotYetTold`):
 * "Someone saved your post" seconds before the first alert that names them
 * would give them away. It is remembered per account, on this phone and on
 * the server, so a person told on one device is not told again on another, and
 * a phone two people share tells each.
 */
export type SaverNoticeFields = { creatorSeesSaver?: true; saverNotYetTold?: true };

/** What the notice asks of the API client. */
export type SaverNoticeApi = {
  getSaverNotice: () => Promise<{ seen: boolean }>;
  recordSaverNotice: () => Promise<unknown>;
};

/** The notice the bar draws: one at a time, for the account it tells. */
export type SaverNoticeModel = { id: number; accountId: string };

/** How the bar went: OK pressed, out of time, or the app left before it was read. */
export type SaverNoticeEnding = 'closed' | 'expired' | 'interrupted';

const SAVER_NOTICE_STORAGE_KEY_PREFIX = 'magicbooklet:saver-notice:v1:';

export const SAVER_NOTICE_MESSAGE = 'Creators can see who saved their posts.';
export const SAVER_NOTICE_DURATION_MS = 6000;

const toldOnThisRun = new Set<string>();
/** Accounts the server has on record as told. */
const recorded = new Set<string>();
/** The API client of each account this run has seen, to record its telling. */
const apis = new Map<string, SaverNoticeApi>();
/** Accounts whose record was read on this run. */
const synced = new Set<string>();

let current: SaverNoticeModel | null = null;
let nextNoticeId = 1;
const listeners = new Set<() => void>();

function storageKey(accountId: string) {
  return `${SAVER_NOTICE_STORAGE_KEY_PREFIX}${accountId}`;
}

function commit(next: SaverNoticeModel | null) {
  current = next;
  listeners.forEach((listener) => listener());
}

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

async function recordOnServer(accountId: string) {
  const api = apis.get(accountId);
  if (!api || recorded.has(accountId)) return;
  try {
    await api.recordSaverNotice();
    recorded.add(accountId);
  } catch {
    // The next launch records it.
  }
}

function rememberTold(accountId: string) {
  toldOnThisRun.add(accountId);
  void AsyncStorage.setItem(storageKey(accountId), '1').catch(() => {
    // Told in this run; the server's record tells the next one.
  });
}

/**
 * Reads, for the signed-in account, whether it has been told (on this phone
 * and on the server) before its first tap needs the answer, and records a
 * telling the server missed. The root layout calls it as the account changes.
 */
export async function syncSaverNotice(accountId: string, api: SaverNoticeApi) {
  apis.set(accountId, api);
  if (synced.has(accountId)) return;
  synced.add(accountId);

  try {
    if (await AsyncStorage.getItem(storageKey(accountId))) toldOnThisRun.add(accountId);
  } catch {
    // Unreadable storage: the server's record decides.
  }

  try {
    const { seen } = await api.getSaverNotice();
    if (seen) {
      recorded.add(accountId);
      if (!toldOnThisRun.has(accountId)) rememberTold(accountId);
      return;
    }
    if (toldOnThisRun.has(accountId)) await recordOnServer(accountId);
  } catch {
    // Read again at the next sign-in or launch.
    synced.delete(accountId);
  }
}

/**
 * The fields a save request carries about telling its saver, decided at the
 * tap and spread into the request whenever it goes out. An account told
 * before this tap may be named (`creatorSeesSaver`). One not told yet is told
 * now, and its saves tell the creator nothing until the bar has gone
 * (`saverNotYetTold`). Send these only through here: the server takes them as
 * word of what the person was told.
 */
export function creatorSeesSaverFields(
  accountId: string | null | undefined,
  shouldSave: boolean,
): SaverNoticeFields {
  if (!shouldSave || !accountId) return {};
  if (toldOnThisRun.has(accountId)) return { creatorSeesSaver: true };

  // Nothing draws the bar (a screen mounted on its own in a test): tell them at a later tap.
  if (listeners.size > 0 && current?.accountId !== accountId) {
    commit({ id: nextNoticeId++, accountId });
  }
  return { saverNotYetTold: true };
}

/** The bar says how its notice went. Only a notice that was read tells. */
export function settleSaverNotice(id: number, ending: SaverNoticeEnding) {
  if (!current || current.id !== id) return;
  const { accountId } = current;
  commit(null);
  if (ending === 'interrupted') return;
  rememberTold(accountId);
  void recordOnServer(accountId);
}

/** Tests only: forget what this run has told, shown and read. */
export function resetSaverNoticeForTests() {
  toldOnThisRun.clear();
  recorded.clear();
  apis.clear();
  synced.clear();
  current = null;
  listeners.clear();
}
