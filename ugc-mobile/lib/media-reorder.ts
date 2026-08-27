/**
 * Geometry for the post composer's media reorder row.
 *
 * Drag and drop asks a reorder for two things this row cannot inherit from a
 * plain `ScrollView`: continuous feedback that shows where the card will land
 * ("show people whether a destination can accept dragged content ... display an
 * insertion point or highlight a containing view"), and a destination that
 * comes to the finger when it is off-screen ("scroll the contents of a
 * destination when necessary"). Both are arithmetic over a fixed card grid, so
 * they live here where a test can reach them without a simulator.
 *
 * The card grid is uniform: card `i` starts at `i * MEDIA_CARD_STEP` in the
 * row's content space, which is what lets every function below work from an
 * index and a single x rather than from measured layout.
 */

/** How many media a post can carry. The row's copy, its slot count and the picker all read it from here. */
export const MEDIA_MAX_ITEMS = 5;

export const MEDIA_CARD_WIDTH = 132;
export const MEDIA_CARD_GAP = 10;
export const MEDIA_CARD_STEP = MEDIA_CARD_WIDTH + MEDIA_CARD_GAP;

/** How long a finger rests on a card before it is picked up rather than scrolling the row. */
export const MEDIA_DRAG_HOLD_MS = 300;
/** Travel that turns a pending pick-up back into a scroll. */
export const MEDIA_DRAG_SLOP = 8;

/** How close to the row's edge the finger has to be before the row scrolls itself. */
export const MEDIA_DRAG_EDGE_ZONE = 56;
/**
 * Points per tick while auto-scrolling. At a 16ms tick this is ~375pt/s, so a
 * full row of five passes under the finger in about a second — fast enough to
 * reach the far slot, slow enough to stop on the one you meant. 12 was tried
 * first and read as a lurch: it crossed two cards before the finger lifted.
 */
export const MEDIA_DRAG_SCROLL_STEP = 6;
export const MEDIA_DRAG_SCROLL_INTERVAL_MS = 16;

export function clampMediaIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(Math.round(index), itemCount - 1));
}

/**
 * The slot a card would land in, from where its leading edge currently sits in
 * the row's content space. Rounding — rather than flooring — means a card takes
 * a slot once it has covered half of it, which is what makes the shift preview
 * flip under the finger at the moment the drop would change.
 */
export function resolveDropIndex(cardContentX: number, itemCount: number): number {
  return clampMediaIndex(cardContentX / MEDIA_CARD_STEP, itemCount);
}

/**
 * How far a card that is *not* being dragged has to move so the row reads as
 * the order it would become. Every card between the origin and the destination
 * steps one slot towards the gap the dragged card left behind; everything
 * outside that span holds still.
 */
export function resolveNeighbourShift(index: number, from: number, to: number): number {
  if (index === from || from === to) return 0;
  if (to > from) return index > from && index <= to ? -MEDIA_CARD_STEP : 0;
  return index >= to && index < from ? MEDIA_CARD_STEP : 0;
}

/**
 * The scroll delta to apply this tick, or 0 to stay put. Held near an edge with
 * content still to reveal, the row walks itself along; at either end it stops
 * rather than fighting the bounce.
 */
export function resolveAutoScrollStep({
  pointerViewportX,
  rowWidth,
  scrollX,
  maxScrollX,
}: {
  pointerViewportX: number;
  rowWidth: number;
  scrollX: number;
  maxScrollX: number;
}): number {
  if (rowWidth <= 0 || maxScrollX <= 0) return 0;
  if (pointerViewportX < MEDIA_DRAG_EDGE_ZONE) {
    const room = Math.min(MEDIA_DRAG_SCROLL_STEP, Math.max(0, scrollX));
    return room === 0 ? 0 : -room;
  }
  if (pointerViewportX > rowWidth - MEDIA_DRAG_EDGE_ZONE) {
    return Math.min(MEDIA_DRAG_SCROLL_STEP, Math.max(0, maxScrollX - scrollX));
  }
  return 0;
}

/** Content width of a row of `itemCount` cards, plus the add-card slot when it is shown. */
export function resolveRowContentWidth(itemCount: number, hasAddCard: boolean): number {
  const cards = itemCount + (hasAddCard ? 1 : 0);
  if (cards <= 0) return 0;
  return cards * MEDIA_CARD_STEP - MEDIA_CARD_GAP;
}

/**
 * What a screen reader is told while a card is held over a slot. Drag and drop
 * asks for feedback "throughout" the drag, and a shift the reader cannot see is
 * no feedback at all.
 */
export function describeDropTarget(to: number, itemCount: number): string {
  return to === 0 ? `Drop as cover, 1 of ${itemCount}` : `Drop at position ${to + 1} of ${itemCount}`;
}
