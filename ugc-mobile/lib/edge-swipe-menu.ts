export const EDGE_SWIPE_START_WIDTH = 24;
export const EDGE_SWIPE_OPEN_DISTANCE = 54;
export const EDGE_SWIPE_MAX_VERTICAL_DRIFT = 44;

export interface EdgeSwipeGesture {
  dx: number;
  dy: number;
  edgeWidth?: number;
  x0: number;
}

export function isLeftEdgeOpenSwipe(gesture: EdgeSwipeGesture) {
  if (gesture.x0 > (gesture.edgeWidth ?? EDGE_SWIPE_START_WIDTH)) return false;
  if (gesture.dx < EDGE_SWIPE_OPEN_DISTANCE) return false;
  if (Math.abs(gesture.dy) > EDGE_SWIPE_MAX_VERTICAL_DRIFT) return false;
  return Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4;
}
