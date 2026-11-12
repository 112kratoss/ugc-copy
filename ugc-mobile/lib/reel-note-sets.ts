/**
 * Notes in the reel (owner, 2026-11-12). A post of writing used to take a
 * whole reel page each: a small card on a black screen between two videos.
 * The reel now gathers the notes near each other in a lane into one page, a
 * sideways row of cards, and the pictures and videos carry on above and below.
 *
 * The rule, on the lane's own order:
 * - a set starts at a note and takes the notes that follow within the next
 *   `window` posts, `maxNotes` in all, in the order the lane gave them;
 * - a note past that starts the next set where it stands;
 * - the post the reel was opened on always starts a set, so it is the card in
 *   front and the page the reel lands on.
 *
 * It only ever looks forward from a note, so posts a later page appends can
 * add a card to the last set but never move a page the reader has passed.
 */
export const REEL_NOTE_SET_MAX_NOTES = 5;
export const REEL_NOTE_SET_WINDOW = 10;

export interface ReelNoteSet<T> {
  /** The first note's id: the set's name for as long as that note is in the reel. */
  key: string;
  notes: T[];
}

export type ReelPage<T> =
  | { kind: 'post'; item: T }
  | { kind: 'notes'; set: ReelNoteSet<T> };

export function clubReelNotes<T extends { id: string }>(
  items: readonly T[],
  {
    isNote,
    anchorId = null,
    maxNotes = REEL_NOTE_SET_MAX_NOTES,
    window = REEL_NOTE_SET_WINDOW,
  }: {
    isNote: (item: T) => boolean;
    /** The post the reel was opened on. */
    anchorId?: string | null;
    maxNotes?: number;
    window?: number;
  },
): ReelPage<T>[] {
  const pages: ReelPage<T>[] = [];
  const taken = new Set<number>();

  for (let index = 0; index < items.length; index += 1) {
    if (taken.has(index)) continue;
    const item = items[index];
    if (!isNote(item)) {
      pages.push({ kind: 'post', item });
      continue;
    }

    const notes = [item];
    const last = Math.min(items.length - 1, index + window);
    for (let next = index + 1; next <= last && notes.length < maxNotes; next += 1) {
      const candidate = items[next];
      if (taken.has(next) || !isNote(candidate)) continue;
      // The opened post leads its own set; it is never a later card of this one.
      if (candidate.id === anchorId) break;
      notes.push(candidate);
      taken.add(next);
    }
    pages.push({ kind: 'notes', set: { key: item.id, notes } });
  }

  return pages;
}

/**
 * The card a set shows in front: the one the reader left it on, else its
 * first. A note the reader removed, or one a refresh dropped, falls back to
 * the first too.
 */
export function frontNoteOfSet<T extends { id: string }>(set: ReelNoteSet<T>, frontNoteId: string | null | undefined): T {
  return set.notes.find((note) => note.id === frontNoteId) ?? set.notes[0];
}

/** Which card a sideways scroll has settled on. */
export function noteIndexAtOffset(offsetX: number, interval: number, count: number) {
  if (interval <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(offsetX / interval)));
}
