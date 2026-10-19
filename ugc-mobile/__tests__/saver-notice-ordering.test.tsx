// Two ordering gaps in the saver notice, found by the 2026-10-20 test pass: a
// "no record" answer that reached the notice before the phone's memory was read
// was dropped, and an account read that landed late made that account active
// again. Both failed before the fix in saver-notice-policy.ts and saver-notice.ts.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  stored: new Map<string, string>(),
  held: new Map<string, Promise<string | null>>(),
  user: { id: 'user-1' } as { id: string } | null,
  api: { recordSaverNotice: vi.fn(async () => ({ seen: true })), getProfile: vi.fn() },
  refreshProfile: vi.fn(async () => {}),
}));

vi.mock('react-native', () => ({
  AccessibilityInfo: { isScreenReaderEnabled: () => Promise.resolve(false), addEventListener: () => ({ remove() {} }) },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  Platform: { OS: 'android' },
  Pressable: () => null,
  View: () => null,
  findNodeHandle: () => null,
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('@/components/ui', () => ({ AppText: () => null }));
vi.mock('@/lib/motion', () => ({ MotionView: () => null, useOverlayPresence: (visible: boolean) => ({ mounted: visible }) }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ api: state.api, user: state.user, refreshProfile: state.refreshProfile }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => state.held.get(key) ?? state.stored.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => { state.stored.set(key, value); }),
    removeItem: vi.fn(async (key: string) => { state.stored.delete(key); }),
  },
}));

import { SaverNoticeSync } from '@/components/saver-notice-bar';
import {
  creatorSeesSaverFields,
  readSaverNotice,
  resetSaverNoticeForTests,
  setSaverNoticeAccount,
  settleSaverNotice,
  subscribeToSaverNotice,
} from '@/lib/saver-notice';
import { saverNoticeStorageKey } from '@/lib/saver-notice-policy/saver-notice-policy';

async function flush() {
  await renderer.act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  resetSaverNoticeForTests();
  state.stored.clear();
  state.held.clear();
  state.user = { id: 'user-1' };
});

describe('saver notice ordering', () => {
  // components/saver-notice-bar.tsx:56-59 applies the profile's record once per
  // value; at launch the persisted profile is already cached (lib/auth.tsx:569),
  // so applySaverNoticeRecord(false) runs before lib/saver-notice.ts:87 has
  // read the phone's memory, does nothing (saver-notice-policy.ts:108-110), and
  // the restore then sets 'recorded' for good.
  it('tells the person again when the profile cached at sign-in already says the record was cleared', async () => {
    const unsubscribe = subscribeToSaverNotice(() => {});
    state.stored.set(saverNoticeStorageKey('user-1'), 'recorded');
    const client = new QueryClient();
    client.setQueryData(['profile', 'user-1'], { id: 'user-1', saverNoticeSeen: false });

    await renderer.act(async () => {
      renderer.create(<QueryClientProvider client={client}><SaverNoticeSync /></QueryClientProvider>);
    });
    await flush();
    // The fresh read says the same.
    await renderer.act(async () => {
      client.setQueryData(['profile', 'user-1'], { id: 'user-1', saverNoticeSeen: false, credits: 1 });
    });
    await flush();

    expect(creatorSeesSaverFields('user-1', true)).toEqual({ saverNotYetTold: true });
    unsubscribe();
    client.clear();
  });

  // lib/saver-notice.ts:82-93 sets the account active after awaiting its
  // storage read, without checking a later call has since set another.
  it('keeps the latest account active when an earlier account read lands late', async () => {
    const unsubscribe = subscribeToSaverNotice(() => {});
    const record = vi.fn(async () => true);
    await setSaverNoticeAccount('user-2', record);
    let release!: () => void;
    state.held.set(saverNoticeStorageKey('user-1'), new Promise((resolve) => {
      release = () => resolve(null);
    }));

    const late = setSaverNoticeAccount('user-1', record);
    await setSaverNoticeAccount('user-2', record);
    creatorSeesSaverFields('user-2', true);
    release();
    await late;
    await flush();

    // user-2's notice is still up, and its telling goes on record as user-2.
    expect(readSaverNotice()).toMatchObject({ accountId: 'user-2' });
    settleSaverNotice(readSaverNotice()!.id, 'closed');
    await flush();
    expect(record.mock.calls).toEqual([['user-2']]);
    unsubscribe();
  });
});
