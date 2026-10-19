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

  it('tells a device once, at its first save, and lets every save after it name the saver', async () => {
    await expect(creatorSeesSaverFields(true)).resolves.toEqual({ creatorSeesSaver: true });
    await expect(creatorSeesSaverFields(true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.showMessageDialog.mock.calls).toEqual([[SAVER_NOTICE]]);
    expect(SAVER_NOTICE).toEqual({ title: 'Saved', message: 'Creators can see who saved their posts.' });

    // The next launch reads that it has been told.
    resetSaverNoticeForTests();
    await expect(creatorSeesSaverFields(true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);
  });

  it('shows one notice for two saves tapped before storage answers', async () => {
    const [first, second] = await Promise.all([creatorSeesSaverFields(true), creatorSeesSaverFields(true)]);

    expect([first, second]).toEqual([{ creatorSeesSaver: true }, { creatorSeesSaver: true }]);
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);
    expect(mocks.getItem).toHaveBeenCalledTimes(1);
  });

  it('adds nothing to taking a save back, and says nothing', async () => {
    await expect(creatorSeesSaverFields(false)).resolves.toEqual({});
    expect(mocks.showMessageDialog).not.toHaveBeenCalled();
    expect(mocks.getItem).not.toHaveBeenCalled();
  });

  it('still tells a device whose storage fails, once a run', async () => {
    mocks.getItem.mockRejectedValue(new Error('storage unavailable'));
    mocks.setItem.mockRejectedValue(new Error('storage unavailable'));

    await expect(creatorSeesSaverFields(true)).resolves.toEqual({ creatorSeesSaver: true });
    await expect(creatorSeesSaverFields(true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(1);
  });

  it('leaves a save unnamed when the notice cannot be shown, and tries again at the next', async () => {
    mocks.showMessageDialog.mockImplementationOnce(() => {
      throw new Error('no dialog host');
    });

    await expect(creatorSeesSaverFields(true)).resolves.toEqual({});
    expect(mocks.stored.size).toBe(0);

    await expect(creatorSeesSaverFields(true)).resolves.toEqual({ creatorSeesSaver: true });
    expect(mocks.showMessageDialog).toHaveBeenCalledTimes(2);
  });
});
