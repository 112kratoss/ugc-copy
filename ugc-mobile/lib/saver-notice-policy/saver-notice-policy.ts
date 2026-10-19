/**
 * Whether a person has been told that creators can see who saved their posts,
 * and what each save request says about it: the one policy the web and the
 * app follow (`src/components/saver-notice.ts`, `ugc-mobile/lib/saver-notice.ts`).
 * Each gives it a memory on the device, the record on the server and its own
 * notice. Free of React Native, Expo, DOM and Node imports, because the web
 * compiles it too.
 *
 * - A save names its saver only when the person was told before tapping
 *   (`creatorSeesSaver`). Until then a save tells the creator nothing at all
 *   (`saverNotYetTold`): "Someone saved your post" seconds before the first
 *   alert that names them would give them away.
 * - Told counts once the notice was read: its button pressed, or the notice
 *   left to run out while it could be seen. Nothing else counts: leaving the
 *   app, or another account signing in, takes the notice down unread.
 * - The device remembers a telling as pending until the server has it on
 *   record, and asks again at the next save, launch or return to the app. The
 *   record is only ever written for the account signed in when it is asked.
 * - The server's record decides when the two differ: a telling this device
 *   saw on record that the server no longer has was cleared there on purpose,
 *   and the person is told again.
 */

export const SAVER_NOTICE_MESSAGE = 'Creators can see who saved their posts.';
export const SAVER_NOTICE_DURATION_MS = 6000;
/**
 * A press on the notice's button this soon after it appears is ignored: it
 * was on its way to what sits there, not a reading of the notice.
 */
export const SAVER_NOTICE_TAP_GUARD_MS = 700;
/** Per account. v2: the value says whether the telling is on record yet. */
export const SAVER_NOTICE_STORAGE_KEY_PREFIX = 'magicbooklet:saver-notice:v2:';

export type SaverNoticeFields = { creatorSeesSaver?: true; saverNotYetTold?: true };
/** What this device remembers of an account: told and on record, or told and not yet on record. */
export type SaverNoticeMemory = 'pending' | 'recorded';
/** How a notice went: its button pressed, run out while it could be seen, or taken down unread. */
export type SaverNoticeEnding = 'closed' | 'expired' | 'interrupted';

export interface SaverNoticePlatform {
  /** Keeps what the device remembers of an account; null forgets it. */
  remember(accountId: string, memory: SaverNoticeMemory | null): void;
  /** Puts the account's telling on record. True once the server has it; never rejects. */
  record(accountId: string): Promise<boolean>;
  /** Draws the notice for the account. False when nothing can draw it now. */
  show(accountId: string): boolean;
  /** Takes the account's notice down unread. */
  hide(accountId: string): void;
}

export function saverNoticeStorageKey(accountId: string) {
  return `${SAVER_NOTICE_STORAGE_KEY_PREFIX}${accountId}`;
}

export function readStoredSaverNoticeMemory(value: unknown): SaverNoticeMemory | null {
  return value === 'pending' || value === 'recorded' ? value : null;
}

export function createSaverNoticePolicy(platform: SaverNoticePlatform) {
  const memory = new Map<string, SaverNoticeMemory>();
  /** Accounts whose memory on the device has been read back (`restore`). */
  const restored = new Set<string>();
  /**
   * Accounts the server said have no record before their memory on the device
   * was read, with nothing newer since: what that memory holds is checked
   * against it once it is read.
   */
  const unrecordedBeforeRestore = new Set<string>();
  const showing = new Set<string>();
  const recording = new Set<string>();
  let activeAccountId: string | null = null;

  function remember(accountId: string, value: SaverNoticeMemory | null) {
    if (value) memory.set(accountId, value);
    else memory.delete(accountId);
    platform.remember(accountId, value);
  }

  /** The server has no record: what that means turns on what this device remembers. */
  function applyNoRecord(accountId: string) {
    const known = memory.get(accountId);
    if (known === 'recorded') remember(accountId, null);
    else if (known === 'pending') void recordTelling(accountId);
  }

  async function recordTelling(accountId: string) {
    // Only for the account signed in: the request goes out as whoever that is.
    if (memory.get(accountId) !== 'pending' || recording.has(accountId) || accountId !== activeAccountId) return;
    recording.add(accountId);
    try {
      const recorded = await platform.record(accountId);
      if (recorded && memory.get(accountId) === 'pending') remember(accountId, 'recorded');
    } finally {
      recording.delete(accountId);
    }
  }

  return {
    /**
     * What the device kept for the account, read back before its first tap
     * needs it; null when there was nothing or it could not be read. Read
     * again while nothing is remembered (another tab may have told them); a
     * telling made since is newer than anything stored.
     */
    restore(accountId: string, stored: unknown) {
      restored.add(accountId);
      if (!memory.has(accountId)) {
        const value = readStoredSaverNoticeMemory(stored);
        if (value) memory.set(accountId, value);
      }
      if (unrecordedBeforeRestore.delete(accountId)) applyNoRecord(accountId);
    },

    /** The account signed in now, or null. Another account's notice comes down unread. */
    setActiveAccount(accountId: string | null) {
      activeAccountId = accountId;
      for (const shown of [...showing]) {
        if (shown === accountId) continue;
        showing.delete(shown);
        platform.hide(shown);
      }
      if (accountId) void recordTelling(accountId);
    },

    /**
     * The server's record for the account, read with what the app already
     * loads. "No record" can come before the device's memory has been read
     * (the app's profile is back from its cache before storage answers), so
     * it is held against that memory too, once it is read.
     */
    applyServerRecord(accountId: string, seen: boolean) {
      if (seen) {
        unrecordedBeforeRestore.delete(accountId);
        if (memory.get(accountId) !== 'recorded') remember(accountId, 'recorded');
        return;
      }
      if (!restored.has(accountId)) unrecordedBeforeRestore.add(accountId);
      applyNoRecord(accountId);
    },

    /** The fields a save request carries, decided at the tap. */
    fieldsForSave(accountId: string | null | undefined, shouldSave: boolean): SaverNoticeFields {
      if (!shouldSave || !accountId) return {};
      const known = memory.get(accountId);
      if (known) {
        if (known === 'pending') void recordTelling(accountId);
        return { creatorSeesSaver: true };
      }
      if (!showing.has(accountId) && platform.show(accountId)) showing.add(accountId);
      return { saverNotYetTold: true };
    },

    /** The account's notice went. Only one that was read tells. */
    settle(accountId: string, ending: SaverNoticeEnding) {
      if (!showing.delete(accountId) || ending === 'interrupted') return;
      // Newer than any "no record" the server gave before this.
      unrecordedBeforeRestore.delete(accountId);
      remember(accountId, 'pending');
      void recordTelling(accountId);
    },

    /** Asks again for a telling not yet on record (the app back in front). */
    retryRecord(accountId: string | null) {
      if (accountId) void recordTelling(accountId);
    },

    isShowing(accountId: string) {
      return showing.has(accountId);
    },

    /** Tests only. */
    reset() {
      memory.clear();
      restored.clear();
      unrecordedBeforeRestore.clear();
      showing.clear();
      recording.clear();
      activeAccountId = null;
    },
  };
}

export type SaverNoticePolicy = ReturnType<typeof createSaverNoticePolicy>;
