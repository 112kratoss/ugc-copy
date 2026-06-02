import { isLeftEdgeOpenSwipe } from './edge-swipe-menu';

export interface WorkspaceSideMenuTouchPoint {
  x: number;
  y: number;
}

export interface WorkspaceSideMenuGestureState {
  enabled?: boolean;
  menuVisible?: boolean;
  start: WorkspaceSideMenuTouchPoint | null;
  end: WorkspaceSideMenuTouchPoint | null;
}

export function shouldOpenWorkspaceSideMenu({
  enabled = true,
  menuVisible = false,
  start,
  end,
}: WorkspaceSideMenuGestureState) {
  if (!enabled || menuVisible || !start || !end) {
    return false;
  }

  return isLeftEdgeOpenSwipe({
    x0: start.x,
    dx: end.x - start.x,
    dy: end.y - start.y,
  });
}
