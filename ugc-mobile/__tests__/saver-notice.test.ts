import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stored = new Map<string, string>();
  return {
    stored,
    getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      stored.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      stored.delete(key);
    }),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: mocks.getItem, setItem: mocks.setItem, removeItem: mocks.removeItem },
}));

import {
  applySaverNoticeRecord,
  creatorSeesSaverFields,
  readSaverNotice,
  resetSaverNoticeForTests,
  retrySaverNoticeRecord,
  setSaverNoticeAccount,
  settleSaverNotice,
  subscribeToSaverNotice,
  type SaverNoticeRecorder,
} from '@/lib/saver-notice';

const KEY = 'magicbooklet:saver-notice:v2:user-1';

/** Puts every telling on record, unless a case says otherwise. */
function recorder(onRecord = true) {
  return vi.fn<SaverNoticeRecorder>(async () => onRecord);
}

/** Lets the module's storage and server calls settle. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The notice up now, read the way the bar reads it. */
function currentNotice() {
  const notice = readSaverNotice();
  expect(notice).not.toBeNull();
  return notice!;
}

describe('saver notice', () => {
  let unsubscribe = () => {};
  let notified = 0;

  beforeEach(() => {
    mocks.stored.clear();
    mocks.getItem.mockReset().mockImplementation(async (key: string) => mocks.stored.get(key) ?? null);
    mocks.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
      mocks.stored.set(key, value);
    });
    mocks.removeItem.mockReset().mockImplementation(async (key: string) => {
      mocks.stored.delete(key);
    });
    notified = 0;
    // The root layout's bar, which draws the notice.
    unsubscribe = subscribeToSaverNotice(() => {
      notified += 1;
    });
  });

  afterEach(() => {
    unsubscribe();
    resetSaverNoticeForTests();
  });

  it('tells an account at its first save, keeps the creator out of its saves until the bar goes, then names it', async () => {
    const record = recorder();
    await setSaverNoticeAccount('user-1', record);

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    const notice = currentNotice();
    expect(notice).toMatchObject({ accountId: 'user-1' });
    expect(notified).toBe(1);

    // A save made while the notice is still up was not made after it.
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(readSaverNotice()).toBe(notice);

    settleSaverNotice(notice.id, 'closed');
    expect(readSaverNotice()).toBeNull();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    await settle();
    // On record, for the account's other devices and for the server's check.
    expect(record.mock.calls).toEqual([['user-1']]);
    expect(mocks.stored.get(KEY)).toBe('recorded');

    // The next launch reads that it has been told, and asks the server nothing.
    resetSaverNoticeForTests();
    unsubscribe = subscribeToSaverNotice(() => {});
    const nextRun = recorder();
    await setSaverNoticeAccount('user-1', nextRun);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(readSaverNotice()).toBeNull();
    await settle();
    expect(nextRun).not.toHaveBeenCalled();
  });

  it('keeps a telling the server did not take as told on the phone, and puts it on record at the next launch', async () => {
    await setSaverNoticeAccount('user-1', recorder(false));
    creatorSeesSaverFields('user-1', true);
    settleSaverNotice(currentNotice().id, 'expired');
    await settle();
    expect(mocks.stored.get(KEY)).toBe('pending');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });

    resetSaverNoticeForTests();
    unsubscribe = subscribeToSaverNotice(() => {});
    const nextRun = recorder();
    await setSaverNoticeAccount('user-1', nextRun);
    await settle();

    expect(nextRun.mock.calls).toEqual([['user-1']]);
    expect(mocks.stored.get(KEY)).toBe('recorded');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(readSaverNotice()).toBeNull();
  });

  it('counts a recorder that throws as not on record, and keeps the telling', async () => {
    const record = vi.fn<SaverNoticeRecorder>(async () => {
      throw new Error('Network request failed');
    });
    await setSaverNoticeAccount('user-1', record);
    creatorSeesSaverFields('user-1', true);
    settleSaverNotice(currentNotice().id, 'closed');
    await settle();

    expect(record).toHaveBeenCalledTimes(1);
    expect(mocks.stored.get(KEY)).toBe('pending');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
  });

  it('asks again for a telling not on record when the app is back in front, and when the server says it lacks it', async () => {
    mocks.stored.set(KEY, 'pending');
    const record = recorder(false);
    await setSaverNoticeAccount('user-1', record);
    await settle();
    // Signing in asks.
    expect(record).toHaveBeenCalledTimes(1);

    retrySaverNoticeRecord('user-1');
    await settle();
    expect(record).toHaveBeenCalledTimes(2);

    applySaverNoticeRecord('user-1', false);
    await settle();
    expect(record).toHaveBeenCalledTimes(3);

    // Told all along: never shown again, never forgotten; the save asks too.
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(readSaverNotice()).toBeNull();
    await settle();
    expect(record).toHaveBeenCalledTimes(4);
    expect(mocks.stored.get(KEY)).toBe('pending');

    record.mockResolvedValue(true);
    retrySaverNoticeRecord('user-1');
    await settle();
    expect(record).toHaveBeenCalledTimes(5);
    expect(mocks.stored.get(KEY)).toBe('recorded');

    // On record: nothing more is asked.
    retrySaverNoticeRecord(null);
    retrySaverNoticeRecord('user-1');
    creatorSeesSaverFields('user-1', true);
    await settle();
    expect(record).toHaveBeenCalledTimes(5);
  });

  it('counts a notice left to run out, and not one the app was left with', () => {
    creatorSeesSaverFields('user-1', true);
    settleSaverNotice(currentNotice().id, 'interrupted');
    // Not read: the next save tells them again.
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });

    settleSaverNotice(currentNotice().id, 'expired');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
  });

  it('ignores the ending of a notice that is no longer the one up', () => {
    creatorSeesSaverFields('user-1', true);
    const first = currentNotice();
    settleSaverNotice(first.id, 'interrupted');
    creatorSeesSaverFields('user-1', true);
    expect(currentNotice().id).not.toBe(first.id);

    settleSaverNotice(first.id, 'closed');
    expect(readSaverNotice()).not.toBeNull();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
  });

  it('tells each account on a shared phone for itself, under its own key', async () => {
    await setSaverNoticeAccount('user-1', recorder());
    creatorSeesSaverFields('user-1', true);
    settleSaverNotice(currentNotice().id, 'closed');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });

    // Someone else signs in on the same phone, without a relaunch.
    await setSaverNoticeAccount('user-2', recorder());
    expect(creatorSeesSaverFields('user-2', true)).toEqual({ saverNotYetTold: true });
    expect(readSaverNotice()).toMatchObject({ accountId: 'user-2' });
    await settle();
    expect(mocks.getItem.mock.calls).toEqual([[KEY], ['magicbooklet:saver-notice:v2:user-2']]);
    expect(mocks.stored.get('magicbooklet:saver-notice:v2:user-2')).toBeUndefined();
  });

  // Review finding #10.
  it("takes one account's notice down unread when another signs in, and records nothing for it", async () => {
    const record = recorder();
    await setSaverNoticeAccount('user-1', record);
    creatorSeesSaverFields('user-1', true);
    const notice = currentNotice();
    const before = notified;

    await setSaverNoticeAccount('user-2', record);

    expect(readSaverNotice()).toBeNull();
    expect(notified).toBe(before + 1);
    // The bar's countdown or OK arriving after the switch is for a notice gone.
    settleSaverNotice(notice.id, 'closed');
    await settle();
    expect(record).not.toHaveBeenCalled();
    expect(mocks.stored.has(KEY)).toBe(false);

    // Back on this phone: told at its next save.
    await setSaverNoticeAccount('user-1', record);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(currentNotice()).toMatchObject({ accountId: 'user-1' });
  });

  it('takes the notice down unread when the account signs out', async () => {
    await setSaverNoticeAccount('user-1', recorder());
    creatorSeesSaverFields('user-1', true);

    await setSaverNoticeAccount(null);

    expect(readSaverNotice()).toBeNull();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
  });

  it('reads the phone once a run per account, and nothing for no account', async () => {
    await setSaverNoticeAccount(null);
    expect(mocks.getItem).not.toHaveBeenCalled();

    await setSaverNoticeAccount('user-1', recorder());
    await setSaverNoticeAccount('user-1', recorder());
    await setSaverNoticeAccount(null);
    await setSaverNoticeAccount('user-1', recorder());

    expect(mocks.getItem.mock.calls).toEqual([[KEY]]);
  });

  it('reads nothing an older version stored as told', async () => {
    mocks.stored.set('magicbooklet:saver-notice:v1:user-1', '1');
    mocks.stored.set(KEY, '1');

    await setSaverNoticeAccount('user-1', recorder());

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
  });

  it('adds nothing to taking a save back, or to a save with no account, and says nothing', () => {
    expect(creatorSeesSaverFields('user-1', false)).toEqual({});
    expect(creatorSeesSaverFields(null, true)).toEqual({});
    expect(creatorSeesSaverFields(undefined, true)).toEqual({});
    expect(readSaverNotice()).toBeNull();
  });

  it('keeps the creator out of saves, and the account untold, while nothing draws the bar', () => {
    unsubscribe();

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(readSaverNotice()).toBeNull();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });

    // The bar mounts: the next save is the one that tells.
    unsubscribe = subscribeToSaverNotice(() => {});
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(currentNotice()).toMatchObject({ accountId: 'user-1' });
  });

  it('takes a telling on record from another device, without the bar', async () => {
    await setSaverNoticeAccount('user-1', recorder());

    applySaverNoticeRecord('user-1', true);

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(readSaverNotice()).toBeNull();
    await settle();
    expect(mocks.stored.get(KEY)).toBe('recorded');
  });

  // Review finding #14.
  it('forgets a telling the server no longer has on record, on the phone too, and tells them again', async () => {
    mocks.stored.set(KEY, 'recorded');
    const record = recorder();
    await setSaverNoticeAccount('user-1', record);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });

    applySaverNoticeRecord('user-1', false);
    await settle();

    expect(mocks.removeItem.mock.calls).toEqual([[KEY]]);
    expect(mocks.stored.has(KEY)).toBe(false);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(currentNotice()).toMatchObject({ accountId: 'user-1' });

    settleSaverNotice(currentNotice().id, 'closed');
    await settle();
    expect(record.mock.calls).toEqual([['user-1']]);
    expect(mocks.stored.get(KEY)).toBe('recorded');
  });

  it('still tells a phone whose storage fails, once a run', async () => {
    mocks.getItem.mockRejectedValue(new Error('storage unavailable'));
    mocks.setItem.mockRejectedValue(new Error('storage unavailable'));
    mocks.removeItem.mockRejectedValue(new Error('storage unavailable'));

    await setSaverNoticeAccount('user-1', recorder());
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    settleSaverNotice(currentNotice().id, 'closed');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    await settle();
  });
});

describe('who may send creatorSeesSaver and saverNotYetTold', () => {
  // The server takes the fields as word of what the person was told, so
  // nothing but the shared policy (behind lib/saver-notice.ts) may set them,
  // and the API client only passes them on. A shorthand property or a quoted
  // key counts as much as a written-out one; comments do not.
  it('is set only by lib/saver-notice-policy and carried only by lib/api-client.ts', () => {
    const mobileRoot = path.resolve(__dirname, '..');
    const sourceFiles = (root: string): string[] => readdirSync(root).flatMap((entry) => {
      const absolutePath = path.join(root, entry);
      if (statSync(absolutePath).isDirectory()) return sourceFiles(absolutePath);
      return /\.(ts|tsx)$/.test(entry) ? [absolutePath] : [];
    });
    const withoutComments = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const mentioning = ['app', 'components', 'lib']
      .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
      .filter((filePath) => /\b(creatorSeesSaver|saverNotYetTold)\b/.test(withoutComments(readFileSync(filePath, 'utf8'))))
      .map((filePath) => path.relative(mobileRoot, filePath).replaceAll(path.sep, '/'))
      .sort();

    expect(mentioning).toEqual(['lib/api-client.ts', 'lib/saver-notice-policy/saver-notice-policy.ts']);
  });
});
