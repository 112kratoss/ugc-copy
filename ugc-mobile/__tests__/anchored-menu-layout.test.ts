import { describe, expect, it } from 'vitest';

import { MENU_ANCHOR_GAP, placeAnchoredMenu, type MenuRect } from '../lib/anchored-menu-layout';

// A Pixel 9a in dp (411 x 923), less its status bar (55), its navigation bar
// (24) and the menu's 8dp margin.
const bounds = { left: 8, top: 63, right: 403, bottom: 891 };

function button(x: number, y: number): MenuRect {
  return { x, y, width: 48, height: 48 };
}

describe('where a menu sits beside its button', () => {
  it('opens under a button on the right, sharing its right edge, and grows from the corner nearest it', () => {
    const placement = placeAnchoredMenu({ anchor: button(355, 208), panel: { width: 248, height: 240 }, bounds });

    expect(placement).toEqual({
      left: 155,
      top: 208 + 48 + MENU_ANCHOR_GAP,
      side: 'below',
      // Under the button's centre, on the panel's top edge.
      origin: { x: 224, y: 0 },
    });
  });

  it('shares its left edge with a button on the left half of the screen', () => {
    const placement = placeAnchoredMenu({ anchor: button(8, 208), panel: { width: 248, height: 240 }, bounds });

    expect(placement.left).toBe(8);
    expect(placement.origin).toEqual({ x: 24, y: 0 });
  });

  it('opens above a button near the foot of the screen, and grows up from it', () => {
    const placement = placeAnchoredMenu({ anchor: button(355, 800), panel: { width: 248, height: 160 }, bounds });

    expect(placement.side).toBe('above');
    expect(placement.top).toBe(800 - MENU_ANCHOR_GAP - 160);
    expect(placement.origin).toEqual({ x: 224, y: 160 });
  });

  it('slides back over its button when it fits on neither side, and grows from the button itself', () => {
    const anchor = button(355, 500);
    const placement = placeAnchoredMenu({ anchor, panel: { width: 248, height: 700 }, bounds });

    // More room above (433) than below (339), and neither is enough.
    expect(placement.side).toBe('above');
    expect(placement.top).toBe(bounds.top);
    expect(placement.top + 700).toBeLessThanOrEqual(bounds.bottom);
    // The button's centre, inside the panel that now covers it.
    expect(placement.origin).toEqual({ x: 224, y: 500 + 24 - bounds.top });
  });

  it('keeps a panel as large as its area against the top left of it', () => {
    const panel = { width: bounds.right - bounds.left, height: bounds.bottom - bounds.top };
    const placement = placeAnchoredMenu({ anchor: button(355, 500), panel, bounds });

    expect(placement.left).toBe(bounds.left);
    expect(placement.top).toBe(bounds.top);
  });

  it('never leaves the area it was given, wherever the button is', () => {
    const escaped: string[] = [];
    for (const panel of [{ width: 248, height: 120 }, { width: 300, height: 480 }, { width: 395, height: 828 }]) {
      // From off the top left to off the bottom right, in steps of a button.
      for (let x = -48; x <= 411; x += 51) {
        for (let y = -48; y <= 923; y += 49) {
          const { left, top, origin } = placeAnchoredMenu({ anchor: button(x, y), panel, bounds });
          const inside = left >= bounds.left
            && left + panel.width <= bounds.right
            && top >= bounds.top
            && top + panel.height <= bounds.bottom
            && origin.x >= 0 && origin.x <= panel.width
            && origin.y >= 0 && origin.y <= panel.height;
          if (!inside) escaped.push(`${panel.width}x${panel.height} at ${x},${y}`);
        }
      }
    }
    expect(escaped).toEqual([]);
  });
});
