import { describe, expect, it, vi } from 'vitest';

import { createReelScrubberStore } from '@/lib/reel-scrubber-store';

type FakePlayer = { id: string };

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
