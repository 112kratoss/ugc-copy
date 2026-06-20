import { EDGE_SWIPE_START_WIDTH, isLeftEdgeOpenSwipe } from './edge-swipe-menu';

export interface WorkspaceSideMenuTouchPoint {
  x: number;
  y: number;
}

export interface WorkspaceSideMenuGestureState {
  edgeWidth?: number;
  enabled?: boolean;
  menuVisible?: boolean;
  start: WorkspaceSideMenuTouchPoint | null;
  end: WorkspaceSideMenuTouchPoint | null;
}

export interface WorkspaceSideMenuTouchStartState {
  edgeWidth?: number;
  enabled?: boolean;
  menuVisible?: boolean;
  start: WorkspaceSideMenuTouchPoint | null;
  topOffset?: number;
}

export function shouldTrackWorkspaceSideMenuTouchStart({
  edgeWidth = EDGE_SWIPE_START_WIDTH,
  enabled = true,
  menuVisible = false,
  start,
  topOffset = 0,
}: WorkspaceSideMenuTouchStartState) {
  if (!enabled || menuVisible || !start) {
    return false;
  }

  if (start.y < topOffset) {
    return false;
  }

  return start.x <= edgeWidth;
}

export function shouldOpenWorkspaceSideMenu({
  edgeWidth,
  enabled = true,
  menuVisible = false,
  start,
  end,
}: WorkspaceSideMenuGestureState) {
  if (!enabled || menuVisible || !start || !end) {
    return false;
  }

  return isLeftEdgeOpenSwipe({
    edgeWidth,
    x0: start.x,
    dx: end.x - start.x,
    dy: end.y - start.y,
  });
}
