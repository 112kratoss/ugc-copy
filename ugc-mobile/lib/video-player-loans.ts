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
 * - lent, adopted, then handed back: a reel closing into the tile it came from
 *   gives the player to that tile, which carries on with it instead of starting
 *   a new player from the clip's poster (see `handBackVideoPlayer`);
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

/**
 * A player handed back that its tile never takes is released this long after
 * the reel that handed it back has gone. The tile takes it within a frame or
 * two of the hand-back; the wait only has to outlast a close that is still
 * drawing the player on its way down. Counted from the reel's going rather than
 * from the hand-back: a dismissal begun with a gesture hands the player back as
 * the gesture begins, and a finger can hold the reel half-shrunk for longer
 * than any timeout.
 */
export const VIDEO_RETURN_TIMEOUT_MS = 2000;

/**
 * How long a player Back hands to its tile stands still there, on the frame it
 * was showing when Back was pressed.
 *
 * Under UIKit's zoom (lib/apple-zoom.ts) Back takes the reel out of React
 * before the pop runs, and react-native-screens pops a picture of the reel in
 * its place: the reel is one frame from then on, and UIKit crossfades that
 * frame into the tile over the first 130 to 170 ms of the shrink. A tile
 * playing on underneath shows a later moment of the clip, so on a clip that
 * moves the crossfade is two different pictures at part opacity, a ghost.
 * Filmed on the simulator: two poses of the dancer at once for five or six
 * frames. Standing still, the tile shows the frame the reel's picture shows,
 * and the crossfade is between two copies of it. It plays on once that is
 * over. A dismissal begun with a gesture keeps the reel itself, playing, and
 * needs none of this.
 *
 * Checking this on the simulator: turn the reel's sound off first. With sound
 * on, the simulator draws a playing clip about 0.6 s behind the player's own
 * clock (measured against the clip's scene cuts), while a view handed a
 * stopped player draws the clock's frame, so the tile shows a later moment
 * than the reel's picture however still it stands. With sound off the two were
 * the same frame, three closes of three.
 */
export const VIDEO_RETURN_STILL_MS = 250;

interface Loan {
  /** `returning`: handed back to the tile, which has not taken it yet. */
  stage: 'lent' | 'adopted' | 'returning';
  /** The tile that lent it is still mounted, and takes it back when the loan ends. */
  lenderMounted: boolean;
  /** Gives the player back to the mounted tile: re-attaches it to the tile's own view. */
  giveBack: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
}

const loans = new Map<VideoPlayer, Loan>();
/** Players a reel has handed back: it must neither pause nor release them again. */
const handedBack = new WeakSet<VideoPlayer>();

/**
 * A tile whose player iOS's own zoom is carrying up keeps drawing it until the
 * push has landed: UIKit grows the tile's live view into the reel, and the
 * reel's view of the same player fades in over it (lib/apple-zoom.ts). The reel
 * ends the hold once the navigator says the push is over; one it never says
 * ends here.
 */
export const VIDEO_LOAN_HOLD_TIMEOUT_MS = 1500;

interface LoanHold {
  key: string;
  timeout: ReturnType<typeof setTimeout>;
}

const holds = new Map<VideoPlayer, LoanHold>();
const holdListeners = new Set<() => void>();

function notifyHoldListeners() {
  holdListeners.forEach((listener) => listener());
}

/** The tile lending `player` out of `tileKey` on `url` keeps its view of it until released. */
export function holdVideoLoan(player: VideoPlayer, tileKey: string, url: string) {
  releaseVideoLoanHold(player);
  holds.set(player, {
    key: returnKey(tileKey, url),
    timeout: setTimeout(() => releaseVideoLoanHold(player), VIDEO_LOAN_HOLD_TIMEOUT_MS),
  });
  notifyHoldListeners();
}

export function releaseVideoLoanHold(player: VideoPlayer) {
  const hold = holds.get(player);
  if (!hold) return;
  clearTimeout(hold.timeout);
  holds.delete(player);
  notifyHoldListeners();
}

/** Whether a player lent out of this tile and stream is still the tile's to draw. */
export function isVideoLoanHeld(tileKey: string, url: string) {
  const key = returnKey(tileKey, url);
  for (const hold of holds.values()) {
    if (hold.key === key) return true;
  }
  return false;
}

export function subscribeToVideoLoanHolds(listener: () => void) {
  holdListeners.add(listener);
  return () => {
    holdListeners.delete(listener);
  };
}

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

/**
 * Feed tiles play silently, and a reel may have turned the sound on. A player
 * leaves the reel silent — handed back, given back or released — rather than
 * when its tile takes it: a tile that takes it late, or never, would otherwise
 * leave a video playing aloud behind a reel that has gone.
 */
function silence(player: VideoPlayer) {
  try {
    player.muted = true;
  } catch {
    // Already released, or its native side is gone.
  }
}

function settle(player: VideoPlayer, loan: Loan) {
  silence(player);
  loans.delete(player);
  releaseVideoLoanHold(player);
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
  // Lent again after coming back: the new reel owns it, as the last one did.
  handedBack.delete(player);
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

/** A viewer-created player can also leave with a receiving tile on iOS. */
export function ownViewerVideoPlayer(player: VideoPlayer) {
  loans.set(player, { stage: 'adopted', lenderMounted: false, giveBack: null, timeout: null });
}

/** A loan that was never adopted ends: back to the tile, or released if the tile is gone. */
export function returnVideoPlayer(player: VideoPlayer) {
  const loan = loans.get(player);
  if (!loan || loan.stage !== 'lent') return;
  settle(player, loan);
}

/**
 * The reel that adopted a player is done with it. One it handed back is not
 * its to end: the tile has it, or the hand-back's own timeout releases it.
 */
export function releaseAdoptedVideoPlayer(player: VideoPlayer) {
  const loan = loans.get(player);
  if (!loan || loan.stage !== 'adopted') return;
  settle(player, loan);
}

// ---------------------------------------------------------------------------
// The way back: a reel closing into the tile it grew out of
// ---------------------------------------------------------------------------
//
// The tile's own player went away when the reel took its screen's focus, so a
// tile coming back used to build a new player: its poster — the clip's first
// frame — until that player drew, then the clip from wherever it was told to
// start. Filmed on a playing clip that was a flash of frame zero and a jump.
// Handing the reel's player back keeps the one picture on screen throughout.
//
// A tile says which streams it would take back (`acceptVideoReturn`), so the
// reel only waits on a tile that is going to answer. The hand-back then stays
// pending until the reel has gone, so the tile keeps its player while its screen
// is still unfocused under the closing reel.

/** A tile's address in the zoom: the screen it is on and the post it shows. */
export function zoomTileKey(surfaceId: string, itemId: string) {
  return `${surfaceId}\u0000${itemId}`;
}

function returnKey(tileKey: string, url: string) {
  return `${tileKey}\u0000${url}`;
}

interface VideoReturn {
  player: VideoPlayer;
  key: string;
  /** The tile has taken it. */
  claimed: boolean;
  /** The tile's own view has drawn it. */
  drawn: boolean;
  /** The reel that handed it back has gone. */
  reelGone: boolean;
  drawnListeners: Set<() => void>;
  /** Armed once the reel has gone: a hand-back still unsettled by then is dropped. */
  timeout: ReturnType<typeof setTimeout> | null;
  /** Running while the player stands still in its tile (`VIDEO_RETURN_STILL_MS`); null otherwise. */
  still: ReturnType<typeof setTimeout> | null;
}

const acceptors = new Map<string, number>();
let pendingReturn: VideoReturn | null = null;
const returnListeners = new Set<() => void>();

function notifyReturnListeners() {
  returnListeners.forEach((listener) => listener());
}

/**
 * A tile that would take back a player streaming `url` — it would hold one of
 * its own if its screen had focus — registers for as long as that is true.
 */
export function acceptVideoReturn(tileKey: string, url: string) {
  const key = returnKey(tileKey, url);
  acceptors.set(key, (acceptors.get(key) ?? 0) + 1);
  return () => {
    const count = (acceptors.get(key) ?? 1) - 1;
    if (count > 0) acceptors.set(key, count);
    else acceptors.delete(key);
  };
}

export function tileAcceptsVideoReturn(tileKey: string, url: string) {
  return acceptors.has(returnKey(tileKey, url));
}

/** Taken, drawn, the reel gone and no longer standing still: nothing more happens to this hand-back. */
function finishReturnIfSettled(pending: VideoReturn) {
  if (pending.claimed && pending.drawn && pending.reelGone && !pending.still) dropReturn(pending);
}

function dropReturn(pending: VideoReturn) {
  if (pendingReturn !== pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  if (pending.still) clearTimeout(pending.still);
  pending.still = null;
  pendingReturn = null;
  if (!pending.claimed) {
    loans.delete(pending.player);
    releaseSoon(pending.player);
  }
  notifyReturnListeners();
}

/**
 * The reel gives the player it adopted back to the tile it came from. False
 * when it cannot: the player is not the reel's adopted one.
 *
 * `still` for a reel that is a single frame from here on (Back under UIKit's
 * zoom): the player stops on the frame it is showing and its tile leaves it
 * there for `VIDEO_RETURN_STILL_MS`, the hand-back staying pending meanwhile,
 * so the tile's own decision to play waits for it.
 */
export function handBackVideoPlayer(player: VideoPlayer, tileKey: string, url: string, still = false): boolean {
  const loan = loans.get(player);
  if (!loan || loan.stage !== 'adopted') return false;
  if (pendingReturn) dropReturn(pendingReturn);
  silence(player);
  loan.stage = 'returning';
  handedBack.add(player);
  const pending: VideoReturn = {
    player,
    key: returnKey(tileKey, url),
    claimed: false,
    drawn: false,
    reelGone: false,
    drawnListeners: new Set(),
    // No clock runs while the reel is up: a dismissal begun with a gesture hands
    // the player back as the gesture begins, and the finger decides how long
    // the reel stays half-shrunk over a tile that is drawing the clip for it.
    timeout: null,
    still: null,
  };
  if (still) {
    try {
      player.pause();
    } catch {
      // Already released, or its native side is gone.
    }
    pending.still = setTimeout(() => {
      pending.still = null;
      // A view given a player that stands still may report no frame at all,
      // and the frame was only ever waited on for the crossfade now over: a
      // tile that has the player, under no reel, carries on with it.
      if (pending.claimed && pending.reelGone) dropReturn(pending);
      else finishReturnIfSettled(pending);
    }, VIDEO_RETURN_STILL_MS);
  }
  pendingReturn = pending;
  notifyReturnListeners();
  return true;
}

export function subscribeToVideoReturns(listener: () => void) {
  returnListeners.add(listener);
  return () => {
    returnListeners.delete(listener);
  };
}

/** A hand-back to this tile and stream is under way, taken up or not. */
export function isVideoReturnPending(tileKey: string, url: string) {
  return pendingReturn?.key === returnKey(tileKey, url);
}

/** Stable identity for a receiving tile's external-store subscription. */
export function peekReturnedVideoPlayer(tileKey: string, url: string): VideoPlayer | null {
  return pendingReturn?.key === returnKey(tileKey, url) ? pendingReturn.player : null;
}

export function getReturningVideoPlayer(): VideoPlayer | null {
  return pendingReturn?.player ?? null;
}

/** The tile takes its player back: from here on it is the tile's, as before it was lent. */
export function claimReturnedVideoPlayer(tileKey: string, url: string): VideoPlayer | null {
  const pending = pendingReturn;
  if (!pending || pending.claimed || pending.key !== returnKey(tileKey, url)) return null;
  pending.claimed = true;
  loans.delete(pending.player);
  return pending.player;
}

/** The tile's own view has drawn the player it took back. */
export function reportReturnedVideoDrawn(player: VideoPlayer) {
  const pending = pendingReturn;
  if (!pending || pending.player !== player || pending.drawn) return;
  pending.drawn = true;
  const listeners = [...pending.drawnListeners];
  pending.drawnListeners.clear();
  listeners.forEach((listener) => listener());
  finishReturnIfSettled(pending);
}

/**
 * Runs `listener` once the tile has drawn `player` — at once if it already has,
 * or if there is no hand-back of it left to wait on.
 */
export function whenReturnedVideoDrawn(player: VideoPlayer, listener: () => void) {
  const pending = pendingReturn;
  if (!pending || pending.player !== player || pending.drawn) {
    listener();
    return () => {};
  }
  pending.drawnListeners.add(listener);
  return () => {
    pending.drawnListeners.delete(listener);
  };
}

/**
 * The reel that handed `player` back has gone. The hand-back ends once the tile
 * has taken the player and drawn it — a close may still be waiting on that — and
 * one still unsettled after `VIDEO_RETURN_TIMEOUT_MS` is dropped: released if
 * no tile took it, as a close may still have been drawing it until now.
 */
export function endVideoReturn(player: VideoPlayer) {
  const pending = pendingReturn;
  if (!pending || pending.player !== player) return;
  pending.reelGone = true;
  finishReturnIfSettled(pending);
  if (pendingReturn !== pending) return;
  if (pending.timeout) clearTimeout(pending.timeout);
  pending.timeout = setTimeout(() => dropReturn(pending), VIDEO_RETURN_TIMEOUT_MS);
}

export function isVideoPlayerHandedBack(player: VideoPlayer) {
  return handedBack.has(player);
}

/**
 * The reel takes back a player it handed to its tile, because the close that
 * began has been cancelled: a drag, pinch or edge swipe let go of before it
 * committed. The hand-back went out as the gesture began, so that the tile —
 * the view UIKit shrinks the reel into — would be drawing the clip carrying on
 * when UIKit crossfades to it. Undone here: the player is the reel's adopted
 * one again, and a tile that took it lets it go without pausing or releasing
 * it, the way a tile whose player is out on loan does. False when nothing was
 * handed back.
 */
export function reclaimVideoPlayer(player: VideoPlayer): boolean {
  const pending = pendingReturn;
  if (!pending || pending.player !== player) return false;
  if (pending.timeout) clearTimeout(pending.timeout);
  if (pending.still) clearTimeout(pending.still);
  pending.still = null;
  pendingReturn = null;
  handedBack.delete(player);
  loans.set(player, { stage: 'adopted', lenderMounted: false, giveBack: null, timeout: null });
  notifyReturnListeners();
  return true;
}

/** Test support: forgets every loan without touching the players. */
export function resetVideoPlayerLoans() {
  loans.forEach((loan) => {
    if (loan.timeout) clearTimeout(loan.timeout);
  });
  loans.clear();
  holds.forEach((hold) => clearTimeout(hold.timeout));
  holds.clear();
  if (pendingReturn?.timeout) clearTimeout(pendingReturn.timeout);
  if (pendingReturn?.still) clearTimeout(pendingReturn.still);
  pendingReturn = null;
  acceptors.clear();
}
