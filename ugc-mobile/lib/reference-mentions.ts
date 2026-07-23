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
