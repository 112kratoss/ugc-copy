import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoPlayer } from 'expo-video';

import {
  acceptVideoReturn,
  adoptVideoPlayer,
  claimReturnedVideoPlayer,
  endVideoReturn,
  handBackVideoPlayer,
  holdVideoLoan,
  isVideoLoanHeld,
  isVideoPlayerHandedBack,
  isVideoPlayerOnLoan,
  isVideoReturnPending,
  lenderUnmounting,
  lendVideoPlayer,
  RELEASED_LOAN_GRACE_MS,
  releaseAdoptedVideoPlayer,
  releaseVideoLoanHold,
  reportReturnedVideoDrawn,
  resetVideoPlayerLoans,
  returnVideoPlayer,
  subscribeToVideoReturns,
  subscribeToVideoLoanHolds,
  tileAcceptsVideoReturn,
  VIDEO_LOAN_HOLD_TIMEOUT_MS,
  VIDEO_LOAN_TIMEOUT_MS,
  VIDEO_RETURN_TIMEOUT_MS,
  whenReturnedVideoDrawn,
  zoomTileKey,
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

/** Lent by its tile, the tile gone, adopted by the reel: where every close starts. */
function adoptedPlayer() {
  const player = fakePlayer();
  lendVideoPlayer(player, vi.fn());
  lenderUnmounting(player);
  adoptVideoPlayer(player);
  return player;
}

const TILE = zoomTileKey('home-surface', 'post-1');
const STREAM = 'https://cdn.example/clip.mp4';

describe('a player the reel hands back to the tile it came from', () => {
  it('is taken by that tile for that stream only, and is then the tile’s own', () => {
    const player = adoptedPlayer();
    expect(handBackVideoPlayer(player, TILE, STREAM)).toBe(true);

    expect(claimReturnedVideoPlayer(zoomTileKey('explore-surface', 'post-1'), STREAM)).toBeNull();
    expect(claimReturnedVideoPlayer(TILE, 'https://cdn.example/other.mp4')).toBeNull();
    expect(claimReturnedVideoPlayer(TILE, STREAM)).toBe(player);
    // Once only.
    expect(claimReturnedVideoPlayer(TILE, STREAM)).toBeNull();

    // The tile pauses and releases its own player when it unmounts again.
    expect(lenderUnmounting(player)).toBe(false);
    // And nothing the reel does on its way out touches it.
    releaseAdoptedVideoPlayer(player);
    vi.advanceTimersByTime(VIDEO_RETURN_TIMEOUT_MS * 2);
    expect(player.pause).not.toHaveBeenCalled();
    expect(player.release).not.toHaveBeenCalled();
  });

  it('stays pending, so its tile keeps a player while unfocused, until the reel has gone and the tile has drawn it', () => {
    const player = adoptedPlayer();
    const changes = vi.fn();
    const unsubscribe = subscribeToVideoReturns(changes);
    handBackVideoPlayer(player, TILE, STREAM);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(isVideoReturnPending(TILE, STREAM)).toBe(true);

    claimReturnedVideoPlayer(TILE, STREAM);
    endVideoReturn(player);
    // Not drawn yet: a close may still be waiting on the tile.
    expect(isVideoReturnPending(TILE, STREAM)).toBe(true);

    reportReturnedVideoDrawn(player);
    expect(isVideoReturnPending(TILE, STREAM)).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('tells whoever waits when the tile has drawn it, and at once to a late waiter', () => {
    const player = adoptedPlayer();
    handBackVideoPlayer(player, TILE, STREAM);
    const reel = vi.fn();
    const cancelled = vi.fn();
    whenReturnedVideoDrawn(player, reel);
    const cancel = whenReturnedVideoDrawn(player, cancelled);
    cancel();

    claimReturnedVideoPlayer(TILE, STREAM);
    reportReturnedVideoDrawn(player);
    reportReturnedVideoDrawn(player);

    expect(reel).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    const late = vi.fn();
    whenReturnedVideoDrawn(player, late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('is released when no tile takes it, once a close could no longer be drawing it', () => {
    const player = adoptedPlayer();
    handBackVideoPlayer(player, TILE, STREAM);
    endVideoReturn(player);

    vi.advanceTimersByTime(VIDEO_RETURN_TIMEOUT_MS - 1);
    expect(player.pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(player.pause).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RELEASED_LOAN_GRACE_MS);
    expect(player.release).toHaveBeenCalledTimes(1);
    expect(isVideoPlayerOnLoan(player)).toBe(false);
    expect(isVideoReturnPending(TILE, STREAM)).toBe(false);
  });

  it('is never released once taken, even if its tile never reports a frame', () => {
    const player = adoptedPlayer();
    handBackVideoPlayer(player, TILE, STREAM);
    claimReturnedVideoPlayer(TILE, STREAM);

    vi.advanceTimersByTime(VIDEO_RETURN_TIMEOUT_MS + RELEASED_LOAN_GRACE_MS);
    expect(player.release).not.toHaveBeenCalled();
    expect(isVideoReturnPending(TILE, STREAM)).toBe(false);
  });

  it('can only be a player the reel adopted', () => {
    const lent = fakePlayer();
    lendVideoPlayer(lent, vi.fn());
    expect(handBackVideoPlayer(lent, TILE, STREAM)).toBe(false);
    expect(handBackVideoPlayer(fakePlayer(), TILE, STREAM)).toBe(false);
    expect(isVideoReturnPending(TILE, STREAM)).toBe(false);
  });

  it('is marked as handed back until the tile lends it to a new reel', () => {
    const player = adoptedPlayer();
    expect(isVideoPlayerHandedBack(player)).toBe(false);
    handBackVideoPlayer(player, TILE, STREAM);
    expect(isVideoPlayerHandedBack(player)).toBe(true);
    claimReturnedVideoPlayer(TILE, STREAM);

    lendVideoPlayer(player, vi.fn());
    expect(isVideoPlayerHandedBack(player)).toBe(false);
  });
});

describe('a tile saying it would take a player back', () => {
  it('holds for as long as the tile says so, per stream', () => {
    expect(tileAcceptsVideoReturn(TILE, STREAM)).toBe(false);
    const first = acceptVideoReturn(TILE, STREAM);
    const second = acceptVideoReturn(TILE, STREAM);
    expect(tileAcceptsVideoReturn(TILE, STREAM)).toBe(true);
    expect(tileAcceptsVideoReturn(TILE, 'https://cdn.example/other.mp4')).toBe(false);

    first();
    expect(tileAcceptsVideoReturn(TILE, STREAM)).toBe(true);
    second();
    expect(tileAcceptsVideoReturn(TILE, STREAM)).toBe(false);
  });
});

describe('a player held on its tile while iOS\'s zoom carries it up', () => {
  const tile = zoomTileKey('home', 'post-1');
  const url = 'https://cdn.test/clip.mp4';

  it('is the tile\'s to draw until the reel lets go, or the hold runs out', () => {
    const player = fakePlayer();
    const listener = vi.fn();
    subscribeToVideoLoanHolds(listener);
    lendVideoPlayer(player, vi.fn());

    holdVideoLoan(player, tile, url);
    expect(isVideoLoanHeld(tile, url)).toBe(true);
    expect(isVideoLoanHeld(tile, 'https://cdn.test/other.mp4')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    releaseVideoLoanHold(player);
    expect(isVideoLoanHeld(tile, url)).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    // Releasing twice tells nobody anything.
    releaseVideoLoanHold(player);
    expect(listener).toHaveBeenCalledTimes(2);

    holdVideoLoan(player, tile, url);
    vi.advanceTimersByTime(VIDEO_LOAN_HOLD_TIMEOUT_MS);
    expect(isVideoLoanHeld(tile, url)).toBe(false);
  });

  it('ends with the loan', () => {
    const player = fakePlayer();
    lendVideoPlayer(player, vi.fn());
    holdVideoLoan(player, tile, url);
    adoptVideoPlayer(player);

    releaseAdoptedVideoPlayer(player);

    expect(isVideoLoanHeld(tile, url)).toBe(false);
  });
});
