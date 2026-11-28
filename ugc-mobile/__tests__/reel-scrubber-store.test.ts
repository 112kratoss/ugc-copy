import { afterEach, describe, expect, it, vi } from 'vitest';

import { createReelScrubberStore, holdResume } from '@/lib/reel-scrubber-store';

type FakePlayer = { id: string };

/** A player that says when it plays, as expo-video's `playingChange` does. */
function createPlayingPlayer(id: string, options: { failsToPlay?: boolean } = {}) {
  const listeners = new Set<(event: { isPlaying: boolean }) => void>();
  return {
    id,
    plays: 0,
    addListener(_event: 'playingChange', listener: (event: { isPlaying: boolean }) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    play() {
      if (options.failsToPlay) throw new Error('released');
      this.plays += 1;
    },
    emit(isPlaying: boolean) {
      for (const listener of [...listeners]) listener({ isPlaying });
    },
    get listening() {
      return listeners.size;
    },
  };
}

describe('the playing page’s intent', () => {
  it('asks the page whose player is attached whether its clip means to play', () => {
    const store = createReelScrubberStore<FakePlayer>();
    expect(store.wantsPlayback()).toBe(false);
    let intent = true;
    const detach = store.attach({ id: 'a' }, () => intent);
    expect(store.wantsPlayback()).toBe(true);
    intent = false;
    expect(store.wantsPlayback()).toBe(false);
    detach();
    expect(store.wantsPlayback()).toBe(false);
  });

  it('reads a page that says nothing as paused', () => {
    const store = createReelScrubberStore<FakePlayer>();
    store.attach({ id: 'a' });
    expect(store.wantsPlayback()).toBe(false);
  });
});

describe('holdResume', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds the resume until the clip plays again, and plays it when asked', () => {
    const store = createReelScrubberStore<ReturnType<typeof createPlayingPlayer>>();
    const player = createPlayingPlayer('a');
    store.attach(player);
    const onEnd = vi.fn();
    holdResume(store, player, { play: true, graceMs: 2500, onEnd });
    expect(player.plays).toBe(1);
    expect(store.getSnapshot().resuming).toBe(true);
    // Loading at the new place says "not playing" first.
    player.emit(false);
    expect(store.getSnapshot().resuming).toBe(true);
    player.emit(true);
    expect(store.getSnapshot().resuming).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(player.listening).toBe(0);
  });

  it('holds a tap’s seek on a playing clip without asking it to play', () => {
    const store = createReelScrubberStore<ReturnType<typeof createPlayingPlayer>>();
    const player = createPlayingPlayer('a');
    store.attach(player);
    holdResume(store, player, { play: false, graceMs: 2500 });
    expect(player.plays).toBe(0);
    expect(store.getSnapshot().resuming).toBe(true);
    player.emit(true);
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('lets go after the grace when the clip never plays again', () => {
    vi.useFakeTimers();
    const store = createReelScrubberStore<ReturnType<typeof createPlayingPlayer>>();
    const player = createPlayingPlayer('a');
    store.attach(player);
    const onEnd = vi.fn();
    holdResume(store, player, { play: true, graceMs: 2500, onEnd });
    vi.advanceTimersByTime(2499);
    expect(store.getSnapshot().resuming).toBe(true);
    vi.advanceTimersByTime(1);
    expect(store.getSnapshot().resuming).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(player.listening).toBe(0);
  });

  it('ends at once when taken back, and only once', () => {
    vi.useFakeTimers();
    const store = createReelScrubberStore<ReturnType<typeof createPlayingPlayer>>();
    const player = createPlayingPlayer('a');
    store.attach(player);
    const onEnd = vi.fn();
    const end = holdResume(store, player, { play: true, graceMs: 2500, onEnd });
    end();
    end();
    player.emit(true);
    vi.advanceTimersByTime(5000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('holds nothing for a player that is no longer the slide’s', () => {
    const store = createReelScrubberStore<ReturnType<typeof createPlayingPlayer>>();
    const player = createPlayingPlayer('a');
    store.attach(createPlayingPlayer('b'));
    holdResume(store, player, { play: false, graceMs: 2500 });
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('survives a player released under it', () => {
    const store = createReelScrubberStore<ReturnType<typeof createPlayingPlayer>>();
    const player = createPlayingPlayer('a', { failsToPlay: true });
    store.attach(player);
    expect(() => holdResume(store, player, { play: true, graceMs: 2500 })).not.toThrow();
    expect(store.getSnapshot().resuming).toBe(false);
    expect(player.listening).toBe(0);
  });
});

describe('createReelScrubberStore', () => {
  it('starts with nothing attached and nothing scrubbed', () => {
    const store = createReelScrubberStore<FakePlayer>();
    expect(store.getSnapshot()).toEqual({ player: null, scrubbing: false, resuming: false });
  });

  it('hands the bar the playing page’s player and takes it back', () => {
    const store = createReelScrubberStore<FakePlayer>();
    const listener = vi.fn();
    store.subscribe(listener);
    const player = { id: 'a' };
    const detach = store.attach(player);
    expect(store.getSnapshot().player).toBe(player);
    detach();
    expect(store.getSnapshot().player).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer player when an older page lets go after it', () => {
    const store = createReelScrubberStore<FakePlayer>();
    const first = { id: 'a' };
    const second = { id: 'b' };
    const detachFirst = store.attach(first);
    store.attach(second);
    detachFirst();
    expect(store.getSnapshot().player).toBe(second);
  });

  it('keeps the snapshot and stays quiet when nothing changed', () => {
    const store = createReelScrubberStore<FakePlayer>();
    const player = { id: 'a' };
    store.attach(player);
    const snapshot = store.getSnapshot();
    const listener = vi.fn();
    store.subscribe(listener);
    store.attach(player);
    store.setScrubbing(false);
    expect(store.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
  });

  it('scrubs only with a player, and a player taken back ends the scrub', () => {
    const store = createReelScrubberStore<FakePlayer>();
    store.setScrubbing(true);
    expect(store.getSnapshot().scrubbing).toBe(false);
    const detach = store.attach({ id: 'a' });
    store.setScrubbing(true);
    expect(store.getSnapshot().scrubbing).toBe(true);
    detach();
    expect(store.getSnapshot()).toEqual({ player: null, scrubbing: false, resuming: false });
  });

  it('holds the resume between the scrub and the clip playing again', () => {
    const store = createReelScrubberStore<FakePlayer>();
    store.setResuming(true);
    expect(store.getSnapshot().resuming).toBe(false);
    const player = { id: 'a' };
    const detach = store.attach(player);
    store.setScrubbing(true);
    store.setScrubbing(false);
    store.setResuming(true);
    expect(store.getSnapshot()).toEqual({ player, scrubbing: false, resuming: true });
    expect(store.seekedWithin(99_000, 1_500)).toBe(true);
    // A new scrub takes over from the last one's resume.
    store.setScrubbing(true);
    expect(store.getSnapshot()).toEqual({ player, scrubbing: true, resuming: false });
    store.setScrubbing(false);
    store.setResuming(true);
    detach();
    expect(store.getSnapshot()).toEqual({ player: null, scrubbing: false, resuming: false });
  });

  it('keeps the same player’s scrub when it is attached again', () => {
    const store = createReelScrubberStore<FakePlayer>();
    const player = { id: 'a' };
    store.attach(player);
    store.setScrubbing(true);
    store.attach(player);
    expect(store.getSnapshot().scrubbing).toBe(true);
  });

  it('stops telling a listener that unsubscribed', () => {
    const store = createReelScrubberStore<FakePlayer>();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.attach({ id: 'a' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('counts seeks, and reads a load right after one as the reader’s doing', () => {
    const store = createReelScrubberStore<FakePlayer>();
    store.attach({ id: 'a' });
    expect(store.seekGeneration()).toBe(0);
    expect(store.seekedWithin(10_000, 1_500)).toBe(false);
    store.noteSeek(10_000);
    expect(store.seekGeneration()).toBe(1);
    expect(store.seekedWithin(11_000, 1_500)).toBe(true);
    expect(store.seekedWithin(11_600, 1_500)).toBe(false);
    store.setScrubbing(true);
    expect(store.seekedWithin(99_000, 1_500)).toBe(true);
  });
});
