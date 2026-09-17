/**
 * Who owns a feed video's player while the reel it opens is carrying it.
 *
 * A tapped feed tile is usually already playing its video. The zoom used to fly
 * the post's poster out of the tile — the clip's first frame — while the tile
 * had been showing some later frame, and the reel then built a player of its
 * own and started the clip again: the picture changed identity at take-off and
 * froze for most of a second after landing. Instead the tile now lends its
 * player: the flight draws the video the reader was watching, and the reel
 * adopts that same player rather than creating one, so the picture never
 * changes and never stops.
 *
 * Lending moves ownership, which is why this is its own module. The tile
 * releases its player when it unmounts — and it unmounts as soon as the reel is
 * pushed, because a feed player needs its screen focused — so a lent player must
 * outlive the tile, and exactly one party must end up pausing and releasing it:
 *
 * - lent, then adopted by the reel: the reel releases it when it is done;
 * - lent, never adopted (the reel opened on something else, the flight turned
 *   round, the push never came): it goes back to the tile if the tile is still
 *   mounted, or is released if the tile is gone.
 *
 * Every function is safe to call on a player that is not on loan.
 */
import type { VideoPlayer } from 'expo-video';

/**
 * A loan the reel never takes up ends by itself after this: long enough for a
 * slow reel to mount and land, short enough that nothing holds a decoder long.
 */
export const VIDEO_LOAN_TIMEOUT_MS = 4000;

/**
 * As the feed's own player layer does: a queued native view transaction may
 * still attach the player after its React owner has gone, so it is paused at
 * once and released a moment later.
 */
export const RELEASED_LOAN_GRACE_MS = 100;

interface Loan {
  stage: 'lent' | 'adopted';
  /** The tile that lent it is still mounted, and takes it back when the loan ends. */
  lenderMounted: boolean;
  /** Gives the player back to the mounted tile: re-attaches it to the tile's own view. */
  giveBack: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

const loans = new Map<VideoPlayer, Loan>();

function releaseSoon(player: VideoPlayer) {
  try {
    player.pause();
  } catch {
    // Already released, or its native side is gone.
  }
  setTimeout(() => {
    try {
      player.release();
    } catch {
      // Release is idempotent from the loan's point of view.
    }
  }, RELEASED_LOAN_GRACE_MS);
}

function settle(player: VideoPlayer, loan: Loan) {
  loans.delete(player);
  if (loan.timeout) clearTimeout(loan.timeout);
  if (loan.lenderMounted) loan.giveBack?.();
  else releaseSoon(player);
}

/**
 * The tile lends its player to a flight. Returns false when it is already out
 * on loan, so the same player is never flown twice.
 */
export function lendVideoPlayer(player: VideoPlayer, giveBack: () => void): boolean {
  if (loans.has(player)) return false;
  const loan: Loan = { stage: 'lent', lenderMounted: true, giveBack, timeout: null };
  loan.timeout = setTimeout(() => returnVideoPlayer(player), VIDEO_LOAN_TIMEOUT_MS);
  loans.set(player, loan);
  return true;
}

export function isVideoPlayerOnLoan(player: VideoPlayer) {
  return loans.has(player);
}

/**
 * The lending tile is unmounting. True when its player is out on loan, in which
 * case the tile must neither pause nor release it: it is no longer the tile's.
 */
export function lenderUnmounting(player: VideoPlayer): boolean {
  const loan = loans.get(player);
  if (!loan) return false;
  loan.lenderMounted = false;
  loan.giveBack = null;
  return true;
}

/**
 * The reel takes a lent player for its own. From here on the reel pauses it and
 * ends the loan with `releaseAdoptedVideoPlayer`. False when it is not on loan
 * any more — it went back, or someone adopted it first — so the reel must build
 * a player of its own.
 */
export function adoptVideoPlayer(player: VideoPlayer): boolean {
  const loan = loans.get(player);
  if (!loan || loan.stage !== 'lent') return false;
  loan.stage = 'adopted';
  if (loan.timeout) clearTimeout(loan.timeout);
  loan.timeout = null;
  return true;
}

/** A loan that was never adopted ends: back to the tile, or released if the tile is gone. */
export function returnVideoPlayer(player: VideoPlayer) {
  const loan = loans.get(player);
  if (!loan || loan.stage !== 'lent') return;
  settle(player, loan);
}

/** The reel that adopted a player is done with it. */
export function releaseAdoptedVideoPlayer(player: VideoPlayer) {
  const loan = loans.get(player);
  if (!loan || loan.stage !== 'adopted') return;
  settle(player, loan);
}

/** Test support: forgets every loan without touching the players. */
export function resetVideoPlayerLoans() {
  loans.forEach((loan) => {
    if (loan.timeout) clearTimeout(loan.timeout);
  });
  loans.clear();
}
