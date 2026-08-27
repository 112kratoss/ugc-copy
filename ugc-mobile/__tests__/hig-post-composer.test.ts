import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  COMPOSER_UNDO_WINDOW_MS,
  describeComposerUndo,
  describeComposerUndoAction,
} from '../lib/composer-undo';
import {
  MEDIA_CARD_GAP,
  MEDIA_CARD_STEP,
  MEDIA_CARD_WIDTH,
  MEDIA_DRAG_EDGE_ZONE,
  MEDIA_DRAG_SCROLL_STEP,
  MEDIA_MAX_ITEMS,
  clampMediaIndex,
  describeDropTarget,
  resolveAutoScrollStep,
  resolveDropIndex,
  resolveNeighbourShift,
  resolveRowContentWidth,
} from '../lib/media-reorder';

/**
 * S11's rules, in the form a suite can hold. Sources: Drag and drop, Undo and
 * redo, Entering data — plus the iOS 26 gesture finding the unit turned up,
 * which is a navigator option rather than a chapter rule but is the reason half
 * the reorder existed only on paper.
 */

const mobileRoot = path.resolve(__dirname, '..');
const read = (name: string) => readFileSync(path.join(mobileRoot, name), 'utf8');

const composer = read('app/post/new.tsx');
const layout = read('app/_layout.tsx');

/** The composer is 5,000 lines; slice a declaration rather than matching across the file. */
function declaration(source: string, header: string) {
  const start = source.indexOf(header);
  expect(start, `missing declaration: ${header}`).toBeGreaterThan(-1);
  const next = source.indexOf('\nfunction ', start + header.length);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('S11 — the reorder can finish', () => {
  /**
   * The unit's violation: iOS 26 turned the navigator's back gesture into a
   * full-screen pan (`fullScreenGestureEnabled` defaults to true from that OS).
   * A native recognizer outranks the JS responder the reorder runs on, so a
   * rightward drag popped the composer after one pan frame. Verified on iOS
   * 26.4: `gestureEnabled: false` does *not* cover it — only this option does.
   */
  it('turns the full-screen back gesture off on the composer route', () => {
    const route = layout.slice(layout.indexOf('name="post/new"'));
    const options = route.slice(0, route.indexOf('/>'));
    expect(options).toContain('fullScreenGestureEnabled: false');
  });

  it('keeps the edge swipe, so the screen still has a gesture out', () => {
    const route = layout.slice(layout.indexOf('name="post/new"'));
    expect(route.slice(0, route.indexOf('/>'))).not.toContain('gestureEnabled: false');
  });

  it('leaves every other route on the platform default', () => {
    expect(layout.match(/fullScreenGestureEnabled:/g)).toHaveLength(1);
  });
});

describe('S11 — the drop is predictable', () => {
  // Drag and drop: "show people whether a destination can accept dragged
  // content ... display an insertion point or highlight a containing view."
  it('moves every card between the origin and the destination, and no others', () => {
    // Dragging card 0 rightwards to slot 3: 1, 2 and 3 step left, 4 holds.
    expect(resolveNeighbourShift(1, 0, 3)).toBe(-MEDIA_CARD_STEP);
    expect(resolveNeighbourShift(3, 0, 3)).toBe(-MEDIA_CARD_STEP);
    expect(resolveNeighbourShift(4, 0, 3)).toBe(0);
    // Dragging card 4 leftwards to slot 1: 1, 2 and 3 step right, 0 holds.
    expect(resolveNeighbourShift(1, 4, 1)).toBe(MEDIA_CARD_STEP);
    expect(resolveNeighbourShift(3, 4, 1)).toBe(MEDIA_CARD_STEP);
    expect(resolveNeighbourShift(0, 4, 1)).toBe(0);
  });

  it('never shifts the card being dragged, or anything when it has not moved', () => {
    expect(resolveNeighbourShift(2, 2, 4)).toBe(0);
    for (let index = 0; index < MEDIA_MAX_ITEMS; index += 1) {
      expect(resolveNeighbourShift(index, 2, 2)).toBe(0);
    }
  });

  // Rounding, not flooring: a card takes the next slot once it has covered half
  // of it, which is the moment the preview under the finger should flip.
  it('takes a slot at the halfway mark', () => {
    expect(resolveDropIndex(0, 5)).toBe(0);
    expect(resolveDropIndex(MEDIA_CARD_STEP * 0.49, 5)).toBe(0);
    expect(resolveDropIndex(MEDIA_CARD_STEP * 0.51, 5)).toBe(1);
    expect(resolveDropIndex(MEDIA_CARD_STEP * 3, 5)).toBe(3);
  });

  it('cannot drop outside the row', () => {
    expect(resolveDropIndex(-900, 5)).toBe(0);
    expect(resolveDropIndex(MEDIA_CARD_STEP * 99, 5)).toBe(4);
    expect(clampMediaIndex(7, 3)).toBe(2);
    expect(clampMediaIndex(-7, 3)).toBe(0);
    expect(clampMediaIndex(1, 0)).toBe(0);
  });
});

describe('S11 — every slot is reachable', () => {
  /**
   * Before this unit the drag was pure finger travel: one slot cost
   * MEDIA_CARD_STEP points, and a phone gives about 370. Reaching slot 4 from
   * slot 0 needs 568, so the far end of a full row could not be reached at all.
   * Drag and drop: "scroll the contents of a destination when necessary."
   */
  it('needs more travel than a phone has, which is why the row scrolls itself', () => {
    const travelForAFullRow = (MEDIA_MAX_ITEMS - 1) * MEDIA_CARD_STEP;
    expect(travelForAFullRow).toBeGreaterThan(402);
  });

  it('walks the row along while the finger is held at either edge', () => {
    const row = { rowWidth: 360, maxScrollX: 400 };
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 10, scrollX: 200 }))
      .toBe(-MEDIA_DRAG_SCROLL_STEP);
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 355, scrollX: 200 }))
      .toBe(MEDIA_DRAG_SCROLL_STEP);
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 180, scrollX: 200 })).toBe(0);
  });

  it('stops at each end rather than fighting the bounce', () => {
    const row = { rowWidth: 360, maxScrollX: 400 };
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 10, scrollX: 0 })).toBe(0);
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 355, scrollX: 400 })).toBe(0);
    // The last tick lands exactly on the end instead of overshooting it.
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 355, scrollX: 397 })).toBe(3);
    expect(resolveAutoScrollStep({ ...row, pointerViewportX: 10, scrollX: 4 })).toBe(-4);
  });

  it('does not scroll a row that fits', () => {
    expect(resolveAutoScrollStep({ pointerViewportX: 5, rowWidth: 360, scrollX: 0, maxScrollX: 0 }))
      .toBe(0);
    expect(resolveAutoScrollStep({ pointerViewportX: 5, rowWidth: 0, scrollX: 0, maxScrollX: 400 }))
      .toBe(0);
  });

  it('measures the row the way the row is laid out', () => {
    expect(MEDIA_CARD_STEP).toBe(MEDIA_CARD_WIDTH + MEDIA_CARD_GAP);
    expect(resolveRowContentWidth(3, false)).toBe(3 * MEDIA_CARD_STEP - MEDIA_CARD_GAP);
    expect(resolveRowContentWidth(3, true)).toBe(4 * MEDIA_CARD_STEP - MEDIA_CARD_GAP);
    expect(resolveRowContentWidth(0, false)).toBe(0);
    // The edge zone has to be smaller than a card, or a card-sized drop target
    // would auto-scroll on contact.
    expect(MEDIA_DRAG_EDGE_ZONE).toBeLessThan(MEDIA_CARD_WIDTH);
  });

  it('carries the row geometry in one place', () => {
    expect(composer).toContain("from '@/lib/media-reorder'");
    // The row's gap and the step arithmetic must agree, or the drop index lands
    // a card off partway down the row.
    expect(composer).toContain('contentContainerStyle={{ gap: MEDIA_CARD_GAP }}');
    expect(composer).not.toMatch(/const MEDIA_CARD_(WIDTH|GAP|STEP)\s*=/);
  });
});

describe('S11 — the row, not the card, runs the drag', () => {
  const row = declaration(composer, 'function UploadContent({');
  const card = declaration(composer, 'function MediaGalleryCard({');

  it('scrolls the row from the drag, with the user scroller switched off', () => {
    expect(row).toContain('scrollEnabled={drag === null}');
    expect(row).toContain('rowRef.current?.scrollTo({ x: scrollXRef.current, animated: false })');
    expect(row).toContain('onLayout={(event) => { rowWidthRef.current = event.nativeEvent.layout.width; }}');
  });

  it('reads the landing slot from the drag rather than from render state', () => {
    expect(row).toContain('const { to } = readDragGeometry(active);');
    expect(row).toContain('if (to !== active.from) latestRef.current.onReorderMedia(active.id, to);');
  });

  it('lets go of the auto-scroll on unmount', () => {
    expect(row).toContain('useEffect(() => stopAutoScroll, [stopAutoScroll]);');
  });

  it('shifts the neighbours and rides the dragged card on the finger', () => {
    expect(card).toContain('const isDragging = drag?.id === item.id;');
    expect(card).toContain('? resolveNeighbourShift(index, drag.from, drag.to)');
    expect(card).toContain('transform: [{ translateX }],');
  });

  // Drag and drop asks for feedback "throughout" the drag; a shift a screen
  // reader cannot see is no feedback at all.
  it('announces the slot under the card while it is held', () => {
    expect(card).toContain('? { text: describeDropTarget(drag.to, totalItems) }');
    expect(describeDropTarget(0, 5)).toBe('Drop as cover, 1 of 5');
    expect(describeDropTarget(3, 5)).toBe('Drop at position 4 of 5');
  });

  it('renames the card to the slot it would take', () => {
    expect(card).toContain('{isDragging ? getComposerMediaLabel(drag.to) : label}');
  });

  // Drag and drop: "offer alternative ways to accomplish drag-and-drop actions
  // ... use accessibility APIs to identify sources and destinations."
  it('keeps a keyboard-and-screen-reader route that needs no drag at all', () => {
    expect(card).toContain("{ name: 'decrement', label: 'Move left' }");
    expect(card).toContain("{ name: 'increment', label: 'Move right' }");
    expect(card).toContain('onReorderMedia(item.id, index - 1)');
    expect(card).toContain('onReorderMedia(item.id, index + 1)');
  });

  it('names every card, whether or not it can be dragged', () => {
    expect(card).toContain('accessibilityLabel={`${label}, ${index + 1} of ${totalItems}`}');
  });

  it('still refuses the gesture until the hold completes', () => {
    expect(card).toContain('onStartShouldSetPanResponder: () => false');
    expect(card).toContain('onMoveShouldSetPanResponder: () => isDragArmedRef.current');
    expect(card).toContain('MEDIA_DRAG_HOLD_MS');
  });
});

describe('S11 — a removal can be taken back', () => {
  const undoBar = declaration(composer, 'function ComposerUndoBar({');

  // Undo and redo: "help people predict the results of undo ... modify the
  // labels to identify the result."
  it('names what comes back, in both the title and the control', () => {
    expect(describeComposerUndo('Cover')).toBe('Removed Cover');
    expect(describeComposerUndoAction('Media 2')).toBe('Undo removing Media 2');
    expect(undoBar).toContain('{describeComposerUndo(entry.label)}');
    expect(undoBar).toContain('accessibilityLabel={describeComposerUndoAction(entry.label)}');
  });

  // "Provide undo and redo buttons only when necessary" — so the offer is not
  // permanent chrome; it exists only while there is something to undo.
  it('renders nothing when there is nothing to put back', () => {
    expect(undoBar).toContain('if (!entry) return null;');
    expect(COMPOSER_UNDO_WINDOW_MS).toBeGreaterThan(4000);
  });

  it('sits above the footer rather than in the scroll it would ride away with', () => {
    const barMount = composer.indexOf('<ComposerUndoBar');
    expect(barMount).toBeGreaterThan(-1);
    // Outside the form's ScrollView, and ahead of the footer.
    const formCloses = composer.lastIndexOf('</ScrollView>', barMount);
    expect(formCloses).toBeGreaterThan(-1);
    expect(composer.slice(formCloses, barMount)).not.toContain('<ScrollView');
    expect(composer.indexOf('<PostComposerFooter', barMount)).toBeGreaterThan(barMount);
  });

  // The consistency rule: a reversal offered on one control and not the next is
  // a bug, not a choice. Every removal that edits the draft records one.
  it('is offered by every removal that edits the draft', () => {
    for (const handler of ['removeMediaItem', 'removeMadeWithRow', 'removeResourceCard']) {
      const body = composer.slice(composer.indexOf(`const ${handler} = (`));
      expect(body.slice(0, body.indexOf('\n  };')), handler).toContain('offerUndo(');
    }
  });

  it('names the media by the label the row already gives it', () => {
    expect(composer).toContain("offerUndo(index >= 0 ? getComposerMediaLabel(index) : 'media');");
  });

  // Undo and redo: "it's crucial to highlight the result of each undo ... to
  // keep people from thinking that the action had no effect."
  it('returns to where the removal happened, so the result is on screen', () => {
    expect(composer).toContain('setUndoEntry({ label, snapshot: draft, scrollY: scrollYRef.current });');
    expect(composer).toContain('scrollRef.current?.scrollTo({ y: scrollY, animated: true });');
    expect(composer).toContain('onScroll={(event) => { scrollYRef.current = event.nativeEvent.contentOffset.y; }}');
  });

  it('drops the offer when it is taken, dismissed, or the screen goes', () => {
    expect(composer).toContain('const dismissUndo = () => {');
    expect(composer).toContain('accessibilityLabel="Dismiss undo"');
    expect(composer).toContain('if (undoTimerRef.current) clearTimeout(undoTimerRef.current);');
  });
});
