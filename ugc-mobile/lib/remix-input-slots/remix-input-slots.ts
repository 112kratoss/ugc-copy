/**
 * Input slots: what a remix is given in place of an input its creator did not
 * share (owner, 2026-11-03).
 *
 * A remix hands over a creation's prompt, model and settings, but its saved
 * inputs (reference pictures, frames, clips, tracks, a named subject's
 * pictures, a motion run's character and clip) only where the creator shares
 * them. For every input it does not, the remix source names an empty slot:
 * what kind of input went there and, when the prompt mentions it, the @handle
 * it goes by. The remixer adds their own in its place and the prompt works
 * unchanged. A slot never carries the creator's file, its link, its stored
 * name or anything else that points at it: its name is its role's own.
 *
 * Shared by the server and the web creators (`src/lib/remix-source.ts`,
 * `src/lib/remix-source-server.ts`, `src/app/create-*`) and the app, by
 * relative import, so it stays free of React Native, Expo and Node imports.
 */

export const REMIX_INPUT_SLOT_KINDS = ['image', 'video', 'audio'] as const;
export type RemixInputSlotKind = (typeof REMIX_INPUT_SLOT_KINDS)[number];

export const REMIX_INPUT_SLOT_ROLES = [
  'reference_image',
  'start_frame',
  'end_frame',
  'reference_video',
  'reference_audio',
  'character_image',
  'motion_reference_video',
  // One slot per named subject (Kling O3), however many pictures it fused.
  'subject',
] as const;
export type RemixInputSlotRole = (typeof REMIX_INPUT_SLOT_ROLES)[number];

export interface RemixInputSlot {
  /** `slot-1`, `slot-2`, … in the run's order: stable within one bundle, never a stored row's id. */
  id: string;
  kind: RemixInputSlotKind;
  role: RemixInputSlotRole;
  /**
   * The handle the creation's prompt mentions this input by (`@product`), or
   * null when the prompt does not mention it. Only a mentioned handle is
   * given: it is in the prompt the remixer reads anyway, while an unmentioned
   * one can have been made from an upload's file name.
   */
  handle: string | null;
  /** What the slot is called: its role's own name, numbered where the role repeats ("Reference image 2"). */
  name: string;
  /** A subject's picture count, which its creator fused under one handle. */
  pictureCount?: number;
  /** A clip or track's length in seconds, when the run kept it. */
  durationSeconds?: number;
}

/** Which creator a run belongs to: a motion run's inputs are its character and its clip whatever their stored roles. */
export type RemixInputSlotTool = 'image' | 'video' | 'motion';

/** A saved input as the slot builder reads it: never its file, link or name. */
export interface RemixInputSlotSource {
  mediaType: string;
  role: string;
  sortOrder: number;
  metadata?: Record<string, unknown> | null;
}

const HANDLE_PATTERN = /^@[a-z0-9_]+$/;
const PROMPT_HANDLE_PATTERN = /(^|[^\w])(@[a-z0-9_]+)(?=$|[^\w])/g;

const ROLE_NAMES: Record<RemixInputSlotRole, string> = {
  reference_image: 'Reference image',
  start_frame: 'Start frame',
  end_frame: 'End frame',
  reference_video: 'Reference video',
  reference_audio: 'Reference audio',
  character_image: 'Character image',
  motion_reference_video: 'Motion video',
  subject: 'Subject',
};

/** Roles a run holds more than one of: their slots are numbered. */
const REPEATING_ROLES = new Set<RemixInputSlotRole>(['reference_image', 'reference_video', 'reference_audio', 'subject']);

const ROLE_KINDS: Record<RemixInputSlotRole, RemixInputSlotKind> = {
  reference_image: 'image',
  start_frame: 'image',
  end_frame: 'image',
  reference_video: 'video',
  reference_audio: 'audio',
  character_image: 'image',
  motion_reference_video: 'video',
  subject: 'image',
};

function promptHandles(prompt: string | null | undefined): Set<string> {
  const handles = new Set<string>();
  (prompt ?? '').replace(PROMPT_HANDLE_PATTERN, (match, _prefix: string, handle: string) => {
    handles.add(handle);
    return match;
  });
  return handles;
}

function readHandle(metadata: Record<string, unknown> | null | undefined): string | null {
  const handle = metadata?.handle;
  return typeof handle === 'string' && HANDLE_PATTERN.test(handle) ? handle : null;
}

function readDuration(metadata: Record<string, unknown> | null | undefined): number | undefined {
  const seconds = metadata?.durationSeconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

/** A stored input's slot role for a run of `tool`, or null for an input no creator restores. */
function slotRoleFor(source: RemixInputSlotSource, tool: RemixInputSlotTool): RemixInputSlotRole | null {
  if (tool === 'motion') {
    // The catalog path stored these under plain reference roles until motion
    // runs got motion roles: a motion run holds one picture and one clip.
    if (source.role === 'character_image' || (source.mediaType === 'image' && source.role === 'reference_image')) return 'character_image';
    if (source.role === 'motion_reference_video' || (source.mediaType === 'video' && source.role === 'reference_video')) return 'motion_reference_video';
    return null;
  }
  if (source.role === 'subject_image') return tool === 'video' ? 'subject' : null;
  if (tool === 'image') return source.role === 'reference_image' && source.mediaType === 'image' ? 'reference_image' : null;
  switch (source.role) {
    case 'reference_image':
    case 'start_frame':
    case 'end_frame':
      return source.mediaType === 'image' ? source.role : null;
    case 'reference_video':
      return source.mediaType === 'video' ? 'reference_video' : null;
    case 'reference_audio':
      return source.mediaType === 'audio' ? 'reference_audio' : null;
    default:
      return null;
  }
}

/**
 * The slots for a run's saved inputs, in the run's order: one per input, one
 * per named subject, and at most one character and one clip for a motion run.
 * A handle is kept only where `prompt` mentions it.
 */
export function buildRemixInputSlots(
  sources: readonly RemixInputSlotSource[],
  options: { tool: RemixInputSlotTool; prompt: string | null | undefined },
): RemixInputSlot[] {
  const mentioned = promptHandles(options.prompt);
  const ordered = [...sources].sort((left, right) => left.sortOrder - right.sortOrder);
  const counts = new Map<RemixInputSlotRole, number>();
  const subjectSlots = new Map<string, RemixInputSlot>();
  const slots: RemixInputSlot[] = [];
  const singleUse = new Set<RemixInputSlotRole>();

  for (const source of ordered) {
    const role = slotRoleFor(source, options.tool);
    if (!role) continue;
    if (!REPEATING_ROLES.has(role)) {
      // A run holds one start frame, one end frame, one character and one motion clip.
      if (singleUse.has(role)) continue;
      singleUse.add(role);
    }
    const storedHandle = readHandle(source.metadata);
    const handle = storedHandle && mentioned.has(storedHandle) ? storedHandle : null;

    // A subject's pictures share its handle, or its index on runs that kept none.
    let subjectKey: string | null = null;
    if (role === 'subject') {
      const subjectIndex = source.metadata?.subjectIndex;
      subjectKey = storedHandle ?? (typeof subjectIndex === 'number' ? `index:${subjectIndex}` : null);
      if (!subjectKey) continue;
      const existing = subjectSlots.get(subjectKey);
      if (existing) {
        existing.pictureCount = (existing.pictureCount ?? 0) + 1;
        continue;
      }
    }

    const count = (counts.get(role) ?? 0) + 1;
    counts.set(role, count);
    const slot: RemixInputSlot = {
      id: `slot-${slots.length + 1}`,
      kind: ROLE_KINDS[role],
      role,
      handle,
      name: REPEATING_ROLES.has(role) ? `${ROLE_NAMES[role]} ${count}` : ROLE_NAMES[role],
    };
    if (subjectKey) {
      slot.pictureCount = 1;
      subjectSlots.set(subjectKey, slot);
    }
    const seconds = slot.kind === 'image' ? undefined : readDuration(source.metadata);
    if (seconds !== undefined) slot.durationSeconds = seconds;
    slots.push(slot);
  }

  return slots;
}

/** A bundle's slots as a client reads them: anything malformed is left out. */
export function parseRemixInputSlots(value: unknown): RemixInputSlot[] {
  if (!Array.isArray(value)) return [];
  const slots: RemixInputSlot[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const role = candidate.role;
    if (typeof candidate.id !== 'string' || !candidate.id) continue;
    if (typeof role !== 'string' || !(REMIX_INPUT_SLOT_ROLES as readonly string[]).includes(role)) continue;
    const slotRole = role as RemixInputSlotRole;
    const handle = typeof candidate.handle === 'string' && HANDLE_PATTERN.test(candidate.handle) ? candidate.handle : null;
    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : ROLE_NAMES[slotRole];
    const slot: RemixInputSlot = { id: candidate.id, kind: ROLE_KINDS[slotRole], role: slotRole, handle, name };
    if (slotRole === 'subject' && typeof candidate.pictureCount === 'number' && candidate.pictureCount > 0) {
      slot.pictureCount = Math.trunc(candidate.pictureCount);
    }
    const seconds = typeof candidate.durationSeconds === 'number' && Number.isFinite(candidate.durationSeconds) && candidate.durationSeconds > 0
      ? candidate.durationSeconds
      : undefined;
    if (seconds !== undefined && slot.kind !== 'image') slot.durationSeconds = seconds;
    slots.push(slot);
  }
  return slots;
}

/** The roles each creator has a place for: a slot of any other role is left out of its draft. */
export const REMIX_INPUT_SLOT_TOOL_ROLES: Record<RemixInputSlotTool, readonly RemixInputSlotRole[]> = {
  image: ['reference_image'],
  video: ['start_frame', 'end_frame', 'reference_image', 'reference_video', 'reference_audio', 'subject'],
  motion: ['character_image', 'motion_reference_video'],
};

/** A bundle's slots as `tool`'s creator holds them: read defensively, and only those it has a place for. */
export function parseRemixInputSlotsForTool(tool: RemixInputSlotTool, value: unknown): RemixInputSlot[] {
  return parseRemixInputSlots(value).filter((slot) => REMIX_INPUT_SLOT_TOOL_ROLES[tool].includes(slot.role));
}

/** The slot's title on its empty box: the handle the prompt knows it by, else its name. */
export function remixInputSlotTitle(slot: Pick<RemixInputSlot, 'handle' | 'name'>): string {
  return slot.handle ?? slot.name;
}

/** The empty box's call to action. */
export function remixInputSlotAction(slot: Pick<RemixInputSlot, 'kind' | 'role'>): string {
  if (slot.role === 'subject') return 'Add your pictures';
  if (slot.kind === 'video') return 'Add your video';
  if (slot.kind === 'audio') return 'Add your audio';
  return 'Add your image';
}

/** The line above a remix whose creator kept inputs to themselves; null when none are missing. */
export function remixInputSlotsNotice(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count === 1
    ? 'The creator kept 1 input to themselves. Add your own in the empty box.'
    : `The creator kept ${count} inputs to themselves. Add your own in the empty boxes.`;
}

/**
 * What a prompt that mentions an empty slot says in place of an unknown
 * mention: the run cannot start with it, so the remixer fills the box or takes
 * the mention out.
 */
export function unfilledRemixSlotsMessage(handles: readonly string[]): string | null {
  const unique = [...new Set(handles)];
  if (unique.length === 0) return null;
  if (unique.length === 1) return `Add your own for ${unique[0]} in its box, or take ${unique[0]} out of the prompt.`;
  const listed = `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
  return `Add your own for ${listed} in their boxes, or take them out of the prompt.`;
}

/** The handles of slots still empty, for a creator's mention check. */
export function remixInputSlotHandles(slots: readonly Pick<RemixInputSlot, 'handle'>[]): string[] {
  return slots.flatMap((slot) => (slot.handle ? [slot.handle] : []));
}
