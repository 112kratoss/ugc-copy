/** A stack navigator's state, as far as taking one of its routes out goes. */
export type ReelStackState = {
  key: string;
  index: number;
  routes: readonly { key: string }[];
};

/** A stack action addressed to one route of one stack (React Navigation's `source` and `target`). */
export type ReelStackAction =
  | { type: 'POP'; payload: { count: number }; source: string; target: string }
  | { type: 'REPLACE'; payload: { name: string; params: { screen: string } }; source: string; target: string };

export type ReelLeave =
  /** The reel is in front: back the usual way (`leaveViewer` in app/viewer.tsx). */
  | { kind: 'back' }
  /** The reel is under another screen: its own route is taken out by its key. */
  | { kind: 'dispatch'; action: ReelStackAction }
  /** The reel's route is no longer in the stack: nothing to take out. */
  | { kind: 'gone' };

/**
 * How a closing reel takes its own route away.
 *
 * An Android close keeps the reel's route until the picture has landed in its
 * tile, up to half a second after Back (`useMediaZoomStage`), and a screen can
 * be pushed in that time: a forced sign-in, a notification opened. Going back
 * then popped that screen instead, and left the reel in front, out of sight
 * and taking every touch (review of #947). So a reel that is no longer on top
 * is taken out by its key (`POP` with `source`, which StackRouter removes
 * wherever it stands, keeping the screens above it), and a first-screen reel,
 * which has nothing beneath to go back to, gives its place to Explore as its
 * own Back does. In front, it goes back as it always has.
 */
export function reelLeaveFor(state: ReelStackState | undefined, routeKey: string): ReelLeave {
  if (!state) return { kind: 'back' };
  const index = state.routes.findIndex((route) => route.key === routeKey);
  if (index < 0) return { kind: 'gone' };
  if (index === state.index) return { kind: 'back' };
  if (index > 0) {
    return { kind: 'dispatch', action: { type: 'POP', payload: { count: 1 }, source: routeKey, target: state.key } };
  }
  return {
    kind: 'dispatch',
    action: { type: 'REPLACE', payload: { name: '(tabs)', params: { screen: 'showcase' } }, source: routeKey, target: state.key },
  };
}
