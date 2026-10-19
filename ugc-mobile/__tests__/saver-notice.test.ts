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
    showMessageDialog: vi.fn(),
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: mocks.getItem, setItem: mocks.setItem },
}));
vi.mock('@/lib/dialog', () => ({ showMessageDialog: mocks.showMessageDialog }));

import {
  SAVER_NOTICE,
  creatorSeesSaverFields,
  resetSaverNoticeForTests,
} from '@/lib/saver-notice';

/** The person reads the notice and taps OK (or Android's back key). */
function dismissNotice(call = mocks.showMessageDialog.mock.calls.length - 1) {
  const [request] = mocks.showMessageDialog.mock.calls[call] as [{ onDismiss?: () => void }];
  request.onDismiss?.();
}

describe('saver notice', () => {
  beforeEach(() => {
    mocks.stored.clear();
    mocks.getItem.mockReset().mockImplementation(async (key: string) => mocks.stored.get(key) ?? null);
    mocks.setItem.mockReset().mockImplementation(async (key: string, value: string) => {
      mocks.stored.set(key, value);
    });
    mocks.showMessageDialog.mockReset();
  });

  afterEach(() => {
    resetSaverNoticeForTests();
  });

  it('tells an account at its first save, which goes out unnamed, and names it once the notice is dismissed', async () => {
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({});
    expect(mocks.showMessageDialog.mock.calls).toEqual([[{ ...SAVER_NOTICE, onDismiss: expect.any(Function) }]]);
    expect(SAVER_NOTICE).toEqual({ title: 'Creators can see who saved their posts.' });

    // A save made while the notice is still up was not made after it.
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({});
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);

    dismissNotice();
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.stored.get('magicbooklet:saver-notice:v1:user-1')).toBe('1');

    // The next launch reads that it has been told.
    resetSaverNoticeForTests();
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);
  });

  it('tells each account on a shared phone for itself', async () => {
    await creatorSeesSaverFields('user-1', true);
    dismissNotice();
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({ creatorSeesSaver: true });

    // Someone else signs in on the same phone, without a relaunch.
    await expect(creatorSeesSaverFields('user-2', true)).resolves.toEqual({});
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(2);
  });

  it('never counts a notice that was not dismissed, as when Android draws a later dialog in its place', async () => {
    await creatorSeesSaverFields('user-1', true);
    // The notice was replaced before anyone read it: no dismissal ever comes.
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({});
    expect(mocks.stored.size).toBe(0);

    // The next launch tells them again.
    resetSaverNoticeForTests();
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({});
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(2);
  });

  it('shows one notice for two saves tapped before storage answers, and names neither', async () => {
    const [first, second] = await Promise.all([
      creatorSeesSaverFields('user-1', true),
      creatorSeesSaverFields('user-1', true),
    ]);

    expect([first, second]).toEqual([{}, {}]);
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);
  });

  it('adds nothing to taking a save back, or to a save with no account, and says nothing', async () => {
    await expect(creatorSeesSaverFields('user-1', false)).resolves.toEqual({});
    await expect(creatorSeesSaverFields(null, true)).resolves.toEqual({});
    expect(mocks.showMessageDialog).not.toHaveBeenCalled();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('still tells a device whose storage fails, once a run', async () => {
    mocks.getItem.mockRejectedValue(new Error('storage unavailable'));
    mocks.setItem.mockRejectedValue(new Error('storage unavailable'));

    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({});
    dismissNotice();
    await expect(creatorSeesSaverFields('user-1', true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);
  });
});

describe('who may send creatorSeesSaver', () => {
  // The server takes the field as word that the person was told, so nothing
  // but the notice module may set it, and the API client only passes it on.
  it('is set only by lib/saver-notice.ts and carried only by lib/api-client.ts', () => {
    const mobileRoot = path.resolve(__dirname, '..');
    const sourceFiles = (root: string): string[] => readdirSync(root).flatMap((entry) => {
      const absolutePath = path.join(root, entry);
      if (statSync(absolutePath).isDirectory()) return sourceFiles(absolutePath);
      return /\.(ts|tsx)$/.test(entry) ? [absolutePath] : [];
    });

    const mentioning = ['app', 'components', 'lib']
      .flatMap((root) => sourceFiles(path.join(mobileRoot, root)))
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('creatorSeesSaver:'))
      .map((filePath) => path.relative(mobileRoot, filePath).replaceAll(path.sep, '/'))
      .sort();

    expect(mentioning).toEqual(['lib/api-client.ts', 'lib/saver-notice.ts']);
  });
});
