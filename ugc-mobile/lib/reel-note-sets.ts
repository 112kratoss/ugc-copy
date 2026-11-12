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
 *   front and the page the reel lands on;
 * - a note the reel was opened on for its Details page stays a page of its
 *   own (`soloId`): a row of cards has no Details page to open on;
 * - a set the reader has reached is closed (`closedGroups`): its notes share
 *   a page only with each other from then on. Without that, a note from the
 *   lane's next page joined a set behind the reader and was never shown, and
 *   two sets the reader had passed could merge and take the reel back with them.
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

export interface ReelNoteClubbing<T> {
  isNote: (item: T) => boolean;
  /** The post the reel was opened on. */
  anchorId?: string | null;
  /** A note that keeps a page of its own, drawn as any other post. */
  soloId?: string | null;
  /** For each note of a set the reader has reached, the set it was closed in. */
  closedGroups?: ReadonlyMap<string, string>;
  maxNotes?: number;
  window?: number;
}

const NO_GROUPS: ReadonlyMap<string, string> = new Map();

export function clubReelNotes<T extends { id: string }>(
  items: readonly T[],
  {
    isNote,
    anchorId = null,
    soloId = null,
    closedGroups = NO_GROUPS,
    maxNotes = REEL_NOTE_SET_MAX_NOTES,
    window = REEL_NOTE_SET_WINDOW,
  }: ReelNoteClubbing<T>,
): ReelPage<T>[] {
  const pages: ReelPage<T>[] = [];
  const taken = new Set<number>();
  const clubs = (item: T) => isNote(item) && item.id !== soloId;

  for (let index = 0; index < items.length; index += 1) {
    if (taken.has(index)) continue;
    const item = items[index];
    if (!clubs(item)) {
      pages.push({ kind: 'post', item });
      continue;
    }

    const notes = [item];
    const group = closedGroups.get(item.id);
    const last = Math.min(items.length - 1, index + window);
    for (let next = index + 1; next <= last && notes.length < maxNotes; next += 1) {
      const candidate = items[next];
      if (taken.has(next) || !clubs(candidate)) continue;
      // The opened post leads its own set; it is never a later card of this one.
      if (candidate.id === anchorId) break;
      // A set the reader has reached takes no newcomer, from the lane or from another such set.
      if (closedGroups.get(candidate.id) !== group) continue;
      notes.push(candidate);
      taken.add(next);
    }
    pages.push({ kind: 'notes', set: { key: item.id, notes } });
  }

  return pages;
}

/**
 * The card a set shows in front: the reel's current post when it is one of
 * the set's, else the one the reader left it on, else its first. A note the
 * reader removed, or one a refresh dropped, falls back the same way.
 */
export function frontNoteOfSet<T extends { id: string }>(
  set: ReelNoteSet<T>,
  { currentId, rememberedId }: { currentId?: string | null; rememberedId?: string | null },
): T {
  return set.notes.find((note) => note.id === currentId)
    ?? set.notes.find((note) => note.id === rememberedId)
    ?? set.notes[0];
}

export type ReelListItem<T> = T & { noteSet?: ReelNoteSet<T> };

/**
 * The reel's list: one entry a page. A page of notes is held by the note in
 * front, carrying its set, so the list stays one item a page and the reel's
 * current post on that page is the card the reader is looking at. Whatever
 * note the reel's position names is the front card of the set that holds it,
 * so a note that moves into another set (a removal between them, a refresh
 * that drops a set's first note) is still found where the reader is.
 */
export function buildReelList<T extends { id: string }>(
  items: readonly T[],
  {
    currentId = null,
    frontNoteIds = {},
    ...clubbing
  }: ReelNoteClubbing<T> & {
    /** The item the reel's position names. */
    currentId?: string | null;
    /** The card each set was left on, by the set's key. */
    frontNoteIds?: Readonly<Record<string, string>>;
  },
): ReelListItem<T>[] {
  return clubReelNotes(items, clubbing).map((page) => (page.kind === 'post'
    ? page.item
    : { ...frontNoteOfSet(page.set, { currentId, rememberedId: frontNoteIds[page.set.key] }), noteSet: page.set }));
}

/**
 * `closedGroups` once the reader stands on `currentIndex`: every note on a page
 * of notes up to and including that page, under the set it is in now. A note
 * closed before keeps the set it was closed in. Returns the map it was given
 * when nothing is new, so a caller can hold it in state without a loop.
 */
export function closeReachedNoteSets<T extends { id: string }>(
  closedGroups: ReadonlyMap<string, string>,
  list: readonly ReelListItem<T>[],
  currentIndex: number,
): ReadonlyMap<string, string> {
  let next: Map<string, string> | null = null;
  for (const entry of list.slice(0, currentIndex + 1)) {
    if (!entry.noteSet) continue;
    for (const note of entry.noteSet.notes) {
      if (closedGroups.has(note.id)) continue;
      next ??= new Map(closedGroups);
      next.set(note.id, entry.noteSet.key);
    }
  }
  return next ?? closedGroups;
}

/** Which card a sideways scroll stands on. */
export function noteIndexAtOffset(offsetX: number, interval: number, count: number) {
  if (interval <= 0 || count <= 0) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(offsetX / interval)));
}

/** True once a sideways scroll is at rest on a card, not passing between two. */
export function isRestingOnNote(offsetX: number, interval: number) {
  if (interval <= 0) return true;
  return Math.abs(offsetX - Math.round(offsetX / interval) * interval) < 1;
}
