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
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: mocks.getItem, setItem: mocks.setItem },
}));

import {
  creatorSeesSaverFields,
  readSaverNotice,
  resetSaverNoticeForTests,
  settleSaverNotice,
  subscribeToSaverNotice,
  syncSaverNotice,
  type SaverNoticeApi,
} from '@/lib/saver-notice';

function api(seen = false) {
  return {
    getSaverNotice: vi.fn(async () => ({ seen })),
    recordSaverNotice: vi.fn(async () => ({ seen: true })),
  } satisfies SaverNoticeApi;
}

/** Lets the module's storage and server calls settle. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('saver notice', () => {
  let unsubscribe = () => {};

  beforeEach(() => {
    mocks.stored.clear();
    mocks.getItem.mockReset().mockImplementation(async (key: string) => mocks.stored.get(key) ?? null);
    mocks.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
      mocks.stored.set(key, value);
    });
    // The root layout's bar, which draws the notice.
    unsubscribe = subscribeToSaverNotice(() => {});
  });

  afterEach(() => {
    unsubscribe();
    resetSaverNoticeForTests();
  });

  it('tells an account at its first save, keeps the creator out of its saves until the bar goes, then names it', async () => {
    const client = api();
    await syncSaverNotice('user-1', client);

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    const notice = readSaverNotice();
    expect(notice).toMatchObject({ accountId: 'user-1' });

    // A save made while the notice is still up was not made after it.
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(readSaverNotice()).toBe(notice);

    settleSaverNotice(notice!.id, 'closed');
    expect(readSaverNotice()).toBeNull();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    await settle();
    expect(mocks.stored.get('magicbooklet:saver-notice:v1:user-1')).toBe('1');
    // On record, for the account's other devices and for the server's check.
    expect(client.recordSaverNotice).toHaveBeenCalledTimes(1);

    // The next launch reads that it has been told.
    resetSaverNoticeForTests();
    unsubscribe = subscribeToSaverNotice(() => {});
    await syncSaverNotice('user-1', api());
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(readSaverNotice()).toBeNull();
  });

  it('counts a notice left to run out, and not one the app was left with', () => {
    creatorSeesSaverFields('user-1', true);
    settleSaverNotice(readSaverNotice()!.id, 'interrupted');
    // Not read: the next save tells them again.
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });

    settleSaverNotice(readSaverNotice()!.id, 'expired');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
  });

  it('ignores the ending of a notice that is no longer the one up', () => {
    creatorSeesSaverFields('user-1', true);
    const first = readSaverNotice()!;
    settleSaverNotice(first.id, 'interrupted');
    creatorSeesSaverFields('user-1', true);

    settleSaverNotice(first.id, 'closed');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
  });

  it('tells each account on a shared phone for itself', () => {
    creatorSeesSaverFields('user-1', true);
    settleSaverNotice(readSaverNotice()!.id, 'closed');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });

    // Someone else signs in on the same phone, without a relaunch.
    expect(creatorSeesSaverFields('user-2', true)).toEqual({ saverNotYetTold: true });
    expect(readSaverNotice()).toMatchObject({ accountId: 'user-2' });
  });

  it('adds nothing to taking a save back, or to a save with no account, and says nothing', () => {
    expect(creatorSeesSaverFields('user-1', false)).toEqual({});
    expect(creatorSeesSaverFields(null, true)).toEqual({});
    expect(readSaverNotice()).toBeNull();
  });

  it('keeps the creator out of saves, and the account untold, while nothing draws the bar', () => {
    unsubscribe();

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    expect(readSaverNotice()).toBeNull();
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
  });

  it('takes a telling on record from another device, without the bar', async () => {
    await syncSaverNotice('user-1', api(true));

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
    expect(readSaverNotice()).toBeNull();
    await settle();
    expect(mocks.stored.get('magicbooklet:saver-notice:v1:user-1')).toBe('1');
  });

  it('records a telling this phone holds that the server missed, and reads the record once a run', async () => {
    mocks.stored.set('magicbooklet:saver-notice:v1:user-1', '1');
    const client = api(false);

    await syncSaverNotice('user-1', client);
    await syncSaverNotice('user-1', client);

    expect(client.getSaverNotice).toHaveBeenCalledTimes(1);
    expect(client.recordSaverNotice).toHaveBeenCalledTimes(1);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
  });

  it('reads the record again at the next sign-in when it could not be read', async () => {
    const client = api(true);
    client.getSaverNotice.mockRejectedValueOnce(new Error('offline'));

    await syncSaverNotice('user-1', client);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });

    await syncSaverNotice('user-1', client);
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
  });

  it('still tells a phone whose storage fails, once a run', async () => {
    mocks.getItem.mockRejectedValue(new Error('storage unavailable'));
    mocks.setItem.mockRejectedValue(new Error('storage unavailable'));

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    settleSaverNotice(readSaverNotice()!.id, 'closed');
    expect(creatorSeesSaverFields('user-1', true)).toEqual({ creatorSeesSaver: true });
  });
});

describe('who may send creatorSeesSaver and saverNotYetTold', () => {
  // The server takes the fields as word of what the person was told, so
  // nothing but the notice module may set them, and the API client only
  // passes them on. A shorthand property or a quoted key counts as much as a
  // written-out one; comments do not.
  it('is set only by lib/saver-notice.ts and carried only by lib/api-client.ts', () => {
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

    expect(mentioning).toEqual(['lib/api-client.ts', 'lib/saver-notice.ts']);
  });
});
