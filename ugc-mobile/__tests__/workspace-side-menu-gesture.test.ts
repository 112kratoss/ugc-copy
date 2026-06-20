import { describe, expect, it } from 'vitest';

import {
  shouldOpenWorkspaceSideMenu,
  shouldTrackWorkspaceSideMenuTouchStart,
} from '../lib/workspace-side-menu-gesture';

describe('shouldOpenWorkspaceSideMenu', () => {
  it('opens for a rightward swipe from the workspace edge', () => {
    expect(shouldOpenWorkspaceSideMenu({
      start: { x: 16, y: 420 },
      end: { x: 96, y: 430 },
    })).toBe(true);
  });

  it('does not open when disabled or already visible', () => {
    expect(shouldOpenWorkspaceSideMenu({
      enabled: false,
      start: { x: 32, y: 420 },
      end: { x: 112, y: 430 },
    })).toBe(false);

    expect(shouldOpenWorkspaceSideMenu({
      menuVisible: true,
      start: { x: 32, y: 420 },
      end: { x: 112, y: 430 },
    })).toBe(false);
  });

  it('ignores missing touches and vertical scrolling', () => {
    expect(shouldOpenWorkspaceSideMenu({
      start: null,
      end: { x: 112, y: 430 },
    })).toBe(false);

    expect(shouldOpenWorkspaceSideMenu({
      start: { x: 32, y: 420 },
      end: { x: 86, y: 498 },
    })).toBe(false);
  });

  it('ignores swipes that start where left-padded feed controls are tapped', () => {
    expect(shouldOpenWorkspaceSideMenu({
      start: { x: 32, y: 196 },
      end: { x: 112, y: 204 },
    })).toBe(false);
  });

  it('only tracks menu touches that begin inside the edge swipe zone', () => {
    expect(shouldTrackWorkspaceSideMenuTouchStart({
      start: { x: 16, y: 196 },
    })).toBe(true);

    expect(shouldTrackWorkspaceSideMenuTouchStart({
      start: { x: 32, y: 196 },
    })).toBe(false);

    expect(shouldTrackWorkspaceSideMenuTouchStart({
      enabled: false,
      start: { x: 16, y: 196 },
    })).toBe(false);
  });
});
