import { describe, expect, it } from 'vitest';

import { shouldOpenWorkspaceSideMenu } from '../lib/workspace-side-menu-gesture';

describe('shouldOpenWorkspaceSideMenu', () => {
  it('opens for a rightward swipe from the workspace edge', () => {
    expect(shouldOpenWorkspaceSideMenu({
      start: { x: 32, y: 420 },
      end: { x: 112, y: 430 },
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
});
