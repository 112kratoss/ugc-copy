export interface ImageElementDescriptor {
  id: string;
  displayName: string;
  handle: string;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
}

export interface PersistedImageElementDraft {
  id: string;
  displayName: string;
}

const HANDLE_PATTERN = /(^|[^\w])(@[a-z0-9_]+)(?=$|[^\w])/g;

function toHandleBase(value: string, fallback = 'element'): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized.length > 0 ? normalized : fallback;
}

export function createElementId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `element_${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeElementDisplayName(value: string | undefined, index: number): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `Element ${index}`;
}

export function buildElementHandle(
  displayName: string,
  usedHandles: Set<string>,
  fallbackIndex: number,
  standIn = 'element'
): string {
  const base = toHandleBase(displayName, standIn);
  let nextHandle = `@${base}`;

  if (!usedHandles.has(nextHandle)) {
    usedHandles.add(nextHandle);
    return nextHandle;
  }

  let suffix = Math.max(2, fallbackIndex);
  while (usedHandles.has(`@${base}_${suffix}`)) {
    suffix += 1;
  }

  nextHandle = `@${base}_${suffix}`;
  usedHandles.add(nextHandle);
  return nextHandle;
}

/**
 * What stands in where a name gives nothing to go by. `place` is the place of
 * the element on its card, counted from 1.
 */
type HandleStandIns = {
  /** The name of an element that has none. */
  displayName: (place: number) => string;
  /** What the handle is built from when the name has nothing a handle can hold. */
  handleBase: (place: number) => string;
};

const ELEMENT_STAND_INS: HandleStandIns = {
  displayName: (place) => normalizeElementDisplayName(undefined, place),
  handleBase: () => 'element',
};

const SUBJECT_STAND_INS: HandleStandIns = {
  displayName: (place) => `Subject ${place}`,
  handleBase: (place) => `subject_${place}`,
};

/**
 * Gives each reference element on a creator card its @handle.
 *
 * A handle follows its element's name: it is built from the name when the
 * element is added, and again when it is renamed (the caller passes the renamed
 * element without a handle). Nothing else changes it, because the prompt
 * mentions it: not another element being added, renamed or removed, and not a
 * reload or a remix, which pass back the handles they saved.
 *
 * The handles being kept are set aside first, so a new handle never takes one
 * that another element holds.
 *
 * `standIns` is for a card whose elements go by another word: see
 * `assignSubjectHandles`.
 */
export function assignElementHandles<T extends { displayName?: string | null; handle?: string | null }>(
  elements: T[],
  standIns: HandleStandIns = ELEMENT_STAND_INS
): Array<T & { displayName: string; handle: string }> {
  const usedHandles = new Set<string>();
  const keptHandles = elements.map((element) => {
    const handle = element.handle;
    if (typeof handle !== 'string' || !isValidElementHandle(handle) || usedHandles.has(handle)) {
      return null;
    }

    usedHandles.add(handle);
    return handle;
  });

  return elements.map((element, index) => {
    const place = index + 1;
    const displayName = element.displayName?.trim() || standIns.displayName(place);

    return {
      ...element,
      displayName,
      handle: keptHandles[index] ?? buildElementHandle(displayName, usedHandles, place, standIns.handleBase(place)),
    };
  });
}

/**
 * Gives each Kling O3 named subject its @handle, by the rule of the element
 * cards: built from the name when the subject is added and again when it is
 * renamed, and kept through everything else.
 *
 * A subject's handle is written like every other handle, in lower case: the
 * prompt is read for lower-case handles only, and the server gives the provider
 * the subject under its handle in lower case, which the mention in the prompt
 * has to match. A handle that kept the capitals of its name ("@Hero_creator")
 * was one spelling on the card and another everywhere it was used.
 *
 * A subject whose name has nothing a handle can hold is called by its place,
 * "@subject_2", the handle a new subject gets from the name it starts with.
 */
export function assignSubjectHandles<T extends { displayName?: string | null; handle?: string | null }>(
  subjects: T[]
): Array<T & { displayName: string; handle: string }> {
  return assignElementHandles(subjects, SUBJECT_STAND_INS);
}

export function extractPromptHandles(prompt: string): string[] {
  const handles = new Set<string>();
  const normalizedPrompt = prompt || '';

  normalizedPrompt.replace(HANDLE_PATTERN, (_match, _prefix, handle: string) => {
    handles.add(handle);
    return _match;
  });

  return Array.from(handles);
}

export function findUnknownPromptHandles(prompt: string, validHandles: string[]): string[] {
  const validHandleSet = new Set(validHandles);
  return extractPromptHandles(prompt).filter((handle) => !validHandleSet.has(handle));
}

export function replacePromptHandles(prompt: string, replacements: Map<string, string>): string {
  if (replacements.size === 0) {
    return prompt;
  }

  return prompt.replace(HANDLE_PATTERN, (match, prefix: string, handle: string) => {
    const nextHandle = replacements.get(handle);
    if (!nextHandle || nextHandle === handle) {
      return match;
    }

    return `${prefix}${nextHandle}`;
  });
}

/**
 * The mention being typed at the caret: the "@" and what follows it.
 *
 * Capitals count here, though a handle has none. The panel this opens also finds
 * a reference by its name, and a name starts with a capital: at "@H" it has to
 * stay open for a subject called "Hero creator". The pages compare the query in
 * lower case, and the reference picked replaces what was typed with its handle.
 */
export function getMentionQueryAtCaret(
  prompt: string,
  caretIndex: number
): { query: string; replaceStart: number; replaceEnd: number } | null {
  const beforeCaret = prompt.slice(0, caretIndex);
  const match = beforeCaret.match(/(^|[^\w])@([A-Za-z0-9_]*)$/);

  if (!match) {
    return null;
  }

  const query = match[2] ?? '';
  return {
    query,
    replaceStart: caretIndex - query.length - 1,
    replaceEnd: caretIndex,
  };
}

export function insertHandleIntoPrompt(
  prompt: string,
  handle: string,
  selectionStart: number,
  selectionEnd: number,
  mentionQuery?: { replaceStart: number; replaceEnd: number } | null
): { prompt: string; caretIndex: number } {
  const start = mentionQuery ? mentionQuery.replaceStart : selectionStart;
  const end = mentionQuery ? mentionQuery.replaceEnd : selectionEnd;
  const prefix = prompt.slice(0, start);
  const suffix = prompt.slice(end);
  const needsLeadingSpace = prefix.length > 0 && !/\s$/.test(prefix);
  const needsTrailingSpace = suffix.length > 0 && !/^\s/.test(suffix);
  const inserted = `${needsLeadingSpace ? ' ' : ''}${handle}${needsTrailingSpace ? ' ' : ''}`;
  const nextPrompt = `${prefix}${inserted}${suffix}`;
  const nextCaretIndex = prefix.length + inserted.length;

  return {
    prompt: nextPrompt,
    caretIndex: nextCaretIndex,
  };
}

export function compileImagePromptWithElements(
  rawPrompt: string,
  elements: ImageElementDescriptor[]
): string {
  return compilePromptWithElements(rawPrompt, elements, 'image');
}

export function compilePromptWithElements(
  rawPrompt: string,
  elements: ImageElementDescriptor[],
  medium: 'image' | 'video' = 'image'
): string {
  const trimmedPrompt = rawPrompt.trim();
  if (!trimmedPrompt) {
    return trimmedPrompt;
  }

  const usedHandles = new Set(extractPromptHandles(trimmedPrompt));
  if (usedHandles.size === 0) {
    return trimmedPrompt;
  }

  const legendLines = elements
    .map((element, index) =>
      usedHandles.has(element.handle)
        ? `${element.handle} = attached reference image ${index + 1} (${element.displayName})`
        : null
    )
    .filter((line): line is string => Boolean(line));

  if (legendLines.length === 0) {
    return trimmedPrompt;
  }

  return [
    'Reference elements:',
    ...legendLines,
    medium === 'video'
      ? 'When an @handle is mentioned, preserve the appearance and identity of the matching attached reference image throughout the generated video.'
      : 'When an @handle is mentioned, preserve the appearance and identity of the matching attached reference image.',
    '',
    'Prompt:',
    trimmedPrompt,
  ].join('\n');
}

export function normalizeSubmittedElementDescriptors(value: unknown): ImageElementDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((element, index): ImageElementDescriptor | null => {
      if (typeof element !== 'object' || element === null) {
        return null;
      }

      const typedElement = element as Partial<ImageElementDescriptor>;
      if (
        typeof typedElement.id !== 'string' ||
        typeof typedElement.displayName !== 'string' ||
        typeof typedElement.handle !== 'string'
      ) {
        return null;
      }

      if (!isValidElementHandle(typedElement.handle)) {
        return null;
      }

      return {
        id: typedElement.id,
        displayName: typedElement.displayName.trim() || `Element ${index + 1}`,
        handle: typedElement.handle,
        storagePath: typeof typedElement.storagePath === 'string' ? typedElement.storagePath : null,
        sourceGenerationId:
          typeof typedElement.sourceGenerationId === 'string'
            ? typedElement.sourceGenerationId
            : null,
      } satisfies ImageElementDescriptor;
    })
    .filter((element): element is ImageElementDescriptor => element !== null);
}

export function isValidElementHandle(value: string): boolean {
  return /^@[a-z0-9_]+$/.test(value);
}

export function isUploadsStoragePath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('uploads/');
}

export function getUploadsBucketPath(storagePath: string): string {
  return storagePath.replace(/^uploads\//, '');
}

export function createElementHandleReplacementMap(
  previousElements: Array<{ id: string; handle: string }>,
  nextElements: Array<{ id: string; handle: string }>
): Map<string, string> {
  const nextById = new Map(nextElements.map((element) => [element.id, element.handle]));
  const replacements = new Map<string, string>();

  previousElements.forEach((element) => {
    const nextHandle = nextById.get(element.id);
    if (nextHandle && nextHandle !== element.handle) {
      replacements.set(element.handle, nextHandle);
    }
  });

  return replacements;
}
