import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createReelEntryState,
  pushReelEntry,
  readCurrentReelHistoryMode,
  readReelHistoryMode,
  replaceReelEntry,
} from '@/lib/reel-history-entry';

// What Next leaves on an entry it wrote: its own two fields, and nothing of the app's.
const nextOwnState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { tree: ['', {}], renderedSearch: '' } };

describe('reel history entries', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/showcase');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The state lives in readers' history entries across deploys: a renamed key reads
  // every entry pushed before it as a shared link's.
  it('writes the parameter the entry was pushed for under one key', () => {
    expect(createReelEntryState('post')).toEqual({ reelPushedFor: 'post' });
    expect(createReelEntryState('generation')).toEqual({ reelPushedFor: 'generation' });
  });

  // Next's patched pushState writes its fields into the object it is given, and takes
  // an object that already carries `__NA` for one of its own writes, which it does not
  // apply to useSearchParams.
  it('gives a new object each time', () => {
    const first = createReelEntryState('post');
    Object.assign(first, nextOwnState);
    const second = createReelEntryState('post');
    expect(second).not.toBe(first);
    expect(second).not.toHaveProperty('__NA');
  });

  describe('the history mode of an entry', () => {
    it('is pushed on the entry the page pushed for what its address names', () => {
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), createReelEntryState('post'))).toBe('pushed');
      expect(readReelHistoryMode('generation', new URLSearchParams('tab=creations&generation=gen-1'), createReelEntryState('generation'))).toBe('pushed');
    });

    // Next copies its fields into the app's object, and its router's write after that
    // spreads the entry's state (`preserveCustomHistoryState`).
    it('is pushed on that entry once Next has written its own fields onto it', () => {
      const pushed = Object.assign(createReelEntryState('post'), nextOwnState);
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), pushed)).toBe('pushed');
      expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), { ...pushed, __NA: true })).toBe('pushed');
    });

    // A shared link's entry, the shell's tap over one, and every entry from before the
    // reels marked theirs: the reel was opened by address, and its close replaces.
    it('is direct where the address names one on any other entry', () => {
      for (const state of [null, undefined, 'post', nextOwnState, createReelEntryState('generation')]) {
        expect(readReelHistoryMode('post', new URLSearchParams('post=post-1'), state)).toBe('direct');
      }
    });

    it('is none where the address names none, whatever the entry says', () => {
      expect(readReelHistoryMode('post', new URLSearchParams('tab=posts'), createReelEntryState('post'))).toBeNull();
      expect(readReelHistoryMode('post', new URLSearchParams('post='), createReelEntryState('post'))).toBeNull();
      expect(readReelHistoryMode('generation', new URLSearchParams(''), null)).toBeNull();
    });

    // A page that mounts on the entry: a reload, or a Back from a page the reel linked to.
    it('is read from the address and the entry the page is on', () => {
      window.history.replaceState(createReelEntryState('post'), '', '/showcase?post=post-1');
      expect(readCurrentReelHistoryMode('post')).toBe('pushed');
      window.history.replaceState(null, '', '/showcase?post=post-1');
      expect(readCurrentReelHistoryMode('post')).toBe('direct');
      window.history.replaceState(createReelEntryState('post'), '', '/showcase');
      expect(readCurrentReelHistoryMode('post')).toBeNull();
    });
  });

  it('pushes the page\'s own entry for what it opens, and a plain one for nothing', () => {
    pushReelEntry('generation', '/profile?tab=creations&generation=gen-1');
    expect(window.history.state).toEqual({ reelPushedFor: 'generation' });
    pushReelEntry(null, '/profile?tab=saved');
    expect(window.history.state).toBeNull();
  });

  describe('replacing the entry the page is on', () => {
    // Another post of the same reel, or another slide.
    it('keeps the page\'s own entry its own while the address still names what it was pushed for', () => {
      pushReelEntry('post', '/showcase?post=post-1');
      replaceReelEntry('/showcase?post=post-2&media=1');
      expect(window.location.search).toBe('?post=post-2&media=1');
      expect(window.history.state).toEqual({ reelPushedFor: 'post' });
    });

    // The entry's state carries Next's fields, and Next takes a write that carries them
    // for its own.
    it('writes a new state, never the entry\'s own with Next\'s fields', () => {
      window.history.replaceState({ ...nextOwnState, reelPushedFor: 'post' }, '', '/showcase?post=post-1');
      const replaceState = vi.spyOn(window.history, 'replaceState');
      replaceReelEntry('/showcase?post=post-2');
      expect(replaceState).toHaveBeenCalledWith({ reelPushedFor: 'post' }, '', '/showcase?post=post-2');
    });

    it('leaves a plain entry once the address names nothing it was pushed for', () => {
      pushReelEntry('post', '/showcase?post=post-1');
      replaceReelEntry('/showcase');
      expect(window.history.state).toBeNull();
      pushReelEntry('generation', '/profile?tab=creations&generation=gen-1');
      replaceReelEntry('/profile?tab=creations&post=post-1');
      expect(window.history.state).toBeNull();
    });

    it('never makes an entry the page did not push its own', () => {
      window.history.replaceState(null, '', '/showcase?post=post-1');
      replaceReelEntry('/showcase?post=post-2');
      expect(window.history.state).toBeNull();
      window.history.replaceState(nextOwnState, '', '/showcase?post=post-1');
      replaceReelEntry('/showcase?post=post-2');
      expect(window.history.state).toBeNull();
      // Only the two parameters a page pushes entries for count.
      window.history.replaceState({ reelPushedFor: 'creator' }, '', '/showcase?creator=x');
      replaceReelEntry('/showcase?creator=y');
      expect(window.history.state).toBeNull();
    });
  });
});
