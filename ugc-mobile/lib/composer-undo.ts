/**
 * The post composer's single-step undo for destructive draft edits.
 *
 * Undo and redo opens on the reason: reversing an action "can also help people
 * explore and experiment safely". Every removal in the composer — a media card,
 * a resource card, a made-with row — used to be instant and final, and the
 * media one costs the most: the file is already uploaded by the time its card
 * appears, and removing it also strips that media from any resource card it was
 * attached to. Re-picking cannot bring those links back.
 *
 * The chapter's own guidance shapes what this is and is not:
 *
 * - *"Provide undo and redo buttons only when necessary"* — so there is no
 *   permanent toolbar pair. A control appears only after something was removed,
 *   and only for as long as the offer stands.
 * - *"Help people predict the results of undo"* — so the offer names what comes
 *   back (`Removed Cover`), rather than saying `Undone` after the fact.
 * - *"Show the results of an undo"* — so the entry carries the scroll position
 *   the removal happened at, and undoing returns there. A restored card that
 *   comes back off-screen reads as an undo that did nothing.
 * - *"Let people undo multiple times"* is the one rule this deliberately does
 *   not meet; see `COMPOSER_UNDO_WINDOW_MS`.
 */

/**
 * How long the offer stands. A draft-wide snapshot cannot be stacked safely —
 * the composer's uploads, resource-editor state and publish mutation all run
 * against the live draft, so a snapshot only stays truthful while the screen is
 * otherwise idle. One step, offered briefly, is the reversal that can be kept
 * honest; a real undo stack is a draft-model change, not a screen change.
 */
export const COMPOSER_UNDO_WINDOW_MS = 8000;

export interface ComposerUndoEntry<TDraft> {
  /** What was removed, in the words the surface already uses for it ("Cover", "Media 2"). */
  label: string;
  /** The whole draft as it stood immediately before the removal. */
  snapshot: TDraft;
  /** Where the composer was scrolled when it happened, so the result of the undo is visible. */
  scrollY: number;
}

/** The offer's title: what will come back, not what just happened. */
export function describeComposerUndo(label: string): string {
  return `Removed ${label}`;
}

/** The control's accessibility label — Undo and redo asks that it name its result. */
export function describeComposerUndoAction(label: string): string {
  return `Undo removing ${label}`;
}
