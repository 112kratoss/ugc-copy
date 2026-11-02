export type TextSelection = {
  start: number;
  end: number;
};

export type ActiveReferenceMention = TextSelection & {
  query: string;
};

const HANDLE_CHARACTER = /[A-Za-z0-9_-]/;
const HANDLE_QUERY = /^[A-Za-z0-9_-]*$/;

export function normalizeTextSelection(text: string, selection: TextSelection): TextSelection {
  const start = Math.max(0, Math.min(text.length, Math.min(selection.start, selection.end)));
  const end = Math.max(start, Math.min(text.length, Math.max(selection.start, selection.end)));
  return { start, end };
}

/**
 * Where a caret in `before` stands once the text is `after`, for a change the field did not type (a
 * saved draft arriving, Enhance, Undo, a rename): before or after the run of text that changed, it
 * keeps its place among the words around it. Inside that run (a rename of a handle the prompt names
 * twice changes the text on both sides of a caret between them) it stays after the words it
 * followed, or before the ones it preceded, where those appear once in the new run; otherwise, and
 * at the run's edges, it goes to the run's end, as a caret moves past text typed at it. A caret at
 * the end stays at the end, so a field that fills puts it there, as both platforms' fields do.
 */
export function selectionAfterTextChange(before: string, after: string, selection: TextSelection): TextSelection {
  const caret = normalizeTextSelection(before, selection);
  if (before === after) return caret;
  if (caret.start === before.length) return { start: after.length, end: after.length };
  const shorter = Math.min(before.length, after.length);
  let head = 0;
  while (head < shorter && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
  let tail = 0;
  while (tail < shorter - head && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail += 1;
  const runEnd = before.length - tail;
  const place = (offset: number) => {
    if (offset < head) return offset;
    if (offset > runEnd) return after.length - (before.length - offset);
    const anchored = offset > head && offset < runEnd
      ? anchorInChangedRun(before.slice(head, offset), before.slice(offset, runEnd), after.slice(head, after.length - tail))
      : null;
    return anchored === null ? after.length - tail : head + anchored;
  };
  // Two anchored ends can cross; the selection keeps both.
  return normalizeTextSelection(after, { start: place(caret.start), end: place(caret.end) });
}

/** How many characters on either side of a caret anchor it inside a changed run, and the fewest that do. */
const RUN_ANCHOR_MAX = 16;
const RUN_ANCHOR_MIN = 4;

/**
 * Where a caret that had `left` before it and `right` after it, inside a run of text that changed,
 * stands in the new run: after the longest end of `left` (up to 16 characters) that the new run
 * holds exactly once, else before the longest start of `right` that it holds exactly once, else
 * nowhere. The characters next to the caret that the change left alone are the anchor.
 */
function anchorInChangedRun(left: string, right: string, run: string): number | null {
  const once = (text: string) => {
    const at = run.indexOf(text);
    return at !== -1 && run.indexOf(text, at + 1) === -1 ? at : -1;
  };
  for (let length = Math.min(RUN_ANCHOR_MAX, left.length); length >= RUN_ANCHOR_MIN; length -= 1) {
    const words = left.slice(left.length - length);
    const at = once(words);
    if (at !== -1) return at + words.length;
  }
  for (let length = Math.min(RUN_ANCHOR_MAX, right.length); length >= RUN_ANCHOR_MIN; length -= 1) {
    const at = once(right.slice(0, length));
    if (at !== -1) return at;
  }
  return null;
}

export function findActiveReferenceMention(text: string, selection: TextSelection): ActiveReferenceMention | null {
  const normalized = normalizeTextSelection(text, selection);
  if (normalized.start !== normalized.end) return null;

  const cursor = normalized.start;
  const beforeCursor = text.slice(0, cursor);
  const atIndex = beforeCursor.lastIndexOf('@');
  if (atIndex < 0) return null;

  const precedingCharacter = atIndex > 0 ? text[atIndex - 1] : '';
  if (precedingCharacter && /[A-Za-z0-9_@]/.test(precedingCharacter)) return null;

  const query = beforeCursor.slice(atIndex + 1);
  if (!HANDLE_QUERY.test(query)) return null;

  const nextCharacter = text[cursor] ?? '';
  if (nextCharacter && HANDLE_CHARACTER.test(nextCharacter)) return null;

  return { start: atIndex, end: cursor, query };
}

/**
 * Whether a reference answers the mention being typed: its handle without the "@", or its name,
 * contains the query, in any case. A reference with no handle cannot be mentioned.
 */
export function referenceMatchesMention(reference: { handle?: string | null; displayName: string }, query: string) {
  if (!reference.handle) return false;
  const needle = query.toLowerCase();
  return reference.handle.slice(1).toLowerCase().includes(needle) || reference.displayName.toLowerCase().includes(needle);
}

export function insertHandleAtSelection(text: string, handle: string, selection: TextSelection) {
  const normalized = normalizeTextSelection(text, selection);
  const before = text.slice(0, normalized.start);
  const after = text.slice(normalized.end);
  const leadingSpace = before.length > 0 && !/[\s([{\/'"“‘]$/.test(before) ? ' ' : '';
  const trailingSpace = after.length > 0 && !/^[\s,.;:!?)}\]\/'"”’]/.test(after) ? ' ' : '';
  const inserted = `${leadingSpace}${handle}${trailingSpace}`;
  const cursor = before.length + inserted.length;

  return {
    text: `${before}${inserted}${after}`,
    selection: { start: cursor, end: cursor },
  };
}
