import { MEDIA_MAX_ITEMS } from './media-reorder';
import {
  MAX_MADE_WITH_ROWS,
  type PostComposerDraft,
  type PostComposerMadeWithRow,
  type PostComposerMediaItem,
  type PostComposerResourceCardDraft,
} from './post-new-view-model';

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
 *
 * Undo puts back what the removal took and nothing else. Typing can go on while
 * the offer stands: on Android the offer rides above the keyboard, and on iOS a
 * field can be focused again before the keyboard is put away to reach it. It
 * used to restore the whole draft as it stood before the removal, and on the
 * Pixel 9a emulator (2026-10-22) text typed into the package summary after a
 * card's removal was gone again after Undo. So a removal records the piece it took, where it stood
 * and what it changed around it (`PostComposerRemoval`), and Undo applies that
 * to the draft as it is when the control is pressed.
 */

/**
 * How long the offer stands. One removal is offered at a time, and the next
 * replaces it: a stack would have to keep each recorded place in step with the
 * removals undone after it, and the composer offers the one step that stays
 * true while uploads, the resource editor and typing all change the live draft.
 */
export const COMPOSER_UNDO_WINDOW_MS = 8000;

export interface ComposerUndoEntry<TRemoval> {
  /** What was removed, in the words the surface already uses for it ("Cover", "Media 2"). */
  label: string;
  /** What the removal took out of the draft, and so what Undo puts back. */
  removal: TRemoval;
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

/** A resource card's choice of outputs, as one removal found and left it. */
type ResourceCardOutputs = Pick<PostComposerResourceCardDraft, 'mediaKeys' | 'appliesToAll'>;

export interface PostComposerMediaRemoval {
  kind: 'media';
  item: PostComposerMediaItem;
  index: number;
  /** The resource cards whose outputs the removal changed: what they were, and what it left. */
  cards: Array<{ id: string; before: ResourceCardOutputs; after: ResourceCardOutputs }>;
  /**
   * The draft's cover upload before and after. Editing a post starts from an upload built from the
   * post itself, not from its first item, so rebuilding it on the way back would leave the draft
   * reading as changed.
   */
  upload: { before: PostComposerDraft['upload']; after: PostComposerDraft['upload'] };
}

export interface PostComposerMadeWithRemoval {
  kind: 'made-with';
  row: PostComposerMadeWithRow;
  index: number;
}

export interface PostComposerResourceCardRemoval {
  kind: 'resource-card';
  card: PostComposerResourceCardDraft;
  index: number;
  /** Set when taking the last card switched resources off: the access mode it had. */
  accessModeBefore: PostComposerDraft['resource']['accessMode'] | null;
}

/** What one removal took out of the post composer's draft, and where it stood. */
export type PostComposerRemoval = PostComposerMediaRemoval | PostComposerMadeWithRemoval | PostComposerResourceCardRemoval;

/**
 * What a removal leaves, and the record Undo puts back from. Taking the same
 * piece from the same draft always gives the same result, so a screen can read
 * the record from the draft it drew and apply the removal to the newest one.
 */
export interface PostComposerTaken<TRemoval extends PostComposerRemoval> {
  draft: PostComposerDraft;
  removal: TRemoval;
}

function uploadFor(item: PostComposerMediaItem | undefined): PostComposerDraft['upload'] {
  return item ? { uri: item.uri, name: item.name, type: item.type } : null;
}

function sameUpload(left: PostComposerDraft['upload'], right: PostComposerDraft['upload']) {
  return left === right || (left !== null && right !== null
    && left.uri === right.uri && left.name === right.name && left.type === right.type);
}

function sameOutputs(left: ResourceCardOutputs, right: ResourceCardOutputs) {
  return left.appliesToAll === right.appliesToAll
    && left.mediaKeys.length === right.mediaKeys.length
    && left.mediaKeys.every((key, index) => right.mediaKeys[index] === key);
}

/**
 * Removes one media item. The cover moves to the next item, and every resource
 * card stops naming the media: one left naming no output applies to all.
 */
export function takeComposerMedia(draft: PostComposerDraft, id: string): PostComposerTaken<PostComposerMediaRemoval> | null {
  const index = draft.mediaItems.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const item = draft.mediaItems[index];
  const mediaKey = item.mediaKey ?? item.id;
  const mediaItems = draft.mediaItems.filter((candidate) => candidate.id !== id);
  const changed: Array<{ id: string; before: ResourceCardOutputs; after: ResourceCardOutputs }> = [];
  const cards = draft.resource.cards.map((card) => {
    const mediaKeys = card.mediaKeys.filter((key) => key !== mediaKey);
    const after = { mediaKeys, appliesToAll: card.appliesToAll || mediaKeys.length === 0 };
    if (sameOutputs(card, after)) return card;
    changed.push({ id: card.id, before: { mediaKeys: card.mediaKeys, appliesToAll: card.appliesToAll }, after });
    return { ...card, ...after };
  });
  const upload = uploadFor(mediaItems[0]);
  return {
    draft: {
      ...draft,
      mediaItems,
      upload,
      resource: { ...draft.resource, cards },
    },
    removal: { kind: 'media', item, index, cards: changed, upload: { before: draft.upload, after: upload } },
  };
}

/** Removes one made-with row. The list never empties: the last row is not taken, as the screen offers no Remove on it. */
export function takeComposerMadeWithRow(draft: PostComposerDraft, id: string): PostComposerTaken<PostComposerMadeWithRemoval> | null {
  const index = draft.madeWithRows.findIndex((row) => row.id === id);
  if (index < 0 || draft.madeWithRows.length <= 1) return null;
  return {
    draft: { ...draft, madeWithRows: draft.madeWithRows.filter((row) => row.id !== id) },
    removal: { kind: 'made-with', row: draft.madeWithRows[index], index },
  };
}

/**
 * Removes one item. Taking the last one leaves the recipe on and empty: removing
 * a recipe is the creator's "No recipe", which the composer asks about on save.
 */
export function takeComposerResourceCard(draft: PostComposerDraft, id: string): PostComposerTaken<PostComposerResourceCardRemoval> | null {
  const index = draft.resource.cards.findIndex((card) => card.id === id);
  if (index < 0) return null;
  return {
    draft: {
      ...draft,
      resource: {
        ...draft.resource,
        cardAuthoringMode: 'cards',
        cards: draft.resource.cards.filter((card) => card.id !== id),
      },
    },
    removal: {
      kind: 'resource-card',
      card: draft.resource.cards[index],
      index,
      accessModeBefore: null,
    },
  };
}

/**
 * Puts back what one removal took, onto the draft as it is now: whatever was
 * typed or chosen since stays. The piece returns to its place (or the end, if
 * the list has since grown shorter), and what the removal changed around it is
 * changed back where nothing has changed it again since: a resource card's
 * outputs, resources switched off. A piece that is already back is left alone,
 * and so is media or a made-with row the list no longer has room for (the
 * screen's Add filled it again meanwhile).
 */
export function putBackComposerRemoval(draft: PostComposerDraft, removal: PostComposerRemoval): PostComposerDraft {
  switch (removal.kind) {
    case 'media': {
      if (draft.mediaItems.some((item) => item.id === removal.item.id)) return draft;
      if (draft.mediaItems.length >= MEDIA_MAX_ITEMS) return draft;
      const mediaItems = [...draft.mediaItems];
      mediaItems.splice(Math.min(removal.index, mediaItems.length), 0, removal.item);
      const cards = draft.resource.cards.map((card) => {
        const change = removal.cards.find((candidate) => candidate.id === card.id);
        return change && sameOutputs(card, change.after) ? { ...card, ...change.before } : card;
      });
      return {
        ...draft,
        mediaItems,
        upload: sameUpload(draft.upload, removal.upload.after) ? removal.upload.before : uploadFor(mediaItems[0]),
        resource: { ...draft.resource, cards },
      };
    }
    case 'made-with': {
      if (draft.madeWithRows.some((row) => row.id === removal.row.id)) return draft;
      if (draft.madeWithRows.length >= MAX_MADE_WITH_ROWS) return draft;
      const madeWithRows = [...draft.madeWithRows];
      madeWithRows.splice(Math.min(removal.index, madeWithRows.length), 0, removal.row);
      return { ...draft, madeWithRows };
    }
    case 'resource-card': {
      if (draft.resource.cards.some((card) => card.id === removal.card.id)) return draft;
      const cards = [...draft.resource.cards];
      cards.splice(Math.min(removal.index, cards.length), 0, removal.card);
      return {
        ...draft,
        resource: {
          ...draft.resource,
          cards,
          accessMode: removal.accessModeBefore && draft.resource.accessMode === 'none'
            ? removal.accessModeBefore
            : draft.resource.accessMode,
        },
      };
    }
  }
}
