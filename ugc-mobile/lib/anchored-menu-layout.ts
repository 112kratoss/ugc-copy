/**
 * Where a menu sits beside the button that opened it, and the point it grows
 * from (`components/anchored-menu.tsx`). Pure arithmetic, so the rules are held
 * by a unit test: the panel never leaves the area it is given, it always spans
 * its button's centre, and its motion always starts at the button.
 */
export interface MenuRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The area a menu may cover: the screen less the system bars, the keyboard and a margin. */
export interface MenuBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AnchoredMenuPlacement {
  left: number;
  top: number;
  /** Below the button where it fits, as a pull-down opens; above it otherwise. */
  side: 'below' | 'above';
  /**
   * The point of the panel that stays still while it grows, in the panel's own
   * box: the part of it nearest the button's centre. A panel that had to cover
   * its button grows from the button itself.
   */
  origin: { x: number; y: number };
}

/** The space left between the button and its menu. */
export const MENU_ANCHOR_GAP = 4;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * `anchor`, `bounds` and the result share one coordinate space. `panel` is the
 * menu's laid-out size, already no taller or wider than `bounds` allows (the
 * surface caps both before it measures).
 */
export function placeAnchoredMenu({
  anchor,
  panel,
  bounds,
  gap = MENU_ANCHOR_GAP,
}: {
  anchor: MenuRect;
  panel: { width: number; height: number };
  bounds: MenuBounds;
  gap?: number;
}): AnchoredMenuPlacement {
  const anchorCentreX = anchor.x + anchor.width / 2;
  const anchorCentreY = anchor.y + anchor.height / 2;

  // A button on the right half of its area (most ••• today) shares its right
  // edge with the menu; one on the left shares its left edge.
  const onRightHalf = anchorCentreX > (bounds.left + bounds.right) / 2;
  const aligned = onRightHalf ? anchor.x + anchor.width - panel.width : anchor.x;
  const fits = aligned >= bounds.left && aligned + panel.width <= bounds.right;
  // Where that edge has no room the menu stays against its button's side of
  // the area. Sliding it back only as far as it had to go carried the menu of
  // a left-hand card (Explore's grid) across the screen, to hang under the
  // next card's ⋮ as though it were that card's.
  const left = clamp(
    fits ? aligned : onRightHalf ? bounds.right - panel.width : bounds.left,
    bounds.left,
    bounds.right - panel.width,
  );

  const roomBelow = bounds.bottom - (anchor.y + anchor.height + gap);
  const roomAbove = anchor.y - gap - bounds.top;
  const side = panel.height <= roomBelow || roomBelow >= roomAbove ? 'below' : 'above';
  // A menu too tall for the side it opens on slides back over its button
  // rather than off the screen, the way the system's menus do.
  const top = clamp(
    side === 'below' ? anchor.y + anchor.height + gap : anchor.y - gap - panel.height,
    bounds.top,
    bounds.bottom - panel.height,
  );

  return {
    left,
    top,
    side,
    origin: {
      x: clamp(anchorCentreX - left, 0, panel.width),
      y: clamp(anchorCentreY - top, 0, panel.height),
    },
  };
}
