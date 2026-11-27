/**
 * When the loading sketches' one shared clock runs (`components/media-sketch.tsx`):
 * while a sketch is on screen, and never while a list is moving under it.
 *
 * Each frame of a running clock redraws every sketch's strokes, and on Android
 * react-native-svg draws an SVG view into a new software bitmap at each change
 * (`SvgView.onDraw` → `drawOutput`, react-native-svg 15), which the render
 * thread then uploads: a raster, an allocation and a texture upload per
 * sketch per frame. A grid scrolled over pictures still on their way has a
 * sketch on most of its tiles, so that cost lands exactly on the frames of the
 * fling (feel audit 2026-11-27: 70 slow bitmap uploads and 12.6% janky frames
 * on the first pass over the S24's profile grid, 7 and 2.2% once its pictures
 * were cached, when no sketch shows). Held, the clock stops where it is and no
 * sketch changes; let go, it starts a new drawing from the beginning.
 *
 * Pure: the clock's motion is handed in (`start`, `stop`), so the rule can be
 * tested without Reanimated.
 */
export function createSketchClock(drive: { start: () => void; stop: () => void }) {
  let sketches = 0;
  let holds = 0;
  let running = false;

  const sync = () => {
    const shouldRun = sketches > 0 && holds === 0;
    if (shouldRun === running) return;
    running = shouldRun;
    if (shouldRun) drive.start();
    else drive.stop();
  };

  /** A count that `release` takes back once, however often it is called. */
  const counted = (add: (by: number) => void) => {
    add(1);
    sync();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      add(-1);
      sync();
    };
  };

  return {
    /** A sketch mounted; the returned function is its unmount. */
    retain: () => counted((by) => { sketches = Math.max(0, sketches + by); }),
    /** A list started moving; the returned function is it coming to rest. */
    hold: () => counted((by) => { holds = Math.max(0, holds + by); }),
    isRunning: () => running,
  };
}

export type ListMotionEvent = 'dragBegin' | 'dragEnd' | 'momentumBegin' | 'momentumEnd';

/**
 * Whether one list is moving, from its scroll view's drag and momentum events:
 * from a drag's start until the momentum that follows it ends. A drag let go at
 * rest is followed by no momentum on iOS, so it rests `settleMs` after the drag
 * ends unless momentum begins meanwhile; Android sends a momentum pair after
 * every drag. A finger put down on a list still coasting keeps it moving.
 */
export function createListMotion({
  settleMs,
  onMove,
  onRest,
  schedule,
}: {
  settleMs: number;
  onMove: () => void;
  onRest: () => void;
  /** Runs `run` after `ms`; returns its cancel. */
  schedule: (run: () => void, ms: number) => () => void;
}) {
  let moving = false;
  let cancelSettle: (() => void) | null = null;

  const clearSettle = () => {
    cancelSettle?.();
    cancelSettle = null;
  };
  const move = () => {
    clearSettle();
    if (moving) return;
    moving = true;
    onMove();
  };
  const rest = () => {
    clearSettle();
    if (!moving) return;
    moving = false;
    onRest();
  };

  return {
    report(event: ListMotionEvent) {
      if (event === 'dragBegin' || event === 'momentumBegin') move();
      else if (event === 'momentumEnd') rest();
      else if (moving) {
        clearSettle();
        cancelSettle = schedule(rest, settleMs);
      }
    },
    /** The list going away: it rests, whatever it was doing. */
    dispose: rest,
  };
}
