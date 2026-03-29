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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toHandleBase(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized.length > 0 ? normalized : 'element';
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
  fallbackIndex: number
): string {
  const base = toHandleBase(displayName);
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

export function reconcileElementDescriptors<T extends { id: string; displayName: string }>(
  elements: T[]
): Array<T & { displayName: string; handle: string }> {
  const usedHandles = new Set<string>();

  return elements.map((element, index) => {
    const displayName = normalizeElementDisplayName(element.displayName, index + 1);
    const handle = buildElementHandle(displayName, usedHandles, index + 1);

    return {
      ...element,
      displayName,
      handle,
    };
  });
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

export function getMentionQueryAtCaret(
  prompt: string,
  caretIndex: number
): { query: string; replaceStart: number; replaceEnd: number } | null {
  const beforeCaret = prompt.slice(0, caretIndex);
  const match = beforeCaret.match(/(^|[^\w])@([a-z0-9_]*)$/);

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
    .map((element, index) => {
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

export function getElementFileNameFromStoragePath(storagePath: string, fallbackHandle: string): string {
  const rawName = storagePath.split('/').pop();
  if (rawName && rawName.length > 0) {
    return rawName;
  }

  return `${fallbackHandle.replace('@', '')}.jpg`;
}

export function isUploadsStoragePath(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith('uploads/');
}

export function getUploadsBucketPath(storagePath: string): string {
  return storagePath.replace(/^uploads\//, '');
}

export function createPersistedElementDrafts(
  elements: Array<{ id: string; displayName: string }>
): PersistedImageElementDraft[] {
  return elements.map((element) => ({
    id: element.id,
    displayName: element.displayName,
  }));
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

export function sortElementsByIdOrder<T extends { id: string }>(
  items: T[],
  idsInOrder: string[]
): T[] {
  const orderMap = new Map(idsInOrder.map((id, index) => [id, index]));

  return [...items].sort((a, b) => {
    const aIndex = orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex;
  });
}

export function buildHandleRegex(handle: string): RegExp {
  return new RegExp(`(^|[^\\w])(${escapeRegExp(handle)})(?=$|[^\\w])`, 'g');
}
