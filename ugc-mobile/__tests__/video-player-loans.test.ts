import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';

import {
  adoptVideoPlayer,
  isVideoPlayerOnLoan,
  lenderUnmounting,
  lendVideoPlayer,
  RELEASED_LOAN_GRACE_MS,
  releaseAdoptedVideoPlayer,
  resetVideoPlayerLoans,
  returnVideoPlayer,
  VIDEO_LOAN_TIMEOUT_MS,
} from '../lib/video-player-loans';

function fakePlayer() {
  return { pause: vi.fn(), release: vi.fn() } as unknown as VideoPlayer & {
    pause: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetVideoPlayerLoans();
  vi.useRealTimers();
});

describe('a player the reel adopts', () => {
  it('belongs to the reel once the tile has gone, and is released by it exactly once', () => {
    const player = fakePlayer();
    const giveBack = vi.fn();

    expect(lendVideoPlayer(player, giveBack)).toBe(true);
    // The reel is pushed; Home loses focus and the tile unmounts.
    expect(lenderUnmounting(player)).toBe(true);
    expect(adoptVideoPlayer(player)).toBe(true);

    // Nothing is released while the reel is using it, however long that is.
    vi.advanceTimersByTime(VIDEO_LOAN_TIMEOUT_MS * 3);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();

    releaseAdoptedVideoPlayer(player);
    expect(player.pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RELEASED_LOAN_GRACE_MS);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(giveBack).not.toHaveBeenCalled();
    expect(isVideoPlayerOnLoan(player)).toBe(false);
  });

  it('is never released by a late return from the flight that carried it', () => {
    const player = fakePlayer();
    lendVideoPlayer(player, vi.fn());
    lenderUnmounting(player);
    adoptVideoPlayer(player);

    // The layer lets go of its copy after the hand-off.
    returnVideoPlayer(player);
    vi.advanceTimersByTime(RELEASED_LOAN_GRACE_MS * 2);

    expect(player.release).not.toHaveBeenCalled();
    expect(isVideoPlayerOnLoan(player)).toBe(true);
  });

  it('goes back to a tile that is still mounted when the reel is done', () => {
    const player = fakePlayer();
    const giveBack = vi.fn();
    lendVideoPlayer(player, giveBack);
    adoptVideoPlayer(player);

    releaseAdoptedVideoPlayer(player);
    vi.advanceTimersByTime(RELEASED_LOAN_GRACE_MS * 2);

    expect(giveBack).toHaveBeenCalledTimes(1);
    expect(player.release).not.toHaveBeenCalled();
  });
});

describe('a player the reel never adopts', () => {
  it('goes back to the tile while the tile is mounted', () => {
    const player = fakePlayer();
    const giveBack = vi.fn();
    lendVideoPlayer(player, giveBack);

    returnVideoPlayer(player);

    expect(giveBack).toHaveBeenCalledTimes(1);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
    expect(isVideoPlayerOnLoan(player)).toBe(false);
  });

  it('is released when the tile has gone, so no decoder is left behind', () => {
    const player = fakePlayer();
    const giveBack = vi.fn();
    lendVideoPlayer(player, giveBack);
    lenderUnmounting(player);

    returnVideoPlayer(player);
    vi.advanceTimersByTime(RELEASED_LOAN_GRACE_MS);

    expect(player.pause).toHaveBeenCalledTimes(1);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(giveBack).not.toHaveBeenCalled();
  });

  it('comes back by itself when nothing takes it up', () => {
    const player = fakePlayer();
    lendVideoPlayer(player, vi.fn());
    lenderUnmounting(player);

    vi.advanceTimersByTime(VIDEO_LOAN_TIMEOUT_MS - 1);
    expect(player.release).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1 + RELEASED_LOAN_GRACE_MS);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(isVideoPlayerOnLoan(player)).toBe(false);
  });

  it('cannot be adopted once it has gone back', () => {
    const player = fakePlayer();
    lendVideoPlayer(player, vi.fn());
    returnVideoPlayer(player);

    expect(adoptVideoPlayer(player)).toBe(false);
  });
});

describe('a player that is not on loan', () => {
  it('is the tile’s own to pause and release', () => {
    expect(lenderUnmounting(fakePlayer())).toBe(false);
  });

  it('cannot be lent twice or adopted twice', () => {
    const player = fakePlayer();

    expect(lendVideoPlayer(player, vi.fn())).toBe(true);
    expect(lendVideoPlayer(player, vi.fn())).toBe(false);
    expect(adoptVideoPlayer(player)).toBe(true);
    expect(adoptVideoPlayer(player)).toBe(false);
  });

  it('ignores every ending', () => {
    const player = fakePlayer();

    returnVideoPlayer(player);
    releaseAdoptedVideoPlayer(player);
    vi.advanceTimersByTime(RELEASED_LOAN_GRACE_MS * 2);

    expect(player.pause).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
  });
});
