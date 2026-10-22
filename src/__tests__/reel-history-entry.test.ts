import { describe, expect, it } from 'vitest';

import {
  createReelEntryState,
  keepReelEntryState,
  readReelEntryParam,
  readReelHistoryMode,
} from '@/lib/reel-history-entry';

// What Next leaves on an entry it wrote: its own two fields, and nothing of the app's.
const nextOwnState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };

describe('reel history entries', () => {
  // The state lives in readers' history entries across deploys: a renamed key reads
  // every entry pushed before it as a shared link's.
  it('writes the parameter the entry was pushed for under one key', () => {
    expect(createReelEntryState('post')).toEqual({ reelPushedFor: 'post' });
    expect(createReelEntryState('generation')).toEqual({ reelPushedFor: 'generation' });
  });

  // Next's patched pushState writes its fields into the object it is given, and takes
  // an object that already carries `__NA` for one of its own writes, which it does not
  // apply to useSearchParams.
  it('gives a new object each time, and never one carrying Next\'s fields', () => {
    const first = createReelEntryState('post');
    Object.assign(first, nextOwnState);
    const second = createReelEntryState('post');
    expect(second).not.toBe(first);
    expect(second).not.toHaveProperty('__NA');

    const kept = keepReelEntryState({ ...nextOwnState, reelPushedFor: 'post' }, new URLSearchParams('post=post-2'));
    expect(kept).toEqual({ reelPushedFor: 'post' });
    expect(kept).not.toHaveProperty('__NA');
  });

  // Next copies its fields into the app's object, and its router's write after that
  // spreads the entry's state (`preserveCustomHistoryState`).
  it('reads the parameter from an entry Next has written its own fields onto', () => {
    const pushed = Object.assign(createReelEntryState('post'), nextOwnState);
    expect(readReelEntryParam(pushed)).toBe('post');
    expect(readReelEntryParam({ ...pushed, __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: [] } })).toBe('post');
  });

  it('reads nothing from an entry the page did not push', () => {
    expect(readReelEntryParam(null)).toBeNull();
    expect(readReelEntryParam(undefined)).toBeNull();
    expect(readReelEntryParam('post')).toBeNull();
    expect(readReelEntryParam(nextOwnState)).toBeNull();
    expect(readReelEntryParam({ reelPushedFor: 'creator' })).toBeNull();
  });

  describe('the history mode of an entry', () => {
    it('is pushed on the entry the page pushed for what its address names', () => {
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), createReelEntryState('post'))).toBe('pushed');
      expect(readReelHistoryMode('generation', new URLSearchParams('tab=creations&generation=gen-1'), createReelEntryState('generation'))).toBe('pushed');
    });

    // A shared link's entry, the shell's tap over one, and every entry from before the
    // reels marked theirs: the reel was opened by address, and its close replaces.
    it('is direct where the address names one on any other entry', () => {
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), null)).toBe('direct');
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), nextOwnState)).toBe('direct');
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), createReelEntryState('generation'))).toBe('direct');
    });

    it('is none where the address names none, whatever the entry says', () => {
      expect(readReelHistoryMode('post', new URLSearchParams('tab=posts'), createReelEntryState('post'))).toBeNull();
      expect(readReelHistoryMode('generation', new URLSearchParams(''), null)).toBeNull();
    });
  });

  describe('replacing the entry the page is on', () => {
    // Another post of the same reel, or another slide.
    it('keeps the page\'s own entry its own while the address still names what it was pushed for', () => {
      expect(keepReelEntryState(createReelEntryState('post'), new URLSearchParams('post=post-2&media=1'))).toEqual(createReelEntryState('post'));
    });

    it('leaves a plain entry once the address names nothing it was pushed for', () => {
      expect(keepReelEntryState(createReelEntryState('post'), new URLSearchParams('tab=posts'))).toBeNull();
      expect(keepReelEntryState(createReelEntryState('generation'), new URLSearchParams('tab=creations&post=post-1'))).toBeNull();
    });

    it('never makes an entry the page did not push its own', () => {
      expect(keepReelEntryState(null, new URLSearchParams('post=post-2'))).toBeNull();
      expect(keepReelEntryState(nextOwnState, new URLSearchParams('post=post-2'))).toBeNull();
    });
  });
});
