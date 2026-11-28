import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { wasVideoMovedByReader } from '@/lib/reader-video-moves';
import { REEL_RESUME_GRACE_MS, createReelScrubController } from '@/lib/reel-scrub-controller';
import { createReelScrubberStore } from '@/lib/reel-scrubber-store';

/**
 * A stand-in for expo-video's player. Its time cannot be read: on Android that
 * read blocks the JS thread, so the bar must never make it.
 */
function createFakePlayer({ playing = true, status = 'readyToPlay' }: { playing?: boolean; status?: string } = {}) {
  const listeners = new Set<(event: { isPlaying: boolean }) => void>();
  const player = {
    playing,
    status,
    playbackRate: 1,
    released: false,
    plays: 0,
    pauses: 0,
    seeks: [] as number[],
    scrubbingModes: [] as boolean[],
    get currentTime(): number {
      throw new Error('the bar read currentTime');
    },
    set currentTime(seconds: number) {
      if (player.released) throw new Error('released');
      player.seeks.push(seconds);
    },
    get scrubbingModeOptions() {
      return {};
    },
    set scrubbingModeOptions(options: { scrubbingModeEnabled?: boolean }) {
      if (player.released) throw new Error('released');
      player.scrubbingModes.push(Boolean(options.scrubbingModeEnabled));
    },
    pause() {
      if (player.released) throw new Error('released');
      player.pauses += 1;
      player.playing = false;
    },
    play() {
      if (player.released) throw new Error('released');
      player.plays += 1;
    },
    addListener(_event: 'playingChange', listener: (event: { isPlaying: boolean }) => void) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emitPlaying(isPlaying: boolean) {
      player.playing = isPlaying;
      for (const listener of [...listeners]) listener({ isPlaying });
    },
  };
  return player;
}

type FakePlayer = ReturnType<typeof createFakePlayer>;

function setUp({ intent = true, player = createFakePlayer(), duration = 10 } = {}) {
  const store = createReelScrubberStore<FakePlayer>();
  const intentRef = { current: intent };
  store.attach(player, () => intentRef.current);
  const line = { setFraction: vi.fn(), runToEnd: vi.fn() };
  const clock: number[] = [];
  const frames: (() => void)[] = [];
  let time = 1_000;
  const controller = createReelScrubController<FakePlayer>({
    store,
    line,
    setClock: (seconds) => clock.push(seconds),
    now: () => time,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: (handle) => {
      frames[handle - 1] = () => undefined;
    },
  });
  controller.setDuration(duration);
  return {
    store,
    player,
    line,
    clock,
    controller,
    intentRef,
    flushFrames: () => {
      for (const frame of frames.splice(0)) frame();
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('following the clip', () => {
  it('runs the line to the end while the clip plays, and leaves an agreeing run alone', () => {
    const { controller, player, line, advance } = setUp();
    controller.follow();
    expect(line.setFraction).toHaveBeenLastCalledWith(0);
    controller.report(player, 2);
    expect(line.runToEnd).toHaveBeenLastCalledWith(0.2, 8000);
    advance(250);
    controller.report(player, 2.25);
    expect(line.runToEnd).toHaveBeenCalledTimes(1);
  });

  it('stands the line at the clip’s place while it does not play', () => {
    const { controller, player, line } = setUp({ player: createFakePlayer({ playing: false }) });
    controller.report(player, 4);
    expect(line.setFraction).toHaveBeenLastCalledWith(0.4);
    expect(line.runToEnd).not.toHaveBeenCalled();
  });

  it('sets the line again from the last report when the clip starts or stops', () => {
    const { controller, player, line } = setUp();
    controller.report(player, 3);
    player.playing = false;
    controller.resync(player);
    expect(line.setFraction).toHaveBeenLastCalledWith(0.3);
  });
});

describe('a drag', () => {
  it('pauses, scrubs one seek a frame, and plays on from where it lets go', () => {
    const { controller, store, player, flushFrames } = setUp();
    controller.beginScrub(0.2);
    expect(player.pauses).toBe(1);
    expect(player.scrubbingModes).toEqual([true]);
    expect(player.seeks).toEqual([2]);
    expect(store.getSnapshot().scrubbing).toBe(true);
    expect(wasVideoMovedByReader(player)).toBe(true);
    controller.scrubTo(0.3);
    controller.scrubTo(0.4);
    controller.scrubTo(0.5);
    flushFrames();
    expect(player.seeks).toEqual([2, 5]);
    controller.endScrub(0.6);
    expect(player.scrubbingModes).toEqual([true, false]);
    expect(player.seeks).toEqual([2, 5, 6]);
    expect(store.getSnapshot()).toMatchObject({ scrubbing: false, resuming: true });
    expect(player.plays).toBe(1);
    // It loads at the new place, then plays: the hold ends there.
    player.emitPlaying(false);
    expect(store.getSnapshot().resuming).toBe(true);
    player.emitPlaying(true);
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('plays on after a drag begun while the clip was still loading, as it meant to play', () => {
    const { controller, store, player } = setUp({ player: createFakePlayer({ playing: false, status: 'loading' }) });
    controller.beginScrub(0.5);
    controller.endScrub(0.5);
    expect(player.plays).toBe(1);
    expect(store.getSnapshot().resuming).toBe(true);
  });

  it('leaves a clip the reader had paused paused', () => {
    const { controller, store, player } = setUp({ intent: false, player: createFakePlayer({ playing: false }) });
    controller.beginScrub(0.5);
    controller.endScrub(0.7);
    expect(player.plays).toBe(0);
    expect(store.getSnapshot()).toMatchObject({ scrubbing: false, resuming: false });
  });

  it('lets the resume go after its grace when the clip never plays again', () => {
    const { controller, store } = setUp();
    controller.beginScrub(0.5);
    controller.endScrub(0.5);
    vi.advanceTimersByTime(REEL_RESUME_GRACE_MS);
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('plays on after a second drag begun while the first was still coming back', () => {
    const { controller, player, intentRef } = setUp();
    controller.beginScrub(0.2);
    controller.endScrub(0.3);
    // The page cannot say yet: the scrub's pause was hidden from it.
    intentRef.current = false;
    controller.beginScrub(0.5);
    controller.endScrub(0.6);
    expect(player.plays).toBe(2);
  });

  it('survives a player released under the finger, and releases nothing twice', () => {
    const { controller, store, player, flushFrames } = setUp();
    controller.beginScrub(0.2);
    player.released = true;
    controller.scrubTo(0.4);
    expect(() => flushFrames()).not.toThrow();
    expect(() => controller.endScrub(0.4)).not.toThrow();
    expect(store.getSnapshot().scrubbing).toBe(false);
    expect(() => controller.release(player)).not.toThrow();
  });

  it('turns scrubbing mode off when the bar lets go of a player mid-drag', () => {
    const { controller, player } = setUp();
    controller.beginScrub(0.2);
    controller.release(player);
    expect(player.scrubbingModes).toEqual([true, false]);
  });

  it('stays still while dragged, whatever the clip reports', () => {
    const { controller, player, line } = setUp();
    controller.beginScrub(0.2);
    line.runToEnd.mockClear();
    line.setFraction.mockClear();
    controller.report(player, 7);
    controller.resync(player);
    expect(line.runToEnd).not.toHaveBeenCalled();
    expect(line.setFraction).not.toHaveBeenCalled();
  });
});

describe('a tap', () => {
  it('seeks a playing clip and holds its "playing" through the load, without asking it to play', () => {
    const { controller, store, player, line } = setUp();
    controller.tapSeek(0.8);
    expect(player.seeks).toEqual([8]);
    expect(line.setFraction).toHaveBeenLastCalledWith(0.8);
    expect(player.plays).toBe(0);
    expect(store.getSnapshot().resuming).toBe(true);
    player.emitPlaying(true);
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('seeks a paused clip and leaves it paused, with nothing to hold', () => {
    const { controller, store, player } = setUp({ intent: false, player: createFakePlayer({ playing: false }) });
    controller.tapSeek(0.8);
    expect(player.seeks).toEqual([8]);
    expect(store.getSnapshot().resuming).toBe(false);
  });

  it('ignores the reports from before its seek until one lands near the new place', () => {
    const { controller, player, line, advance } = setUp();
    controller.report(player, 2);
    controller.tapSeek(0.8);
    line.runToEnd.mockClear();
    advance(250);
    controller.report(player, 2.25);
    expect(line.runToEnd).not.toHaveBeenCalled();
    advance(250);
    controller.report(player, 8.1);
    expect(line.runToEnd).toHaveBeenCalledTimes(1);
  });
});

describe('a screen reader’s step', () => {
  it('moves a tenth of the clip from the last known place, and holds a playing clip through the load', () => {
    const { controller, store, player } = setUp();
    controller.report(player, 3);
    expect(controller.step(1)).toBeCloseTo(0.4);
    expect(player.seeks).toEqual([4]);
    expect(store.getSnapshot().resuming).toBe(true);
    expect(controller.step(-1)).toBeCloseTo(0.3);
    expect(player.seeks).toEqual([4, 3]);
  });

  it('does nothing for a clip of no known length', () => {
    const { controller, player } = setUp({ duration: 0 });
    expect(controller.step(1)).toBeNull();
    expect(player.seeks).toEqual([]);
  });
});
